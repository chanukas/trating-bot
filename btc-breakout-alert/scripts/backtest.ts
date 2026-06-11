/**
 * Evidence pass over the EXACT production breakout logic (scanHistory).
 *
 * For every historical close-mode signal: enter at the NEXT candle's open
 * (no look-ahead), exit at the close H candles after the signal candle,
 * long on upside / short on downside. Reports per-horizon stats against the
 * unconditional drift of the same period. Gross returns — subtract your
 * venue's round-trip cost (spot taker ≈ 0.20%, futures taker ≈ 0.10%).
 *
 * Usage: npm run backtest -- 1h 20000          (timeframe, candle count)
 *    or: npx tsx scripts/backtest.ts --tf 1h --candles 20000 --holds 5,10,20
 * (PowerShell strips a bare `--`, so positional args are the safe form there.)
 */
import { DEFAULT_CONFIG, scanHistory } from '../src/strategy/breakout';
import type { Candle, StrategyConfig } from '../src/types';

interface Args {
  tf: string;
  candles: number;
  holds: number[];
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const positional = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1] ?? '').startsWith('--'));
  return {
    tf: get('--tf') ?? positional.find((a) => /^\d+[mhdw]$/.test(a)) ?? '15m',
    candles: Number(get('--candles') ?? positional.find((a) => /^\d+$/.test(a)) ?? 10_000),
    holds: (get('--holds') ?? '5,10,20').split(',').map(Number),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Page backwards through /klines until `total` candles are collected. */
async function fetchHistory(tf: string, total: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let endTime: number | undefined;
  let dropForming = false;
  let firstPage = true;

  while (out.length < total) {
    const url = new URL('https://api.binance.com/api/v3/klines');
    url.searchParams.set('symbol', 'BTCUSDT');
    url.searchParams.set('interval', tf);
    url.searchParams.set('limit', '1000');
    if (endTime !== undefined) url.searchParams.set('endTime', String(endTime));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text()}`);
    const rows = (await res.json()) as (string | number)[][];
    if (rows.length === 0) break;

    if (firstPage) {
      // Newest page comes first; its last row may be the forming candle.
      dropForming = Number(rows[rows.length - 1][6]) > Date.now();
      firstPage = false;
    }

    out.unshift(
      ...rows.map((r) => ({
        time: Math.floor(Number(r[0]) / 1000),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
        takerBuy: Number(r[9]),
      })),
    );
    endTime = Number(rows[0][0]) - 1;
    if (rows.length < 1000) break;
    await sleep(120);
  }

  if (dropForming) out.pop();
  return out.slice(-total);
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface Row {
  label: string;
  n: number;
  winRate: number;
  mean: number;
  med: number;
  pf: number;
}

function stats(label: string, rets: number[]): Row {
  const wins = rets.filter((r) => r > 0);
  const grossWin = wins.reduce((s, r) => s + r, 0);
  const grossLoss = rets.filter((r) => r <= 0).reduce((s, r) => s - r, 0);
  return {
    label,
    n: rets.length,
    winRate: rets.length ? (wins.length / rets.length) * 100 : NaN,
    mean: rets.length ? rets.reduce((s, r) => s + r, 0) / rets.length : NaN,
    med: median(rets),
    pf: grossLoss > 0 ? grossWin / grossLoss : Infinity,
  };
}

const fmt = (v: number, w: number, d = 2) =>
  (Number.isFinite(v) ? v.toFixed(d) : v === Infinity ? '∞' : '—').padStart(w);

function printRow(r: Row): void {
  console.log(
    `    ${r.label.padEnd(14)} n=${String(r.n).padStart(4)}  win%=${fmt(r.winRate, 5, 1)}  ` +
      `mean%=${fmt(r.mean, 6, 3)}  med%=${fmt(r.med, 6, 3)}  PF=${fmt(r.pf, 5)}`,
  );
}

function runConfig(closed: Candle[], cfg: StrategyConfig, holds: number[]): void {
  const idxByTime = new Map(closed.map((c, i) => [c.time, i]));
  const signals = scanHistory(closed, cfg);
  const ups = signals.filter((s) => s.direction === 'up').length;
  console.log(`  signals: ${signals.length} (${ups} up / ${signals.length - ups} down)`);

  for (const H of holds) {
    const all: number[] = [];
    const up: number[] = [];
    const down: number[] = [];
    for (const s of signals) {
      const i = idxByTime.get(s.candleTime);
      if (i === undefined || i + 1 >= closed.length || i + H >= closed.length) continue;
      const entry = closed[i + 1].open;
      const exit = closed[i + H].close;
      const ret = ((exit - entry) / entry) * 100 * (s.direction === 'up' ? 1 : -1);
      all.push(ret);
      (s.direction === 'up' ? up : down).push(ret);
    }

    // Unconditional H-candle drift of the same period (long side), for baseline.
    let drift = 0;
    let m = 0;
    for (let i = 0; i + H < closed.length; i++) {
      drift += ((closed[i + H].close - closed[i].close) / closed[i].close) * 100;
      m++;
    }
    drift /= m;

    console.log(`  hold = ${H} candles  (unconditional ${H}-candle drift: ${drift.toFixed(3)}%)`);
    printRow(stats('all', all));
    printRow(stats('long (up)', up));
    printRow(stats('short (down)', down));
  }
}

const { tf, candles, holds } = parseArgs();
const closed = await fetchHistory(tf, candles);
const from = new Date(closed[0].time * 1000).toISOString().slice(0, 10);
const to = new Date(closed[closed.length - 1].time * 1000).toISOString().slice(0, 10);
console.log(`\nBTCUSDT ${tf} — ${closed.length} closed candles (${from} → ${to})`);
console.log('Entry = next candle open after signal close; exit = close H candles later.');
console.log('Returns are GROSS percent; subtract ~0.10–0.20% round-trip costs.\n');

const base: StrategyConfig = { ...DEFAULT_CONFIG, cvdFilter: false };
const configs: [string, StrategyConfig][] = [
  [`A — defaults, no CVD (vol ${base.volumeMultiplier}× + buffer ${base.bufferPct}%, cooldown ${base.cooldown})`, base],
  ['B — raw Donchian (all filters off)', { ...base, volumeFilter: false, bufferFilter: false }],
  ['C — defaults + CVD window 1 (breakout candle flow only)', { ...base, cvdFilter: true, cvdLookback: 1 }],
  ['D — defaults + CVD window 5', { ...base, cvdFilter: true, cvdLookback: 5 }],
  ['E — defaults + CVD window 10', { ...base, cvdFilter: true, cvdLookback: 10 }],
];

for (const [label, cfg] of configs) {
  console.log(`\nConfig ${label}:`);
  runConfig(closed, cfg, holds);
}

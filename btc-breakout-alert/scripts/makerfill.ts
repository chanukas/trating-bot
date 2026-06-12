/**
 * Pre-registered test of Hypothesis H8: maker (retest-limit) entries on the
 * breakout alert signals.
 *
 * Motivation (bridge probe, 2026-06-12): round-trip taker costs are 0.07-0.14R
 * per trade -- the same order as the strategy's entire measured edge. A maker
 * entry cannot pay taker fees or slippage AND fills at the level itself rather
 * than chasing the breakout close, but it misses trades that never retest --
 * and misses are plausibly biased toward the strongest breakouts.
 *
 * Signals: the EXACT production strategy (scanHistory), config = the live
 * alert config: 1h close mode, LB20, volume 1.5x, buffer 0.1%, CVD 5,
 * squeeze 30/12/500 ON. Exits for every variant: stop = 2xATR(14 at signal),
 * target = 3R, stop-first intrabar (the walk-forward-validated structure).
 *
 * Variants (entry mechanics only; ALL parameters FIXED, no grid, no tuning):
 *   baseline -> taker: enter at next candle open, fee 5 bps + slip 2 bps/side.
 *   retest   -> limit resting at the broken Donchian level for K=12 bars after
 *               the signal close; fills (conservatively AT the level, no gap
 *               improvement) iff price trades back to it; otherwise the signal
 *               is MISSED (0R). Maker fee 5 bps, slip 0 on the entry side;
 *               exit side stays taker (stop/target exits cross the spread).
 *   hybrid   -> retest for K bars; if unfilled, taker entry at the K-th bar's
 *               close (never skips a signal).
 *
 * Success criteria COMMITTED BEFORE RUNNING -- keep a variant only if (all of):
 *   (a) pooled net R PER SIGNAL (misses count 0) > baseline's pooled net R
 *       per signal over the full period, AND
 *   (b) (a) also holds in BOTH halves of the period independently, AND
 *   (c) for retest only: fill rate >= 50% (below that it is a different,
 *       mostly-flat strategy and the comparison is not meaningful).
 * Anything less -> H8 fails for that variant, recorded, no further tweaking.
 *
 * Usage: npx tsx scripts/makerfill.ts            (1h, 40000 candles)
 */
import { atrSeries, DEFAULT_CONFIG, scanHistory } from '../src/strategy/breakout';
import type { Candle, StrategyConfig } from '../src/types';

const TAKER_SIDE = 0.0007; // 5 bps fee + 2 bps slip
const MAKER_SIDE = 0.0005; // 5 bps fee, no slip (limit fills at its price)
const ATR_MULT = 2.0;
const TARGET_R = 3.0;
const RETEST_BARS = 12; // FIXED -- pre-registered, never tuned
const MAX_HOLD = 1000;

const CONFIG: StrategyConfig = { ...DEFAULT_CONFIG, mode: 'close', squeezeFilter: true };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function fetchHistory(tf: string, total: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let endTime: number | undefined;
  let dropForming = false;
  let first = true;
  while (out.length < total) {
    const url = new URL('https://data-api.binance.vision/api/v3/klines');
    url.searchParams.set('symbol', 'BTCUSDT');
    url.searchParams.set('interval', tf);
    url.searchParams.set('limit', '1000');
    if (endTime !== undefined) url.searchParams.set('endTime', String(endTime));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text()}`);
    const rows = (await res.json()) as (string | number)[][];
    if (rows.length === 0) break;
    if (first) {
      dropForming = Number(rows[rows.length - 1][6]) > Date.now();
      first = false;
    }
    out.unshift(
      ...rows.map((r) => ({
        time: Math.floor(Number(r[0]) / 1000),
        open: +r[1], high: +r[2], low: +r[3], close: +r[4],
        volume: +r[5], takerBuy: +r[9],
      })),
    );
    endTime = Number(rows[0][0]) - 1;
    if (rows.length < 1000) break;
    await sleep(100);
  }
  if (dropForming) out.pop();
  return out.slice(-total);
}

/** Net R of one position: walk bars from `from`, stop-first, costs included. */
function exitR(
  closed: Candle[], from: number, dir: 1 | -1,
  entry: number, risk: number, entrySideCost: number,
): number {
  const stop = entry - dir * risk;
  const target = entry + dir * TARGET_R * risk;
  let exit = NaN;
  for (let j = from; j < Math.min(closed.length, from + MAX_HOLD); j++) {
    if (dir === 1 ? closed[j].low <= stop : closed[j].high >= stop) { exit = stop; break; }
    if (dir === 1 ? closed[j].high >= target : closed[j].low <= target) { exit = target; break; }
  }
  if (Number.isNaN(exit)) exit = closed[Math.min(closed.length - 1, from + MAX_HOLD - 1)].close;
  const gross = dir * (exit - entry);
  const cost = entry * entrySideCost + exit * TAKER_SIDE; // exits always cross the spread
  return (gross - cost) / risk;
}

interface Outcome { r: number; filled: boolean }

function run(closed: Candle[]): { base: Outcome[]; retest: Outcome[]; hybrid: Outcome[] } {
  const atr = atrSeries(closed, 14);
  const idxByTime = new Map(closed.map((c, i) => [c.time, i]));
  const base: Outcome[] = [];
  const retest: Outcome[] = [];
  const hybrid: Outcome[] = [];

  for (const s of scanHistory(closed, CONFIG)) {
    const i = idxByTime.get(s.candleTime)!;
    if (i + 1 + RETEST_BARS + 2 >= closed.length) continue; // room for the slowest variant
    const dir: 1 | -1 = s.direction === 'up' ? 1 : -1;
    const risk = ATR_MULT * atr[i]; // risk fixed at signal time for every variant
    if (!(risk > 0)) continue;

    // baseline: taker at next open
    base.push({ r: exitR(closed, i + 1, dir, closed[i + 1].open, risk, TAKER_SIDE), filled: true });

    // retest: limit at the broken level for K bars (fill conservatively AT the level)
    const level = s.level;
    let fillBar = -1;
    for (let j = i + 1; j <= i + RETEST_BARS; j++) {
      if (dir === 1 ? closed[j].low <= level : closed[j].high >= level) { fillBar = j; break; }
    }
    if (fillBar >= 0) {
      const r = exitR(closed, fillBar, dir, level, risk, MAKER_SIDE);
      retest.push({ r, filled: true });
      hybrid.push({ r, filled: true });
    } else {
      retest.push({ r: 0, filled: false }); // miss
      hybrid.push({
        r: exitR(closed, i + RETEST_BARS + 1, dir, closed[i + RETEST_BARS].close, risk, TAKER_SIDE),
        filled: true,
      });
    }
  }
  return { base, retest, hybrid };
}

function stats(outcomes: Outcome[]) {
  const filled = outcomes.filter((o) => o.filled);
  const r = filled.map((o) => o.r);
  const wins = r.filter((v) => v > 0);
  const gw = wins.reduce((s, v) => s + v, 0);
  const gl = r.filter((v) => v <= 0).reduce((s, v) => s - v, 0);
  return {
    signals: outcomes.length,
    fillPct: outcomes.length ? (filled.length / outcomes.length) * 100 : NaN,
    winPct: r.length ? (wins.length / r.length) * 100 : NaN,
    expTrade: r.length ? r.reduce((s, v) => s + v, 0) / r.length : NaN,
    expSignal: outcomes.length ? outcomes.reduce((s, o) => s + o.r, 0) / outcomes.length : NaN,
    pf: gl > 0 ? gw / gl : Infinity,
  };
}

function printRow(name: string, s: ReturnType<typeof stats>): void {
  console.log(
    `${name.padEnd(10)} signals=${String(s.signals).padStart(4)}  fill%=${s.fillPct.toFixed(1).padStart(5)}  ` +
      `win%=${s.winPct.toFixed(1).padStart(5)}  expR/trade=${s.expTrade >= 0 ? '+' : ''}${s.expTrade.toFixed(3)}  ` +
      `expR/SIGNAL=${s.expSignal >= 0 ? '+' : ''}${s.expSignal.toFixed(3)}  PF=${s.pf.toFixed(2)}`,
  );
}

const closed = await fetchHistory('1h', 40000);
const from = new Date(closed[0].time * 1000).toISOString().slice(0, 10);
const to = new Date(closed[closed.length - 1].time * 1000).toISOString().slice(0, 10);
console.log(`H8 maker/retest entries — BTCUSDT 1h, ${closed.length} candles (${from} -> ${to})`);
console.log(`Signals: live alert config (LB20+vol+buffer+CVD+squeeze, close mode). Exits 2xATR/3R.`);
console.log(`Retest window K=${RETEST_BARS} bars FIXED. Gates committed in the module docstring.\n`);

const halves = [closed, closed.slice(0, Math.floor(closed.length / 2)), closed.slice(Math.floor(closed.length / 2))];
const labels = ['FULL', 'HALF1', 'HALF2'];
const perSignal: Record<string, number[]> = { base: [], retest: [], hybrid: [] };
const fillRates: number[] = [];

for (let k = 0; k < halves.length; k++) {
  const { base, retest, hybrid } = run(halves[k]);
  console.log(`--- ${labels[k]} ---`);
  const sb = stats(base), sr = stats(retest), sh = stats(hybrid);
  printRow('baseline', sb);
  printRow('retest', sr);
  printRow('hybrid', sh);
  console.log();
  perSignal.base.push(sb.expSignal);
  perSignal.retest.push(sr.expSignal);
  perSignal.hybrid.push(sh.expSignal);
  if (k === 0) fillRates.push(sr.fillPct);
}

console.log('='.repeat(78));
console.log('H8 VERDICT (criteria committed before running — see module docstring)');
console.log('='.repeat(78));
for (const v of ['retest', 'hybrid'] as const) {
  const a = perSignal[v][0] > perSignal.base[0];
  const b = perSignal[v][1] > perSignal.base[1] && perSignal[v][2] > perSignal.base[2];
  const c = v === 'retest' ? fillRates[0] >= 50 : true;
  console.log(`\n${v}:`);
  console.log(`  (a) full-period expR/signal ${perSignal[v][0].toFixed(3)} vs baseline ${perSignal.base[0].toFixed(3)} (must beat) -> ${a ? 'ok' : 'FAIL'}`);
  console.log(`  (b) beats baseline in both halves (${perSignal[v][1].toFixed(3)}/${perSignal.base[1].toFixed(3)}, ${perSignal[v][2].toFixed(3)}/${perSignal.base[2].toFixed(3)}) -> ${b ? 'ok' : 'FAIL'}`);
  if (v === 'retest') console.log(`  (c) fill rate ${fillRates[0].toFixed(1)}% (need >= 50) -> ${c ? 'ok' : 'FAIL'}`);
  console.log(`  H8 ${v}: ${a && b && c ? 'PASS' : 'FAIL -> rejected (no further tweaking)'}`);
}

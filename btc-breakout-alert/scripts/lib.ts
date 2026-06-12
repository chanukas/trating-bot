/**
 * Shared helpers for the headless scripts (watch.ts = live socket,
 * poll.ts = scheduled cron). Config comes from env vars; the alert text is
 * built identically to the web app (useBreakoutEngine.ts) so all three paths
 * emit the same messages.
 */
import { fmtDelta, fmtPrice } from '../src/format';
import {
  DEFAULT_CONFIG,
} from '../src/strategy/breakout';
import type {
  BreakoutMode,
  BreakoutSignal,
  StrategyConfig,
  Timeframe,
} from '../src/types';
import { TIMEFRAMES } from '../src/types';

/** Candle duration in seconds, for freshness math in the cron poller. */
export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14_400,
  '1d': 86_400,
};

export function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  // Unset OR empty (CI passes `${{ vars.X || '' }}` for unset vars) → fallback.
  if (v === undefined || v.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

export function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env ${name}="${v}" is not a number`);
  return n;
}

export function readTimeframe(): Timeframe {
  const raw = (flag('--tf') ?? process.env.TIMEFRAME ?? '1h').trim();
  if (!(TIMEFRAMES as string[]).includes(raw)) {
    throw new Error(`TIMEFRAME="${raw}" must be one of ${TIMEFRAMES.join(', ')}`);
  }
  return raw as Timeframe;
}

export function readConfig(): StrategyConfig {
  const mode = (process.env.MODE ?? DEFAULT_CONFIG.mode).trim() as BreakoutMode;
  if (mode !== 'close' && mode !== 'intracandle') {
    throw new Error(`MODE="${mode}" must be 'close' or 'intracandle'`);
  }
  return {
    lookback: envNum('LOOKBACK', DEFAULT_CONFIG.lookback),
    volumeFilter: envBool('VOLUME_FILTER', DEFAULT_CONFIG.volumeFilter),
    volumeMultiplier: envNum('VOLUME_MULTIPLIER', DEFAULT_CONFIG.volumeMultiplier),
    volumePeriod: envNum('VOLUME_PERIOD', DEFAULT_CONFIG.volumePeriod),
    bufferFilter: envBool('BUFFER_FILTER', DEFAULT_CONFIG.bufferFilter),
    bufferPct: envNum('BUFFER_PCT', DEFAULT_CONFIG.bufferPct),
    cvdFilter: envBool('CVD_FILTER', DEFAULT_CONFIG.cvdFilter),
    cvdLookback: envNum('CVD_LOOKBACK', DEFAULT_CONFIG.cvdLookback),
    squeezeFilter: envBool('SQUEEZE_FILTER', DEFAULT_CONFIG.squeezeFilter),
    squeezePct: envNum('SQUEEZE_PCT', DEFAULT_CONFIG.squeezePct),
    squeezeWithin: envNum('SQUEEZE_WITHIN', DEFAULT_CONFIG.squeezeWithin),
    squeezeLookback: envNum('SQUEEZE_LOOKBACK', DEFAULT_CONFIG.squeezeLookback),
    mode,
    cooldown: envNum('COOLDOWN', DEFAULT_CONFIG.cooldown),
  };
}

/** Telegram credentials from env; prints guidance and exits if missing. */
export function readTelegramCreds(): { token: string; chatId: string } {
  const token = (process.env.TELEGRAM_TOKEN ?? '').trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID ?? '').trim();
  if (!token || !chatId) {
    console.error(
      'Missing Telegram credentials.\n' +
        'Set TELEGRAM_TOKEN and TELEGRAM_CHAT_ID, then run again.\n' +
        'PowerShell:  $env:TELEGRAM_TOKEN="123:abc"; $env:TELEGRAM_CHAT_ID="456"; npm run watch\n' +
        'bash:        TELEGRAM_TOKEN=123:abc TELEGRAM_CHAT_ID=456 npm run watch',
    );
    process.exit(1);
  }
  return { token, chatId };
}

/** Same title/body the web app sends (useBreakoutEngine.ts fireAlert). */
export function buildAlert(signal: BreakoutSignal, timeframe: Timeframe): { title: string; body: string } {
  const arrow = signal.direction === 'up' ? '▲' : '▼';
  const levelWord = signal.direction === 'up' ? 'resistance' : 'support';
  const title = `${arrow} BTC ${signal.direction === 'up' ? 'upside' : 'downside'} breakout (${timeframe})`;
  const ratio = signal.volumeRatio !== null ? `, volume ${signal.volumeRatio.toFixed(2)}× avg` : '';
  const cvd = signal.cvdDelta !== null ? `, CVD ${fmtDelta(signal.cvdDelta)}` : '';
  const sq = signal.volPctile !== null ? `, ATR %ile ${signal.volPctile.toFixed(0)}` : '';
  const body = `${fmtPrice(signal.price)} broke ${levelWord} ${fmtPrice(signal.level)}${ratio}${cvd}${sq}`;
  return { title, body };
}

export const stamp = (): string => new Date().toISOString().slice(11, 19);
export const log = (msg: string): void => console.log(`[${stamp()}] ${msg}`);

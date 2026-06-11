/**
 * Donchian-channel breakout detection.
 *
 * Pure module: no DOM, no network, no React. All functions take explicit
 * inputs and the mutable bits live in a plain StrategyState object the caller
 * owns, so the logic is unit-testable and additional strategies can be added
 * alongside this file later.
 */
import type { BreakoutSignal, Candle, Direction, Levels, StrategyConfig } from '../types';

export const DEFAULT_CONFIG: StrategyConfig = {
  lookback: 20,
  volumeFilter: true,
  volumeMultiplier: 1.5,
  volumePeriod: 20,
  bufferFilter: true,
  bufferPct: 0.1,
  cvdFilter: true,
  cvdLookback: 5,
  mode: 'close',
  cooldown: 10,
};

export interface StrategyState {
  /** Open time (UNIX s) of the last candle that fired, per direction. */
  lastFired: { up: number | null; down: number | null };
}

export function createState(): StrategyState {
  return { lastFired: { up: null, down: null } };
}

/**
 * Donchian levels over the last `lookback` candles of `closed`.
 * The caller must pass only CLOSED candles — the forming candle never
 * contributes to its own levels. Returns null when history is too short.
 */
export function computeLevels(closed: Candle[], lookback: number): Levels | null {
  if (lookback <= 0 || closed.length < lookback) return null;
  let resistance = -Infinity;
  let support = Infinity;
  for (let i = closed.length - lookback; i < closed.length; i++) {
    if (closed[i].high > resistance) resistance = closed[i].high;
    if (closed[i].low < support) support = closed[i].low;
  }
  return { resistance, support };
}

/** Average volume of the last `period` candles, or null when history is too short. */
export function averageVolume(closed: Candle[], period: number): number | null {
  if (period <= 0 || closed.length < period) return null;
  let sum = 0;
  for (let i = closed.length - period; i < closed.length; i++) sum += closed[i].volume;
  return sum / period;
}

/** Signed taker-flow imbalance of one candle: aggressive buys − aggressive sells (base units). */
export function volumeDelta(c: Candle): number {
  return 2 * c.takerBuy - c.volume;
}

/**
 * Net volume delta over the `lookback` most recent candles: `candle` itself
 * plus the `lookback − 1` newest candles of `history` (the CVD change across
 * the window). Null when history is too short or taker data is missing.
 */
export function cvdChange(candle: Candle, history: Candle[], lookback: number): number | null {
  if (lookback <= 0 || history.length < lookback - 1) return null;
  let sum = volumeDelta(candle);
  for (let i = history.length - (lookback - 1); i < history.length; i++) {
    sum += volumeDelta(history[i]);
  }
  return Number.isFinite(sum) ? sum : null;
}

/** Number of candles in `history` newer than the candle that last fired. */
function candlesSinceFire(history: Candle[], lastFiredTime: number): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0 && history[i].time > lastFiredTime; i--) count++;
  return count;
}

/**
 * Evaluate one candle against levels built from `history`.
 *
 * `history` must hold the closed candles strictly BEFORE `candle` (the
 * evaluated candle is never part of its own range or volume average).
 * `isClosed` says whether `candle` is final or still forming; in 'close'
 * mode forming candles never signal.
 *
 * Pure — does not mutate state. When a signal is acted on, the caller must
 * call `markFired` so cooldown/dedup kick in.
 */
export function evaluate(
  candle: Candle,
  history: Candle[],
  state: StrategyState,
  config: StrategyConfig,
  isClosed: boolean,
): BreakoutSignal | null {
  if (config.mode === 'close' && !isClosed) return null;

  const levels = computeLevels(history, config.lookback);
  if (!levels) return null;

  const buffer = config.bufferFilter ? config.bufferPct / 100 : 0;
  const upThreshold = levels.resistance * (1 + buffer);
  const downThreshold = levels.support * (1 - buffer);

  // In intracandle mode the wick counts (price crossed the level at some
  // point); in close mode only the closing price does.
  const upPrice = config.mode === 'intracandle' ? candle.high : candle.close;
  const downPrice = config.mode === 'intracandle' ? candle.low : candle.close;

  const brokeUp = upPrice > upThreshold;
  const brokeDown = downPrice < downThreshold;
  let direction: Direction | null = null;
  if (brokeUp && brokeDown) {
    // Giant candle pierced both sides (intracandle only): side the close leans to wins.
    direction = candle.close >= (upThreshold + downThreshold) / 2 ? 'up' : 'down';
  } else if (brokeUp) {
    direction = 'up';
  } else if (brokeDown) {
    direction = 'down';
  }
  if (!direction) return null;

  // Cooldown (per direction, by candle time so REST backfills can't skew it).
  const last = state.lastFired[direction];
  if (last !== null) {
    if (candle.time === last) return null; // this candle already fired
    if (candlesSinceFire(history, last) < config.cooldown) return null;
  }

  // Volume must be strictly greater than multiplier × average. When history
  // is too short to compute the average, the filter conservatively blocks.
  const avg = averageVolume(history, config.volumePeriod);
  const volumeRatio = avg !== null && avg > 0 ? candle.volume / avg : null;
  if (config.volumeFilter && (volumeRatio === null || volumeRatio <= config.volumeMultiplier)) {
    return null;
  }

  // CVD filter: net aggressive flow over the window must point the same way
  // as the breakout (strictly — neutral flow does not confirm). Blocks
  // conservatively when the window can't be computed.
  const cvdDelta = cvdChange(candle, history, config.cvdLookback);
  if (config.cvdFilter) {
    if (cvdDelta === null) return null;
    if (direction === 'up' ? cvdDelta <= 0 : cvdDelta >= 0) return null;
  }

  return {
    direction,
    price: direction === 'up' ? upPrice : downPrice,
    level: direction === 'up' ? levels.resistance : levels.support,
    volumeRatio,
    cvdDelta,
    candleTime: candle.time,
  };
}

/** Record that `signal` was acted on, starting its direction's cooldown. */
export function markFired(state: StrategyState, signal: BreakoutSignal): void {
  state.lastFired[signal.direction] = signal.candleTime;
}

/**
 * Replay the strategy over a finished candle series (oldest → newest),
 * firing and marking as the live engine would. Used to paint markers for
 * breakouts that happened before the app was opened, and by tests.
 */
export function scanHistory(closed: Candle[], config: StrategyConfig): BreakoutSignal[] {
  const state = createState();
  const signals: BreakoutSignal[] = [];
  for (let i = 0; i < closed.length; i++) {
    const signal = evaluate(closed[i], closed.slice(0, i), state, config, true);
    if (signal) {
      signals.push(signal);
      markFired(state, signal);
    }
  }
  return signals;
}

import { describe, expect, it } from 'vitest';
import type { Candle, StrategyConfig } from '../types';
import { computeLevels, createState, cvdChange, evaluate, markFired, scanHistory, volumeDelta } from './breakout';

const T0 = 1_700_000_000;
const STEP = 60;

/** n candles ranging 90–100 (resistance 100, support 90), volume 10, neutral flow. */
function rangeCandles(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: T0 + i * STEP,
    open: 95,
    high: 100,
    low: 90,
    close: 95,
    volume: 10,
    takerBuy: 5, // delta 0
  }));
}

/** Next candle after `history`, defaults inside the range. */
function next(history: Candle[], over: Partial<Candle> = {}): Candle {
  const last = history[history.length - 1];
  return {
    time: last.time + STEP,
    open: 95,
    high: 100,
    low: 90,
    close: 95,
    volume: 10,
    takerBuy: 5,
    ...over,
  };
}

/** Filters off by default so each test enables exactly what it exercises. */
const base: StrategyConfig = {
  lookback: 20,
  volumeFilter: false,
  volumeMultiplier: 1.5,
  volumePeriod: 20,
  bufferFilter: false,
  bufferPct: 0.1,
  cvdFilter: false,
  cvdLookback: 5,
  mode: 'close',
  cooldown: 10,
};

describe('computeLevels', () => {
  it('returns Donchian high/low of the lookback window', () => {
    expect(computeLevels(rangeCandles(20), 20)).toEqual({ resistance: 100, support: 90 });
  });

  it('returns null when history is shorter than the lookback', () => {
    expect(computeLevels(rangeCandles(19), 20)).toBeNull();
    expect(computeLevels(rangeCandles(20), 0)).toBeNull();
  });

  it('only uses the last N candles', () => {
    const candles = [...rangeCandles(10), ...rangeCandles(5).map((c, i) => ({
      ...c, time: T0 + (10 + i) * STEP, high: 98, low: 92,
    }))];
    expect(computeLevels(candles, 5)).toEqual({ resistance: 98, support: 92 });
  });
});

describe('upside breakout', () => {
  it('fires when the candle closes above resistance', () => {
    const history = rangeCandles(20);
    const c = next(history, { close: 101, high: 101.5 });
    const signal = evaluate(c, history, createState(), base, true);
    expect(signal).toMatchObject({ direction: 'up', level: 100, price: 101, candleTime: c.time });
  });

  it('does not fire when the close is at or inside the level', () => {
    const history = rangeCandles(20);
    expect(evaluate(next(history, { close: 99 }), history, createState(), base, true)).toBeNull();
    expect(evaluate(next(history, { close: 100 }), history, createState(), base, true)).toBeNull();
  });

  it('ignores a wick above resistance in close mode', () => {
    const history = rangeCandles(20);
    const c = next(history, { high: 102, close: 99 });
    expect(evaluate(c, history, createState(), base, true)).toBeNull();
  });

  it('excludes the evaluated candle from its own levels', () => {
    const history = rangeCandles(20);
    const c = next(history, { high: 105, close: 101 });
    const signal = evaluate(c, history, createState(), base, true);
    expect(signal?.level).toBe(100); // not raised to 105 by its own high
  });
});

describe('downside breakout', () => {
  it('fires when the candle closes below support', () => {
    const history = rangeCandles(20);
    const c = next(history, { close: 89, low: 88.5 });
    const signal = evaluate(c, history, createState(), base, true);
    expect(signal).toMatchObject({ direction: 'down', level: 90, price: 89 });
  });

  it('does not fire when the close holds the level', () => {
    const history = rangeCandles(20);
    expect(evaluate(next(history, { close: 90 }), history, createState(), base, true)).toBeNull();
  });
});

describe('buffer filter', () => {
  const cfg: StrategyConfig = { ...base, bufferFilter: true, bufferPct: 0.1 };

  it('rejects a close barely beyond the level', () => {
    const history = rangeCandles(20);
    // Upside threshold is 100 × 1.001 = 100.1
    expect(evaluate(next(history, { close: 100.05, high: 100.05 }), history, createState(), cfg, true)).toBeNull();
    // Downside threshold is 90 × 0.999 = 89.91
    expect(evaluate(next(history, { close: 89.95, low: 89.95 }), history, createState(), cfg, true)).toBeNull();
  });

  it('fires once the close clears the buffer', () => {
    const history = rangeCandles(20);
    const up = evaluate(next(history, { close: 100.2, high: 100.2 }), history, createState(), cfg, true);
    expect(up?.direction).toBe('up');
    const down = evaluate(next(history, { close: 89.8, low: 89.8 }), history, createState(), cfg, true);
    expect(down?.direction).toBe('down');
  });
});

describe('volume filter', () => {
  const cfg: StrategyConfig = { ...base, volumeFilter: true, volumeMultiplier: 1.5 };

  it('blocks a breakout on weak volume', () => {
    const history = rangeCandles(20); // average volume 10
    const c = next(history, { close: 101, high: 101, volume: 12 }); // 1.2× < 1.5×
    expect(evaluate(c, history, createState(), cfg, true)).toBeNull();
  });

  it('requires strictly more than multiplier × average', () => {
    const history = rangeCandles(20);
    const c = next(history, { close: 101, high: 101, volume: 15 }); // exactly 1.5×
    expect(evaluate(c, history, createState(), cfg, true)).toBeNull();
  });

  it('passes a breakout on strong volume and reports the ratio', () => {
    const history = rangeCandles(20);
    const c = next(history, { close: 101, high: 101, volume: 16 });
    const signal = evaluate(c, history, createState(), cfg, true);
    expect(signal?.direction).toBe('up');
    expect(signal?.volumeRatio).toBeCloseTo(1.6);
  });

  it('blocks when history is too short for the volume average', () => {
    const history = rangeCandles(20);
    const c = next(history, { close: 101, high: 101, volume: 100 });
    expect(evaluate(c, history, createState(), { ...cfg, volumePeriod: 30 }, true)).toBeNull();
  });

  it('still reports the ratio when the filter is off', () => {
    const history = rangeCandles(20);
    const c = next(history, { close: 101, high: 101, volume: 25 });
    expect(evaluate(c, history, createState(), base, true)?.volumeRatio).toBeCloseTo(2.5);
  });
});

describe('cooldown', () => {
  it('suppresses same-direction signals for `cooldown` candles, then re-arms', () => {
    // 20 range candles, then 5 candles closing 101, 102, … (highs = closes).
    // Every one of them closes above the rolling resistance, so without a
    // cooldown all 5 would fire.
    const candles = rangeCandles(20);
    for (let i = 0; i < 5; i++) {
      candles.push(next(candles, { close: 101 + i, high: 101 + i }));
    }
    const signals = scanHistory(candles, { ...base, cooldown: 3 });
    expect(signals.map((s) => (s.candleTime - T0) / STEP)).toEqual([20, 24]); // 3 candles silenced
  });

  it('cooldown of 0 lets consecutive candles fire', () => {
    const candles = rangeCandles(20);
    candles.push(next(candles, { close: 101, high: 101 }));
    candles.push(next(candles, { close: 102, high: 102 }));
    const signals = scanHistory(candles, { ...base, cooldown: 0 });
    expect(signals).toHaveLength(2);
  });

  it('is tracked per direction', () => {
    const candles = rangeCandles(20);
    candles.push(next(candles, { close: 101, high: 101 }));
    candles.push(next(candles, { close: 88, low: 88 }));
    const signals = scanHistory(candles, { ...base, cooldown: 10 });
    expect(signals.map((s) => s.direction)).toEqual(['up', 'down']);
  });
});

describe('CVD filter', () => {
  // Window of 1 = only the breakout candle's own taker flow.
  const cfg: StrategyConfig = { ...base, cvdFilter: true, cvdLookback: 1 };

  it('computes volume delta as buys minus sells', () => {
    expect(volumeDelta({ time: 0, open: 0, high: 0, low: 0, close: 0, volume: 10, takerBuy: 8 })).toBe(6);
    expect(volumeDelta({ time: 0, open: 0, high: 0, low: 0, close: 0, volume: 10, takerBuy: 2 })).toBe(-6);
  });

  it('blocks an up-breakout without net buying aggression', () => {
    const history = rangeCandles(20);
    const c = next(history, { close: 101, high: 101, takerBuy: 2 }); // delta −6
    expect(evaluate(c, history, createState(), cfg, true)).toBeNull();
  });

  it('passes an up-breakout on aggressive buying and reports the delta', () => {
    const history = rangeCandles(20);
    const c = next(history, { close: 101, high: 101, takerBuy: 9 }); // delta +8
    const signal = evaluate(c, history, createState(), cfg, true);
    expect(signal?.direction).toBe('up');
    expect(signal?.cvdDelta).toBeCloseTo(8);
  });

  it('mirrors for the downside', () => {
    const history = rangeCandles(20);
    const buying = next(history, { close: 89, low: 89, takerBuy: 8 }); // delta +6
    expect(evaluate(buying, history, createState(), cfg, true)).toBeNull();
    const selling = next(history, { close: 89, low: 89, takerBuy: 1 }); // delta −8
    expect(evaluate(selling, history, createState(), cfg, true)?.cvdDelta).toBeCloseTo(-8);
  });

  it('neutral flow does not confirm', () => {
    const history = rangeCandles(20);
    const c = next(history, { close: 101, high: 101, takerBuy: 5 }); // delta 0
    expect(evaluate(c, history, createState(), cfg, true)).toBeNull();
  });

  it('sums net flow over the lookback window', () => {
    const wide: StrategyConfig = { ...base, cvdFilter: true, cvdLookback: 3 };
    // Last two history candles sold hard (−6 each); breakout candle bought +8.
    const history = rangeCandles(20);
    history[18] = { ...history[18], takerBuy: 2 };
    history[19] = { ...history[19], takerBuy: 2 };
    const c = next(history, { close: 101, high: 101, takerBuy: 9 });
    expect(cvdChange(c, history, 3)).toBeCloseTo(-4);
    expect(evaluate(c, history, createState(), wide, true)).toBeNull();
    // With buying pressure leading in instead, the same breakout confirms.
    history[18] = { ...history[18], takerBuy: 8 };
    history[19] = { ...history[19], takerBuy: 8 };
    const signal = evaluate(c, history, createState(), wide, true);
    expect(signal?.cvdDelta).toBeCloseTo(20);
  });

  it('blocks when history is shorter than the window', () => {
    const history = rangeCandles(20);
    const c = next(history, { close: 101, high: 101, takerBuy: 9 });
    expect(evaluate(c, history, createState(), { ...base, cvdFilter: true, cvdLookback: 25 }, true)).toBeNull();
  });
});

describe('intracandle mode', () => {
  const cfg: StrategyConfig = { ...base, mode: 'intracandle' };

  it('fires as soon as the wick crosses the level, before the close', () => {
    const history = rangeCandles(20);
    const forming = next(history, { high: 100.5, close: 99.8 });
    const signal = evaluate(forming, history, createState(), cfg, false);
    expect(signal).toMatchObject({ direction: 'up', price: 100.5, level: 100 });
  });

  it('fires only once per candle as ticks keep arriving', () => {
    const history = rangeCandles(20);
    const state = createState();
    const first = evaluate(next(history, { high: 100.5, close: 100.4 }), history, state, cfg, false);
    expect(first).not.toBeNull();
    markFired(state, first!);
    // Later tick of the SAME candle, even higher — must stay silent.
    const again = evaluate(next(history, { high: 101, close: 100.9 }), history, state, cfg, false);
    expect(again).toBeNull();
  });

  it('also evaluates closed candles (covers ticks lost to a disconnect)', () => {
    const history = rangeCandles(20);
    const c = next(history, { high: 101, close: 99 });
    expect(evaluate(c, history, createState(), cfg, true)?.direction).toBe('up');
  });

  it('close mode never fires on a forming candle', () => {
    const history = rangeCandles(20);
    const forming = next(history, { close: 105, high: 105 });
    expect(evaluate(forming, history, createState(), base, false)).toBeNull();
  });
});

describe('guards', () => {
  it('returns null when history is shorter than the lookback', () => {
    const history = rangeCandles(10);
    const c = next(history, { close: 101, high: 101 });
    expect(evaluate(c, history, createState(), base, true)).toBeNull();
  });
});

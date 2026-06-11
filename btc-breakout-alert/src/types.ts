/** One OHLCV candle. `time` is the candle OPEN time in UNIX seconds (UTC). */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Taker-buy (aggressor bought) base volume; volume delta = 2·takerBuy − volume. */
  takerBuy: number;
}

export type Direction = 'up' | 'down';

/** 'close' = signal only on candle close; 'intracandle' = signal as soon as price crosses the level. */
export type BreakoutMode = 'close' | 'intracandle';

export type Timeframe = '5m' | '15m' | '1h' | '4h' | '1d';

export const TIMEFRAMES: Timeframe[] = ['5m', '15m', '1h', '4h', '1d'];

export interface StrategyConfig {
  /** Donchian lookback: levels = highest high / lowest low of the last N closed candles. */
  lookback: number;
  volumeFilter: boolean;
  /** Breakout candle volume must exceed multiplier × average volume. */
  volumeMultiplier: number;
  /** Number of closed candles in the volume average. */
  volumePeriod: number;
  bufferFilter: boolean;
  /** Percent beyond the level the price must reach, e.g. 0.1 = 0.1%. */
  bufferPct: number;
  /** Require net taker flow (CVD change) to align with the breakout direction. */
  cvdFilter: boolean;
  /** Candles in the CVD window, breakout candle included. */
  cvdLookback: number;
  mode: BreakoutMode;
  /** After a signal, suppress same-direction signals for this many candles. */
  cooldown: number;
}

export interface Levels {
  resistance: number;
  support: number;
}

export interface BreakoutSignal {
  direction: Direction;
  /** Price that triggered the signal (close in close mode, crossing extreme in intracandle mode). */
  price: number;
  /** The level that was broken. */
  level: number;
  /** Breakout candle volume / average volume; null when not enough history to compute. */
  volumeRatio: number | null;
  /** Net volume delta (taker buys − sells, base units) over the CVD window; null when not computable. */
  cvdDelta: number | null;
  /** Open time (UNIX seconds) of the breakout candle. */
  candleTime: number;
}

export interface AlertRecord extends BreakoutSignal {
  id: number;
  /** Wall-clock time the alert fired (ms). */
  firedAt: number;
  timeframe: Timeframe;
  mode: BreakoutMode;
}

export type ConnStatus = 'connecting' | 'live' | 'reconnecting' | 'error';

export interface AppSettings extends StrategyConfig {
  timeframe: Timeframe;
  soundOn: boolean;
  telegramToken: string;
  telegramChatId: string;
}

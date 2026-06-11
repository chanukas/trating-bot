/**
 * The live engine: streams Binance klines, runs the breakout strategy on
 * every update, and fans signals out to the alert channels and React state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fmtDelta, fmtPrice } from '../format';
import { fetchKlines, KlineSocket } from '../services/binance';
import {
  playBreakoutSound,
  sendTelegram,
  showBrowserNotification,
} from '../services/notify';
import {
  computeLevels,
  createState,
  evaluate,
  markFired,
  scanHistory,
  type StrategyState,
} from '../strategy/breakout';
import type {
  AlertRecord,
  AppSettings,
  BreakoutSignal,
  Candle,
  ConnStatus,
  Levels,
  StrategyConfig,
} from '../types';

/** Cap on closed candles kept in memory during long sessions. */
const MAX_CANDLES = 2000;

export interface ChartSeed {
  candles: Candle[];
  /** Bumped whenever the full series should be redrawn (load, backfill). */
  version: number;
}

export interface EngineView {
  status: ConnStatus;
  /** Set when the initial history load failed — the app has no data at all. */
  fatalError: string | null;
  /** Non-fatal warning (failed backfill, failed Telegram send …). */
  notice: string | null;
  dismissNotice: () => void;
  price: number | null;
  levels: Levels | null;
  alerts: AlertRecord[];
  /** Breakouts detected in the loaded history (chart markers only, no alerts). */
  historicalSignals: BreakoutSignal[];
  seed: ChartSeed;
  /** Latest bar (forming or just closed) for incremental chart updates. */
  lastBar: Candle | null;
  retry: () => void;
}

function toStrategyConfig(s: AppSettings): StrategyConfig {
  return {
    lookback: s.lookback,
    volumeFilter: s.volumeFilter,
    volumeMultiplier: s.volumeMultiplier,
    volumePeriod: s.volumePeriod,
    bufferFilter: s.bufferFilter,
    bufferPct: s.bufferPct,
    cvdFilter: s.cvdFilter,
    cvdLookback: s.cvdLookback,
    mode: s.mode,
    cooldown: s.cooldown,
  };
}

export function useBreakoutEngine(settings: AppSettings): EngineView {
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const [levels, setLevels] = useState<Levels | null>(null);
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [historicalSignals, setHistoricalSignals] = useState<BreakoutSignal[]>([]);
  const [seed, setSeed] = useState<ChartSeed>({ candles: [], version: 0 });
  const [lastBar, setLastBar] = useState<Candle | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const closedRef = useRef<Candle[]>([]);
  const formingRef = useRef<Candle | null>(null);
  const stateRef = useRef<StrategyState>(createState());
  const seedVersionRef = useRef(0);
  const alertIdRef = useRef(0);

  // Live settings for the stream callbacks, without re-subscribing on every change.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const dismissNotice = useCallback(() => setNotice(null), []);
  const retry = useCallback(() => setReloadNonce((n) => n + 1), []);

  useEffect(() => {
    const timeframe = settings.timeframe;
    let cancelled = false;
    let socket: KlineSocket | null = null;

    const publishSeed = () => {
      const candles = formingRef.current
        ? [...closedRef.current, formingRef.current]
        : [...closedRef.current];
      seedVersionRef.current += 1;
      setSeed({ candles, version: seedVersionRef.current });
      const last = candles[candles.length - 1] ?? null;
      setLastBar(last);
      setPrice(last ? last.close : null);
      setLevels(computeLevels(closedRef.current, settingsRef.current.lookback));
    };

    const fireAlert = (signal: BreakoutSignal) => {
      markFired(stateRef.current, signal);
      const s = settingsRef.current;
      const record: AlertRecord = {
        ...signal,
        id: ++alertIdRef.current,
        firedAt: Date.now(),
        timeframe: s.timeframe,
        mode: s.mode,
      };
      setAlerts((prev) => [record, ...prev].slice(0, 200));

      const arrow = signal.direction === 'up' ? '▲' : '▼';
      const levelWord = signal.direction === 'up' ? 'resistance' : 'support';
      const title = `${arrow} BTC ${signal.direction === 'up' ? 'upside' : 'downside'} breakout (${s.timeframe})`;
      const ratio = signal.volumeRatio !== null ? `, volume ${signal.volumeRatio.toFixed(2)}× avg` : '';
      const cvd = signal.cvdDelta !== null ? `, CVD ${fmtDelta(signal.cvdDelta)}` : '';
      const body = `${fmtPrice(signal.price)} broke ${levelWord} ${fmtPrice(signal.level)}${ratio}${cvd}`;

      showBrowserNotification(title, body);
      if (s.soundOn) playBreakoutSound(signal.direction);
      if (s.telegramToken.trim() && s.telegramChatId.trim()) {
        sendTelegram(s.telegramToken, s.telegramChatId, `${title}\n${body}`).catch((err: unknown) => {
          setNotice(err instanceof Error ? err.message : 'Telegram send failed');
        });
      }
    };

    const handleKline = ({ candle, isClosed }: { candle: Candle; isClosed: boolean }) => {
      const cfg = toStrategyConfig(settingsRef.current);
      if (isClosed) {
        const last = closedRef.current[closedRef.current.length - 1];
        if (!last || candle.time > last.time) {
          // Evaluate BEFORE appending — a candle is never part of its own range.
          const signal = evaluate(candle, closedRef.current, stateRef.current, cfg, true);
          if (signal) fireAlert(signal);
          closedRef.current = [...closedRef.current, candle].slice(-MAX_CANDLES);
          setLevels(computeLevels(closedRef.current, cfg.lookback));
        }
        formingRef.current = null;
      } else {
        formingRef.current = candle;
        if (cfg.mode === 'intracandle') {
          const signal = evaluate(candle, closedRef.current, stateRef.current, cfg, false);
          if (signal) fireAlert(signal);
        }
      }
      setPrice(candle.close);
      setLastBar(candle);
    };

    const backfill = async () => {
      try {
        const history = await fetchKlines(settingsRef.current.timeframe);
        if (cancelled) return;
        closedRef.current = history.closed;
        formingRef.current = history.forming;
        publishSeed();
      } catch (err) {
        if (cancelled) return;
        setNotice(
          `Backfill after reconnect failed (${err instanceof Error ? err.message : err}). ` +
            'Live updates continue; candles closed while offline may be missing.',
        );
      }
    };

    (async () => {
      setStatus('connecting');
      setFatalError(null);
      try {
        const history = await fetchKlines(timeframe);
        if (cancelled) return;
        closedRef.current = history.closed;
        formingRef.current = history.forming;
        stateRef.current = createState();
        publishSeed();

        socket = new KlineSocket(timeframe, {
          onKline: handleKline,
          onStatus: (s) => {
            if (!cancelled) setStatus(s);
          },
          onOpen: ({ reconnect }) => {
            // Refetch history after every reconnect to fill candles missed offline.
            if (reconnect) void backfill();
          },
        });
        socket.connect();
      } catch (err) {
        if (cancelled) return;
        setStatus('error');
        setFatalError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      socket?.dispose();
    };
  }, [settings.timeframe, reloadNonce]);

  // Re-derive levels and historical breakout markers when the strategy
  // parameters change or the series is (re)loaded.
  const strategyKey = JSON.stringify(toStrategyConfig(settings));
  useEffect(() => {
    const cfg = toStrategyConfig(settingsRef.current);
    setLevels(computeLevels(closedRef.current, cfg.lookback));
    setHistoricalSignals(scanHistory(closedRef.current, cfg));
  }, [strategyKey, seed.version]);

  return useMemo(
    () => ({
      status,
      fatalError,
      notice,
      dismissNotice,
      price,
      levels,
      alerts,
      historicalSignals,
      seed,
      lastBar,
      retry,
    }),
    [status, fatalError, notice, dismissNotice, price, levels, alerts, historicalSignals, seed, lastBar, retry],
  );
}

/**
 * Binance public market data: REST klines + live kline WebSocket.
 * No API key required for either.
 */
import type { Candle, ConnStatus, Timeframe } from '../types';

export const SYMBOL = 'BTCUSDT';

// The browser uses api.binance.com directly. Headless runners in geo-blocked
// clouds (e.g. GitHub Actions on Azure US, which gets HTTP 451) can point at
// Binance's public market-data mirror via BINANCE_REST_BASE — same /api/v3
// schema, no geo restriction. The typeof guard keeps this safe in the browser
// build, where `process` is undefined.
const REST_BASE =
  (typeof process !== 'undefined' && process.env?.BINANCE_REST_BASE?.trim()) ||
  'https://api.binance.com';
// Binance exposes the same stream on both ports; alternating between them on
// reconnect helps when a proxy/firewall blocks the non-standard one.
const WS_HOSTS = ['wss://stream.binance.com:9443', 'wss://stream.binance.com:443'];

const MAX_RECONNECT_DELAY_MS = 30_000;

export interface KlineUpdate {
  candle: Candle;
  isClosed: boolean;
}

export interface KlineHistory {
  closed: Candle[];
  /** The currently forming candle, when Binance included it (it almost always does). */
  forming: Candle | null;
}

/**
 * Fetch up to `limit` candles. Binance returns oldest → newest and includes
 * the still-forming candle as the last element; it is split off so strategy
 * code only ever sees closed candles in `closed`.
 */
export async function fetchKlines(timeframe: Timeframe, limit = 1000): Promise<KlineHistory> {
  const url = `${REST_BASE}/api/v3/klines?symbol=${SYMBOL}&interval=${timeframe}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Binance REST ${res.status}: ${body.slice(0, 200) || res.statusText}`);
  }
  const rows = (await res.json()) as (string | number)[][];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Binance REST returned no candles');
  }

  const candles = rows.map((r) => ({
    time: Math.floor(Number(r[0]) / 1000),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
    takerBuy: Number(r[9]),
  }));

  // The last row is the forming candle iff its close time is still in the future.
  const lastCloseMs = Number(rows[rows.length - 1][6]);
  if (lastCloseMs > Date.now()) {
    return { closed: candles.slice(0, -1), forming: candles[candles.length - 1] };
  }
  return { closed: candles, forming: null };
}

export interface KlineSocketHandlers {
  onKline: (update: KlineUpdate) => void;
  onStatus: (status: ConnStatus) => void;
  /** Fires on every successful (re)connect; `reconnect` is false for the first one. */
  onOpen: (info: { reconnect: boolean }) => void;
}

/**
 * Auto-reconnecting kline stream for one symbol/timeframe.
 * Exponential backoff 1s → 30s; never reconnects after dispose().
 */
export class KlineSocket {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private everConnected = false;
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly timeframe: Timeframe,
    private readonly handlers: KlineSocketHandlers,
  ) {}

  connect(): void {
    if (this.disposed) return;
    const host = WS_HOSTS[this.attempts % WS_HOSTS.length];
    const url = `${host}/ws/${SYMBOL.toLowerCase()}@kline_${this.timeframe}`;
    this.handlers.onStatus(this.everConnected || this.attempts > 0 ? 'reconnecting' : 'connecting');

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      if (ws !== this.ws || this.disposed) return;
      const reconnect = this.everConnected;
      this.everConnected = true;
      this.attempts = 0;
      this.handlers.onStatus('live');
      this.handlers.onOpen({ reconnect });
    };

    ws.onmessage = (event) => {
      if (ws !== this.ws || this.disposed) return;
      let msg: { e?: string; k?: Record<string, string | number | boolean> };
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return; // malformed frame — ignore
      }
      if (msg.e !== 'kline' || !msg.k) return;
      const k = msg.k;
      this.handlers.onKline({
        candle: {
          time: Math.floor(Number(k.t) / 1000),
          open: Number(k.o),
          high: Number(k.h),
          low: Number(k.l),
          close: Number(k.c),
          volume: Number(k.v),
          takerBuy: Number(k.V), // taker-buy base volume; NaN-safe downstream
        },
        isClosed: k.x === true,
      });
    };

    // Binance drops connections roughly every 24h; errors also end in close.
    ws.onclose = () => {
      if (ws !== this.ws || this.disposed) return;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* the close event that follows drives the reconnect */
    };
  }

  private scheduleReconnect(): void {
    this.attempts += 1;
    const delay = Math.min(1000 * 2 ** (this.attempts - 1), MAX_RECONNECT_DELAY_MS);
    this.handlers.onStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      try {
        this.ws.close();
      } catch {
        /* already closed */
      }
      this.ws = null;
    }
  }
}

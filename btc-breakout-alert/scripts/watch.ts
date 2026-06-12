/**
 * Headless background watcher — sends Telegram breakout alerts with NO browser open.
 *
 * Runs the EXACT production strategy (src/strategy/breakout.ts) over the same
 * live Binance kline stream the web app uses (src/services/binance.ts), and
 * fires Telegram messages identical to the app's (src/services/notify.ts).
 * Leave it running on an always-on host and you get alerts whether or not the
 * web app is open.
 *
 * Requires Node 22+ (global WebSocket + fetch). No API key needed for Binance;
 * Telegram bot token + chat id come from environment variables.
 *
 * Usage (PowerShell):
 *   $env:TELEGRAM_TOKEN="123:abc"; $env:TELEGRAM_CHAT_ID="456"; npm run watch
 *   $env:TIMEFRAME="4h"; npm run watch              # override timeframe
 *
 * Usage (bash):
 *   TELEGRAM_TOKEN=123:abc TELEGRAM_CHAT_ID=456 npm run watch
 *   npx tsx scripts/watch.ts --tf 1h
 *
 * Strategy parameters default to DEFAULT_CONFIG (same as the app). Override any
 * of them via env vars (see lib.ts readConfig), e.g. LOOKBACK, VOLUME_MULTIPLIER,
 * MODE, COOLDOWN, SQUEEZE_FILTER=true, etc.
 *
 * For a host that can't run a long-lived process (e.g. GitHub Actions cron),
 * use scripts/poll.ts instead.
 */
import { fmtPrice } from '../src/format';
import { fetchKlines, KlineSocket, SYMBOL } from '../src/services/binance';
import { sendTelegram } from '../src/services/notify';
import { computeLevels, createState, evaluate, markFired } from '../src/strategy/breakout';
import type { BreakoutSignal, Candle } from '../src/types';
import { buildAlert, log, readConfig, readTelegramCreds, readTimeframe } from './lib';

const MAX_CANDLES = 2000;

const { token, chatId } = readTelegramCreds();
const timeframe = readTimeframe();
const config = readConfig();

const closed: Candle[] = [];
let forming: Candle | null = null;
const state = createState();

// Mirror of the web app's fireAlert (useBreakoutEngine.ts).
function fireAlert(signal: BreakoutSignal): void {
  markFired(state, signal);
  const { title, body } = buildAlert(signal, timeframe);
  log(`ALERT  ${title} — ${body}`);
  sendTelegram(token, chatId, `${title}\n${body}`).catch((err: unknown) => {
    log(`Telegram send FAILED: ${err instanceof Error ? err.message : String(err)}`);
  });
}

// Mirror of useBreakoutEngine.handleKline.
function handleKline({ candle, isClosed }: { candle: Candle; isClosed: boolean }): void {
  if (isClosed) {
    const last = closed[closed.length - 1];
    if (!last || candle.time > last.time) {
      // Evaluate BEFORE appending — a candle is never part of its own range.
      const signal = evaluate(candle, closed, state, config, true);
      if (signal) fireAlert(signal);
      closed.push(candle);
      if (closed.length > MAX_CANDLES) closed.splice(0, closed.length - MAX_CANDLES);
      const lv = computeLevels(closed, config.lookback);
      if (lv) log(`close ${fmtPrice(candle.close)}  R ${fmtPrice(lv.resistance)} / S ${fmtPrice(lv.support)}`);
    }
    forming = null;
  } else {
    forming = candle;
    if (config.mode === 'intracandle') {
      const signal = evaluate(candle, closed, state, config, false);
      if (signal) fireAlert(signal);
    }
  }
}

async function backfill(): Promise<void> {
  try {
    const history = await fetchKlines(timeframe);
    closed.length = 0;
    closed.push(...history.closed);
    forming = history.forming;
    log(`backfilled ${closed.length} candles after reconnect`);
  } catch (err) {
    log(`backfill after reconnect FAILED (${err instanceof Error ? err.message : err}); live updates continue`);
  }
}

async function main(): Promise<void> {
  const filters = [
    config.volumeFilter && `vol ${config.volumeMultiplier}×`,
    config.bufferFilter && `buffer ${config.bufferPct}%`,
    config.cvdFilter && `CVD ${config.cvdLookback}`,
    config.squeezeFilter && `squeeze ≤${config.squeezePct}%`,
  ].filter(Boolean);
  log(
    `watching ${SYMBOL} ${timeframe} — mode ${config.mode}, lookback ${config.lookback}, ` +
      `cooldown ${config.cooldown}, filters: ${filters.join(' + ') || 'none'}`,
  );

  const history = await fetchKlines(timeframe);
  closed.push(...history.closed);
  forming = history.forming;
  log(`loaded ${closed.length} closed candles; last close ${fmtPrice(closed[closed.length - 1].close)}`);
  void forming; // kept in sync for parity; not otherwise read headless

  const socket = new KlineSocket(timeframe, {
    onKline: handleKline,
    onStatus: (s) => log(`status: ${s}`),
    onOpen: ({ reconnect }) => {
      if (reconnect) void backfill();
    },
  });
  socket.connect();

  const shutdown = () => {
    log('shutting down');
    socket.dispose();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

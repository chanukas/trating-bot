/**
 * Scheduled one-shot poller — for hosts that can't run a long-lived process
 * (GitHub Actions cron, any cron job). Fetches recent klines, replays the EXACT
 * production strategy, and sends a Telegram alert IFF the most-recently-closed
 * candle is a fresh breakout. Then exits.
 *
 * Stateless de-duplication (no database needed): a cron run only alerts when the
 * latest closed candle closed within POLL_WINDOW_MIN minutes ago. Keep
 * POLL_WINDOW_MIN equal to your cron interval so each candle fires at most once.
 * Trade-off: if a scheduled run is dropped/badly delayed (GitHub Actions cron is
 * best-effort), that candle's alert is missed rather than duplicated.
 *
 * Close-mode only by design (a poller can't see intra-candle crossings between
 * runs). The cron interval must be <= the timeframe, so default to 1h/4h/1d.
 *
 * Requires Node 22+ (global fetch). Env vars: TELEGRAM_TOKEN, TELEGRAM_CHAT_ID
 * (required), TIMEFRAME (default 1h), POLL_WINDOW_MIN (default 15), plus the same
 * strategy overrides as watch.ts (LOOKBACK, VOLUME_MULTIPLIER, …).
 */
import { fetchKlines } from '../src/services/binance';
import { sendTelegram } from '../src/services/notify';
import { scanHistory } from '../src/strategy/breakout';
import {
  buildAlert,
  envNum,
  log,
  readConfig,
  readTelegramCreds,
  readTimeframe,
  TIMEFRAME_SECONDS,
} from './lib';

async function main(): Promise<void> {
  const { token, chatId } = readTelegramCreds();
  const timeframe = readTimeframe();
  const config = readConfig();
  const windowMin = envNum('POLL_WINDOW_MIN', 15);

  if (config.mode !== 'close') {
    log(`note: MODE=${config.mode} ignored — the poller is close-mode only.`);
  }

  const { closed } = await fetchKlines(timeframe);
  if (closed.length === 0) {
    log('no closed candles returned; nothing to do');
    return;
  }

  const latest = closed[closed.length - 1];
  // Replay with full cooldown/filter parity; the latest candle fires only if it
  // would have fired live.
  const signal = scanHistory(closed, { ...config, mode: 'close' }).find((s) => s.candleTime === latest.time);
  if (!signal) {
    log(`no breakout on latest closed candle (${timeframe}); checked ${closed.length} candles`);
    return;
  }

  // Freshness gate: only the run shortly after the candle closed should fire.
  const closeAgeMin = (Date.now() - (latest.time + TIMEFRAME_SECONDS[timeframe]) * 1000) / 60_000;
  if (closeAgeMin >= windowMin) {
    log(
      `latest signal candle closed ${closeAgeMin.toFixed(1)} min ago ` +
        `(>= POLL_WINDOW_MIN ${windowMin}); skipping to avoid a duplicate`,
    );
    return;
  }

  const { title, body } = buildAlert(signal, timeframe);
  await sendTelegram(token, chatId, `${title}\n${body}`);
  log(`ALERT sent: ${title} — ${body}`);
}

main().catch((err: unknown) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

/**
 * Scheduled one-shot poller — for hosts that can't run a long-lived process
 * (GitHub Actions cron, any cron job). Fetches recent klines, replays the EXACT
 * production strategy, and sends a Telegram alert IFF the most-recently-closed
 * candle is a fresh breakout. Then exits.
 *
 * De-duplication is STATEFUL: the open time of the last alerted candle is kept
 * in a small JSON state file (STATE_FILE, persisted between runs via the
 * GitHub Actions cache). A breakout is alerted exactly once, by whichever run
 * first sees it — so a delayed or dropped cron run (GitHub cron is best-effort)
 * still catches it on a later run within the same candle, instead of missing
 * it. POLL_MAX_AGE_MIN is a safety bound that ignores implausibly old candles
 * if the state is ever lost (default = 2× the timeframe; effectively never
 * triggers in normal operation).
 *
 * Close-mode only by design (a poller can't see intra-candle crossings between
 * runs). The cron interval must be <= the timeframe, so default to 1h/4h/1d.
 *
 * Requires Node 22+ (global fetch). Env vars: TELEGRAM_TOKEN, TELEGRAM_CHAT_ID
 * (required), TIMEFRAME (default 1h), STATE_FILE (default .poll-state.json),
 * POLL_MAX_AGE_MIN, plus the same strategy overrides as watch.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fetchKlines } from '../src/services/binance';
import { sendTelegram } from '../src/services/notify';
import { scanHistory } from '../src/strategy/breakout';
import {
  buildAlert,
  envBool,
  envNum,
  log,
  readConfig,
  readTelegramCreds,
  readTimeframe,
  TIMEFRAME_SECONDS,
} from './lib';

/** timeframe → open time (UNIX s) of the last candle we alerted on. */
type State = Record<string, number>;

function readState(path: string): State {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as State;
  } catch {
    return {}; // missing/unreadable/corrupt → start fresh
  }
}

function writeState(path: string, state: State): void {
  try {
    writeFileSync(path, JSON.stringify(state));
  } catch (err) {
    log(`warning: could not write state file ${path}: ${err instanceof Error ? err.message : err}`);
  }
}

async function main(): Promise<void> {
  const { token, chatId } = readTelegramCreds();
  const timeframe = readTimeframe();

  // TEST_ALERT=true sends one guaranteed message and exits — proves the
  // credentials + CI→Telegram path without depending on a live breakout.
  if (envBool('TEST_ALERT', false)) {
    await sendTelegram(token, chatId, `✅ Test alert — BTC breakout watcher is wired up (${timeframe}). Real alerts fire on breakouts.`);
    log('TEST_ALERT sent');
    return;
  }

  const config = readConfig();
  const statePath = (process.env.STATE_FILE ?? '.poll-state.json').trim();
  const maxAgeMin = envNum('POLL_MAX_AGE_MIN', (TIMEFRAME_SECONDS[timeframe] / 60) * 2);

  if (config.mode !== 'close') {
    log(`note: MODE=${config.mode} ignored — the poller is close-mode only.`);
  }

  // Always re-persist at the end so the cache keeps a valid (and present) file.
  const state = readState(statePath);
  try {
    const { closed } = await fetchKlines(timeframe);
    if (closed.length === 0) {
      log('no closed candles returned; nothing to do');
      return;
    }

    const latest = closed[closed.length - 1];
    const stamp = `${new Date(latest.time * 1000).toISOString().slice(0, 16)}Z`;

    // Replay with full cooldown/filter parity; the latest candle fires only if
    // it would have fired live.
    const signal = scanHistory(closed, { ...config, mode: 'close' }).find((s) => s.candleTime === latest.time);
    if (!signal) {
      log(`no breakout on latest closed candle (${timeframe}); checked ${closed.length} candles`);
      return;
    }

    if ((state[timeframe] ?? 0) >= latest.time) {
      log(`breakout candle ${stamp} already alerted; skipping`);
      return;
    }

    const closeAgeMin = (Date.now() - (latest.time + TIMEFRAME_SECONDS[timeframe]) * 1000) / 60_000;
    if (closeAgeMin > maxAgeMin) {
      log(`breakout candle ${stamp} closed ${closeAgeMin.toFixed(1)} min ago (> POLL_MAX_AGE_MIN ${maxAgeMin}); stale, skipping`);
      state[timeframe] = latest.time; // don't reconsider it on later runs
      return;
    }

    const { title, body } = buildAlert(signal, timeframe);
    await sendTelegram(token, chatId, `${title}\n${body}`); // throws on failure → no state update, run fails, retried next time
    state[timeframe] = latest.time;
    log(`ALERT sent: ${title} — ${body}`);
  } finally {
    writeState(statePath, state);
  }
}

main().catch((err: unknown) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

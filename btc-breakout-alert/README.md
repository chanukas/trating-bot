# BTC Breakout Alert

Real-time Donchian-channel breakout monitor for **BTC/USDT** on Binance. Watches the live
kline stream, draws support/resistance on a candlestick chart, and alerts you — browser
notification, sound, on-screen log, and optionally Telegram — when price breaks out of the
range in either direction.

Frontend-only: the browser talks directly to Binance's public REST + WebSocket APIs.
**No API key, no backend, no stored credentials** (the optional Telegram token stays in your
browser's localStorage).

## Quick start

```bash
npm install
npm run dev      # → http://localhost:5173
```

Other commands:

```bash
npm test         # unit tests for the breakout logic (Vitest)
npm run build    # type-check + production build into dist/
npm run preview  # serve the production build locally
```

On first load the app asks for notification permission — allow it if you want desktop
alerts. Sound needs one click anywhere in the page first (a browser autoplay rule); the
**Test sound** button in settings confirms it's audible.

## How the strategy works

1. **Range definition (Donchian channel).** Over the last **N** closed candles
   (*Lookback*, default 20): resistance = highest high, support = lowest low. The
   currently forming candle is **never** part of its own range.
2. **Upside breakout** — candle closes above resistance.
   **Downside breakout** — candle closes below support.
3. **Confirmation filters** (each can be toggled off):
   - **Volume filter:** breakout candle volume must be **strictly greater** than
     *multiplier* × average volume of the last *period* closed candles (default 1.5× / 20).
   - **Buffer filter:** the close must clear the level by at least *buffer%*
     (default 0.1%), so wicks barely poking through don't trigger.
   - **CVD filter:** net taker flow (cumulative volume delta = aggressive buys −
     aggressive sells, from Binance's taker-buy field) over the last *CVD window*
     candles (breakout candle included, default 5) must point in the breakout
     direction. The idea: a breakout backed by real aggression is more likely to
     follow through than one drifting through the level. The purple line on the
     volume pane plots CVD over the loaded history.
   - **Squeeze filter** (off by default): only count breakouts that follow a
     volatility **compression** — ATR(14) as a % of price must have ranked in the
     lowest *squeeze percentile* (default 30%) of the trailing *lookback* (default
     500 candles) at least once within the last *within* candles (default 12).
     Provenance, honestly: this gate passed a pre-registered walk-forward
     validation in the companion Python repo (`test_h4_squeeze.py`: 55-bar
     channel, ATR stop, trailing exits, 6.7y of BTCUSDT 1h — pooled
     out-of-sample +0.086R vs −0.014R unfiltered), but it did **not** improve
     this app's default 20-bar fixed-hold replay (see the backtest section), so
     it ships disabled. Enable it if you configure the app closer to the
     validated system (1h, lookback ~55). Needs ~500 closed candles of history
     before it can pass; blocks conservatively until then.
4. **Trigger mode:**
   - *Candle close* (default): evaluates only when a candle closes. Fewer false signals,
     but you learn about the breakout at the close.
   - *Intra-candle cross*: fires the moment price trades through the level (the wick
     counts). Faster, noisier — note the volume filter is biased against firing early
     here, because a forming candle's volume is still accumulating.
5. **Cooldown:** after a signal, same-direction signals are suppressed for **M** candles
   (default 10). Directions are tracked independently — an upside alert doesn't silence a
   downside one.

Past breakouts found in the loaded history are drawn as **dimmed arrows** on the chart
(markers only — no notifications), so you can immediately see how your current parameters
would have behaved. Alerts fired live this session are drawn vivid and logged in the table.

## Tuning the parameters

| Parameter | Default | Effect of raising it | Effect of lowering it |
|---|---|---|---|
| Timeframe | 15m | Slower, bigger, more meaningful breakouts | Faster, noisier signals |
| Lookback N | 20 | Wider channel → rarer, stronger breakouts | Tighter channel → more frequent triggers |
| Volume multiplier | 1.5× | Demands more conviction; filters quiet drifts | Lets low-volume pokes through |
| Volume avg period | 20 | Smoother volume baseline | Baseline reacts faster to volume regime shifts |
| Buffer % | 0.1% | Fewer fake-outs from marginal closes | Earlier entry, more false triggers |
| CVD window | 5 | Demands sustained flow into the break | Window 1 = breakout candle's own flow only (nearly redundant with a close-through) |
| Squeeze percentile | 30 | Looser squeeze definition → more signals pass | Stricter compression required |
| Squeeze within | 12 | Accepts breakouts longer after the squeeze | Demands the break come right out of the squeeze |
| Squeeze lookback | 500 | More stable volatility baseline (validated value) | Adapts faster, but less meaningful percentile |
| Cooldown | 10 | Less alert spam in trending moves | Re-alerts sooner on continuation |
| Trigger mode | close | — | intra-candle = faster but noisier |

Settings persist in localStorage; the alert history lasts for the browser session.

A practical way to tune: pick a timeframe, then adjust *Lookback* until the dimmed
historical arrows mark the moves you'd actually have wanted to know about — then tighten
the volume/buffer filters until the marginal ones disappear.

## Telegram alerts (optional)

1. Create a bot with [@BotFather](https://t.me/BotFather) → copy the **bot token**.
2. Send your bot any message, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and read your **chat id** from the
   response (`message.chat.id`).
3. Paste both into Settings → Telegram and hit **Send test message**.

Leave the fields blank to skip Telegram entirely. Messages go straight from your browser
to `api.telegram.org`; the token is stored only in this browser's localStorage — fine for
a local tool, but don't host the app publicly with a token saved.

## Background alerts (no browser)

The web app only sends alerts while its tab is open. To get Telegram alerts running in the
background — on your machine or a server, browser closed — use the headless watcher
(`scripts/watch.ts`). It runs the **exact same strategy code** over the same live Binance
stream and sends the **identical** Telegram messages; no browser, no API key (Binance is
public). Needs Node 22+ (built-in WebSocket + fetch).

```bash
# PowerShell
$env:TELEGRAM_TOKEN="123:abc"; $env:TELEGRAM_CHAT_ID="456"; npm run watch

# bash
TELEGRAM_TOKEN=123:abc TELEGRAM_CHAT_ID=456 npm run watch
```

Defaults to the **1h** timeframe and `DEFAULT_CONFIG` (same parameters as the app). Override
anything via environment variables:

| Env var | Default | Maps to |
|---|---|---|
| `TELEGRAM_TOKEN` / `TELEGRAM_CHAT_ID` | — (required) | bot credentials |
| `TIMEFRAME` (or `--tf`) | `1h` | `5m`/`15m`/`1h`/`4h`/`1d` |
| `MODE` | `close` | `close` / `intracandle` |
| `LOOKBACK` | 20 | Donchian lookback |
| `VOLUME_FILTER` / `VOLUME_MULTIPLIER` / `VOLUME_PERIOD` | on / 1.5 / 20 | volume filter |
| `BUFFER_FILTER` / `BUFFER_PCT` | on / 0.1 | buffer filter |
| `CVD_FILTER` / `CVD_LOOKBACK` | on / 5 | CVD filter |
| `SQUEEZE_FILTER` / `SQUEEZE_PCT` / `SQUEEZE_WITHIN` / `SQUEEZE_LOOKBACK` | off / 30 / 12 / 500 | squeeze filter |
| `COOLDOWN` | 10 | same-direction cooldown |

It logs each candle close and every alert to the console, auto-reconnects and backfills on
WebSocket drops (same logic as the app), and shuts down cleanly on Ctrl-C.

### Free 24/7 with GitHub Actions (no server) — recommended

If you don't have an always-on machine and don't want to pay for a host, run the **cron
poller** (`scripts/poll.ts`) on GitHub Actions for free. Instead of holding a socket open,
a scheduled job wakes up, fetches recent klines, replays the **same strategy**, and sends a
Telegram alert when the just-closed candle is a fresh breakout — then exits.

The workflow is already in [`.github/workflows/btc-alert.yml`](../.github/workflows/btc-alert.yml).
To enable it:

1. Push this repo to GitHub.
2. Repo → **Settings → Secrets and variables → Actions → New repository secret**:
   - `TELEGRAM_TOKEN` = your bot token
   - `TELEGRAM_CHAT_ID` = your chat id
3. (Optional) add repository **Variables** to tune `TIMEFRAME`, `POLL_WINDOW_MIN`, `LOOKBACK`, etc.
4. **Actions** tab → run the workflow once manually (`workflow_dispatch`) to confirm it works.

It runs every 15 min by default. Honest limits of the free cron approach:

- **Close-mode only** and alerts arrive **a few minutes after** the candle closes — fine for
  1h/4h, not for fast scalping. The cron interval must be **≤ your timeframe**.
- **Stateless de-dup:** an alert fires only if the latest candle closed within
  `POLL_WINDOW_MIN` minutes (default 15 — keep it equal to the cron interval). GitHub cron is
  best-effort and can be delayed under load, so a badly delayed run **misses** that candle's
  alert rather than sending a duplicate.
- Scheduled workflows are paused after 60 days of no repo activity (a commit re-arms them).

Run it locally the same way to test: `TELEGRAM_TOKEN=… TELEGRAM_CHAT_ID=… npm run poll`.

### Keeping the real-time watcher running 24/7

For instant (and intra-candle-capable) alerts you can instead keep the long-lived watcher
running. It needs an **always-on host** — **not** Vercel (that deploy is a static site;
serverless functions can't hold a WebSocket open). Pick one:

**Your own always-on machine / Pi (free), via pm2:**

```bash
cd btc-breakout-alert && npm install
TELEGRAM_TOKEN=123:abc TELEGRAM_CHAT_ID=456 pm2 start npm --name btc-watch -- run watch
pm2 save && pm2 startup     # restart on reboot
```

**Any Docker host (VPS, home server):** a `Dockerfile` is included.

```bash
docker build -t btc-watch ./btc-breakout-alert
docker run -d --restart unless-stopped --name btc-watch \
  -e TELEGRAM_TOKEN=123:abc -e TELEGRAM_CHAT_ID=456 -e TIMEFRAME=1h btc-watch
docker logs -f btc-watch    # expect "status: live"
```

**Railway (git deploy, closest to your Vercel workflow):** New Project → Deploy from your
GitHub repo → set **Root Directory** to `btc-breakout-alert` (it auto-detects the
`Dockerfile`) → add the `TELEGRAM_TOKEN` / `TELEGRAM_CHAT_ID` (and optional `TIMEFRAME`)
variables → deploy. **Fly.io** works the same way (`fly launch` in `btc-breakout-alert`,
then `fly secrets set TELEGRAM_TOKEN=… TELEGRAM_CHAT_ID=…`).

On any host, set the token via the platform's **environment variables / secrets** — never
commit it.

## Backtesting (and honest expectations)

`scripts/backtest.ts` replays the **exact production strategy code** over Binance history
and measures forward returns (entry at next candle open, exit at close +H candles, gross):

```bash
npm run backtest -- 1h 20000     # timeframe, candle count (positional — PowerShell-safe)
npx tsx scripts/backtest.ts --tf 4h --candles 10000 --holds 5,10,20
```

Measured on 2026-06-11 with default parameters (in-sample, single pass, no tuning):

- **15m** (3.5 months): negative expectancy *before* costs (PF ≈ 0.7). Useful as an alert,
  not as a mechanical entry.
- **1h** (14 months): mildly positive gross (PF ≈ 1.3–1.4 at short holds), roughly
  breakeven after fees. The CVD filter added ~+1.5 pp win rate and ~+0.03%/trade here —
  consistent but small, and within statistical noise at n ≈ 300.
- **4h** (4.5 years): gross PF ≈ 1.1–1.26; carried by a few large trend trades
  (medians are negative). CVD helped short holds, hurt the longest.

Squeeze filter, measured 2026-06-11 on **1h × 10,000 candles** (~14 months, configs F/G):
it *reduced* performance for this app's default 20-bar / fixed-hold setup (PF 0.76–1.04
filtered vs ≈1.0–1.45 unfiltered at the same holds, n = 177). That is why it ships
**off** — its validation came from a different system (55-bar channel with trailing
exits over 6.7 years; see the companion Python repo). A filter is only as good as the
strategy it filters.

Treat the alerts as a prompt to look at the market, not as an auto-tradeable signal.

## Reliability behavior

- **WebSocket drops** (Binance recycles connections ~24h): automatic reconnect with
  exponential backoff (1s → 30s), alternating between ports 9443/443. The status pill
  shows *Live / Reconnecting / Error* at all times.
- **After every reconnect** the app refetches REST history, so candles that closed while
  offline are backfilled — levels and signals stay correct.
- **No simulated data.** If the initial history fetch fails you get an error panel with a
  retry button, not a fake chart.

> If `stream.binance.com` is blocked in your region (e.g. the US), the app will sit in
> *Reconnecting*. binance.us streams use a different host and are not wired in.

## Project structure

```
src/
  strategy/breakout.ts    pure breakout logic (levels, filters, CVD, cooldown) + tests
  services/binance.ts     REST klines + auto-reconnecting kline WebSocket
  services/notify.ts      browser notifications, WebAudio tones, Telegram
  hooks/useBreakoutEngine.ts  glue: stream → strategy → alerts → React state
  components/             ChartPanel, StatusBar, SettingsPanel, AlertTable
scripts/
  backtest.ts             replay the strategy over history, measure forward returns
```

The strategy module is dependency-free (no DOM/network/React) — to add another strategy,
drop a sibling file in `src/strategy/` exposing the same `evaluate`-style interface and
wire it into the engine hook.

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

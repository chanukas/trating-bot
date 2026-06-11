# Elliott-Inspired BTCUSDT Trading Bot

A modular, honestly-validated crypto trading bot. It mechanises **one narrow,
testable** Elliott-Wave idea (catch the start of a probable Wave 3) and — more
importantly — measures whether that idea has any **real edge after costs** using
out-of-sample and walk-forward testing.

> **This is research code, not a money printer. Read "Honest expectations" below
> before you even think about real money.**

## Install

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install numpy pandas matplotlib requests ccxt
```

All dependencies are free. **No API key is needed for data or backtesting.**
The only keys ever required are free **Binance testnet** keys for paper trading.

## Run

```powershell
# 1) fetch + cache real BTCUSDT 1h history (keyless Binance public API)
.\.venv\Scripts\python.exe data.py

# 2) backtest with 60/40 in-sample/out-of-sample split + equity plot
.\.venv\Scripts\python.exe run_backtest.py
#    options: --symbol BTCUSDT --timeframe 1h --start 2019-09-01 --split 0.6

# 3) walk-forward validation (the real test of edge stability)
.\.venv\Scripts\python.exe walkforward.py

# 3b) SIGNAL ADVISOR — get a suggested trade + why + its backtested record (you trade manually)
.\.venv\Scripts\python.exe advisor.py
.\.venv\Scripts\python.exe advisor.py --as-of 2025-03-15   # replay any past date

# 3c) WEB PAGE — the easy way: run this, then open http://127.0.0.1:8000
.\.venv\Scripts\python.exe webapp.py

# 4) paper trade on Binance TESTNET (needs free testnet keys; see below)
$env:BINANCE_TESTNET_API_KEY="..."; $env:BINANCE_TESTNET_API_SECRET="..."
.\.venv\Scripts\python.exe live_skeleton.py
```

## Modules

| File | Job |
|---|---|
| `config.py` | All parameters (symbol, timeframe, fees, slippage, risk %, ZigZag/Fib). `periods_per_year = 24*365`. |
| `data.py` | Keyless OHLCV fetch (Binance REST → bulk CSV → ccxt), CSV cache, + a labelled **synthetic** generator for smoke tests. |
| `indicators.py` | Wilder ATR; ATR-based ZigZag with per-pivot `confirm_idx` (no look-ahead); Fib helper. |
| `elliott.py` | Pure signal logic: 3 confirmed pivots → Wave1/Wave2 → bracket (entry/stop/target). |
| `trend.py` | **Validated** Donchian trend-following strategy (breakout + ATR stop, trailing or fixed-R exit). |
| `run_trend.py` | Trend backtest with 60/40 split + equity plot (`trend_equity.png`). |
| `backtest.py` | Event-driven engine: one position, bracket orders, worst-case fills, fees+slippage, fixed-% risk sizing. |
| `metrics.py` | Profit factor, expectancy ($/R), max drawdown (the headline) + supporting stats. |
| `run_backtest.py` | 60/40 split, reports IS & OOS separately, saves `equity_curve.png`. |
| `walkforward.py` | Rolling re-tune on a tiny grid, test on the next window, report consistency. |
| `advisor.py` | **Signal advisor for MANUAL trading**: scans latest closed-candle data, suggests a setup with entry/stop/target + the "why" + the honest backtested track record. Does NOT place orders. `--as-of DATE` replays a past date. |
| `webapp.py` | **Local web page** (stdlib only, no framework) showing the advisor in your browser at `http://127.0.0.1:8000`. Bound to localhost; never places orders. |
| `live_skeleton.py` | **Testnet/paper only**, risk limits, kill switch, acts on closed candles, refuses live. |

## The strategy in one paragraph

Reduce price to alternating swing pivots with an ATR-based ZigZag. On three
confirmed pivots `L0→H1→L2` (bull) where `L2 > L0` and Wave 2 retraces 0.382–0.886
of Wave 1, arm a buy-stop just above `H1` (Wave-3 proxy), stop just below `L2`,
target `L2 + 1.618×(H1−L0)`. Mirror for shorts. Every pivot is only usable once
**confirmed**, so there is no repaint/look-ahead.

## Costs & assumptions (so results aren't fantasy)

- Taker fee **0.05%/side** (configurable 0.04–0.10%) + slippage **2 bps/side**, on entry **and** exit.
- If a bar touches **both** stop and target, the **stop** is assumed to fill first (worst case), including the entry bar.
- Stop-orders that **gap** through fill at the bar **open**.
- Position size risks a **fixed % of current equity** (default 1%) based on entry→stop distance.
- Shorts are simulated symmetrically in the backtest; the live skeleton respects what the venue allows.

## Honest expectations (please read)

- **Most retail trading bots lose money** after fees and slippage. This one may well be no exception — the code is built to *tell you that* rather than hide it.
- **Win rate is a trap.** A bot can win 70% of trades and still bleed money if losers are bigger than winners. Judge by **profit factor, expectancy (R), and max drawdown** — which is why those lead every report. A wave-3 idea is *expected* to have a modest (~35–45%) win rate.
- **Elliott Wave is subjective.** This is a mechanical approximation, not "real" wave counting; treat it as just one pattern-based signal among many.
- **In-sample results mean little.** If out-of-sample or walk-forward is much worse than in-sample, that's **overfitting** — do not trust it.
- **A backtest is a best case.** Live results are worse: real slippage, outages, latency, partial fills, funding, and your own behaviour.
- **Validate, then paper-trade, then maybe risk tiny size.** In that order. For weeks, not hours.
- On any real key: **disable withdrawal permission.** Use IP allow-listing. Never commit keys.
- **This is not financial advice.** You are responsible for your own capital and risk.

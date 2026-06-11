# PLAN.md — Elliott-Inspired BTCUSDT Trading Bot

> Status: Phase 1 (planning). Honest framing up front: this is a **mechanical
> approximation** of Elliott Wave logic, not real wave counting. The goal is to
> find out — with out-of-sample and walk-forward testing — whether it has *any*
> real, repeatable edge. The most likely honest outcome is "no edge after costs,"
> and the code is built to tell us that clearly rather than hide it.

---

## 1. Architecture & module list

Strategy logic is kept strictly separate from execution. Each module has one job:

| Module | Job (one line) |
|---|---|
| `config.py` | Central config: symbol, timeframe, fees, slippage, risk %, ZigZag/Fib params, periods_per_year = 24*365. |
| `data.py` | Fetch & cache BTCUSDT OHLCV from a free, keyless source (Binance klines REST → bulk CSV → ccxt fallback). Also a clearly-labeled **synthetic** generator for smoke tests only. |
| `indicators.py` | ATR; ATR-based ZigZag pivot detector (clean state machine, strictly alternating High/Low pivots, each pivot carrying a *confirmation bar index* to prevent look-ahead); Fibonacci level helpers. |
| `elliott.py` | Pure signal logic. From confirmed pivots, detect a probable Wave 1 + Wave 2 and emit a `Setup` (entry trigger, stop, target, direction). No I/O, no look-ahead. |
| `backtest.py` | Event-driven engine: one position at a time, bracket orders, worst-case fills, realistic fees + slippage, fixed-% risk position sizing. |
| `metrics.py` | num_trades, win_rate, profit_factor, expectancy ($ and R), avg_win, avg_loss, max_drawdown, annualized Sharpe. Leads with profit_factor / expectancy / max_drawdown. |
| `run_backtest.py` | Orchestrate: fetch history → 60/40 in-sample/out-of-sample split → run both → print both metric tables → save equity-curve plot with the split marked. |
| `walkforward.py` | Rolling re-tune (small grid) on a train window, test on the next window, step forward; report per-window consistency. |
| `live_skeleton.py` | **Paper/testnet only.** Binance SPOT TESTNET via ccxt, bracket orders, `RiskLimits`, kill switch, acts only on CLOSED candles. Hard-refuses live until a human flips it. Keys from env vars only. |
| `README.md` | How to run + honest expectations and caveats. |

Data flow: `data.py → indicators.py → elliott.py → backtest.py → metrics.py`, with
`run_backtest.py` / `walkforward.py` as orchestrators and `live_skeleton.py` reusing
`indicators.py` + `elliott.py` unchanged (same signals offline and on paper).

---

## 2. Strategy in plain English (Elliott-inspired)

Elliott Wave theory says markets move in 5-wave impulses then 3-wave corrections.
Wave 3 is usually the strongest, most tradable leg. Full wave counting is subjective
and unfalsifiable, so we do **not** attempt it. Instead we mechanize one narrow,
testable idea: *catch the start of a possible Wave 3.*

We use an **ATR-based ZigZag** to reduce price to alternating swing pivots (High, Low,
High, …). Then:

**Bullish setup** — three consecutive confirmed pivots `L0 → H1 → L2`:
- `L0` = swing low (possible Wave 1 start), `H1` = swing high (Wave 1 top), `L2` = swing low (Wave 2 bottom).
- **Rule 1 (Elliott):** `L2 > L0` — Wave 2 may not erase all of Wave 1.
- **Rule 2 (retrace):** retrace fraction `(H1 − L2) / (H1 − L0)` must be in **0.382 … 0.886** (a healthy Wave-2 pullback, not a tiny dip or a near-full reversal).
- **Entry:** a buy-stop just above `H1`. Breaking H1 is our proxy for "Wave 3 starting." We only arm this on bars **after L2 is confirmed**.
- **Stop:** just below `L2` (if price comes back under the Wave-2 low, the idea is wrong).
- **Target:** the 1.618 Fibonacci extension of Wave 1, projected from L2: `target = L2 + 1.618 × (H1 − L0)`.

**Bearish setup** — mirror image `H0 → L1 → H2`: require `H2 < H0`; retrace `(H2 − L1)/(H0 − L1)` in 0.382…0.886; sell-stop below `L1`; stop just above `H2`; target `= H2 − 1.618 × (H0 − L1)`.

**Setup invalidation (before trigger):** cancel if price hits the stop level before the entry
trigger, or if a newer confirmed pivot changes the structure (we always trade the most
recent valid 3-pivot pattern).

**No look-ahead — the part that's easy to get wrong:** a ZigZag pivot is *not known* at the
bar where the extreme occurs; it's only confirmed later, once price has reversed by the ATR
threshold. So every pivot carries a `confirm_idx`. At simulated bar `t`, the strategy may
only use pivots with `confirm_idx ≤ t`, and may only act on bars `t` strictly after `L2`'s
confirmation. This is what stops the classic ZigZag "repaint" cheat.

---

## 3. Data source (free, keyless)

**Primary: Binance public klines REST** — `https://api.binance.com/api/v3/klines`.
No API key. Returns up to 1000 candles/request; we paginate with `startTime`/`endTime`
to pull years of 1h history. Chosen because it's the exact exchange/pair we trade, it's
keyless, and pagination is simple and reliable.

**Fallback 1: `data.binance.vision`** monthly/daily bulk CSV archives — keyless, ideal for
large backfills if the REST endpoint is rate-limited or geo-blocked.

**Fallback 2: `ccxt`** with the `binance` exchange — market data needs no key. Last resort
if both above fail.

**Caching:** every fetch is written to `./data_cache/BTCUSDT_1h.csv`. Subsequent runs load
the cache and only fetch the missing tail. (CSV, not parquet, to avoid a pyarrow dependency.)

**No key needed for any of Phases 2–4.** The *only* place a key is ever needed is
`live_skeleton.py` paper trading on Binance **testnet** — and I will STOP and ask you for
those testnet keys when we get there, never hardcode them.

---

## 4. Validation plan

1. **Chronological 60/40 split.** First 60% of history = in-sample (IS), last 40% =
   out-of-sample (OOS). Never shuffle (time series). Report IS and OOS **separately**.
2. **Walk-forward.** Rolling train window (~12 months) to pick parameters from a *small*
   grid, then test on the next untouched window (~6 months); step forward and repeat.
   Aggregate the OOS-only results across windows and check **consistency** (is the edge
   present in most windows, or driven by one lucky period?).
3. **Anti-overfitting discipline.** The tuning grid is deliberately tiny (a couple of
   ZigZag/retrace params). I will *not* tweak parameters until a single backtest looks
   pretty. If OOS ≪ IS, I'll say "overfitting" and we reduce degrees of freedom.

---

## 5. Metrics (and why win rate is NOT the headline)

**Headline (reported first):**
- **Profit factor** = gross profit / gross loss. >1 means the system makes money; this
  blends frequency *and* size of wins vs losses.
- **Expectancy** — average $ and **average R** (R = multiples of risk) per trade. This is
  the single number that says "do I make money per trade, accounting for win size?"
- **Max drawdown** — worst peak-to-trough equity drop. Survivability; this is what blows
  accounts up.

**Secondary:** num_trades (is the sample even meaningful?), avg_win, avg_loss, annualized
Sharpe (hourly equity returns × √(24·365)).

**De-emphasized:** **win_rate.** Win rate is a trap because it ignores *size*. A Wave-3
trend-following idea is *expected* to have a modest win rate (~35–45%) with a few large
winners paying for many small losers. A high win rate with a bad payoff ratio loses money;
a low win rate with asymmetric winners makes money. Expectancy/profit factor capture this;
win rate alone actively misleads.

---

## 6. Milestones & "done"

| Milestone | "Done" means |
|---|---|
| **M1 — Plan** | This file reviewed. ✅ when you've seen it. |
| **M2 — Data** | `data.py` pulls ≥2 yrs real BTCUSDT 1h, caches to CSV, reloads without refetch; synthetic generator labeled meaningless. Done when I show you the data summary (rows, date range, sample). |
| **M3 — Indicators + signals** | ZigZag produces sane alternating pivots (non-zero, visually plausible) with confirm indices; `elliott.py` emits setups with no look-ahead. Done when I show pivot counts + a few example setups. |
| **M4 — Backtest engine** | Event-driven loop runs end-to-end with fees/slippage/worst-case fills and fixed-% risk. Done when a full equity curve + metric table prints. |
| **M5 — Validation** | IS vs OOS reported separately with the split-marked equity plot; walk-forward per-window table printed. Done when you've seen both. |
| **M6 — Honest verdict** | A plain-English diagnosis: is there an edge after costs? Overfit? Negative expectancy? Done when I state the verdict without spin. |
| **M7 — Live skeleton** | Testnet paper-trading skeleton exists, forced to paper, refuses live. Done when reviewed (not run until you provide testnet keys). |

---

## 7. Decisions & assumptions

- **Target projection:** "1.618 extension of Wave 1" implemented as `L2 + 1.618×(H1−L0)`
  (standard Wave-3 projection from the Wave-2 low). Flagged here because "of Wave 1" is
  slightly ambiguous; this is the conventional reading. Easy to change in `config.py`.
- **Spot, long & short, one position at a time.** Shorts are simulated symmetrically even
  though spot can't naturally short — this is a *backtest* of the signal's symmetry; the
  paper/live skeleton will respect what the venue actually allows.
- **Costs:** default taker fee 0.05% per side (configurable 0.04–0.10%) + slippage (a few
  bps) on **both** entry and exit. Both-touched bar → **stop fills first** (worst case).
- **Position sizing:** risk a fixed % of *current* equity per trade (default 1%), sized off
  the entry→stop distance. Fractional position sizes allowed (crypto).
- **Caching format:** CSV (keeps deps to numpy/pandas/matplotlib/requests/ccxt only).
- **Annualization:** `periods_per_year = 24*365 = 8760` (crypto trades 24/7).
- **Dependencies not yet installed** in this environment (numpy/pandas/matplotlib/requests/
  ccxt). I'll install them into a local `.venv` in Phase 2 — all free, no keys.
- **Geo note:** if `api.binance.com` is rate-limited/blocked from this machine, the code
  auto-falls back to `data.binance.vision` then ccxt; I'll report which path succeeded.

---

## 8. Risks to the edge (named on purpose)

- ZigZag look-ahead/repaint (mitigated via `confirm_idx`).
- Survivorship of one bull-market regime; walk-forward is the check.
- Too few trades → statistically meaningless; we report `num_trades` prominently.
- Overfitting via the tuning grid; kept tiny on purpose.
- Costs eating a thin theoretical edge; fees+slippage charged on both sides.

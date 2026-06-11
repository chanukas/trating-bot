"""Pre-registered test of Hypothesis H1: an EMA(200) trend filter on breakouts.

Rule: only arm LONG when close>EMA200, SHORT when close<EMA200. EMA period FIXED
at 200 (NOT tuned, NOT in the walk-forward grid).

Success criterion COMMITTED BEFORE RUNNING:
  keep H1 only if  walk-forward pooled OOS expectancy >= +0.03 R
                   AND >= 7/11 windows positive
                   AND 60/40 out-of-sample expectancy > 0.
Anything less -> H1 fails, we stop (no further tweaking).
"""
import dataclasses

import data
from config import DEFAULT
from backtest import run_backtest
from metrics import compute_metrics, format_metrics
import walkforward as wf

cfg_base = DEFAULT
cfg_h1 = dataclasses.replace(DEFAULT, trend_filter=True)

df = data.load_ohlcv(cfg_base)
n = len(df)
split = int(n * 0.6)
is_df, oos_df = df.iloc[:split], df.iloc[split:]

print("\n" + "=" * 72)
print("60/40 SPLIT  —  BASELINE vs H1 (EMA200 trend filter), out-of-sample focus")
print("=" * 72)
for name, cfg in [("BASELINE", cfg_base), ("H1 trend-filter", cfg_h1)]:
    is_m = compute_metrics(run_backtest(is_df, cfg), cfg, f"{name}  IN-SAMPLE")
    oos_m = compute_metrics(run_backtest(oos_df, cfg), cfg, f"{name}  OUT-OF-SAMPLE")
    print(format_metrics(is_m)); print(); print(format_metrics(oos_m)); print()

print("\n" + "#" * 72)
print("WALK-FORWARD with H1 trend filter (grid still only atr_mult x retrace_max)")
print("#" * 72)
rows, pooled = wf.walk_forward(cfg_h1)
wf.print_report(rows, pooled, cfg_h1)

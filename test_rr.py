"""Does demanding 1:3 reward:risk create an edge? Honest test on real data.

Compares, on full history AND the 60/40 out-of-sample tail:
  - baseline     : fib (1.618) target, no R:R filter
  - forced 3R    : target set to exactly entry +/- 3*risk
  - forced 2R    : target set to exactly entry +/- 2*risk
  - natural >=3R : keep fib target but only take setups already offering >=3:1
Key question: does the far target get HIT often enough to beat the ~27% break-even
(25% for 1:3, +costs)?  win% is the hit rate; expectancy_R is the verdict.
"""
import dataclasses

import data
from config import DEFAULT
from backtest import run_backtest
from metrics import compute_metrics

df = data.load_ohlcv(DEFAULT)
n = len(df); split = int(n * 0.6)
oos_df = df.iloc[split:]

variants = {
    "baseline (fib)":   dataclasses.replace(DEFAULT),
    "forced 3R":        dataclasses.replace(DEFAULT, use_r_target=True, target_r=3.0),
    "forced 2R":        dataclasses.replace(DEFAULT, use_r_target=True, target_r=2.0),
    "natural >=3R":     dataclasses.replace(DEFAULT, min_rr=3.0),
}

hdr = f"{'variant':<16}{'scope':<6}{'#tr':>5}{'win%':>7}{'payoff':>8}{'PF':>6}{'expR':>8}{'ret%':>8}"
print(hdr); print("-" * len(hdr))
for name, cfg in variants.items():
    for scope, d in (("full", df), ("OOS", oos_df)):
        m = compute_metrics(run_backtest(d, cfg), cfg)
        pf = "inf" if m["profit_factor"] == float("inf") else f"{m['profit_factor']:.2f}"
        print(f"{name:<16}{scope:<6}{m['num_trades']:>5}{m['win_rate_%']:>7.1f}"
              f"{m['payoff_ratio']:>8.2f}{pf:>6}{m['expectancy_R']:>+8.3f}{m['total_return_%']:>+8.1f}")
    print()
print("break-even win rate: 1:3 -> 25%, 1:2 -> 33%.  Beating it after costs = edge.")

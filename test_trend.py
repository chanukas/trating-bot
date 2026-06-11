"""Honest evaluation of Hypothesis H2 (Donchian trend-following).
Compares exit modes (trail vs fixed 3R) and long-only vs long+short, on full
history and 60/40 OOS, then walk-forwards the configs. Success bar (pre-registered):
WF pooled OOS >= +0.05R AND >=7/11 windows positive AND 60/40 OOS positive.
"""
import dataclasses
import numpy as np

import data
from config import DEFAULT
from trend import run_trend_backtest
from metrics import compute_metrics

df = data.load_ohlcv(DEFAULT)
n = len(df); split = int(n * 0.6)
oos = df.iloc[split:]

variants = {
    "trail  L+S":     dataclasses.replace(DEFAULT, trend_exit="trail",  allow_shorts=True),
    "trail  long":    dataclasses.replace(DEFAULT, trend_exit="trail",  allow_shorts=False),
    "3R     L+S":     dataclasses.replace(DEFAULT, trend_exit="rtarget", allow_shorts=True),
    "3R     long":    dataclasses.replace(DEFAULT, trend_exit="rtarget", allow_shorts=False),
}

hdr = f"{'variant':<12}{'scope':<6}{'#tr':>5}{'win%':>7}{'payoff':>8}{'PF':>6}{'expR':>8}{'ret%':>8}{'maxDD%':>8}"
print(hdr); print("-" * len(hdr))
for name, cfg in variants.items():
    for scope, d in (("full", df), ("OOS", oos)):
        m = compute_metrics(run_trend_backtest(d, cfg), cfg)
        pf = "inf" if m["profit_factor"] == float("inf") else f"{m['profit_factor']:.2f}"
        print(f"{name:<12}{scope:<6}{m['num_trades']:>5}{m['win_rate_%']:>7.1f}"
              f"{m['payoff_ratio']:>8.2f}{pf:>6}{m['expectancy_R']:>+8.3f}"
              f"{m['total_return_%']:>+8.1f}{m['max_drawdown_%']:>8.1f}")
    print()

# ---- walk-forward for trend (tiny grid: dc_entry x atr_stop_mult), the better configs ----
TRAIN, TEST = 24 * 365, 24 * 182
GRID = [(de, sm) for de in (20, 55) for sm in (2.0, 3.0)]

def wf(base):
    rows, pooled = [], []
    i = 0
    while i + TRAIN + TEST <= n:
        tr, te = df.iloc[i:i+TRAIN], df.iloc[i+TRAIN:i+TRAIN+TEST]
        best, best_s = base, -1e9
        for de, sm in GRID:
            cfg = dataclasses.replace(base, dc_entry=de, atr_stop_mult=sm)
            m = compute_metrics(run_trend_backtest(tr, cfg), cfg)
            if m["num_trades"] >= 15 and m["expectancy_R"] > best_s:
                best, best_s = cfg, m["expectancy_R"]
        tm = compute_metrics(run_trend_backtest(te, best), best)
        rows.append(tm["expectancy_R"]); pooled.append(tm)
        i += TEST
    pos = sum(1 for r in rows if r > 0)
    pooled_expR = float(np.median(rows)) if rows else 0
    return len(rows), pos, pooled_expR, float(np.mean([m["expectancy_R"] for m in pooled]))

for name in ("trail  long", "3R     long", "trail  L+S"):
    base = variants[name]
    nW, pos, med, mean = wf(base)
    print(f"WALK-FWD {name:<10}: {pos}/{nW} windows positive | median expR {med:+.3f} | mean expR {mean:+.3f}")
print("\nSuccess bar: WF mean/median expR >= +0.05 AND >=7/11 windows AND 60/40 OOS > 0.")

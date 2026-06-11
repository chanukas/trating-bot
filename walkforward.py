"""Walk-forward validation: the real test of whether the edge is stable.

Roll a train window forward; on each train window pick the best params from a
SMALL grid (kept tiny on purpose to limit overfitting); then run those params on
the NEXT, untouched test window. Repeat. Report per-window consistency.

Why this matters more than a single 60/40 split: it checks whether parameters
chosen on the past keep working on the immediate future, repeatedly, across
different market regimes -- not whether one lucky period carried the result.
"""
from __future__ import annotations

import dataclasses

import numpy as np

import data
from config import Config, DEFAULT
from backtest import run_backtest
from metrics import compute_metrics

# Deliberately tiny grid (6 combos). More knobs => more overfitting.
GRID = {
    "zigzag_atr_mult": [2.5, 3.0, 3.5],
    "retrace_max": [0.786, 0.886],
}

TRAIN_BARS = 24 * 365      # ~12 months
TEST_BARS = 24 * 182       # ~6 months
MIN_TRAIN_TRADES = 15      # ignore param combos that barely trade in-sample
SELECT_BY = "expectancy_R"


def _grid_configs(base: Config):
    for m in GRID["zigzag_atr_mult"]:
        for r in GRID["retrace_max"]:
            yield dataclasses.replace(base, zigzag_atr_mult=m, retrace_max=r)


def _best_on_train(train_df, base: Config) -> tuple[Config, dict]:
    best_cfg, best_metric, best_m = base, -1e18, None
    for cfg in _grid_configs(base):
        res = run_backtest(train_df, cfg)
        m = compute_metrics(res, cfg)
        if m["num_trades"] < MIN_TRAIN_TRADES:
            continue
        score = m[SELECT_BY]
        if score > best_metric:
            best_cfg, best_metric, best_m = cfg, score, m
    return best_cfg, best_m


def walk_forward(cfg: Config = DEFAULT, start=None, end=None,
                 train_bars=TRAIN_BARS, test_bars=TEST_BARS):
    df = data.load_ohlcv(cfg, start=start, end=end)
    n = len(df)
    rows = []
    pooled_trades = []
    i = 0
    while i + train_bars + test_bars <= n:
        train_df = df.iloc[i:i + train_bars]
        test_df = df.iloc[i + train_bars:i + train_bars + test_bars]
        best_cfg, train_m = _best_on_train(train_df, cfg)
        test_res = run_backtest(test_df, best_cfg)
        test_m = compute_metrics(test_res, best_cfg)
        pooled_trades.extend(test_res.trades)
        rows.append({
            "test_start": test_df.index[0].date(),
            "test_end": test_df.index[-1].date(),
            "atr_mult": best_cfg.zigzag_atr_mult,
            "retr_max": best_cfg.retrace_max,
            "train_expR": train_m[SELECT_BY] if train_m else float("nan"),
            "test_trades": test_m["num_trades"],
            "test_PF": test_m["profit_factor"],
            "test_expR": test_m["expectancy_R"],
            "test_dd%": test_m["max_drawdown_%"],
            "test_ret%": test_m["total_return_%"],
        })
        i += test_bars
    return rows, pooled_trades


def _pf(trades):
    g = sum(t.pnl for t in trades if t.pnl > 0)
    l = -sum(t.pnl for t in trades if t.pnl < 0)
    return (g / l) if l > 0 else float("inf") if g > 0 else 0.0


def print_report(rows, pooled_trades, cfg: Config = DEFAULT):
    print(f"\nWALK-FORWARD  (train {TRAIN_BARS} bars / test {TEST_BARS} bars, "
          f"select by {SELECT_BY} on train)\n")
    hdr = (f"{'test window':<24}{'atr':>5}{'retr':>6}{'tr_expR':>9}"
           f"{'#tr':>5}{'PF':>7}{'expR':>8}{'dd%':>7}{'ret%':>8}")
    print(hdr); print("-" * len(hdr))
    for r in rows:
        pf = r["test_PF"]
        pf_s = "inf" if pf == float("inf") else f"{pf:.2f}"
        print(f"{str(r['test_start'])+'..'+str(r['test_end']):<24}"
              f"{r['atr_mult']:>5.1f}{r['retr_max']:>6.2f}{r['train_expR']:>9.3f}"
              f"{r['test_trades']:>5}{pf_s:>7}{r['test_expR']:>+8.3f}"
              f"{r['test_dd%']:>7.1f}{r['test_ret%']:>+8.1f}")

    n = len(rows)
    pos = sum(1 for r in rows if r["test_expR"] > 0)
    med_expR = float(np.median([r["test_expR"] for r in rows])) if rows else 0.0
    med_pf = float(np.median([r["test_PF"] for r in rows if r["test_PF"] != float("inf")])) if rows else 0.0
    pooled_expR = float(np.mean([t.r_multiple for t in pooled_trades])) if pooled_trades else 0.0
    print("-" * len(hdr))
    print(f"windows: {n} | positive-expectancy windows: {pos}/{n} "
          f"({100*pos/n:.0f}%)" if n else "no windows")
    print(f"median test expectancy_R: {med_expR:+.3f} | median test PF: {med_pf:.2f}")
    print(f"POOLED out-of-sample: {len(pooled_trades)} trades | "
          f"PF {_pf(pooled_trades):.2f} | expectancy {pooled_expR:+.3f} R/trade")
    print("\nConsistency read: an edge should show POSITIVE expectancy in a MAJORITY "
          "of windows,\nnot one window carrying the rest. Few/negative -> no reliable edge.")


if __name__ == "__main__":
    rows, pooled = walk_forward(DEFAULT)
    print_report(rows, pooled, DEFAULT)

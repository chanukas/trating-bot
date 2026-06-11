"""Run the trend-following strategy on real BTCUSDT with a 60/40 split and an
equity-curve plot. Reports IS and OOS separately (independent runs)."""
from __future__ import annotations

import dataclasses
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

import data
from config import DEFAULT
from trend import run_trend_backtest
from metrics import compute_metrics, format_metrics

CFG = dataclasses.replace(DEFAULT, trend_exit="rtarget", trend_target_r=3.0, allow_shorts=True)


def main(cfg=CFG, out_png="trend_equity.png"):
    df = data.load_ohlcv(cfg)
    print(data.summarize(df))
    n = len(df); split = int(n * 0.6); split_time = df.index[split]

    full = run_trend_backtest(df, cfg)
    is_res = run_trend_backtest(df.iloc[:split], cfg)
    oos_res = run_trend_backtest(df.iloc[split:], cfg)

    print(f"\nSplit at {split_time}\n")
    print(format_metrics(compute_metrics(is_res, cfg, "TREND IN-SAMPLE (first 60%)"))); print()
    print(format_metrics(compute_metrics(oos_res, cfg, "TREND OUT-OF-SAMPLE (last 40%)"))); print()
    print(format_metrics(compute_metrics(full, cfg, "TREND FULL HISTORY")))

    fig, ax = plt.subplots(figsize=(12, 6))
    ax.plot(full.equity_curve.index, full.equity_curve.values, lw=1.1, color="#2ca02c")
    ax.axvline(split_time, color="red", ls="--", lw=1.2, label="60/40 split")
    ax.axhline(cfg.initial_equity, color="gray", ls=":", lw=0.8)
    ax.set_title(f"{cfg.symbol} {cfg.timeframe} — Donchian trend-following, 3R target "
                 f"(fees+slippage, risk {cfg.risk_pct*100:.0f}%/trade)")
    ax.set_ylabel("equity"); ax.set_xlabel("date"); ax.legend(); ax.grid(alpha=0.25)
    fig.tight_layout(); fig.savefig(out_png, dpi=110)
    print(f"\nSaved -> {out_png}")


if __name__ == "__main__":
    main()

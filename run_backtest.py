"""Run the backtest on REAL BTCUSDT history with a chronological 60/40
in-sample / out-of-sample split. Reports IS and OOS SEPARATELY and saves an
equity-curve plot with the split marked.

IS and OOS are run as INDEPENDENT backtests, each starting from the same initial
equity, so every metric is self-consistent within its segment and OOS is a clean
"unseen" period. The plotted curve is the single continuous full-history run.

Note: this base run uses FIXED parameters (no fitting), so IS-vs-OOS here is a
consistency check. True out-of-sample-WITH-REFIT validation is walkforward.py.
"""
from __future__ import annotations

import argparse

import matplotlib
matplotlib.use("Agg")  # headless: save to file, no display
import matplotlib.pyplot as plt

import data
from config import Config, DEFAULT
from backtest import run_backtest
from metrics import compute_metrics, format_metrics


def main(cfg: Config = DEFAULT, start: str | None = None, end: str | None = None,
         split: float = 0.6, out_png: str = "equity_curve.png") -> None:
    df = data.load_ohlcv(cfg, start=start, end=end)
    print(data.summarize(df))
    n = len(df)
    split_idx = int(n * split)
    split_time = df.index[split_idx]

    is_df = df.iloc[:split_idx]
    oos_df = df.iloc[split_idx:]

    print(f"\nSplit at {split_time}  ->  IS {len(is_df):,} bars | OOS {len(oos_df):,} bars\n")

    full = run_backtest(df, cfg)
    is_res = run_backtest(is_df, cfg)
    oos_res = run_backtest(oos_df, cfg)

    m_full = compute_metrics(full, cfg, "FULL HISTORY")
    m_is = compute_metrics(is_res, cfg, "IN-SAMPLE (first 60%)")
    m_oos = compute_metrics(oos_res, cfg, "OUT-OF-SAMPLE (last 40%)")

    print(format_metrics(m_is)); print()
    print(format_metrics(m_oos)); print()
    print(format_metrics(m_full))

    # ---- equity curve plot (continuous full-history run, split marked) ----
    fig, ax = plt.subplots(figsize=(12, 6))
    ax.plot(full.equity_curve.index, full.equity_curve.values, lw=1.1, color="#1f77b4")
    ax.axvline(split_time, color="red", ls="--", lw=1.2, label="60/40 split")
    ax.axhline(cfg.initial_equity, color="gray", ls=":", lw=0.8)
    ax.fill_betweenx([full.equity_curve.min(), full.equity_curve.max()],
                     split_time, full.equity_curve.index[-1], color="orange", alpha=0.06,
                     label="out-of-sample region")
    ax.set_title(f"{cfg.symbol} {cfg.timeframe} — Elliott-inspired equity "
                 f"(fees {cfg.taker_fee*100:.2f}%/side + slippage, risk {cfg.risk_pct*100:.0f}%/trade)")
    ax.set_ylabel("equity (quote ccy)"); ax.set_xlabel("date")
    ax.legend(loc="upper left"); ax.grid(alpha=0.25)
    fig.tight_layout(); fig.savefig(out_png, dpi=110)
    print(f"\nSaved equity curve -> {out_png}")

    return m_is, m_oos, m_full


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default=DEFAULT.symbol)
    ap.add_argument("--timeframe", default=DEFAULT.timeframe)
    ap.add_argument("--start", default=None)
    ap.add_argument("--end", default=None)
    ap.add_argument("--split", type=float, default=0.6)
    args = ap.parse_args()
    cfg = Config(symbol=args.symbol, timeframe=args.timeframe)
    main(cfg, start=args.start, end=args.end, split=args.split)

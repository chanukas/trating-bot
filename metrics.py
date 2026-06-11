"""Performance metrics. LEADS with profit factor / expectancy / max drawdown.

Win rate is reported but DE-EMPHASISED on purpose: it ignores the SIZE of wins vs
losses. A wave-3 trend idea is expected to have a modest win rate carried by a few
large winners; expectancy and profit factor capture that, win rate alone misleads.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from config import Config, DEFAULT
from backtest import BacktestResult, Trade


def _max_drawdown(equity: np.ndarray) -> tuple[float, float]:
    """Return (max_drawdown_fraction, max_drawdown_abs) on an equity array."""
    if len(equity) == 0:
        return 0.0, 0.0
    peak = np.maximum.accumulate(equity)
    dd = equity - peak
    frac = np.where(peak > 0, dd / peak, 0.0)
    return float(-frac.min()), float(-dd.min())


def compute_metrics(result: BacktestResult, cfg: Config = DEFAULT,
                    label: str = "") -> dict:
    trades: list[Trade] = result.trades
    eq = result.equity_curve
    eq_arr = eq.to_numpy(float)

    pnls = np.array([t.pnl for t in trades], dtype=float)
    rs = np.array([t.r_multiple for t in trades], dtype=float)
    wins = pnls[pnls > 0]
    losses = pnls[pnls < 0]

    gross_profit = float(wins.sum())
    gross_loss = float(-losses.sum())
    profit_factor = (gross_profit / gross_loss) if gross_loss > 0 else float("inf") if gross_profit > 0 else 0.0

    mdd_frac, mdd_abs = _max_drawdown(eq_arr)

    # annualised Sharpe from per-bar mark-to-market returns
    rets = eq.pct_change().dropna().to_numpy(float)
    if rets.std() > 0:
        sharpe = float(rets.mean() / rets.std() * np.sqrt(cfg.periods_per_year))
    else:
        sharpe = 0.0

    n = len(trades)
    total_return = (eq_arr[-1] / cfg.initial_equity - 1.0) if len(eq_arr) else 0.0
    years = (eq.index[-1] - eq.index[0]).total_seconds() / (365 * 86400) if len(eq) > 1 else 0.0
    cagr = ((eq_arr[-1] / cfg.initial_equity) ** (1 / years) - 1.0) if years > 0 and eq_arr[-1] > 0 else 0.0

    return {
        "label": label,
        # ---- headline ----
        "profit_factor": profit_factor,
        "expectancy_$": float(pnls.mean()) if n else 0.0,
        "expectancy_R": float(rs.mean()) if n else 0.0,
        "max_drawdown_%": mdd_frac * 100,
        "max_drawdown_$": mdd_abs,
        # ---- supporting ----
        "num_trades": n,
        "win_rate_%": (len(wins) / n * 100) if n else 0.0,   # de-emphasised
        "avg_win_$": float(wins.mean()) if len(wins) else 0.0,
        "avg_loss_$": float(losses.mean()) if len(losses) else 0.0,
        "payoff_ratio": (float(wins.mean()) / float(-losses.mean())) if len(wins) and len(losses) else 0.0,
        "sharpe_annual": sharpe,
        "total_return_%": total_return * 100,
        "cagr_%": cagr * 100,
        "final_equity": float(eq_arr[-1]) if len(eq_arr) else cfg.initial_equity,
        "n_target": sum(1 for t in trades if t.reason == "target"),
        "n_stop": sum(1 for t in trades if t.reason == "stop"),
        "n_eod": sum(1 for t in trades if t.reason == "eod"),
    }


def format_metrics(m: dict) -> str:
    pf = m["profit_factor"]
    pf_s = "inf" if pf == float("inf") else f"{pf:.2f}"
    lines = [
        f"=== {m['label'] or 'metrics'} ===",
        "  -- headline (judge the system by these) --",
        f"  profit_factor : {pf_s:>10}     (>1 makes money; blends win freq & size)",
        f"  expectancy    : {m['expectancy_$']:>10.2f} $/trade  | {m['expectancy_R']:+.3f} R/trade",
        f"  max_drawdown  : {m['max_drawdown_%']:>9.1f}%     ({m['max_drawdown_$']:,.0f} $)",
        "  -- supporting --",
        f"  num_trades    : {m['num_trades']:>10}",
        f"  win_rate      : {m['win_rate_%']:>9.1f}%     (DE-EMPHASISED -- ignores win/loss size)",
        f"  avg_win/loss  : {m['avg_win_$']:>10.2f} / {m['avg_loss_$']:.2f} $   payoff {m['payoff_ratio']:.2f}",
        f"  sharpe (ann.) : {m['sharpe_annual']:>10.2f}",
        f"  total_return  : {m['total_return_%']:>9.1f}%     CAGR {m['cagr_%']:.1f}%   final_eq {m['final_equity']:,.0f}",
        f"  exits         : target={m['n_target']}  stop={m['n_stop']}  eod={m['n_eod']}",
    ]
    return "\n".join(lines)


if __name__ == "__main__":
    import data
    from backtest import run_backtest
    syn = data.generate_synthetic(n=6000, seed=1)
    res = run_backtest(syn, DEFAULT)
    print(format_metrics(compute_metrics(res, DEFAULT, "SYNTHETIC SMOKE -- MEANINGLESS")))

"""Trend-following strategy: Donchian channel breakout (the 'Turtle' idea).

Entry : go LONG when close breaks above the highest high of the prior `dc_entry`
        bars; go SHORT when it breaks below the prior `dc_entry`-bar low. Acted on
        the NEXT bar's open (the breakout bar is already closed -> no look-ahead).
Stop  : initial stop = entry -/+ atr_stop_mult * ATR(at entry).
Exit  : two modes -
        "trail"   -> ratcheting Donchian trailing stop (exit on a `dc_exit`-bar
                     low/high). Open-ended winners -- where trend edge usually lives.
        "rtarget" -> fixed target at trend_target_r * initial risk (your 1:3 style).

Same costs / slippage / worst-case-stop-first / fixed-% risk sizing as backtest.py,
and it returns a BacktestResult so metrics.py works unchanged.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from config import Config, DEFAULT
from indicators import atr
from backtest import Trade, BacktestResult


def run_trend_backtest(df: pd.DataFrame, cfg: Config = DEFAULT) -> BacktestResult:
    o = df["open"].to_numpy(float)
    h = df["high"].to_numpy(float)
    l = df["low"].to_numpy(float)
    c = df["close"].to_numpy(float)
    idx = df.index
    n = len(df)
    fee, slip = cfg.taker_fee, cfg.slippage

    a = atr(df, cfg.atr_period).to_numpy(float)
    # channels use bars STRICTLY BEFORE the current bar (shift(1)) -> no look-ahead
    up_entry = df["high"].rolling(cfg.dc_entry).max().shift(1).to_numpy(float)
    dn_entry = df["low"].rolling(cfg.dc_entry).min().shift(1).to_numpy(float)
    up_exit = df["high"].rolling(cfg.dc_exit).max().shift(1).to_numpy(float)
    dn_exit = df["low"].rolling(cfg.dc_exit).min().shift(1).to_numpy(float)

    warm = max(cfg.dc_entry, cfg.atr_period) + 1
    realized = cfg.initial_equity
    equity = np.empty(n)
    trades: list[Trade] = []
    pos: dict | None = None

    def close_pos(level, reason, t):
        nonlocal pos, realized
        d, qty, entry = pos["dir"], pos["qty"], pos["entry"]
        exit_fill = level * (1 - slip) if d == +1 else level * (1 + slip)
        gross = (exit_fill - entry) * qty if d == +1 else (entry - exit_fill) * qty
        net = gross - (entry + exit_fill) * qty * fee
        realized += net
        trades.append(Trade(d, pos["entry_idx"], t, idx[pos["entry_idx"]], idx[t],
                            entry, exit_fill, pos["stop0"], pos.get("target", float("nan")),
                            qty, net, net / pos["risk_amount"], reason, t - pos["entry_idx"]))
        pos = None

    for t in range(n):
        # ---- manage an open position FIRST (worst case: stop before target) ----
        if pos is not None:
            d = pos["dir"]
            if cfg.trend_exit == "trail":
                # ratchet the trailing stop using the Donchian exit channel
                if d == +1:
                    pos["stop"] = max(pos["stop"], dn_exit[t]) if not np.isnan(dn_exit[t]) else pos["stop"]
                    if l[t] <= pos["stop"]:
                        close_pos(min(o[t], pos["stop"]), "trail", t)
                else:
                    pos["stop"] = min(pos["stop"], up_exit[t]) if not np.isnan(up_exit[t]) else pos["stop"]
                    if h[t] >= pos["stop"]:
                        close_pos(max(o[t], pos["stop"]), "trail", t)
            else:  # rtarget: fixed bracket
                if d == +1:
                    if l[t] <= pos["stop"]:
                        close_pos(pos["stop"], "stop", t)
                    elif h[t] >= pos["target"]:
                        close_pos(pos["target"], "target", t)
                else:
                    if h[t] >= pos["stop"]:
                        close_pos(pos["stop"], "stop", t)
                    elif l[t] <= pos["target"]:
                        close_pos(pos["target"], "target", t)

        # ---- entries: act at THIS bar's open on the PREVIOUS (closed) bar's signal ----
        if pos is None and t > warm:
            long_sig = c[t - 1] > up_entry[t - 1] and not np.isnan(up_entry[t - 1])
            short_sig = c[t - 1] < dn_entry[t - 1] and not np.isnan(dn_entry[t - 1])
            d = +1 if long_sig else (-1 if (short_sig and cfg.allow_shorts) else 0)
            if d != 0:
                entry = o[t] * (1 + slip) if d == +1 else o[t] * (1 - slip)
                stop0 = entry - cfg.atr_stop_mult * a[t] if d == +1 else entry + cfg.atr_stop_mult * a[t]
                stop_dist = abs(entry - stop0)
                if stop_dist > 0:
                    risk_amount = realized * cfg.risk_pct
                    qty = risk_amount / stop_dist
                    pos = {"dir": d, "entry": entry, "stop0": stop0, "stop": stop0,
                           "qty": qty, "entry_idx": t, "risk_amount": risk_amount}
                    if cfg.trend_exit == "rtarget":
                        pos["target"] = entry + cfg.trend_target_r * stop_dist if d == +1 \
                            else entry - cfg.trend_target_r * stop_dist
                    # worst-case: the entry bar itself may hit the stop
                    if d == +1 and l[t] <= stop0:
                        close_pos(stop0, "stop", t)
                    elif d == -1 and h[t] >= stop0:
                        close_pos(stop0, "stop", t)

        # ---- mark-to-market equity ----
        if pos is not None:
            d, qty, entry = pos["dir"], pos["qty"], pos["entry"]
            gross = (c[t] - entry) * qty if d == +1 else (entry - c[t]) * qty
            equity[t] = realized + gross - (entry + c[t]) * qty * fee
        else:
            equity[t] = realized

    if pos is not None:
        close_pos(c[n - 1], "eod", n - 1)
        equity[n - 1] = realized

    return BacktestResult(trades, pd.Series(equity, index=idx, name="equity"), cfg)


if __name__ == "__main__":
    import data
    from metrics import compute_metrics, format_metrics
    df = data.load_ohlcv(DEFAULT)
    res = run_trend_backtest(df, DEFAULT)
    print(format_metrics(compute_metrics(res, DEFAULT, "TREND (trail) full history")))

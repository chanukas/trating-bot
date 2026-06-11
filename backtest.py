"""Event-driven backtest engine.

Rules (deliberately conservative):
  * one position at a time; bracket order (entry stop-order, hard stop, fib target)
  * a pending setup is re-evaluated whenever a new pivot confirms; trades the most
    recent valid 3-pivot structure; cancelled if the stop level is breached before
    triggering, or after `setup_expiry_bars`
  * NO look-ahead: a setup armed at bar `created_idx` can only trigger from the
    NEXT bar onward
  * gap handling: a stop-order that gaps through fills at the bar's open
  * worst-case fills: if a bar touches BOTH stop and target, the STOP fills first
    (checked on the entry bar too)
  * realistic costs: taker fee + slippage charged on entry AND exit
  * sizing: risk a fixed % of current equity, sized off the entry->stop distance
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from config import Config, DEFAULT
from indicators import Pivot, zigzag, ema
from elliott import Setup, detect_setup


@dataclass
class Trade:
    direction: int
    entry_idx: int
    exit_idx: int
    entry_time: pd.Timestamp
    exit_time: pd.Timestamp
    entry_price: float
    exit_price: float
    stop: float
    target: float
    qty: float
    pnl: float        # net of fees & slippage, in quote currency
    r_multiple: float
    reason: str       # 'target' | 'stop' | 'eod' (forced close at series end)
    bars_held: int


@dataclass
class BacktestResult:
    trades: list[Trade]
    equity_curve: pd.Series  # mark-to-market equity, indexed by timestamp
    cfg: Config


def _exit_level(direction: int, t: int, high, low, pos) -> tuple[float | None, str | None]:
    """Worst-case exit check for bar t. Stop is tested BEFORE target."""
    if direction == +1:
        if low[t] <= pos["stop"]:
            return pos["stop"], "stop"
        if high[t] >= pos["target"]:
            return pos["target"], "target"
    else:
        if high[t] >= pos["stop"]:
            return pos["stop"], "stop"
        if low[t] <= pos["target"]:
            return pos["target"], "target"
    return None, None


def run_backtest(df: pd.DataFrame, cfg: Config = DEFAULT,
                 pivots: list[Pivot] | None = None) -> BacktestResult:
    if pivots is None:
        pivots = zigzag(df, cfg)

    open_ = df["open"].to_numpy(float)
    high = df["high"].to_numpy(float)
    low = df["low"].to_numpy(float)
    close = df["close"].to_numpy(float)
    idx = df.index
    n = len(df)
    fee, slip = cfg.taker_fee, cfg.slippage
    ema_arr = ema(df["close"], cfg.trend_ema).to_numpy(float) if cfg.trend_filter else None
    arm_warmup = max(cfg.warmup_bars, cfg.trend_ema if cfg.trend_filter else 0)

    realized = cfg.initial_equity
    equity = np.empty(n)
    trades: list[Trade] = []
    pos: dict | None = None
    pending: Setup | None = None

    confirmed: list[Pivot] = []
    piv_ptr = 0

    def open_position(direction, fill_base, t):
        nonlocal pos
        if direction == +1:
            entry = fill_base * (1.0 + slip)
            stop = pending.stop
            stop_dist = entry - stop
        else:
            entry = fill_base * (1.0 - slip)
            stop = pending.stop
            stop_dist = stop - entry
        if stop_dist <= 0:
            return  # malformed; skip
        risk_amount = realized * cfg.risk_pct
        qty = risk_amount / stop_dist
        pos = {"dir": direction, "entry": entry, "stop": stop,
               "target": pending.target, "qty": qty, "entry_idx": t,
               "risk_amount": risk_amount}

    def close_position(level, reason, t):
        nonlocal pos, realized
        d, qty, entry = pos["dir"], pos["qty"], pos["entry"]
        exit_fill = level * (1.0 - slip) if d == +1 else level * (1.0 + slip)
        gross = (exit_fill - entry) * qty if d == +1 else (entry - exit_fill) * qty
        fees = (entry + exit_fill) * qty * fee
        net = gross - fees
        realized += net
        trades.append(Trade(
            direction=d, entry_idx=pos["entry_idx"], exit_idx=t,
            entry_time=idx[pos["entry_idx"]], exit_time=idx[t],
            entry_price=entry, exit_price=exit_fill, stop=pos["stop"],
            target=pos["target"], qty=qty, pnl=net,
            r_multiple=net / pos["risk_amount"], reason=reason,
            bars_held=t - pos["entry_idx"]))
        pos = None

    for t in range(n):
        # 1) ingest pivots that become known at bar t
        new_confirmed = False
        while piv_ptr < len(pivots) and pivots[piv_ptr].confirm_idx == t:
            confirmed.append(pivots[piv_ptr])
            piv_ptr += 1
            new_confirmed = True

        # 2) manage an OPEN position on this bar (stop-first worst case)
        if pos is not None:
            level, reason = _exit_level(pos["dir"], t, high, low, pos)
            if level is not None:
                close_position(level, reason, t)

        # 3) if flat, try to trigger the pending setup (only AFTER it was armed)
        if pos is None and pending is not None:
            if t - pending.created_idx > cfg.setup_expiry_bars:
                pending = None
            elif t > pending.created_idx:
                if pending.direction == +1:
                    if low[t] <= pending.stop:           # invalidated before trigger
                        pending = None
                    elif high[t] >= pending.entry:        # buy-stop hit (gap -> open)
                        open_position(+1, max(pending.entry, open_[t]), t)
                else:
                    if high[t] >= pending.stop:
                        pending = None
                    elif low[t] <= pending.entry:         # sell-stop hit (gap -> open)
                        open_position(-1, min(pending.entry, open_[t]), t)
                # worst-case: the very same entry bar may also hit stop/target
                if pos is not None:
                    level, reason = _exit_level(pos["dir"], t, high, low, pos)
                    if level is not None:
                        close_position(level, reason, t)
                    if pos is not None:
                        pending = None  # consumed

        # 4) (re)arm pending from the latest confirmed structure when a pivot just confirmed
        if pos is None and new_confirmed and t >= arm_warmup:
            s = detect_setup(confirmed, cfg)
            pending = None
            if s is not None and (cfg.allow_shorts or s.direction == +1):
                if not cfg.trend_filter:
                    pending = s
                else:
                    # H1: only trade breakouts WITH the trend (no look-ahead: EMA at bar t)
                    up = close[t] > ema_arr[t]
                    if (s.direction == +1 and up) or (s.direction == -1 and not up):
                        pending = s

        # 5) record mark-to-market equity
        if pos is not None:
            d, qty, entry = pos["dir"], pos["qty"], pos["entry"]
            gross = (close[t] - entry) * qty if d == +1 else (entry - close[t]) * qty
            mtm = gross - (entry + close[t]) * qty * fee
            equity[t] = realized + mtm
        else:
            equity[t] = realized

    # force-close any position still open at the end of the series (at last close)
    if pos is not None:
        close_position(close[n - 1], "eod", n - 1)
        equity[n - 1] = realized

    return BacktestResult(trades=trades,
                          equity_curve=pd.Series(equity, index=idx, name="equity"),
                          cfg=cfg)


if __name__ == "__main__":
    import data
    # SMOKE TEST on SYNTHETIC data -- MEANINGLESS numbers, just proves it runs.
    syn = data.generate_synthetic(n=6000, seed=1)
    res = run_backtest(syn, DEFAULT)
    pnl = sum(t.pnl for t in res.trades)
    print(f"[SMOKE/synthetic -- meaningless] trades={len(res.trades)} "
          f"final_equity={res.equity_curve.iloc[-1]:,.0f} sum_pnl={pnl:,.0f}")
    if res.trades:
        wins = sum(1 for t in res.trades if t.pnl > 0)
        print(f"   wins={wins} reasons={ {r: sum(1 for t in res.trades if t.reason==r) for r in ['target','stop','eod']} }")

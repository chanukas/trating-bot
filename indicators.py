"""Indicators: Wilder ATR, an ATR-based ZigZag pivot detector, and Fib helpers.

The ZigZag is the heart of the no-look-ahead design. Each pivot carries a
`confirm_idx`: the bar index at which the pivot first became *knowable* (i.e.
when price had reversed by the ATR threshold away from the extreme). The
strategy is only ever allowed to use pivots whose confirm_idx <= current bar.
That is what prevents the classic ZigZag "repaint" look-ahead cheat.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from config import Config, DEFAULT


@dataclass
class Pivot:
    idx: int          # bar index where the swing extreme occurred
    price: float      # the extreme price (a high or a low)
    kind: str         # 'H' or 'L'
    confirm_idx: int  # bar index at which this pivot became known (no look-ahead)


def atr(df: pd.DataFrame, period: int) -> pd.Series:
    """Wilder's ATR via RMA (ewm alpha=1/period). Finite from bar 0 (seeded by TR[0])."""
    high, low, close = df["high"], df["low"], df["close"]
    prev_close = close.shift(1)
    tr = pd.concat([(high - low),
                    (high - prev_close).abs(),
                    (low - prev_close).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1.0 / period, adjust=False).mean()


def zigzag(df: pd.DataFrame, cfg: Config = DEFAULT) -> list[Pivot]:
    """ATR-based ZigZag. Returns strictly alternating H/L pivots, each with a
    confirmation index. Reversal threshold at bar i = ATR[i] * cfg.zigzag_atr_mult.

    State machine:
      trend = 0  -> seeking the very first pivot (direction unknown)
      trend = +1 -> in an up-leg; last confirmed pivot was a Low; tracking a High
      trend = -1 -> in a down-leg; last confirmed pivot was a High; tracking a Low
    On a confirmed reversal the tracked extreme becomes a pivot and we flip trend.
    When a new leg starts, its extreme is (re)seeded as the true high/low over the
    bars from the just-confirmed pivot up to the current bar -- all <= current bar,
    so no future information is used.
    """
    high = df["high"].to_numpy(dtype=float)
    low = df["low"].to_numpy(dtype=float)
    atr_arr = atr(df, cfg.atr_period).to_numpy(dtype=float)
    n = len(df)
    mult = cfg.zigzag_atr_mult
    start = cfg.atr_period  # let ATR stabilise before we trust the threshold
    if n <= start + 2:
        return []

    pivots: list[Pivot] = []
    trend = 0
    # running extremes used only during the unknown-direction seeding phase
    max_i, max_p = start, high[start]
    min_i, min_p = start, low[start]
    ext_i, ext_p = start, high[start]  # current-leg tracked extreme

    for i in range(start, n):
        thr = atr_arr[i] * mult

        if trend == 0:
            # --- seeding: figure out whether the first pivot is a Low or a High ---
            if high[i] > max_p:
                max_p, max_i = high[i], i
            if low[i] < min_p:
                min_p, min_i = low[i], i
            up = (high[i] - min_p) >= thr      # rose thr above the running min -> first pivot is that Low
            dn = (max_p - low[i]) >= thr       # fell thr below the running max -> first pivot is that High
            if up and dn:                      # both in one bar: the earlier extreme wins
                if min_i <= max_i:
                    dn = False
                else:
                    up = False
            if up:
                pivots.append(Pivot(min_i, min_p, "L", i))
                trend = 1
                ext_i = (min_i + 1 + int(np.argmax(high[min_i + 1:i + 1]))) if i > min_i else i
                ext_p = high[ext_i]
            elif dn:
                pivots.append(Pivot(max_i, max_p, "H", i))
                trend = -1
                ext_i = (max_i + 1 + int(np.argmin(low[max_i + 1:i + 1]))) if i > max_i else i
                ext_p = low[ext_i]

        elif trend == 1:
            # up-leg: track the highest high; confirm a High when price drops thr off it
            if high[i] > ext_p:
                ext_p, ext_i = high[i], i
            if (ext_p - low[i]) >= thr:
                pivots.append(Pivot(ext_i, ext_p, "H", i))
                trend = -1
                lo_i = (ext_i + 1 + int(np.argmin(low[ext_i + 1:i + 1]))) if i > ext_i else i
                ext_i, ext_p = lo_i, low[lo_i]

        else:  # trend == -1
            # down-leg: track the lowest low; confirm a Low when price rises thr off it
            if low[i] < ext_p:
                ext_p, ext_i = low[i], i
            if (high[i] - ext_p) >= thr:
                pivots.append(Pivot(ext_i, ext_p, "L", i))
                trend = 1
                hi_i = (ext_i + 1 + int(np.argmax(high[ext_i + 1:i + 1]))) if i > ext_i else i
                ext_i, ext_p = hi_i, high[hi_i]

    return pivots


def confirmed_upto(pivots: list[Pivot], t: int) -> list[Pivot]:
    """Pivots knowable at bar t (confirm_idx <= t). Cheap because pivots are ordered."""
    return [p for p in pivots if p.confirm_idx <= t]


def ema(series: pd.Series, period: int) -> pd.Series:
    """Standard exponential moving average."""
    return series.ewm(span=period, adjust=False).mean()


def fib_extension(start: float, end: float, ext: float) -> float:
    """Project a move of length (end-start) by `ext` from `end`."""
    return end + (end - start) * (ext - 1.0)


if __name__ == "__main__":
    import data
    df = data.load_ohlcv(DEFAULT)
    a = atr(df, DEFAULT.atr_period)
    piv = zigzag(df, DEFAULT)
    kinds = [p.kind for p in piv]
    alternating = all(kinds[i] != kinds[i + 1] for i in range(len(kinds) - 1))
    # average confirmation lag (bars between extreme and when it became known)
    lag = np.mean([p.confirm_idx - p.idx for p in piv]) if piv else float("nan")
    print(f"ATR last: {a.iloc[-1]:.1f}")
    print(f"pivots: {len(piv)}  | strictly alternating H/L: {alternating}")
    print(f"first kinds: {kinds[:8]}")
    print(f"avg confirmation lag: {lag:.1f} bars (knowable AFTER the extreme, not at it)")
    if piv:
        for p in piv[:4]:
            print(f"  {p.kind} @ bar {p.idx} ({df.index[p.idx].date()}) "
                  f"price {p.price:,.0f}  confirmed at bar {p.confirm_idx}")

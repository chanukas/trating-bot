"""Elliott-INSPIRED signal logic. Pure functions, no I/O, no look-ahead.

We do NOT count waves subjectively. We mechanise one narrow, testable idea:
from three consecutive confirmed ZigZag pivots, detect a probable Wave 1 + Wave 2
and define a bracket order to try to catch the start of Wave 3.

Bullish  L0 -> H1 -> L2 :  require L2 > L0  and  retrace (H1-L2)/(H1-L0) in [min,max]
  entry  = break above H1   (buy-stop, proxy for wave-3 start)
  stop   = just below L2
  target = L2 + fib_ext*(H1-L0)        (1.618 extension of wave 1, projected from L2)

Bearish  H0 -> L1 -> H2 :  mirror image.
"""
from __future__ import annotations

from dataclasses import dataclass

from config import Config, DEFAULT
from indicators import Pivot


@dataclass
class Setup:
    direction: int      # +1 long, -1 short
    entry: float        # trigger price for the stop-order
    stop: float
    target: float
    retrace: float      # wave-2 retracement fraction (for inspection)
    rr: float           # reward:risk at the planned levels
    created_idx: int    # = confirm_idx of the last pivot; earliest actionable bar is created_idx+1
    p0_idx: int
    p1_idx: int
    p2_idx: int
    p0: float
    p1: float
    p2: float


def detect_setup(confirmed: list[Pivot], cfg: Config = DEFAULT) -> Setup | None:
    """Build a Setup from the three most-recent CONFIRMED pivots, or None.

    Caller guarantees every pivot in `confirmed` has confirm_idx <= current bar,
    so acting on this setup from (created_idx + 1) onward has no look-ahead.
    """
    if len(confirmed) < 3:
        return None
    p0, p1, p2 = confirmed[-3], confirmed[-2], confirmed[-1]

    # require a clean, temporally-ordered structure (drops rare same-bar pivots)
    if not (p0.idx < p1.idx < p2.idx):
        return None

    created_idx = p2.confirm_idx

    # ---------------- bullish: L0 -> H1 -> L2 ----------------
    if p0.kind == "L" and p1.kind == "H" and p2.kind == "L":
        L0, H1, L2 = p0.price, p1.price, p2.price
        wave1 = H1 - L0
        if wave1 <= 0 or not (L2 > L0):          # Elliott rule: wave 2 can't erase wave 1
            return None
        retrace = (H1 - L2) / wave1
        if not (cfg.retrace_min <= retrace <= cfg.retrace_max):
            return None
        entry = H1 * (1.0 + cfg.trigger_buffer)
        stop = L2 * (1.0 - cfg.stop_buffer)
        risk = entry - stop
        if risk <= 0:
            return None
        target = entry + cfg.target_r * risk if cfg.use_r_target else L2 + cfg.fib_ext * wave1
        rr = (target - entry) / risk
        if rr < cfg.min_rr:
            return None
        return Setup(+1, entry, stop, target, retrace, rr, created_idx,
                     p0.idx, p1.idx, p2.idx, L0, H1, L2)

    # ---------------- bearish: H0 -> L1 -> H2 ----------------
    if p0.kind == "H" and p1.kind == "L" and p2.kind == "H":
        H0, L1, H2 = p0.price, p1.price, p2.price
        wave1 = H0 - L1
        if wave1 <= 0 or not (H2 < H0):
            return None
        retrace = (H2 - L1) / wave1
        if not (cfg.retrace_min <= retrace <= cfg.retrace_max):
            return None
        entry = L1 * (1.0 - cfg.trigger_buffer)
        stop = H2 * (1.0 + cfg.stop_buffer)
        risk = stop - entry
        if risk <= 0:
            return None
        target = entry - cfg.target_r * risk if cfg.use_r_target else H2 - cfg.fib_ext * wave1
        rr = (entry - target) / risk
        if rr < cfg.min_rr:
            return None
        return Setup(-1, entry, stop, target, retrace, rr, created_idx,
                     p0.idx, p1.idx, p2.idx, H0, L1, H2)

    return None


if __name__ == "__main__":
    import data
    from indicators import zigzag, confirmed_upto

    df = data.load_ohlcv(DEFAULT)
    pivots = zigzag(df, DEFAULT)

    # Walk every confirmation event and collect the setups that would have armed,
    # exactly as the backtest will see them (no look-ahead).
    setups, seen = [], 0
    confirm_bars = sorted({p.confirm_idx for p in pivots})
    for t in confirm_bars:
        s = detect_setup(confirmed_upto(pivots, t), DEFAULT)
        if s is not None:
            setups.append(s)
    longs = [s for s in setups if s.direction == +1]
    shorts = [s for s in setups if s.direction == -1]
    print(f"setups armed across history: {len(setups)} (long {len(longs)}, short {len(shorts)})")
    print(f"avg reward:risk = {sum(s.rr for s in setups)/len(setups):.2f}" if setups else "no setups")
    print("\nfirst 5 setups (as they would arm, no look-ahead):")
    for s in setups[:5]:
        d = "LONG " if s.direction == +1 else "SHORT"
        print(f"  {d} armed@bar{s.created_idx} ({df.index[s.created_idx].date()}) "
              f"entry {s.entry:,.0f} stop {s.stop:,.0f} target {s.target:,.0f} "
              f"retr {s.retrace:.2f} RR {s.rr:.2f}")

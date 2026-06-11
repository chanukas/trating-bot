"""SIGNAL ADVISOR — suggests trades for MANUAL execution, and explains why.

Does NOT place orders. Reads the latest CLOSED-candle data and reports, for each
strategy: whether there's a setup now, the exact entry/stop/target, WHY, and the
HONEST backtested track record.

  1) TREND   (Donchian breakout, 3R) -- VALIDATED: positive IS/OOS/walk-forward.
  2) ELLIOTT (wave-3 breakout, 3R)   -- EXPERIMENTAL: only ~breakeven.

This module exposes data functions (report()) used by both the CLI and webapp.py.

CLI:  ./.venv/Scripts/python.exe advisor.py [--as-of 2025-03-15]
"""
from __future__ import annotations

import dataclasses
import time

import data
from config import Config, DEFAULT, interval_ms
from indicators import zigzag, confirmed_upto, atr
from elliott import detect_setup
from backtest import run_backtest
from trend import run_trend_backtest
from metrics import compute_metrics

TREND_CFG = dataclasses.replace(DEFAULT, trend_exit="rtarget", trend_target_r=3.0, allow_shorts=True)
ELLIOTT_CFG = dataclasses.replace(DEFAULT, use_r_target=True, target_r=3.0)


def drop_forming_candle(df, timeframe):
    now_ms = int(time.time() * 1000)
    last_open_ms = int(df.index[-1].value // 1_000_000)
    return df.iloc[:-1] if last_open_ms + interval_ms(timeframe) > now_ms else df


def _record(run_fn, cfg, df) -> dict:
    n = len(df); split = int(n * 0.6)
    keys = ("num_trades", "win_rate_%", "expectancy_R", "profit_factor", "max_drawdown_%")
    def pick(m):
        d = {k: m[k] for k in keys}
        d["profit_factor"] = None if m["profit_factor"] == float("inf") else round(m["profit_factor"], 2)
        return d
    full = compute_metrics(run_fn(df, cfg), cfg)
    oos = compute_metrics(run_fn(df.iloc[split:], cfg), cfg)
    return {"full": pick(full), "oos": pick(oos)}


# --------------------------------------------------------------------------- #
def trend_signal(df, cfg) -> dict | None:
    up = df["high"].rolling(cfg.dc_entry).max().shift(1)
    dn = df["low"].rolling(cfg.dc_entry).min().shift(1)
    a = float(atr(df, cfg.atr_period).iloc[-1])
    close = float(df["close"].iloc[-1])
    up_now, dn_now = float(up.iloc[-1]), float(dn.iloc[-1])
    prev_close, up_prev, dn_prev = float(df["close"].iloc[-2]), float(up.iloc[-2]), float(dn.iloc[-2])

    if close > up_now:
        entry, fresh = close, prev_close <= up_prev
        stop = entry - cfg.atr_stop_mult * a
        return {"side": "LONG", "fresh": fresh, "entry": entry, "stop": stop,
                "target": entry + cfg.trend_target_r * (entry - stop), "rr": cfg.trend_target_r,
                "why": f"close {close:,.0f} broke above the {cfg.dc_entry}-bar high {up_now:,.0f}",
                "risk_per_unit": entry - stop}
    if cfg.allow_shorts and close < dn_now:
        entry, fresh = close, prev_close >= dn_prev
        stop = entry + cfg.atr_stop_mult * a
        return {"side": "SHORT", "fresh": fresh, "entry": entry, "stop": stop,
                "target": entry - cfg.trend_target_r * (entry - stop), "rr": cfg.trend_target_r,
                "why": f"close {close:,.0f} broke below the {cfg.dc_entry}-bar low {dn_now:,.0f}",
                "risk_per_unit": stop - entry}
    return {"side": None, "channel_low": dn_now, "channel_high": up_now}


def _elliott_status(df, setup, cfg) -> str:
    high, low = df["high"].to_numpy(float), df["low"].to_numpy(float)
    t = len(df) - 1
    if t - setup.created_idx > cfg.setup_expiry_bars:
        return "expired"
    for j in range(setup.created_idx + 1, t + 1):
        if setup.direction == +1:
            if low[j] <= setup.stop: return "invalidated"
            if high[j] >= setup.entry: return "triggered"
        else:
            if high[j] >= setup.stop: return "invalidated"
            if low[j] <= setup.entry: return "triggered"
    return "armed"


def elliott_signal(df, cfg) -> dict | None:
    setup = detect_setup(confirmed_upto(zigzag(df, cfg), len(df) - 1), cfg)
    if setup is None:
        return {"side": None}
    return {"side": "LONG" if setup.direction == +1 else "SHORT",
            "status": _elliott_status(df, setup, cfg),
            "entry": setup.entry, "stop": setup.stop, "target": setup.target,
            "rr": round(setup.rr, 1), "retrace_pct": round(setup.retrace * 100),
            "why": f"3 swing pivots, wave-2 retrace {setup.retrace*100:.0f}% (valid 38-89%)"}


def report(as_of: str | None = None, df=None) -> dict:
    if df is None:
        df = drop_forming_candle(data.load_ohlcv(TREND_CFG), TREND_CFG.timeframe)
    if as_of:
        df = df.loc[:as_of]
    return {
        "symbol": TREND_CFG.symbol, "timeframe": TREND_CFG.timeframe,
        "asof": str(df.index[-1]), "price": float(df["close"].iloc[-1]),
        "trend": {"name": "Trend — Donchian breakout, 3R target", "validated": True,
                  "signal": trend_signal(df, TREND_CFG),
                  "record": _record(run_trend_backtest, TREND_CFG, df)},
        "elliott": {"name": "Elliott — wave-3 breakout, 3R target", "validated": False,
                    "signal": elliott_signal(df, ELLIOTT_CFG),
                    "record": _record(run_backtest, ELLIOTT_CFG, df)},
    }


def advise(as_of: str | None = None):
    r = report(as_of)
    print("=" * 70)
    print(f"  {r['symbol']} {r['timeframe']} — SIGNAL ADVISOR (you trade manually)")
    print("=" * 70)
    print(f"as of {r['asof']}  |  last closed price: {r['price']:,.2f}")
    for key, tag in (("trend", "VALIDATED"), ("elliott", "EXPERIMENTAL ~breakeven")):
        blk = r[key]; sig = blk["signal"]; rec = blk["record"]
        print(f"\n[{ '1' if key=='trend' else '2'}] {blk['name']}   ({tag})")
        if not sig or sig.get("side") is None:
            print("    SIGNAL: NONE")
        else:
            extra = f" [{sig['status'].upper()}]" if "status" in sig else \
                    (" (FRESH — actionable)" if sig.get("fresh") else " (already broken out — chasing worsens R:R)")
            print(f"    SIGNAL: {sig['side']}{extra}")
            print(f"      why    : {sig['why']}")
            print(f"      entry {sig['entry']:,.0f} | stop {sig['stop']:,.0f} | "
                  f"target {sig['target']:,.0f}  ({sig['rr']}:1)")
        for scope in ("full", "oos"):
            m = rec[scope]
            print(f"      {scope:<4}: {m['num_trades']} trades | win {m['win_rate_%']:.0f}% | "
                  f"exp {m['expectancy_R']:+.3f}R | PF {m['profit_factor']} | maxDD {m['max_drawdown_%']:.0f}%")
    print("\n" + "-" * 70)
    print("NOT financial advice. Trend = real but MODEST edge (~30% win rate, ~29% DD).")


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--as-of", default=None)
    advise(as_of=ap.parse_args().as_of)

"""PAPER / TESTNET skeleton -- NOT runnable live by default.

Safety model (read this):
  * Trades Binance SPOT TESTNET only, via ccxt sandbox mode. Testnet money is fake.
  * `ALLOW_LIVE` is hard-coded False. The script REFUSES to run against real money
    unless YOU edit that constant AND set GO_LIVE=1 in the env. I will not flip it.
  * Keys come from environment variables ONLY -- never hard-coded, never logged.
  * It acts ONLY on CLOSED candles (the still-forming candle is dropped each loop).
  * RiskLimits + a kill-switch file can halt trading at any time.

Get FREE testnet keys at https://testnet.binance.vision (login with GitHub).
On the API key: DISABLE withdrawals. Enable only spot trading. (Testnet can't
withdraw anyway, but build the habit now.)

Required env vars (testnet):
  BINANCE_TESTNET_API_KEY, BINANCE_TESTNET_API_SECRET

This file is intentionally a SKELETON: the structure, safety rails and signal wiring
are real, but you should paper-trade it and read every order before trusting it.
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass, field

import pandas as pd

from config import Config, DEFAULT, ccxt_symbol, interval_ms
from indicators import zigzag, confirmed_upto
from elliott import detect_setup, Setup

# ─────────────────────────────────────────────────────────────────────────────
ALLOW_LIVE = False           # <-- HARD SAFETY. Do not change unless you mean it.
KILL_SWITCH_FILE = "KILL"    # create a file named KILL in the cwd to halt instantly
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class RiskLimits:
    max_risk_per_trade: float = 0.01     # fraction of equity risked per trade
    max_open_positions: int = 1
    max_daily_loss: float = 0.03         # halt for the day after -3% equity
    max_consecutive_losses: int = 4      # halt after N losses in a row


@dataclass
class RiskState:
    day: str = ""
    day_start_equity: float = 0.0
    consecutive_losses: int = 0
    halted: bool = False
    reason: str = ""


class PaperTrader:
    def __init__(self, cfg: Config = DEFAULT, limits: RiskLimits = RiskLimits(),
                 live: bool = False):
        self.cfg = cfg
        self.limits = limits
        self.live = live
        self.ex = None
        self.risk = RiskState()
        self._last_candle_ts = None

    # ---- connection (testnet enforced unless explicitly + dangerously overridden) ----
    def connect(self):
        import ccxt
        key = os.environ.get("BINANCE_TESTNET_API_KEY")
        secret = os.environ.get("BINANCE_TESTNET_API_SECRET")
        if not key or not secret:
            raise SystemExit(
                "Missing testnet keys. Set BINANCE_TESTNET_API_KEY and "
                "BINANCE_TESTNET_API_SECRET (free at https://testnet.binance.vision). "
                "Disable withdrawal permission on the key.")
        go_live = os.environ.get("GO_LIVE") == "1"
        if self.live or go_live:
            if not (ALLOW_LIVE and self.live and go_live):
                raise SystemExit(
                    "LIVE trading blocked. Requires ALL of: ALLOW_LIVE=True in code, "
                    "live=True, and GO_LIVE=1 in env. Refusing. (This is on purpose.)")
        self.ex = ccxt.binance({
            "apiKey": key, "secret": secret, "enableRateLimit": True,
            "options": {"defaultType": "spot"},
        })
        self.ex.set_sandbox_mode(True)   # <-- TESTNET. Always on in this skeleton.
        self.ex.load_markets()
        print(f"[live] connected to Binance SPOT TESTNET (sandbox). live={self.live} "
              f"-> trading is PAPER.")

    # ---- the still-forming candle must never be used; we drop it ----
    def fetch_closed_ohlcv(self, limit: int = 500) -> pd.DataFrame:
        raw = self.ex.fetch_ohlcv(ccxt_symbol(self.cfg.symbol), self.cfg.timeframe, limit=limit)
        df = pd.DataFrame(raw, columns=["t", "open", "high", "low", "close", "volume"])
        df.index = pd.to_datetime(df["t"], unit="ms", utc=True)
        df = df.drop(columns="t")
        # Drop the last row if its candle has not closed yet.
        now_ms = self.ex.milliseconds()
        last_open_ms = int(df.index[-1].value // 1_000_000)
        if last_open_ms + interval_ms(self.cfg.timeframe) > now_ms:
            df = df.iloc[:-1]
        return df

    # ---- risk gates -----------------------------------------------------------
    def _check_risk(self, equity: float) -> bool:
        if os.path.exists(KILL_SWITCH_FILE):
            self.risk.halted, self.risk.reason = True, "KILL switch file present"
        today = time.strftime("%Y-%m-%d")
        if self.risk.day != today:
            self.risk.day, self.risk.day_start_equity = today, equity
            self.risk.consecutive_losses = 0  # fresh day
        if equity <= self.risk.day_start_equity * (1 - self.limits.max_daily_loss):
            self.risk.halted, self.risk.reason = True, "max daily loss hit"
        if self.risk.consecutive_losses >= self.limits.max_consecutive_losses:
            self.risk.halted, self.risk.reason = True, "max consecutive losses hit"
        if self.risk.halted:
            print(f"[live] HALTED: {self.risk.reason}. No new entries.")
        return not self.risk.halted

    # ---- placing the bracket (testnet) ----------------------------------------
    def place_bracket(self, setup: Setup, equity: float):
        """Skeleton: entry stop-order + protective stop + take-profit.

        On Binance spot you'd typically place the entry, then an OCO
        (stop-loss + take-profit) once filled. Left as clearly-marked TODO so you
        verify behaviour on TESTNET before relying on it.
        """
        side = "buy" if setup.direction == +1 else "sell"
        risk_amount = equity * self.limits.max_risk_per_trade
        stop_dist = abs(setup.entry - setup.stop)
        qty = risk_amount / stop_dist if stop_dist > 0 else 0.0
        print(f"[live][PAPER] would {side} ~{qty:.6f} {self.cfg.symbol} "
              f"entry~{setup.entry:.2f} stop {setup.stop:.2f} target {setup.target:.2f}")
        # --- TODO (verify on testnet before use) ---
        # entry = self.ex.create_order(sym, 'stop_loss_limit' / 'market', side, qty, ...)
        # then OCO: self.ex.private_post_order_oco({...}) for stop + take-profit
        return None

    # ---- one iteration on CLOSED data -----------------------------------------
    def step(self):
        df = self.fetch_closed_ohlcv()
        if self._last_candle_ts == df.index[-1]:
            return  # no new closed candle yet
        self._last_candle_ts = df.index[-1]

        # equity from the (testnet) account
        bal = self.ex.fetch_balance()
        quote = self.cfg.symbol[-4:] if self.cfg.symbol.endswith("USDT") else "USDT"
        equity = float(bal.get("total", {}).get(quote, 0.0)) or self.cfg.initial_equity

        if not self._check_risk(equity):
            return

        pivots = zigzag(df, self.cfg)
        t = len(df) - 1
        setup = detect_setup(confirmed_upto(pivots, t), self.cfg)
        open_orders = self.ex.fetch_open_orders(ccxt_symbol(self.cfg.symbol))
        if setup is not None and len(open_orders) < self.limits.max_open_positions:
            if self.cfg.allow_shorts or setup.direction == +1:
                self.place_bracket(setup, equity)

    def run(self, poll_seconds: int = 30):
        self.connect()
        print(f"[live] loop every {poll_seconds}s on CLOSED {self.cfg.timeframe} candles. "
              f"Ctrl-C to stop, or create a '{KILL_SWITCH_FILE}' file to halt.")
        while True:
            try:
                self.step()
            except Exception as e:  # noqa: BLE001 -- never let one bad poll kill the loop
                print(f"[live] step error: {e}")
            time.sleep(poll_seconds)


if __name__ == "__main__":
    print(__doc__)
    print(">>> This is a SKELETON. It will connect to TESTNET only and refuses live.")
    print(">>> To paper-trade: set testnet env keys, then in Python:")
    print(">>>     from live_skeleton import PaperTrader; PaperTrader().run()")
    if os.environ.get("BINANCE_TESTNET_API_KEY"):
        print("\n[info] testnet key detected in env. Not auto-starting; call .run() yourself.")
    else:
        print("\n[info] no testnet key in env -- nothing to do. See the docstring above.")

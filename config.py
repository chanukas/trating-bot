"""Central configuration. Every module takes a `Config` so walk-forward can vary
parameters without touching globals. `DEFAULT` is the baseline used by scripts."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Config:
    # --- market ---
    symbol: str = "BTCUSDT"
    timeframe: str = "1h"
    periods_per_year: int = 24 * 365  # crypto trades 24/7

    # --- data ---
    cache_dir: str = "data_cache"
    history_start: str = "2019-09-01"  # how far back to try to pull (BTCUSDT 1h exists from ~2017)

    # --- costs (charged on entry AND exit) ---
    taker_fee: float = 0.0005   # 0.05% per side (Binance taker is ~0.04-0.10%)
    slippage: float = 0.0002    # 2 bps per side

    # --- risk / sizing ---
    initial_equity: float = 10_000.0
    risk_pct: float = 0.01      # risk 1% of current equity per trade

    # --- indicators: ATR ZigZag ---
    atr_period: int = 14
    zigzag_atr_mult: float = 3.0   # reversal threshold = mult * ATR

    # --- elliott / fib ---
    retrace_min: float = 0.382
    retrace_max: float = 0.886
    fib_ext: float = 1.618         # wave-3 target = L2 + fib_ext*(H1-L0)
    stop_buffer: float = 0.0010    # place stop this fraction beyond the pivot
    trigger_buffer: float = 0.0005 # entry stop-order this fraction beyond H1/L1

    # --- target / reward:risk control ---
    use_r_target: bool = False     # if True, target = entry +/- target_r * risk (fixed R:R)
    target_r: float = 3.0          # the R multiple for the target when use_r_target
    min_rr: float = 0.0            # skip any setup whose planned reward:risk is below this

    # --- backtest behaviour ---
    allow_shorts: bool = True
    setup_expiry_bars: int = 60    # cancel an un-triggered setup after N bars
    warmup_bars: int = 50          # bars to skip before trading (indicator warmup)

    # --- optional trend filter (pre-registered hypothesis H1; EMA period FIXED, not tuned) ---
    trend_filter: bool = False     # only trade breakouts with the medium-term trend
    trend_ema: int = 200           # EMA(close) period for the trend filter

    # --- trend-following strategy (Donchian breakout; hypothesis H2) ---
    dc_entry: int = 55             # entry channel lookback (breakout of N-bar high/low)
    dc_exit: int = 20              # trailing-exit channel lookback
    atr_stop_mult: float = 2.0     # initial stop = entry -/+ atr_stop_mult * ATR
    trend_exit: str = "trail"      # "trail" (Donchian trailing) or "rtarget" (fixed R target)
    trend_target_r: float = 3.0    # R multiple when trend_exit == "rtarget"


DEFAULT = Config()


def interval_ms(timeframe: str) -> int:
    """Milliseconds per candle, e.g. '1h' -> 3_600_000."""
    unit = timeframe[-1]
    n = int(timeframe[:-1])
    mult = {"m": 60_000, "h": 3_600_000, "d": 86_400_000, "w": 604_800_000}
    if unit not in mult:
        raise ValueError(f"Unsupported timeframe unit in {timeframe!r}")
    return n * mult[unit]


def ccxt_symbol(symbol: str) -> str:
    """'BTCUSDT' -> 'BTC/USDT' for ccxt."""
    for quote in ("USDT", "USDC", "BUSD", "USD", "BTC", "ETH"):
        if symbol.endswith(quote):
            return f"{symbol[:-len(quote)]}/{quote}"
    return symbol

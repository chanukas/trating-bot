"""Free, KEYLESS OHLCV data for BTCUSDT (or any pair).

Fetch chain (no API key anywhere):
  1. Binance public klines REST  (api.binance.com / mirrors / data-api.binance.vision)
  2. data.binance.vision monthly bulk CSV archives
  3. ccxt 'binance' (market data needs no key)

Everything is cached to ./data_cache/<SYMBOL>_<TF>.csv and only the missing
head/tail is refetched on later runs.

Also includes a SYNTHETIC generator for smoke tests only -- its output is
random and MEANINGLESS for evaluating any edge. It is clearly labelled.
"""
from __future__ import annotations

import io
import os
import time
import zipfile
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import requests

from config import Config, DEFAULT, interval_ms, ccxt_symbol

# Public Binance REST hosts to try, in order. data-api.binance.vision is a
# keyless market-data mirror that often works where api.binance.com is blocked.
_REST_HOSTS = [
    "https://api.binance.com",
    "https://api-gcp.binance.com",
    "https://api1.binance.com",
    "https://api2.binance.com",
    "https://data-api.binance.vision",
]

_COLS = ["open", "high", "low", "close", "volume"]


def _log(msg: str) -> None:
    print(f"[data] {msg}")


def _to_ms(when: str | int | datetime) -> int:
    if isinstance(when, int):
        return when
    if isinstance(when, datetime):
        return int(when.replace(tzinfo=timezone.utc).timestamp() * 1000)
    return int(pd.Timestamp(when, tz="UTC").timestamp() * 1000)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _cache_path(cfg: Config) -> str:
    os.makedirs(cfg.cache_dir, exist_ok=True)
    return os.path.join(cfg.cache_dir, f"{cfg.symbol}_{cfg.timeframe}.csv")


# --------------------------------------------------------------------------- #
# Source 1: Binance klines REST (keyless, paginated)
# --------------------------------------------------------------------------- #
def _pick_rest_host(symbol: str, timeframe: str, session: requests.Session) -> str | None:
    for host in _REST_HOSTS:
        try:
            r = session.get(
                f"{host}/api/v3/klines",
                params={"symbol": symbol, "interval": timeframe, "limit": 1},
                timeout=10,
            )
            if r.status_code == 200 and isinstance(r.json(), list):
                return host
        except Exception:
            continue
    return None


def _fetch_rest(symbol: str, timeframe: str, start_ms: int, end_ms: int) -> pd.DataFrame:
    session = requests.Session()
    host = _pick_rest_host(symbol, timeframe, session)
    if host is None:
        raise RuntimeError("No reachable Binance REST host (all hosts failed).")
    _log(f"REST host: {host}")
    step = interval_ms(timeframe)
    rows: list[list] = []
    cur = start_ms
    while cur < end_ms:
        r = session.get(
            f"{host}/api/v3/klines",
            params={"symbol": symbol, "interval": timeframe,
                    "startTime": cur, "endTime": end_ms, "limit": 1000},
            timeout=20,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        rows.extend(batch)
        last_open = batch[-1][0]
        cur = last_open + step
        if len(batch) < 1000:
            break
        time.sleep(0.25)  # be polite to the public endpoint
    return _klines_to_df(rows)


def _klines_to_df(rows: list[list]) -> pd.DataFrame:
    if not rows:
        return _empty_df()
    arr = pd.DataFrame(rows).iloc[:, :6]
    arr.columns = ["open_time"] + _COLS
    df = pd.DataFrame({c: pd.to_numeric(arr[c]) for c in _COLS})
    df.index = pd.to_datetime(arr["open_time"].astype("int64"), unit="ms", utc=True)
    df.index.name = "timestamp"
    return df[~df.index.duplicated(keep="last")].sort_index()


# --------------------------------------------------------------------------- #
# Source 2: data.binance.vision bulk monthly CSV (keyless)
# --------------------------------------------------------------------------- #
def _month_range(start_ms: int, end_ms: int) -> list[tuple[int, int]]:
    start = pd.Timestamp(start_ms, unit="ms", tz="UTC").to_period("M")
    end = pd.Timestamp(end_ms, unit="ms", tz="UTC").to_period("M")
    out, p = [], start
    while p <= end:
        out.append((p.year, p.month))
        p += 1
    return out


def _fetch_vision(symbol: str, timeframe: str, start_ms: int, end_ms: int) -> pd.DataFrame:
    frames = []
    for year, month in _month_range(start_ms, end_ms):
        url = (f"https://data.binance.vision/data/spot/monthly/klines/"
               f"{symbol}/{timeframe}/{symbol}-{timeframe}-{year}-{month:02d}.zip")
        try:
            r = requests.get(url, timeout=60)
            if r.status_code != 200:
                continue
            with zipfile.ZipFile(io.BytesIO(r.content)) as z:
                with z.open(z.namelist()[0]) as f:
                    raw = pd.read_csv(f, header=None)
            # Some monthly files now ship a header row; drop it if present.
            if not str(raw.iloc[0, 0]).replace(".", "", 1).isdigit():
                raw = raw.iloc[1:]
            frames.append(_klines_to_df(raw.values.tolist()))
            _log(f"vision {year}-{month:02d}: {len(frames[-1])} rows")
        except Exception as e:  # noqa: BLE001
            _log(f"vision {year}-{month:02d} failed: {e}")
    if not frames:
        return _empty_df()
    return pd.concat(frames).sort_index()


# --------------------------------------------------------------------------- #
# Source 3: ccxt (keyless market data)
# --------------------------------------------------------------------------- #
def _fetch_ccxt(symbol: str, timeframe: str, start_ms: int, end_ms: int) -> pd.DataFrame:
    import ccxt  # imported lazily so it's optional

    ex = ccxt.binance({"enableRateLimit": True})
    sym = ccxt_symbol(symbol)
    step = interval_ms(timeframe)
    rows: list[list] = []
    cur = start_ms
    while cur < end_ms:
        batch = ex.fetch_ohlcv(sym, timeframe=timeframe, since=cur, limit=1000)
        if not batch:
            break
        rows.extend(batch)
        cur = batch[-1][0] + step
        if len(batch) < 1000:
            break
    if not rows:
        return _empty_df()
    arr = pd.DataFrame(rows, columns=["open_time"] + _COLS)
    df = pd.DataFrame({c: pd.to_numeric(arr[c]) for c in _COLS})
    df.index = pd.to_datetime(arr["open_time"].astype("int64"), unit="ms", utc=True)
    df.index.name = "timestamp"
    return df[~df.index.duplicated(keep="last")].sort_index()


# --------------------------------------------------------------------------- #
# Orchestration: cache + fetch-missing
# --------------------------------------------------------------------------- #
def _empty_df() -> pd.DataFrame:
    df = pd.DataFrame(columns=_COLS)
    df.index = pd.DatetimeIndex([], tz="UTC", name="timestamp")
    return df


def _read_cache(path: str) -> pd.DataFrame:
    if not os.path.exists(path):
        return _empty_df()
    df = pd.read_csv(path, index_col="timestamp", parse_dates=["timestamp"])
    if df.index.tz is None:
        df.index = df.index.tz_localize("UTC")
    return df.sort_index()


def _fetch_range(cfg: Config, start_ms: int, end_ms: int) -> pd.DataFrame:
    """Try each keyless source in order until one returns data."""
    for name, fn in (("REST", _fetch_rest), ("vision", _fetch_vision), ("ccxt", _fetch_ccxt)):
        try:
            df = fn(cfg.symbol, cfg.timeframe, start_ms, end_ms)
            if len(df):
                _log(f"source '{name}' returned {len(df)} rows")
                return df
            _log(f"source '{name}' returned 0 rows, trying next")
        except Exception as e:  # noqa: BLE001
            _log(f"source '{name}' failed: {e}; trying next")
    raise RuntimeError(
        "All keyless data sources failed. No API key is needed for backtesting; "
        "this is a network/geo issue. Check connectivity to api.binance.com or "
        "data.binance.vision."
    )


def load_ohlcv(cfg: Config = DEFAULT, start: str | None = None,
               end: str | None = None, refresh: bool = False) -> pd.DataFrame:
    """Return cached+fetched OHLCV as a UTC-indexed DataFrame [open,high,low,close,volume].

    Only the missing head/tail relative to the cache is fetched. `refresh=True`
    ignores the cache and refetches the whole requested range.
    """
    start_ms = _to_ms(start or cfg.history_start)
    end_ms = _to_ms(end) if end else _now_ms()
    path = _cache_path(cfg)
    cache = _empty_df() if refresh else _read_cache(path)

    if len(cache):
        cache_start = _to_ms(cache.index[0])
        cache_end = _to_ms(cache.index[-1])
        pieces = [cache]
        if start_ms < cache_start:
            _log(f"fetching earlier gap {start} .. {cache.index[0].date()}")
            pieces.append(_fetch_range(cfg, start_ms, cache_start))
        if end_ms > cache_end + interval_ms(cfg.timeframe):
            _log(f"fetching newer tail {cache.index[-1].date()} .. now")
            pieces.append(_fetch_range(cfg, cache_end + interval_ms(cfg.timeframe), end_ms))
        df = pd.concat(pieces)
        df = df[~df.index.duplicated(keep="last")].sort_index()
    else:
        _log(f"cache empty -> fetching {start or cfg.history_start} .. {'now' if not end else end}")
        df = _fetch_range(cfg, start_ms, end_ms)

    df.to_csv(path)
    out = df.loc[(df.index >= pd.Timestamp(start_ms, unit="ms", tz="UTC")) &
                 (df.index <= pd.Timestamp(end_ms, unit="ms", tz="UTC"))]
    return out


# --------------------------------------------------------------------------- #
# SYNTHETIC generator -- SMOKE TESTS ONLY. MEANINGLESS for edge evaluation.
# --------------------------------------------------------------------------- #
def generate_synthetic(n: int = 5000, seed: int = 0, start: str = "2021-01-01",
                       timeframe: str = "1h") -> pd.DataFrame:
    """!!! SYNTHETIC, RANDOM, MEANINGLESS DATA -- smoke tests only. !!!

    A geometric-random-walk with intrabar noise. Any backtest 'edge' on this is
    pure noise and must NOT be interpreted as evidence of anything.
    """
    rng = np.random.default_rng(seed)
    ret = rng.normal(0, 0.01, n)
    close = 30_000 * np.exp(np.cumsum(ret))
    open_ = np.empty(n)
    open_[0] = close[0]
    open_[1:] = close[:-1]
    noise = np.abs(rng.normal(0, 0.004, n)) * close
    high = np.maximum(open_, close) + noise
    low = np.minimum(open_, close) - noise
    vol = rng.uniform(10, 100, n)
    idx = pd.date_range(start, periods=n, freq=timeframe.replace("h", "h").replace("m", "min"),
                        tz="UTC", name="timestamp")
    df = pd.DataFrame({"open": open_, "high": high, "low": low, "close": close, "volume": vol},
                      index=idx)
    print("[data] !!! SYNTHETIC data generated -- MEANINGLESS for evaluating edge !!!")
    return df


def summarize(df: pd.DataFrame) -> str:
    if not len(df):
        return "EMPTY dataframe"
    span_days = (df.index[-1] - df.index[0]).total_seconds() / 86400
    return (f"{len(df):,} bars | {df.index[0]} -> {df.index[-1]} "
            f"({span_days:.0f} days, ~{span_days/365:.2f} yrs)\n"
            f"close: min {df['close'].min():,.0f}  max {df['close'].max():,.0f}  "
            f"last {df['close'].iloc[-1]:,.0f}")


if __name__ == "__main__":
    cfg = DEFAULT
    df = load_ohlcv(cfg)
    print(summarize(df))
    print(df.head(3))
    print(df.tail(3))

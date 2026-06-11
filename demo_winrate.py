"""WIN RATE IS NOT PROFIT  —  demonstrated on REAL BTCUSDT 1h data.

Trivial strategy: when flat, enter in a RANDOM direction (seeded) at the next bar's
open, then bracket with a take-profit% and a stop-loss%. Direction is random ON
PURPOSE so there is NO directional edge and BTC's bull-market drift cancels out --
this isolates the PURE effect of the TP/SL choice on win rate vs profitability.
Same fees + slippage as the real backtest; worst-case stop-first.

Watch what happens to win rate vs profit factor as we shrink the take-profit and
widen the stop.
"""
import numpy as np

import data
from config import DEFAULT

df = data.load_ohlcv(DEFAULT)
o = df["open"].to_numpy(float)
h = df["high"].to_numpy(float)
l = df["low"].to_numpy(float)
c = df["close"].to_numpy(float)
n = len(df)
FEE, SLIP = DEFAULT.taker_fee, DEFAULT.slippage


def run(tp, sl, seed=0):
    rng = np.random.default_rng(seed)
    eq = eq0 = 10_000.0
    peak = eq0
    maxdd = 0.0
    wins = losses = ntr = 0
    gp = gl = 0.0
    i = 1
    while i < n:
        d = 1 if rng.random() < 0.5 else -1          # random long/short
        if d == 1:
            entry = o[i] * (1 + SLIP); tpp = entry * (1 + tp); slp = entry * (1 - sl)
        else:
            entry = o[i] * (1 - SLIP); tpp = entry * (1 - tp); slp = entry * (1 + sl)
        qty = (eq * 0.01) / abs(entry - slp)          # risk 1% to the stop
        j, ex = i, None
        while j < n:                                   # stop checked BEFORE target
            if d == 1:
                if l[j] <= slp: ex = slp * (1 - SLIP); break
                if h[j] >= tpp: ex = tpp * (1 - SLIP); break
            else:
                if h[j] >= slp: ex = slp * (1 + SLIP); break
                if l[j] <= tpp: ex = tpp * (1 + SLIP); break
            j += 1
        if ex is None:
            ex = c[n - 1] * (1 - SLIP if d == 1 else 1 + SLIP); j = n - 1
        gross = (ex - entry) * qty if d == 1 else (entry - ex) * qty
        net = gross - (entry + ex) * qty * FEE
        eq += net; ntr += 1
        if net > 0: wins += 1; gp += net
        else: losses += 1; gl += -net
        peak = max(peak, eq); maxdd = max(maxdd, (peak - eq) / peak)
        i = j + 1
    wr = 100 * wins / ntr if ntr else 0
    pf = gp / gl if gl > 0 else float("inf")
    payoff = (gp / wins) / (gl / losses) if wins and losses else 0
    return dict(tp=tp, sl=sl, ntr=ntr, wr=wr, payoff=payoff, pf=pf,
                ret=100 * (eq / eq0 - 1), maxdd=100 * maxdd)


combos = [(0.005, 0.20), (0.01, 0.10), (0.02, 0.05), (0.03, 0.03),
          (0.05, 0.02), (0.10, 0.02)]
print(f"{'take-profit':>12}{'stop':>7}{'#trades':>9}{'WIN%':>8}{'payoff':>8}"
      f"{'PF':>7}{'return%':>10}{'maxDD%':>9}")
print("-" * 70)
for tp, sl in combos:
    r = run(tp, sl)
    flag = "  <- looks 'great'" if r["wr"] >= 70 else ""
    print(f"{100*r['tp']:>10.1f}%{100*r['sl']:>6.1f}%{r['ntr']:>9}{r['wr']:>8.1f}"
          f"{r['payoff']:>8.2f}{r['pf']:>7.2f}{r['ret']:>+10.1f}{r['maxdd']:>9.1f}{flag}")
print("-" * 70)
print("WIN% high <-> profit factor (PF) low. PF<1 = loses money. A >90% win rate is")
print("manufactured by a tiny target + wide stop -- and it still bleeds after costs.")

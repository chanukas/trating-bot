"""Local web UI for the signal advisor. No web framework -- Python stdlib only.

Run:  ./.venv/Scripts/python.exe webapp.py
Then open http://127.0.0.1:8000 in your browser.

It binds to 127.0.0.1 (your machine only) and never places orders -- it just shows
the advisor's suggestions, the reasoning, and the honest backtested track record.
"""
from __future__ import annotations

import json
import os
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import data
import advisor
from trend import run_trend_backtest
from backtest import run_backtest
from run_trend import main as make_trend_plot

HOST, PORT = "127.0.0.1", 8000
EQUITY_PNG = "trend_equity.png"

# ---- simple caches so the page is snappy and we don't hammer Binance ----
_C = {"df": None, "df_ts": 0.0, "rec_n": None, "trend_rec": None, "ell_rec": None}


def get_df():
    if _C["df"] is None or time.time() - _C["df_ts"] > 60:
        _C["df"] = advisor.drop_forming_candle(
            data.load_ohlcv(advisor.TREND_CFG), advisor.TREND_CFG.timeframe)
        _C["df_ts"] = time.time()
    return _C["df"]


def get_records(df):
    if _C["rec_n"] != len(df):
        _C["trend_rec"] = advisor._record(run_trend_backtest, advisor.TREND_CFG, df)
        _C["ell_rec"] = advisor._record(run_backtest, advisor.ELLIOTT_CFG, df)
        _C["rec_n"] = len(df)
    return _C["trend_rec"], _C["ell_rec"]


def build_report(as_of: str | None):
    df = get_df()
    trend_rec, ell_rec = get_records(df)
    sub = df.loc[:as_of] if as_of else df
    return {
        "symbol": advisor.TREND_CFG.symbol, "timeframe": advisor.TREND_CFG.timeframe,
        "asof": str(sub.index[-1]), "price": float(sub["close"].iloc[-1]),
        "trend": {"name": advisor.TREND_CFG.symbol and "Trend — Donchian breakout, 3R target",
                  "validated": True, "signal": advisor.trend_signal(sub, advisor.TREND_CFG),
                  "record": trend_rec},
        "elliott": {"name": "Elliott — wave-3 breakout, 3R target", "validated": False,
                    "signal": advisor.elliott_signal(sub, advisor.ELLIOTT_CFG),
                    "record": ell_rec},
    }


PAGE = """<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>BTCUSDT Signal Advisor</title><style>
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif;
background:#0f1419;color:#e6e6e6}.wrap{max-width:980px;margin:0 auto;padding:22px}
h1{font-size:20px;margin:0 0 2px}.sub{color:#8b98a5;font-size:13px}
.warn{background:#3a1d1d;border:1px solid #7a2d2d;color:#ffb4b4;padding:10px 14px;
border-radius:8px;margin:14px 0;font-size:13px}
.bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:14px 0}
button{background:#1d9bf0;color:#fff;border:0;padding:9px 16px;border-radius:8px;cursor:pointer;font-size:14px}
button.sec{background:#2a3540}input{background:#1a212a;border:1px solid #2a3540;color:#e6e6e6;
padding:8px 10px;border-radius:8px}
.price{font-size:15px;margin:6px 0 0}.price b{font-size:20px}
.cards{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:14px}
@media(max-width:760px){.cards{grid-template-columns:1fr}}
.card{background:#171e26;border:1px solid #232c36;border-radius:12px;padding:16px}
.card.val{border-color:#1f7a3d}.card.exp{border-color:#7a5a1f}
.badge{font-size:11px;padding:2px 8px;border-radius:20px;font-weight:600}
.badge.val{background:#11331f;color:#5fe08a}.badge.exp{background:#332b11;color:#e0c25f}
.sig{font-size:18px;font-weight:700;margin:10px 0 4px}
.long{color:#5fe08a}.short{color:#ff7a7a}.none{color:#8b98a5}
.why{color:#aab4bf;font-size:13px;margin-bottom:10px}
.lv{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:8px 0}
.lv div{background:#0f1620;border:1px solid #232c36;border-radius:8px;padding:8px;text-align:center}
.lv small{display:block;color:#8b98a5;font-size:11px}.lv b{font-size:15px}
table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px}
th,td{text-align:right;padding:5px 6px;border-top:1px solid #232c36}th:first-child,td:first-child{text-align:left}
.muted{color:#8b98a5}.pos{color:#5fe08a}.neg{color:#ff7a7a}
img{width:100%;border-radius:10px;margin-top:16px;border:1px solid #232c36}
.foot{color:#8b98a5;font-size:12px;margin-top:16px}
</style></head><body><div class=wrap>
<h1>📈 BTCUSDT Signal Advisor</h1>
<div class=sub>Suggestions for MANUAL trading — it never places orders. Acts on closed 1h candles.</div>
<div class=warn><b>Not financial advice.</b> The trend signal has a REAL but MODEST edge:
~30% win rate (you lose most trades), ~29% drawdowns, long flat stretches. Backtest ≠ future.</div>
<div class=bar>
  <button onclick="load()">↻ Get latest signal</button>
  <input type=date id=asof><button class=sec onclick="load(true)">Replay this date</button>
  <span id=status class=muted></span>
</div>
<div class=price id=price></div>
<div class=cards id=cards></div>
<img id=eq src="/equity/trend.png" alt="trend equity curve">
<div class=foot>Data: keyless Binance public API. Strategy &amp; costs documented in README.md.</div>
</div><script>
function fmt(n){return n==null?'—':Number(n).toLocaleString(undefined,{maximumFractionDigits:0})}
function rec(r){
  function row(name,m){let e=m.expectancy_R, c=e>0?'pos':'neg';
    return `<tr><td>${name}</td><td>${m.num_trades}</td><td>${m['win_rate_%'].toFixed(0)}%</td>
    <td class=${c}>${e>=0?'+':''}${e.toFixed(3)}R</td><td>${m.profit_factor==null?'∞':m.profit_factor}</td>
    <td>${m['max_drawdown_%'].toFixed(0)}%</td></tr>`}
  return `<table><tr><th>backtest</th><th>#</th><th>win</th><th>expect.</th><th>PF</th><th>maxDD</th></tr>
    ${row('full history',r.full)}${row('out-of-sample',r.oos)}</table>`}
function card(b,exp){
  let s=b.signal, cls=exp?'exp':'val', badge=exp?'EXPERIMENTAL ~breakeven':'VALIDATED edge';
  let body;
  if(!s||s.side==null){body=`<div class="sig none">No setup right now</div>
    <div class=why>Price is inside the channel — wait for a breakout.</div>`}
  else{let side=s.side=='LONG'?'long':'short';
    let state = ('status' in s)?` [${s.status}]` : (s.fresh?' · fresh, actionable':' · already moved (chasing worsens R:R)');
    body=`<div class="sig ${side}">${s.side}${state}</div><div class=why>${s.why}</div>
    <div class=lv><div><small>entry</small><b>${fmt(s.entry)}</b></div>
    <div><small>stop</small><b>${fmt(s.stop)}</b></div>
    <div><small>target</small><b>${fmt(s.target)}</b></div>
    <div><small>R:R</small><b>${s.rr}:1</b></div></div>`}
  return `<div class="card ${cls}"><span class="badge ${cls}">${badge}</span>
    <div style="margin-top:8px;font-weight:600">${b.name}</div>${body}${rec(b.record)}</div>`}
async function load(replay){
  let st=document.getElementById('status'); st.textContent='loading…';
  let q = (replay && document.getElementById('asof').value)?('?as_of='+document.getElementById('asof').value):'';
  try{let r=await (await fetch('/api/signal'+q)).json();
    document.getElementById('price').innerHTML=`${r.symbol} ${r.timeframe} · as of ${r.asof} · <b>$${fmt(r.price)}</b>`;
    document.getElementById('cards').innerHTML=card(r.trend,false)+card(r.elliott,true);
    st.textContent='updated '+new Date().toLocaleTimeString();
  }catch(e){st.textContent='error: '+e}}
load();
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quieter console
        pass

    def _send(self, code, body, ctype="text/html; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        try:
            if u.path == "/":
                self._send(200, PAGE.encode("utf-8"))
            elif u.path == "/api/signal":
                as_of = parse_qs(u.query).get("as_of", [None])[0]
                self._send(200, json.dumps(build_report(as_of)).encode("utf-8"),
                           "application/json")
            elif u.path == "/equity/trend.png":
                if not os.path.exists(EQUITY_PNG):
                    make_trend_plot(out_png=EQUITY_PNG)
                with open(EQUITY_PNG, "rb") as f:
                    self._send(200, f.read(), "image/png")
            elif u.path == "/favicon.ico":
                self._send(204, b"")
            else:
                self._send(404, b"not found", "text/plain")
        except Exception as e:  # noqa: BLE001
            self._send(500, json.dumps({"error": str(e)}).encode("utf-8"), "application/json")


def main():
    if not os.path.exists(EQUITY_PNG):
        print("[web] generating equity plot (one-time)…")
        make_trend_plot(out_png=EQUITY_PNG)
    print("[web] warming data + backtests…")
    get_records(get_df())
    url = f"http://{HOST}:{PORT}"
    print(f"[web] serving on {url}  (Ctrl-C to stop)")
    try:
        webbrowser.open(url)
    except Exception:
        pass
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()

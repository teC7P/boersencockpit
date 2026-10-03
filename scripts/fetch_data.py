#!/usr/bin/env python3
"""Holt alle Kennzahlen und Videos und schreibt sie in eine data.json.

Nur Standardbibliothek. Jede Quelle darf ausfallen: dann bleibt der letzte
gute Wert aus der vorherigen data.json stehen und wird als veraltet markiert.

Aufruf:
  python scripts/fetch_data.py --out site/data.json [--previous URL_ODER_PFAD]
"""
import argparse
import csv
import io
import json
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
NOW = datetime.now(timezone.utc)
ERRORS = []


def log(msg):
    print(msg, file=sys.stderr)


def http_get(url, headers=None, timeout=15, retries=1):
    h = {"User-Agent": UA, "Accept": "*/*"}
    h.update(headers or {})
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8", errors="replace")
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"{url[:80]}: {last}")


def http_json(url, headers=None):
    return json.loads(http_get(url, headers))


TIMINGS = {}


def safe(label, fn, *args):
    t0 = time.time()
    try:
        return fn(*args)
    except Exception as e:  # noqa: BLE001
        msg = f"{label}: {e}"
        log("FEHLER " + msg)
        ERRORS.append(msg)
        return None
    finally:
        TIMINGS[label] = TIMINGS.get(label, 0) + time.time() - t0


# ---------------------------------------------------------------- Quellen

_YAHOO = {"opener": None, "crumb": None}


def _yahoo_session():
    """Yahoo verlangt seit 2023 ein Cookie plus "Crumb", sonst kommt oft 429."""
    if _YAHOO["opener"] is None:
        import http.cookiejar
        jar = http.cookiejar.CookieJar()
        op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        op.addheaders = [("User-Agent", UA), ("Accept", "*/*"), ("Accept-Language", "en-US,en;q=0.9")]
        for u in ("https://fc.yahoo.com", "https://finance.yahoo.com/"):
            try:
                op.open(u, timeout=15).read(200)
            except Exception:  # noqa: BLE001  (fc.yahoo.com antwortet mit 404, setzt aber das Cookie)
                pass
        crumb = None
        for host in ("query1", "query2"):
            try:
                c = op.open(f"https://{host}.finance.yahoo.com/v1/test/getcrumb", timeout=15).read().decode().strip()
                if c and "<" not in c and len(c) < 40:
                    crumb = c
                    break
            except Exception as e:  # noqa: BLE001
                log(f"Yahoo-Crumb fehlgeschlagen: {e}")
        _YAHOO.update(opener=op, crumb=crumb)
    return _YAHOO["opener"], _YAHOO["crumb"]


def yahoo_series(symbol):
    """Kurs, Vortagesschluss und Tagesschlüsse (1 Jahr) von Yahoo Finance."""
    op, crumb = _yahoo_session()
    q = urllib.parse.quote(symbol)
    extra = f"&crumb={urllib.parse.quote(crumb)}" if crumb else ""
    last = None
    for attempt, host in enumerate(("query1", "query2", "query1")):
        try:
            time.sleep(0.4 + attempt * 2)
            raw = op.open(f"https://{host}.finance.yahoo.com/v8/finance/chart/{q}"
                          f"?range=1y&interval=1d&includePrePost=false{extra}", timeout=15).read()
            res = json.loads(raw)["chart"]["result"][0]
            break
        except Exception as e:  # noqa: BLE001
            last = e
    else:
        raise RuntimeError(f"Yahoo {symbol}: {last}")
    meta = res["meta"]
    ts = res.get("timestamp") or []
    closes = res["indicators"]["quote"][0].get("close") or []
    pts = [(t, c) for t, c in zip(ts, closes) if c is not None]
    if len(pts) < 5:
        raise RuntimeError(f"Yahoo {symbol}: zu wenige Daten")
    price = meta.get("regularMarketPrice") or pts[-1][1]
    mtime = meta.get("regularMarketTime") or pts[-1][0]
    day = lambda t: datetime.fromtimestamp(t, timezone.utc).date()  # noqa: E731
    if day(pts[-1][0]) == day(mtime):
        prev = pts[-2][1]
        hist = [c for _, c in pts[:-1]] + [price]
    else:
        prev = pts[-1][1]
        hist = [c for _, c in pts] + [price]
    return {
        "value": float(price),
        "prev": float(prev),
        "history": [float(x) for x in hist],
        "asOf": datetime.fromtimestamp(mtime, timezone.utc).isoformat(),
        "source": "Yahoo Finance",
    }



def _num(x):
    return float(str(x).replace(",", "").replace("%", "").strip())


def cnbc_series(symbol):
    """Kurs und 1-Jahres-Verlauf von CNBC (inoffiziell, ohne Schlüssel)."""
    q = http_json("https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol"
                  f"?symbols={urllib.parse.quote(symbol)}&requestMethod=itv&noform=1&partnerId=2"
                  "&fund=1&exthrs=1&output=json&events=1")
    quotes = q["FormattedQuoteResult"]["FormattedQuote"]
    fq = quotes[0] if isinstance(quotes, list) else quotes
    price = _num(fq["last"])
    prev = _num(fq.get("previous_day_closing") or fq.get("previous_close"))
    hist = []
    try:
        c = http_json(f"https://ts-api.cnbc.com/harmony/app/charts/1Y.json?symbol={urllib.parse.quote(symbol)}")
        bars = c["barData"]["priceBars"]
        hist = [_num(b["close"]) for b in bars if b.get("close") not in (None, "")]
    except Exception as e:  # noqa: BLE001
        log(f"CNBC-Verlauf {symbol}: {e}")
    if not hist or abs(hist[-1] - price) / price > 0.0001:
        hist.append(price)
    return {"value": price, "prev": prev, "history": hist,
            "asOf": fq.get("last_time") or NOW.isoformat(), "source": "CNBC"}


def cboe_vix():
    txt = http_get("https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv")
    rows = list(csv.DictReader(io.StringIO(txt)))[-260:]
    vals = [float(r["CLOSE"]) for r in rows]
    return {"value": vals[-1], "prev": vals[-2], "history": vals,
            "asOf": rows[-1]["DATE"], "source": "Cboe"}


def treasury_10y():
    vals = []
    for year in (NOW.year - 1, NOW.year):
        txt = http_get("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/"
                       f"daily-treasury-rates.csv/{year}/all?type=daily_treasury_yield_curve"
                       f"&field_tdr_date_value={year}&page&_format=csv")
        for r in csv.DictReader(io.StringIO(txt)):
            if r.get("10 Yr"):
                m, d, y = r["Date"].split("/")
                vals.append((f"{y}-{m}-{d}", float(r["10 Yr"])))
    vals.sort()
    if len(vals) < 5:
        raise RuntimeError("US-Treasury: zu wenige Daten")
    vals = vals[-260:]
    return {"value": vals[-1][1], "prev": vals[-2][1], "history": [v for _, v in vals],
            "asOf": vals[-1][0], "source": "US Treasury"}


def ecb_eurusd():
    return sdmx_csv_series("https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A"
                           "?lastNObservations=260&format=csvdata", "EZB")


def coingecko_btc():
    d = http_json("https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=365&interval=daily")
    vals = [p[1] for p in d["prices"]]
    return {"value": vals[-1], "prev": vals[-2], "history": vals,
            "asOf": datetime.fromtimestamp(d["prices"][-1][0] / 1000, timezone.utc).isoformat(),
            "source": "CoinGecko"}


def fred_series(series_id):
    txt = http_get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}", timeout=10, retries=0)
    rows = list(csv.reader(io.StringIO(txt)))[1:]
    vals = [(r[0], float(r[1])) for r in rows if len(r) > 1 and r[1] not in ("", ".")]
    if len(vals) < 5:
        raise RuntimeError(f"FRED {series_id}: zu wenige Daten")
    vals = vals[-260:]
    return {
        "value": vals[-1][1], "prev": vals[-2][1],
        "history": [v for _, v in vals],
        "asOf": vals[-1][0], "source": "FRED",
    }


def sdmx_csv_series(url, source):
    txt = http_get(url, {"Accept": "application/vnd.sdmx.data+csv;version=1.0.0, text/csv"})
    rd = csv.DictReader(io.StringIO(txt))
    vals = []
    for r in rd:
        v = (r.get("OBS_VALUE") or "").strip()
        if v and v not in (".", "NaN"):
            vals.append((r.get("TIME_PERIOD"), float(v)))
    vals.sort(key=lambda x: x[0])
    if len(vals) < 5:
        raise RuntimeError(f"{source}: zu wenige Daten")
    vals = vals[-260:]
    return {
        "value": vals[-1][1], "prev": vals[-2][1],
        "history": [v for _, v in vals], "asOf": vals[-1][0], "source": source,
    }


def bund10():
    try:
        return sdmx_csv_series(
            "https://api.statistiken.bundesbank.de/rest/data/BBSIS/"
            "D.I.ZST.ZI.EUR.S1311.B.A604.R10XX.R.A.A._Z._Z.A?lastNObservations=260",
            "Bundesbank")
    except Exception as e:  # noqa: BLE001
        log(f"Bundesbank fehlgeschlagen ({e}), nehme EZB")
        return sdmx_csv_series(
            "https://data-api.ecb.europa.eu/service/data/YC/"
            "B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y?lastNObservations=260&format=csvdata",
            "EZB (AAA-Staatsanleihen, Näherung)")


def first_ok(*fns):
    errs = []
    for fn in fns:
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            errs.append(str(e)[:140])
            log(f"  Fallback nach Fehler: {e}")
    raise RuntimeError(" | ".join(errs))


FG_DE = {"extreme fear": "extreme Angst", "fear": "Angst", "neutral": "neutral",
         "greed": "Gier", "extreme greed": "extreme Gier"}


def cnn_fear_greed():
    d = http_json("https://production.dataviz.cnn.io/index/fearandgreed/graphdata",
                  {"Referer": "https://edition.cnn.com/", "Origin": "https://edition.cnn.com",
                   "Accept": "application/json"})
    fg = d["fear_and_greed"]
    hist = [p["y"] for p in d.get("fear_and_greed_historical", {}).get("data", [])][-120:]
    score = float(fg["score"])
    prev = float(fg.get("previous_close") or (hist[-2] if len(hist) > 1 else score))
    return {"value": score, "prev": prev, "history": hist or [score],
            "label": FG_DE.get(str(fg.get("rating", "")).lower(), fg.get("rating")),
            "asOf": fg.get("timestamp"), "source": "CNN"}


def crypto_fear_greed():
    d = http_json("https://api.alternative.me/fng/?limit=90&format=json")
    data = d["data"]
    hist = [float(x["value"]) for x in reversed(data)]
    return {"value": hist[-1], "prev": hist[-2], "history": hist,
            "label": FG_DE.get(data[0]["value_classification"].lower(), data[0]["value_classification"]),
            "asOf": datetime.fromtimestamp(int(data[0]["timestamp"]), timezone.utc).isoformat(),
            "source": "alternative.me"}


# ---------------------------------------------------------- Smart / Dumb

COT_URL = "https://publicreporting.cftc.gov/resource/6dca-aqww.json"


def cot_rows(where):
    since = (NOW - timedelta(days=3 * 365 + 30)).strftime("%Y-%m-%dT00:00:00")
    params = {
        "$where": f"{where} AND report_date_as_yyyy_mm_dd >= '{since}'",
        "$order": "report_date_as_yyyy_mm_dd ASC",
        "$limit": "1000",
    }
    return http_json(COT_URL + "?" + urllib.parse.urlencode(params))


def cot_index(values, window=156):
    out = []
    for i, v in enumerate(values):
        w = values[max(0, i - window + 1): i + 1]
        lo, hi = min(w), max(w)
        out.append(50.0 if hi == lo else (v - lo) / (hi - lo) * 100)
    return out


def smart_dumb():
    rows = first_ok(
        lambda: _nonempty(cot_rows("cftc_contract_market_code='13874A'")),
        lambda: _nonempty(cot_rows("upper(market_and_exchange_names) like 'E-MINI S&P 500 -%'")),
    )
    # bei mehreren Zeilen pro Datum (sollte nicht vorkommen) die letzte nehmen
    by_date = {}
    for r in rows:
        by_date[r["report_date_as_yyyy_mm_dd"][:10]] = r
    dates = sorted(by_date)
    num = lambda r, k: float(r.get(k) or 0)  # noqa: E731
    comm = [num(by_date[d], "comm_positions_long_all") - num(by_date[d], "comm_positions_short_all") for d in dates]
    small = [num(by_date[d], "nonrept_positions_long_all") - num(by_date[d], "nonrept_positions_short_all") for d in dates]
    if len(dates) < 30:
        raise RuntimeError(f"CFTC: nur {len(dates)} Wochen")
    s_idx, d_idx = cot_index(comm), cot_index(small)
    smart, dumb = round(s_idx[-1]), round(d_idx[-1])
    spread = smart - dumb
    hist = [{"d": d, "s": round(s, 1), "u": round(u, 1)} for d, s, u in zip(dates, s_idx, d_idx)][-52:]
    return {
        "smart": smart, "dumb": dumb, "spread": spread,
        "state": "g" if spread >= 50 else ("r" if spread <= -50 else "y"),
        "label": ("Profis kaufen" if spread >= 50 else "Kleinanleger euphorisch" if spread <= -50 else "neutral"),
        "asOf": dates[-1], "history": hist,
        "market": by_date[dates[-1]].get("market_and_exchange_names", "E-MINI S&P 500"),
        "source": "CFTC Commitments of Traders",
    }


def _nonempty(rows):
    if not rows:
        raise RuntimeError("CFTC: keine Zeilen")
    return rows


# ---------------------------------------------------------------- Videos

def resolve_channel_id(handle, cache):
    if handle in cache:
        return cache[handle]
    html = http_get(f"https://www.youtube.com/@{urllib.parse.quote(handle)}",
                    {"Accept-Language": "de-DE,de;q=0.9", "Cookie": "CONSENT=YES+1"})
    for pat in (r'"externalId":"(UC[\w-]{22})"',
                r'<meta itemprop="identifier" content="(UC[\w-]{22})"',
                r'youtube\.com/channel/(UC[\w-]{22})"',
                r'"channelId":"(UC[\w-]{22})"'):
        m = re.search(pat, html)
        if m:
            cache[handle] = m.group(1)
            return m.group(1)
    raise RuntimeError(f"YouTube @{handle}: Kanal-ID nicht gefunden")


NS = {"a": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015",
      "media": "http://search.yahoo.com/mrss/"}


def channel_videos(name, handle, cid):
    xml = http_get(f"https://www.youtube.com/feeds/videos.xml?channel_id={cid}")
    root = ET.fromstring(xml)
    out = []
    for e in root.findall("a:entry", NS)[:5]:
        vid = e.findtext("yt:videoId", default="", namespaces=NS)
        link = e.find("a:link", NS)
        url = link.get("href") if link is not None else f"https://www.youtube.com/watch?v={vid}"
        if "/shorts/" in url:
            continue
        thumb = e.find("media:group/media:thumbnail", NS)
        out.append({
            "channel": name, "handle": handle,
            "title": e.findtext("a:title", default="", namespaces=NS),
            "url": url,
            "thumb": thumb.get("url") if thumb is not None else f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg",
            "published": e.findtext("a:published", default="", namespaces=NS),
        })
    return out


# ---------------------------------------------------------------- Aufbau

def yh(symbol, *fallbacks):
    return lambda: first_ok(lambda: yahoo_series(symbol), *fallbacks)


TILES = [
    ("Indizes", [
        ("dax", "DAX", yh("^GDAXI", lambda: cnbc_series(".GDAXI")), {"dec": 0, "chg": "pct", "ma": True}),
        ("spx", "S&P 500", yh("^GSPC", lambda: cnbc_series(".SPX")), {"dec": 0, "chg": "pct", "ma": True}),
        ("ndx", "Nasdaq 100", yh("^NDX", lambda: cnbc_series(".NDX")), {"dec": 0, "chg": "pct", "ma": True}),
    ]),
    ("Risiko & Stimmung", [
        ("vix", "VIX", yh("^VIX", cboe_vix, lambda: fred_series("VIXCLS")), {"dec": 1, "chg": "pct", "invert": True}),
        ("fg", "Fear & Greed", cnn_fear_greed, {"dec": 0, "chg": "label"}),
        ("cfg", "Krypto F&G", crypto_fear_greed, {"dec": 0, "chg": "label"}),
    ]),
    ("Zinsen & Währung", [
        ("us10", "US 10 J.", yh("^TNX", treasury_10y, lambda: fred_series("DGS10")),
         {"dec": 2, "chg": "bp", "unit": "%", "invert": True}),
        ("de10", "Bund 10 J.", bund10, {"dec": 2, "chg": "bp", "unit": "%", "invert": True}),
        ("eurusd", "EUR/USD", yh("EURUSD=X", ecb_eurusd), {"dec": 4, "chg": "pct"}),
    ]),
    ("Rohstoffe & Krypto", [
        ("gold", "Gold", yh("GC=F", lambda: cnbc_series("@GC.1")), {"dec": 0, "chg": "pct", "unit": "$"}),
        ("brent", "Brent", yh("BZ=F", lambda: cnbc_series("@LCO.1")), {"dec": 2, "chg": "pct", "unit": "$"}),
        ("btc", "Bitcoin", yh("BTC-USD", coingecko_btc), {"dec": 0, "chg": "pct", "unit": "$"}),
    ]),
]


def build_tile(tid, name, fn, opts, prev_tiles):
    data = safe(name, fn)
    stale = False
    if data is None:
        old = prev_tiles.get(tid)
        if not old:
            return {"id": tid, "name": name, "missing": True, **opts}
        old = dict(old)
        old["stale"] = True
        return old
    hist = data["history"]
    ma200 = None
    if opts.get("ma") and len(hist) >= 200:
        ma200 = sum(hist[-200:]) / 200
    tile = {
        "id": tid, "name": name, **opts,
        "value": data["value"], "prev": data["prev"],
        "spark": [round(x, 4) for x in hist[-60:]],
        "asOf": data.get("asOf"), "source": data.get("source"),
        "stale": stale,
    }
    if data.get("label"):
        tile["label"] = data["label"]
    if ma200 is not None:
        tile["ma200"] = ma200
        tile["aboveMa200"] = data["value"] > ma200
    return tile


def verdict(tiles, sd):
    sig = []
    dax, spx = tiles.get("dax", {}), tiles.get("spx", {})
    above = [t.get("aboveMa200") for t in (dax, spx) if "aboveMa200" in t]
    if above:
        n = sum(1 for a in above if a)
        state = "g" if n == len(above) else ("r" if n == 0 else "y")
        text = {"g": "DAX und S&P über 200-Tage-Linie", "r": "DAX und S&P unter 200-Tage-Linie",
                "y": "nur " + ("DAX" if dax.get("aboveMa200") else "S&P") + " über 200-Tage-Linie"}[state]
        sig.append({"key": "trend", "state": state, "text": "Trend: " + text})
    vix = tiles.get("vix", {})
    if "value" in vix:
        v = vix["value"]
        state = "g" if v < 20 else ("y" if v < 30 else "r")
        word = {"g": "ruhig", "y": "erhöht", "r": "Stress"}[state]
        sig.append({"key": "vix", "state": state,
                    "text": f"Volatilität: VIX {v:.1f}".replace(".", ",") + f" {word}"})
    if sd:
        sig.append({"key": "sd", "state": sd["state"],
                    "text": f"Smart/Dumb: {sd['spread']:+d} {sd['label']}".replace("-", "−")})
    g = sum(1 for s in sig if s["state"] == "g")
    r = sum(1 for s in sig if s["state"] == "r")
    if not sig:
        return {"label": "keine Daten", "text": "Gerade sind keine Daten verfügbar.", "signals": []}
    if r >= 2:
        label = "angespannt"
    elif r == 0 and g >= 2:
        label = "freundlich"
    else:
        label = "gemischt"
    parts = []
    st = {s["key"]: s["state"] for s in sig}
    if "trend" in st:
        parts.append({"g": "Trend intakt", "y": "Trend uneinheitlich", "r": "Trend gebrochen"}[st["trend"]])
    if "vix" in st:
        parts.append({"g": "Angst niedrig", "y": "Nervosität erhöht", "r": "hohe Angst"}[st["vix"]])
    if "sd" in st:
        parts.append({"g": "Profis kaufen", "y": "Profis abwartend", "r": "Profis sichern ab"}[st["sd"]])
    text = ", ".join(parts) + "."
    return {"label": label, "text": text[0].upper() + text[1:], "signals": sig}


def load_previous(src):
    if not src:
        return {}
    try:
        if src.startswith("http"):
            return json.loads(http_get(src + ("&" if "?" in src else "?") + f"t={int(time.time())}", retries=1))
        return json.loads(Path(src).read_text("utf-8"))
    except Exception as e:  # noqa: BLE001
        log(f"Keine vorherigen Daten ({e})")
        return {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="site/data.json")
    ap.add_argument("--previous", default="")
    args = ap.parse_args()

    cfg = json.loads((ROOT / "config.json").read_text("utf-8"))
    prev = load_previous(args.previous)
    prev_tiles = {t["id"]: t for g in prev.get("groups", []) for t in g.get("items", []) if "value" in t}

    groups, tiles = [], {}
    for gname, items in TILES:
        out = []
        for tid, name, fn, opts in items:
            t = build_tile(tid, name, fn, opts, prev_tiles)
            tiles[tid] = t
            out.append(t)
        groups.append({"name": gname, "items": out})

    sd = safe("Smart/Dumb", smart_dumb)
    if sd is None and prev.get("smartDumb"):
        sd = dict(prev["smartDumb"], stale=True)

    cache = dict(prev.get("channelIds", {}))
    videos, channel_links = [], []
    for ch in cfg["channels"]:
        channel_links.append({"name": ch["name"], "url": f"https://www.youtube.com/@{ch['handle']}/videos"})
        cid = safe(f"YouTube {ch['name']}", resolve_channel_id, ch["handle"], cache)
        if cid:
            vs = safe(f"YouTube {ch['name']}", channel_videos, ch["name"], ch["handle"], cid)
            if vs is None:
                vs = [v for v in prev.get("videos", []) if v.get("handle") == ch["handle"]]
            videos.extend(vs)
    videos.sort(key=lambda v: v.get("published", ""), reverse=True)
    if not videos:
        videos = prev.get("videos", [])

    data = {
        "updated": NOW.isoformat(),
        "verdict": verdict(tiles, sd),
        "groups": groups,
        "smartDumb": sd,
        "videos": videos[: cfg.get("video_count", 12)],
        "channels": channel_links,
        "channelIds": cache,
        "magazines": cfg["magazines"],
        "errors": ERRORS,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1), "utf-8")
    log(f"geschrieben: {out} ({len(ERRORS)} Fehler)")
    # Hinweise für die GitHub-Actions-Oberfläche
    if "GITHUB_ACTIONS" in __import__("os").environ:
        ok = sum(1 for g in groups for t in g["items"] if "value" in t and not t.get("stale"))
        srcs = ", ".join(f"{t['name']}={t.get('source', '-')}{'(alt)' if t.get('stale') else ''}"
                         for g in groups for t in g["items"])
        locked = bool(__import__("os").environ.get("COCKPIT_PASSWORD"))  # Logs sind öffentlich
        if not locked:
            print(f"::notice title=Quellen::{srcs}")
        vals = "; ".join(f"{t['name']} {t['value']:.4g} (Vortag {t['prev']:.4g}, {len(t.get('spark', []))} Pkt"
                         f"{', 200T ' + ('über' if t['aboveMa200'] else 'unter') if 'aboveMa200' in t else ''})"
                         for g in groups for t in g["items"] if "value" in t)
        if not locked:
            print(f"::notice title=Werte::{vals}")
        if sd and not locked:
            print(f"::notice title=SmartDumb::{sd.get('market')} {sd['asOf']}: smart {sd['smart']} dumb {sd['dumb']} "
                  f"spread {sd['spread']} | Marktlage {data['verdict']['label']}: {data['verdict']['text']}")
        if not locked:
            print("::notice title=Videos::" + " | ".join(f"{v['channel']}: {v['title'][:40]} ({v['published'][:10]})"
                                                    for v in data["videos"]))
        slow = ", ".join(f"{k} {v:.0f}s" for k, v in sorted(TIMINGS.items(), key=lambda x: -x[1])[:5])
        print(f"::notice title=Datenlauf::{ok}/12 Kennzahlen frisch, Smart/Dumb "
              f"{'ok' if sd and not sd.get('stale') else 'fehlt'}, {len(videos)} Videos. Langsamste: {slow}")
        for e in ERRORS[:20]:
            print("::warning title=Quelle::" + e.replace("\n", " ")[:300])


if __name__ == "__main__":
    main()

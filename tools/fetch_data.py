"""Bake Aion 2 crafting + market data into data/*.json.

Sources:
  gamers4.life  crafting-graph.json  (recipes, items, icons)
  aion2.exchange /api              (servers, cheapest listings, 28d sales stats, price history)

Usage: python tools/fetch_data.py [server_id ...]
Default servers come from data/config.json.
"""
import json, os, sys, time, urllib.request, urllib.error
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
UA = {"User-Agent": "Mozilla/5.0 (aion2-craft bake; github.com/amazo197/aion2-craft)"}
EX = "https://aion2.exchange/api"
GRAPH_URL = "https://gamers4.life/aion-2/database/crafting-graph.json"
ICON_BASE = "https://gamers4.life/aion-2/database/icons"
PAUSE = 0.15


def get(url, retries=3):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.load(r)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            if i == retries - 1:
                print("FAIL", url, e)
                return None
            time.sleep(1.5 * (i + 1))


def icon_url(ic):
    if not ic:
        return ""
    folder, fn = ic.rsplit("/", 1)
    return f"{ICON_BASE}{folder}/{fn.split('.')[0]}.webp"


def bake_graph():
    g = get(GRAPH_URL)
    if not g:
        print("graph fetch failed, keeping existing data/graph.json")
        return json.load(open(os.path.join(DATA, "graph.json"), encoding="utf-8"))
    for k, it in g["items"].items():
        it["icon"] = icon_url(it.get("ic", ""))
        it.pop("ic", None)
    json.dump(g, open(os.path.join(DATA, "graph.json"), "w", encoding="utf-8"), separators=(",", ":"))
    print("graph: items", len(g["items"]), "recipes", len(g["recipes"]))
    return g


def bake_servers():
    d = get(f"{EX}/servers")
    if d:
        json.dump(d, open(os.path.join(DATA, "servers.json"), "w"), separators=(",", ":"))
        print("servers:", len(d["servers"]))
    return d


def bake_prices(server):
    items, off = [], 0
    while True:
        d = get(f"{EX}/items?sort=name&order=asc&window=24h&limit=200&offset={off}&server={server}")
        if not d:
            break
        items += d["items"]
        off += 200
        if off >= d["total"]:
            break
        time.sleep(PAUSE)
    out = {}
    for it in items:
        out[str(it["item_key"])] = {
            "name": it["name"], "p": it.get("price"), "n": it.get("listings") or 0,
            "sold": it.get("units_sold") or 0, "avg": it.get("sold_avg_price"),
            "smin": it.get("sold_min_price"), "smax": it.get("sold_max_price"),
            "cat": it["category"]["name"], "sec": it["category"]["section_id"],
            "chg": it.get("change_pct"),
        }
    print(f"server {server}: {len(out)} items on market")
    return out


def cleared_band(points):
    """Infer what cleared from listing-count drops in 10-minute buckets."""
    gone, lows, highs, events = 0, [], [], 0
    for a, b in zip(points, points[1:]):
        drop = (a.get("listings_max") or a.get("listings") or 0) - (b.get("listings_min") or b.get("listings") or 0)
        if drop > 0:
            gone += drop
            events += 1
            la, lb = a.get("low"), b.get("low")
            if la and lb and lb > la * 1.001:
                lows.append(la)
                highs.append(lb)
    # tmax = highest ask that vanished in this window (best evidence of a real trade price)
    return {"gone": gone, "events": events, "lo": min(lows) if lows else None, "hi": max(highs) if highs else None,
            "tmax": max(lows) if lows else None, "hours": round(len(points) * 10 / 60, 1)}


def bake_history(server, keys, hours=24):
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = {}
    for i, k in enumerate(keys):
        d = get(f"{EX}/items/{k}/prices?server={server}&from={since}&bucket=10m")
        if d and d.get("points"):
            out[k] = cleared_band(d["points"])
            s = d.get("summary") or {}
            out[k]["low24"] = s.get("low")
            out[k]["high24"] = s.get("high")
        time.sleep(PAUSE)
        if i % 50 == 0:
            print(f"  history {server}: {i}/{len(keys)}")
    return out


def main():
    cfg_path = os.path.join(DATA, "config.json")
    cfg = json.load(open(cfg_path)) if os.path.exists(cfg_path) else {"servers": [11102, 11304], "history_servers": [11102]}
    servers = [int(s) for s in sys.argv[1:]] or cfg["servers"]
    os.makedirs(DATA, exist_ok=True)
    g = bake_graph()
    bake_servers()
    # keys worth history: anything a recipe touches
    touched = set()
    for r in g["recipes"].values():
        touched.add(str(r["out"]))
        if r.get("combo"):
            touched.add(str(r["combo"]))
        for i in r["in"]:
            touched.add(str(i[0]))
    meta = {"baked_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "servers": {}}
    meta_path = os.path.join(DATA, "meta.json")
    if os.path.exists(meta_path):
        try:
            meta["servers"] = json.load(open(meta_path)).get("servers", {})  # keep servers not baked this run
        except Exception:
            pass
    for s in servers:
        prices = bake_prices(s)
        hist = {}
        prev_path = os.path.join(DATA, f"prices_{s}.json")
        prev_hist = {}
        if os.path.exists(prev_path):
            try:
                prev_hist = json.load(open(prev_path, encoding="utf-8")).get("history", {}) or {}
            except Exception:
                prev_hist = {}
        if s in cfg.get("history_servers", []):
            keys = [k for k in prices if k in touched]
            hist = bake_history(s, keys)
            print(f"server {s}: history for {len(hist)} items")
        # carry the all-time highest vanished ask forward across bakes
        for k, h in hist.items():
            ever = (prev_hist.get(k) or {}).get("tmax_ever")
            h["tmax_ever"] = max(x for x in (ever, h.get("tmax")) if x) if (ever or h.get("tmax")) else None
        for k, h in prev_hist.items():
            if k not in hist and h.get("tmax_ever"):
                hist[k] = {"gone": 0, "events": 0, "lo": None, "hi": None, "tmax": None, "hours": 0, "tmax_ever": h["tmax_ever"]}
        json.dump({"server": s, "prices": prices, "history": hist, "baked_at": meta["baked_at"]},
                  open(os.path.join(DATA, f"prices_{s}.json"), "w"), separators=(",", ":"))
        meta["servers"][str(s)] = {"items": len(prices), "history": len(hist), "has_sales": any(v["sold"] for v in prices.values())}
        time.sleep(PAUSE)
    json.dump(meta, open(os.path.join(DATA, "meta.json"), "w"), indent=1)
    print("done", meta)


if __name__ == "__main__":
    main()

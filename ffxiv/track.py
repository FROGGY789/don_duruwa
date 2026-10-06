"""📈 재료 트래킹용 데이터: 하루 단위 가격 기록을 쌓고, 화면이 쓸 파일을 만든다.

기록 (cache/history.json.gz, GitHub Actions 캐시로 실행 사이에 이어진다)
  {"days": {"2026-10-06": {"아이템ID": {"s": {"dc": [중앙값, 팔린 수량, 건수], "월드ID": [...]},
                                       "m": {"월드ID": 그날 본 최저 매물}}}}}
  - 판매 기록은 Universalis 가 7일치를 주니까, 매번 지난 7일을 다시 계산해서 채운다 (건수가 줄면 안 덮어씀:
    많이 팔리는 템은 999건 제한 때문에 오래된 날이 잘려서 오기 때문)
  - 최저 매물은 그날 본 것 중 제일 싼 값
  - KEEP_DAYS 보다 오래된 날은 지운다

화면용 (site/data/track/items.json, track/t{n}.json)
  items.json   검색용 [아이템ID, 이름] (시세가 있는 거래 가능 아이템만)
  t{n}.json    {아이템ID: {w: 서버별 지금 매물, h: 하루 기록, upd}}  (아이템ID % TRACK_SHARDS 로 나눔)
"""
import gzip
import json
import statistics
import time
from datetime import datetime, timedelta, timezone

from .profit import clean_by_world

KST = timezone(timedelta(hours=9), "KST")
KEEP_DAYS = 60
TRACK_SHARDS = 64
TOP_LISTINGS = 10  # 서버마다 보여줄 싼 매물 개수


def day_of(ts):
    return datetime.fromtimestamp(ts, KST).strftime("%Y-%m-%d")


def load_history(path):
    try:
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"days": {}}


def save_history(path, hist):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with gzip.open(tmp, "wt", encoding="utf-8") as f:
        json.dump(hist, f, ensure_ascii=False, separators=(",", ":"))
    tmp.replace(path)


def update_history(hist, items, cfg):
    """지금 받은 시세로 기록을 채운다. items = MarketCache.items ({아이템ID: entry})."""
    days = hist.setdefault("days", {})
    today = day_of(time.time())
    odd = cfg.get("odd_sale_ratio", 3)
    outlier = cfg["outlier_ratio"]
    for iid, entry in items.items():
        key = str(iid)
        kept, _, good, _ = clean_by_world(entry["sales"], entry["listings"], odd, outlier)
        # 판매: 날짜별 · 서버별 중앙값
        by_day = {}
        for s in kept:
            d = by_day.setdefault(day_of(s[3]), {})
            d.setdefault("dc", []).append(s)
            d.setdefault(str(s[4]), []).append(s)
        for d, groups in by_day.items():
            rec = days.setdefault(d, {}).setdefault(key, {})
            old = rec.get("s", {})
            new = {w: [statistics.median(x[0] for x in ss), sum(x[1] for x in ss), len(ss)] for w, ss in groups.items()}
            if not old or new.get("dc", [0, 0, 0])[2] >= old.get("dc", [0, 0, 0])[2]:
                rec["s"] = new
        # 매물: 오늘 본 최저가
        mins = {}
        for l in good:
            w = str(l[3])
            mins[w] = min(mins.get(w, l[0]), l[0])
        if mins:
            rec = days.setdefault(today, {}).setdefault(key, {})
            m = rec.setdefault("m", {})
            for w, v in mins.items():
                m[w] = min(m.get(w, v), v)
    cutoff = (datetime.now(KST) - timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%d")
    for d in [d for d in days if d < cutoff]:
        del days[d]
    return hist


def build_tracking(gd, items, hist, cfg, write, out):
    """화면용 파일을 쓴다. write(path, data) 는 build.py 의 JSON 쓰기."""
    odd, outlier = cfg.get("odd_sale_ratio", 3), cfg["outlier_ratio"]
    dates = sorted(hist.get("days", {}))
    names, shards = [], {}
    for iid, entry in items.items():
        item = gd.items.get(iid)
        if not item or not item.marketable or not (entry["listings"] or entry["sales"]):
            continue
        names.append([iid, item.name])
        # 매물은 다 보여주고, 그 서버 보통 가격의 절반도 안 되는 미끼만 표시
        _, _, _, baits = clean_by_world(entry["sales"], entry["listings"], odd, outlier)
        bait_set = {tuple(b) for b in baits}
        worlds = {}
        for l in sorted(entry["listings"], key=lambda l: l[0]):
            w = worlds.setdefault(str(l[3]), {"lst": [], "cnt": 0})
            if len(w["lst"]) < TOP_LISTINGS:
                w["lst"].append([l[0], l[1], 1 if l[2] else 0, 1 if tuple(l) in bait_set else 0])
        for k, n in (entry.get("counts") or {}).items():
            w = worlds.setdefault(k.split(":")[0], {"lst": [], "cnt": 0})
            w["cnt"] += n
        h = []
        for d in dates:
            rec = hist["days"][d].get(str(iid))
            if rec:
                h.append([d[5:], rec.get("s", {}), rec.get("m", {})])
        shards.setdefault(iid % TRACK_SHARDS, {})[str(iid)] = {
            "w": worlds, "h": h, "upd": (entry.get("last_upload") or 0) / 1000, "stack": item.stack_size,
        }
    names.sort(key=lambda x: x[1])
    write(out / "track" / "items.json", names)
    for n in range(TRACK_SHARDS):
        write(out / "track" / f"t{n}.json", shards.get(n, {}))
    return len(names)

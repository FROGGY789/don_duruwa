"""Universalis 공식 API 로 시세 / 판매 기록 / 세율을 받아 로컬에 캐시한다.

- 한 번에 최대 100개 아이템을 묶어 요청
- 요청은 한 줄로(동시 연결 1개) 보내고, 요청 사이 간격을 둬서 초당 25회 제한을 넘지 않음
- 데이터센터(한국) 전체 시세를 한 번에 받는다. 매물/판매 기록마다 어느 서버인지 같이 저장해서,
  계산할 때 "데이터센터 전체" 또는 "내 서버만" 으로 골라 볼 수 있다.
- 받은 데이터는 cache/market_<월드ID>_dc.json 에 저장

직접 실행하면 (python -m ffxiv.market) 분석에 필요한 아이템 시세를 전부 받아 저장합니다.
"""
import json
import time
from urllib.parse import quote

import requests

from .config import CACHE_DIR, load_config

BATCH = 100
KEEP_LISTINGS = 30  # 서버·품질별로 싼 매물 몇 개까지 저장할지 (메모리 절약). 전체 개수는 따로 센다.


class Universalis:
    def __init__(self, base_url, interval=0.1):
        self.base = base_url.rstrip("/")
        self.interval = interval
        self._last = 0.0
        self.session = requests.Session()
        self.session.headers["User-Agent"] = "ffxiv-craft-profit (personal analysis tool)"

    def _get(self, path, params=None):
        for attempt in range(5):
            wait = self.interval - (time.time() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.time()
            try:
                resp = self.session.get(f"{self.base}{path}", params=params, timeout=60)
            except requests.RequestException:
                if attempt == 4:
                    raise
                time.sleep(2 ** attempt)
                continue
            if resp.status_code == 429 or resp.status_code >= 500:
                if attempt == 4:
                    resp.raise_for_status()
                time.sleep(2 ** attempt)
                continue
            resp.raise_for_status()
            return resp.json()

    def server_info(self, name, world_id=None):
        """내 월드 ID, 속한 데이터센터 이름, 그 데이터센터의 {월드ID: 이름} 을 찾는다."""
        worlds = {w["id"]: w["name"] for w in self._get("/api/v2/worlds")}
        if not world_id:
            world_id = next((wid for wid, n in worlds.items() if n == name), None)
        if world_id is None:
            names = ", ".join(sorted(n for n in worlds.values() if not n.isascii()))
            raise ValueError(f"'{name}' 월드를 몬 찾았다. config.yaml 의 world 한번 봐 봐라. (한글 월드: {names})")
        dc = next((d for d in self._get("/api/v2/data-centers") if world_id in d["worlds"]), None)
        members = dc["worlds"] if dc else [world_id]
        return {
            "world_id": world_id,
            "world": worlds.get(world_id, name),
            "dc": dc["name"] if dc else None,
            "world_names": {str(w): worlds.get(w, str(w)) for w in members},
        }

    def tax_rates(self, world_id):
        """{도시(영문): 세율(0~1)}"""
        data = self._get("/api/tax-rates", {"world": world_id})
        return {city: rate / 100 for city, rate in data.items()}

    @staticmethod
    def _items(data):
        # 아이템을 여러 개 요청하면 {"items": {...}}, 하나만 요청하면 그 아이템 자체가 온다
        if "items" in data:
            return {int(k): v for k, v in data["items"].items()}
        if "itemID" in data:
            return {int(data["itemID"]): data}
        return {}

    def fetch(self, target, item_ids, history_hours, default_world, progress=None):
        """아이템별 {listings, sales, last_upload, fetched_at} 를 돌려준다.

        target 은 데이터센터 이름 또는 월드 ID. 월드 하나만 조회하면 응답에 서버 정보가 없어서 default_world 로 채운다.
        """
        target = quote(str(target))
        ids = sorted(set(item_ids))
        out = {}
        batches = [ids[i:i + BATCH] for i in range(0, len(ids), BATCH)]
        for n, chunk in enumerate(batches):
            if progress:
                progress(n / len(batches), f"시세 받는 중이데이 ({n + 1}/{len(batches)})")
            id_str = ",".join(map(str, chunk))
            now = time.time()
            current = self._items(self._get(f"/api/v2/{target}/{id_str}", {"entries": 0}))
            history = self._items(self._get(
                f"/api/v2/history/{target}/{id_str}",
                {"entriesWithin": int(history_hours * 3600), "entriesToReturn": 999},
            ))
            for iid in chunk:
                cur = current.get(iid, {})
                hist = history.get(iid, {})
                listings, counts = _trim_listings(cur.get("listings", []), default_world)
                out[iid] = {
                    # [단가(세금 제외), 수량, HQ여부, 월드ID] — 서버·품질별 싼 순 KEEP_LISTINGS 개
                    "listings": listings,
                    # {"월드ID:0 또는 1(HQ)": 전체 매물 수}
                    "counts": counts,
                    # [단가, 수량, HQ여부, 판매 시각(초), 월드ID]
                    "sales": [[s["pricePerUnit"], s["quantity"], bool(s.get("hq")), s["timestamp"],
                               s.get("worldID", default_world)]
                              for s in hist.get("entries", [])],
                    "last_upload": max(cur.get("lastUploadTime", 0) or 0, hist.get("lastUploadTime", 0) or 0),
                    "fetched_at": now,
                }
        if progress:
            progress(1.0, "다 됐데이")
        return out


def _trim_listings(raw, default_world):
    groups = {}
    for l in raw:
        world = l.get("worldID", default_world)
        hq = bool(l.get("hq"))
        groups.setdefault((world, hq), []).append([l["pricePerUnit"], l["quantity"], hq, world])
    listings, counts = [], {}
    for (world, hq), group in groups.items():
        group.sort(key=lambda x: x[0])
        listings.extend(group[:KEEP_LISTINGS])
        counts[f"{world}:{int(hq)}"] = len(group)
    return listings, counts


class MarketCache:
    """cache/market_<월드ID>_dc.json 읽기/쓰기."""

    def __init__(self, server):
        suffix = "_dc" if server["dc"] else ""
        self.path = CACHE_DIR / f"market_{server['world_id']}{suffix}.json"
        self.data = {"world_id": server["world_id"], "updated_at": 0, "tax_rates": {}, "items": {}}
        if self.path.exists():
            with open(self.path, encoding="utf-8") as f:
                self.data = json.load(f)

    @property
    def items(self):
        return {int(k): v for k, v in self.data["items"].items()}

    @property
    def updated_at(self):
        return self.data.get("updated_at", 0)

    @property
    def tax_rates(self):
        return self.data.get("tax_rates", {})

    def missing(self, item_ids):
        have = self.data["items"]
        return [i for i in item_ids if str(i) not in have]

    def update(self, items, tax_rates=None, full=False):
        # 새 dict 를 다 만든 뒤 한 번에 바꿔 끼운다 → 뒤에서 갱신하는 동안 화면이 읽어도 안전
        new = {} if full else dict(self.data["items"])
        for iid, entry in items.items():
            new[str(iid)] = entry
        self.data["items"] = new
        if full:
            self.data["updated_at"] = time.time()
        if tax_rates:
            self.data["tax_rates"] = tax_rates
        if not self.data["updated_at"]:
            self.data["updated_at"] = time.time()
        self.save()

    def save(self):
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.data, f, ensure_ascii=False)
        tmp.replace(self.path)


def resolve_server(api, cfg):
    """월드 ID / 데이터센터 / 서버 이름 목록을 찾아서 cache/server.json 에 기억해 둔다."""
    memo = CACHE_DIR / "server.json"
    known = json.loads(memo.read_text(encoding="utf-8")) if memo.exists() else {}
    key = str(cfg.get("world_id") or cfg["world"])
    if key not in known:
        known[key] = api.server_info(cfg["world"], cfg.get("world_id"))
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        memo.write_text(json.dumps(known, ensure_ascii=False), encoding="utf-8")
    return known[key]


def refresh(api, cache, server, item_ids, history_hours, full, progress=None):
    """full=True 면 전부 새로 받고, 아니면 캐시에 없는 아이템만 받는다."""
    ids = list(item_ids) if full else cache.missing(item_ids)
    tax = None
    if full or not cache.tax_rates:
        try:
            tax = api.tax_rates(server["world_id"])
        except requests.RequestException:
            tax = None
    target = server["dc"] or server["world_id"]
    items = api.fetch(target, ids, history_hours, server["world_id"], progress) if ids else {}
    cache.update(items, tax, full=full)
    return len(ids)


if __name__ == "__main__":
    from .gamedata import GameData, download_csvs, scope_recipes
    from .profit import market_item_ids

    cfg = load_config()
    download_csvs(cfg["datamining_base_url"])
    gd = GameData()
    api = Universalis(cfg["universalis_base_url"], cfg["request_interval_sec"])
    server = resolve_server(api, cfg)
    print(f"월드: {server['world']} (ID {server['world_id']}) / 데이터센터: {server['dc']} "
          f"({', '.join(server['world_names'].values())})")
    recipes = list(scope_recipes(gd, cfg, True))
    ids = market_item_ids(gd, recipes)
    print(f"레시피 {len(recipes)}개 (전체 레벨), 시세 조회할 아이템 {len(ids)}개")
    cache = MarketCache(server)
    n = refresh(api, cache, server, ids, cfg["history_hours"], full=True,
                progress=lambda p, msg: print(f"  {msg}"))
    items = cache.items
    with_sales = sum(1 for i in ids if items.get(i, {}).get("sales"))
    with_listings = sum(1 for i in ids if items.get(i, {}).get("listings"))
    print(f"\n{n}개 받음 → {cache.path}")
    home = server["world_id"]
    home_sales = sum(1 for i in ids if any(s[4] == home for s in items.get(i, {}).get("sales", [])))
    print(f"판매 기록 있는 아이템: 데이터센터 전체 {with_sales}/{len(ids)}, {server['world']}만 {home_sales}/{len(ids)}")
    print(f"매물 있는 아이템: {with_listings}/{len(ids)}")
    print(f"세율: {cache.tax_rates}")

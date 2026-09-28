"""Universalis 공식 API 로 시세 / 판매 기록 / 세율을 받아 로컬에 캐시한다.

- 한 번에 최대 100개 아이템을 묶어 요청
- 요청은 한 줄로(동시 연결 1개) 보내고, 요청 사이 간격을 둬서 초당 25회 제한을 넘지 않음
- 받은 데이터는 cache/market_<월드ID>.json 에 저장

직접 실행하면 (python -m ffxiv.market) 분석에 필요한 아이템 시세를 전부 받아 저장합니다.
"""
import json
import time

import requests

from .config import CACHE_DIR, load_config

BATCH = 100


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

    def world_id(self, name):
        worlds = self._get("/api/v2/worlds")
        for w in worlds:
            if w["name"] == name:
                return w["id"]
        names = ", ".join(sorted(w["name"] for w in worlds if not w["name"].isascii()))
        raise ValueError(f"'{name}' 월드를 찾지 못했습니다. config.yaml 의 world 를 확인하세요. (한글 월드: {names})")

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

    def fetch(self, world_id, item_ids, history_hours, progress=None):
        """아이템별 {listings, sales, last_upload, fetched_at} 를 돌려준다."""
        ids = sorted(set(item_ids))
        out = {}
        batches = [ids[i:i + BATCH] for i in range(0, len(ids), BATCH)]
        for n, chunk in enumerate(batches):
            if progress:
                progress(n / len(batches), f"시세 받는 중 ({n + 1}/{len(batches)})")
            id_str = ",".join(map(str, chunk))
            now = time.time()
            current = self._items(self._get(f"/api/v2/{world_id}/{id_str}", {"entries": 0}))
            history = self._items(self._get(
                f"/api/v2/history/{world_id}/{id_str}",
                {"entriesWithin": int(history_hours * 3600), "entriesToReturn": 999},
            ))
            for iid in chunk:
                cur = current.get(iid, {})
                hist = history.get(iid, {})
                out[iid] = {
                    # [단가(세금 제외), 수량, HQ여부]
                    "listings": [[l["pricePerUnit"], l["quantity"], bool(l.get("hq"))]
                                 for l in cur.get("listings", [])],
                    # [단가, 수량, HQ여부, 판매 시각(초)]
                    "sales": [[s["pricePerUnit"], s["quantity"], bool(s.get("hq")), s["timestamp"]]
                              for s in hist.get("entries", [])],
                    "last_upload": max(cur.get("lastUploadTime", 0) or 0, hist.get("lastUploadTime", 0) or 0),
                    "fetched_at": now,
                }
        if progress:
            progress(1.0, "완료")
        return out


class MarketCache:
    """cache/market_<월드ID>.json 읽기/쓰기."""

    def __init__(self, world_id):
        self.path = CACHE_DIR / f"market_{world_id}.json"
        self.data = {"world_id": world_id, "updated_at": 0, "tax_rates": {}, "items": {}}
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
        if full:
            self.data["items"] = {}
            self.data["updated_at"] = time.time()
        for iid, entry in items.items():
            self.data["items"][str(iid)] = entry
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


def resolve_world_id(api, cfg):
    """config 의 world_id 가 있으면 그대로, 없으면 이름으로 찾아서 cache 에 기억해 둔다."""
    if cfg.get("world_id"):
        return int(cfg["world_id"])
    memo = CACHE_DIR / "world_ids.json"
    known = json.loads(memo.read_text(encoding="utf-8")) if memo.exists() else {}
    if cfg["world"] in known:
        return known[cfg["world"]]
    wid = api.world_id(cfg["world"])
    known[cfg["world"]] = wid
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    memo.write_text(json.dumps(known, ensure_ascii=False), encoding="utf-8")
    return wid


def refresh(api, cache, world_id, item_ids, history_hours, full, progress=None):
    """full=True 면 전부 새로 받고, 아니면 캐시에 없는 아이템만 받는다."""
    ids = list(item_ids) if full else cache.missing(item_ids)
    tax = None
    if full or not cache.tax_rates:
        try:
            tax = api.tax_rates(world_id)
        except requests.RequestException:
            tax = None
    items = api.fetch(world_id, ids, history_hours, progress) if ids else {}
    cache.update(items, tax, full=full)
    return len(ids)


if __name__ == "__main__":
    from .gamedata import GameData, download_csvs, scope_recipes
    from .profit import market_item_ids

    cfg = load_config()
    download_csvs(cfg["datamining_base_url"])
    gd = GameData()
    api = Universalis(cfg["universalis_base_url"], cfg["request_interval_sec"])
    wid = resolve_world_id(api, cfg)
    print(f"월드: {cfg['world']} (ID {wid})")
    recipes = list(scope_recipes(gd, cfg, cfg["include_all_crafts"]))
    ids = market_item_ids(gd, recipes)
    print(f"레시피 {len(recipes)}개 (전체 레벨), 시세 조회할 아이템 {len(ids)}개")
    cache = MarketCache(wid)
    n = refresh(api, cache, wid, ids, cfg["history_hours"], full=True,
                progress=lambda p, msg: print(f"  {msg}"))
    items = cache.items
    with_sales = sum(1 for i in ids if items.get(i, {}).get("sales"))
    with_listings = sum(1 for i in ids if items.get(i, {}).get("listings"))
    print(f"\n{n}개 받음 → {cache.path}")
    print(f"판매 기록 있는 아이템: {with_sales}/{len(ids)}, 매물 있는 아이템: {with_listings}/{len(ids)}")
    print(f"세율: {cache.tax_rates}")

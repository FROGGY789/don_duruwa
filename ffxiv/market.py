"""Universalis 공식 API 로 시세 / 판매 기록 / 세율을 받아 로컬에 캐시한다.

- 한 번에 최대 100개 아이템을 묶어 요청
- 요청은 한 줄로(동시 연결 1개) 보내고, 요청 사이 간격을 둬서 초당 25회 제한을 넘지 않음
- 데이터센터(한국) 전체 시세를 한 번에 받는다. 매물/판매 기록마다 어느 서버인지 같이 저장해서,
  계산할 때 "데이터센터 전체" 또는 "내 서버만" 으로 골라 볼 수 있다.
- 받은 데이터는 cache/market_<월드ID>_dc.json 에 저장

직접 실행하면 (python -m ffxiv.market) 분석에 필요한 아이템 시세를 전부 받아 저장합니다.
"""
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

import requests

from .config import CACHE_DIR, load_config

BATCH = 100
KEEP_LISTINGS = 30  # 서버·품질별로 싼 매물 몇 개까지 저장할지 (메모리 절약). 전체 개수는 따로 센다.


class Universalis:
    def __init__(self, base_url, interval=0.1, workers=4):
        self.base = base_url.rstrip("/")
        self.interval = interval
        self.workers = max(1, int(workers))  # 동시에 보내는 요청 수 (Universalis 허용: 초당 25회, 동시 8개)
        self._last = 0.0
        self._lock = threading.Lock()
        self.session = requests.Session()
        self.session.headers["User-Agent"] = "ffxiv-craft-profit (personal analysis tool)"
        self.stats = {"missing": 0, "recovered": 0}  # 응답에서 빠진 아이템 수 (로그용)

    def _get(self, path, params=None):
        for attempt in range(5):
            with self._lock:  # 여러 스레드가 같이 보내도 요청 간격은 지킨다
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
            raise ValueError(f"'{name}' 월드를 못 찾았다 개굴. config.yaml 의 world 한번 봐 봐라 개굴. (한글 월드: {names})")
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

    def _many(self, path, chunk, params, depth=0):
        """여러 아이템을 한 번에 받는다. 응답에서 말없이 빠진 아이템(없는 아이템 목록에도 없는데 안 온 것)은
        작게 쪼개서 다시 받는다. Universalis 가 바쁠 때 일부만 돌려주는 일이 있다."""
        try:
            data = self._get(f"{path}/{','.join(map(str, chunk))}", params)
        except requests.HTTPError as e:  # 다시 받을 때 하나짜리 요청은 모르는 아이템이면 404 가 온다
            code = e.response.status_code if e.response is not None else 0
            if depth and code == 404:
                return {}
            # Universalis 가 바빠서 504 같은 걸 계속 주면: 작게 쪼개서 다시, 그래도 안 되면 그 템들만 건너뛴다
            # (건너뛴 템은 지난번에 받아 둔 값을 그대로 쓴다 — MarketCache.update)
            if code >= 500:
                if len(chunk) > 1 and depth < 3:
                    got, step = {}, max(1, len(chunk) // 4)
                    for i in range(0, len(chunk), step):
                        got.update(self._many(path, chunk[i:i + step], params, depth + 1))
                    return got
                with self._lock:
                    self.stats["skipped"] = self.stats.get("skipped", 0) + len(chunk)
                return {}
            raise
        got = self._items(data)
        unresolved = {int(x) for x in data.get("unresolvedItems") or []}
        missing = [i for i in chunk if i not in got and i not in unresolved]
        if missing and depth == 0:
            with self._lock:
                self.stats["missing"] += len(missing)
        if missing and depth < 3:
            step = max(1, len(missing) // 4)
            for i in range(0, len(missing), step):
                more = self._many(path, missing[i:i + step], params, depth + 1)
                got.update(more)
            if depth == 0:
                with self._lock:
                    self.stats["recovered"] += sum(1 for i in missing if i in got)
        return got

    def fetch(self, target, item_ids, history_hours, default_world, progress=None):
        """아이템별 {listings, sales, last_upload, fetched_at} 를 돌려준다.

        target 은 데이터센터 이름 또는 월드 ID. 월드 하나만 조회하면 응답에 서버 정보가 없어서 default_world 로 채운다.
        """
        target = quote(str(target))
        ids = sorted(set(item_ids))
        out = {}
        batches = [ids[i:i + BATCH] for i in range(0, len(ids), BATCH)]
        done = [0]

        def one(chunk):
            now = time.time()
            current = self._many(f"/api/v2/{target}", chunk, {"entries": 0})
            history = self._many(f"/api/v2/history/{target}", chunk,
                                 {"entriesWithin": int(history_hours * 3600), "entriesToReturn": 999})
            part = {}
            for iid in chunk:
                if iid not in current and iid not in history:
                    continue  # 둘 다 못 받았으면 (서버 오류로 건너뜀) 지난번 값을 그대로 둔다
                cur = current.get(iid, {})
                hist = history.get(iid, {})
                listings, counts = _trim_listings(cur.get("listings", []), default_world)
                part[iid] = {
                    # [단가(세금 제외), 수량, HQ여부, 월드ID] — 서버·품질별 싼 순 KEEP_LISTINGS 개
                    "listings": listings,
                    # {"월드ID:0 또는 1(HQ)": 전체 매물 수}
                    "counts": counts,
                    # 🏰 부대원 판매 찾기용: [리테이너, 제작자 서명, 월드ID, HQ여부, 단가, 수량, 확인 시각(초)] — 전부
                    "sellers": _sellers(cur.get("listings", []), default_world),
                    # [단가, 수량, HQ여부, 판매 시각(초), 월드ID]
                    "sales": [[s["pricePerUnit"], s["quantity"], bool(s.get("hq")), s["timestamp"],
                               s.get("worldID", default_world)]
                              for s in hist.get("entries", [])],
                    "last_upload": max(cur.get("lastUploadTime", 0) or 0, hist.get("lastUploadTime", 0) or 0),
                    "fetched_at": now,
                }
            done[0] += 1
            if progress:
                progress(done[0] / len(batches), f"시세 받는 중이다 개굴 ({done[0]}/{len(batches)})")
            return part

        # 묶음 여러 개를 동시에 받는다 (하나씩 받으면 10분 넘게 걸린다)
        with ThreadPoolExecutor(self.workers) as pool:
            for part in pool.map(one, batches):
                out.update(part)
        if progress:
            progress(1.0, "다 됐다 개굴")
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


def _sellers(raw, default_world):
    return [[l.get("retainerName") or "", l.get("creatorName") or "", l.get("worldID", default_world), int(bool(l.get("hq"))),
             l["pricePerUnit"], l["quantity"], int(l.get("lastReviewTime") or 0)]
            for l in raw if l.get("retainerName") or l.get("creatorName")]


class MarketCache:
    """cache/market_<월드ID>_dc.json 읽기/쓰기."""

    def __init__(self, server):
        suffix = "_dc" if server["dc"] else ""
        self.path = CACHE_DIR / f"market_{server['world_id']}{suffix}.json"
        self.data = {"world_id": server["world_id"], "updated_at": 0, "tax_rates": {}, "items": {}}
        self.version = 0
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
        # 전부 새로 받을 때도 이번에 못 받은 템(서버 오류로 건너뜀)은 지난번 값을 남긴다
        fresh = {str(i) for i in items}
        new = {k: v for k, v in self.data["items"].items() if k not in fresh} if full else dict(self.data["items"])
        for iid, entry in items.items():
            new[str(iid)] = entry
        self.data["items"] = new
        self.version += 1  # 화면 쪽 계산 결과 기억(캐시)을 새로 하라는 신호
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

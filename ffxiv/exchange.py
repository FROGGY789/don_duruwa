"""🪙 교환 순위용 데이터: 군표·화폐·석판 같은 걸로 바꿔서 거래소에 팔 수 있는 템.

제작·채집 순위에 없는 템만 (그건 이미 다른 탭에 있으니까). 출처는 게임 데이터에서 바로 뽑는다.

  군표          GCScripShopItem (총사령부 보급 담당관, 계급 제한 있음)
  화폐·석판 등  SpecialShop (교환 상점마다 대가로 받는 아이템이 정해져 있다)
  판매 NPC      ENpcBase 의 ENpcData → 상점 (중간에 TopicSelect · PreHandler · CustomTalk 를 거치기도 함)
  위치          Level (NPC 가 서 있는 맵·좌표) → Map → PlaceName

한국 데이터마이닝 CSV 기준이라 이름·화폐 표현은 한국 서버 그대로다 (예: 제작자용 화폐: 등화, 알라그 석판: 시학).
"""
import csv
from collections import defaultdict
from dataclasses import dataclass, field

from .gamedata import CSV_DIR

SHEETS = ["SpecialShop", "GCScripShopItem", "GCScripShopCategory", "GCShop", "GrandCompany", "TomestonesItem",
          "GCRankLimsaMaleText", "GCRankGridaniaMaleText", "GCRankUldahMaleText",
          "ENpcBase", "ENpcResident", "Level", "Map", "PlaceName", "TopicSelect", "PreHandler", "CustomTalk"]

GC_RANK_SHEET = {1: "GCRankLimsaMaleText", 2: "GCRankGridaniaMaleText", 3: "GCRankUldahMaleText"}
GC_SEAL = "군표"
# SpecialShop 의 대가 아이템 번호가 작은 숫자면 진짜 아이템이 아니라 '지금 쓰는 화폐' 번호다
#   UseCurrencyType 16 (또는 상점 이름에 '화폐') → 제작자·채집가 화폐, 2·4 → 알라그 석판 (TomestonesItem)
SCRIPS = {2: 33913, 4: 33914, 6: 41784, 7: 41785}  # 제작자용·채집가용 화폐: 자화 / 등화
POETICS = 28  # 알라그 석판: 시학
GIL = 1


def _rows(sheet):
    """(key, {열 이름: 값}) — 이름이 겹치거나 빈 열은 위치 번호로."""
    with open(CSV_DIR / f"{sheet}.csv", encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        next(reader)
        names = next(reader)
        next(reader)
        names = [n or f"#{i}" for i, n in enumerate(names)]
        for row in reader:
            if row:
                yield row[0], dict(zip(names, row))


def _int(s):
    try:
        return int(float(s))
    except (TypeError, ValueError):
        return 0


@dataclass
class Offer:
    item_id: int
    amount: int           # 한 번 교환에 받는 개수
    currency: str         # 화폐 이름 (군표는 "군표" 하나로 묶는다)
    currency_id: int
    price: int            # 화폐 몇 개
    group: str            # 화면 분류: 군표 / 제작자·채집가 화폐 / 알라그 석판 / 기타 화폐
    sources: list = field(default_factory=list)  # [{"shop", "npc", "place", "x", "y", "note"}]
    unlock: str = ""      # 계급·퀘스트 같은 조건


def _group(currency_id, name):
    if currency_id in SCRIPS.values():
        return "제작자·채집가 화폐"
    if name.startswith("알라그 석판"):
        return "알라그 석판"
    return "기타 화폐"


class Places:
    """NPC ID → [(NPC 이름, 지역 이름, X, Y)]."""

    def __init__(self):
        self.names = {k: r["Singular"] for k, r in _rows("ENpcResident")}
        place = {k: r["Name"] for k, r in _rows("PlaceName")}
        maps = {}
        for k, r in _rows("Map"):
            maps[k] = (place.get(r["PlaceName"], ""), place.get(r["PlaceName{Region}"], ""), _int(r["SizeFactor"]) or 100,
                       _int(r["Offset{X}"]), _int(r["Offset{Y}"]))
        self.where = defaultdict(list)
        for _, r in _rows("Level"):
            if r["Type"] != "8" or r["Map"] not in maps:  # 8 = NPC
                continue
            name, region, size, ox, oy = maps[r["Map"]]
            if not name:
                continue
            c = size / 100
            coord = lambda v, o: round(41 / c * ((float(v) + o) * c + 1024) / 2048 + 1, 1)
            self.where[r["Object"]].append((name, region, coord(r["X"], ox), coord(r["Z"], oy)))

    def of(self, npc):
        name = self.names.get(npc, "")
        spots = self.where.get(npc) or [("", "", None, None)]
        return [{"npc": name, "place": p, "region": g, "x": x, "y": y} for p, g, x, y in spots[:1]]


def _npc_shops(shop_ids):
    """상점 ID → 그 상점을 여는 NPC ID 들."""
    topic = {k: [r[f"Shop[{i}]"] for i in range(10)] for k, r in _rows("TopicSelect")}
    pre = {k: [r["Target"]] for k, r in _rows("PreHandler")}
    talk = {k: [v for v in r.values() if v.isdigit() and len(v) >= 6] for k, r in _rows("CustomTalk")}

    def resolve(v, depth=0):
        if v in shop_ids:
            return {v}
        if depth > 3:
            return set()
        for table in (topic, pre, talk):
            if v in table:
                return set().union(*(resolve(x, depth + 1) for x in table[v]))
        return set()

    npcs = defaultdict(set)
    for k, r in _rows("ENpcBase"):
        for i in range(32):
            v = r.get(f"ENpcData[{i}]", "0")
            if v != "0":
                for shop in resolve(v):
                    npcs[shop].add(k)
    return npcs


def load_offers(gd):
    """교환으로 얻는 거래 가능 템 [Offer]. 같은 템·화폐·가격은 하나로 합치고 출처만 모은다."""
    items = gd.items
    tomes = {_int(r["Tomestones"]): _int(r["Item"]) for _, r in _rows("TomestonesItem") if _int(r["Tomestones"]) > 0}
    tomes[1] = POETICS

    raw = []  # (shop_id, shop_name, item, amount, currency_id, price, unlock)
    for key, r in _rows("SpecialShop"):
        use = _int(r["UseCurrencyType"])
        name = r["Name"]
        for i in range(60):
            got = [(_int(r[f"Item{{Receive}}[{i}][{k}]"]), _int(r[f"Count{{Receive}}[{i}][{k}]"])) for k in range(2)]
            cost = [(_int(r[f"Item{{Cost}}[{i}][{k}]"]), _int(r[f"Count{{Cost}}[{i}][{k}]"])) for k in range(3)]
            got = [(a, n) for a, n in got if a > 0 and n > 0]
            cost = [(a, n) for a, n in cost if a > 0 and n > 0]
            if len(got) != 1 or len(cost) != 1:
                continue  # 여러 개 묶음 교환은 값어치를 나누기 애매해서 뺀다
            (iid, amount), (cid, price) = got[0], cost[0]
            if cid < 10:
                if use == 16 or "화폐" in name:
                    cid = SCRIPS.get(cid, 0)
                elif use in (2, 4):
                    cid = tomes.get(cid, 0)
            if not cid or cid == GIL:
                continue
            quest = _int(r.get(f"Quest{{Item}}[{i}]") or r.get(f"Quest[{i}]") or 0)
            raw.append((key, name, iid, amount, cid, price, "퀘스트 해금" if quest else ""))

    gc_name = {k: r["Name"] for k, r in _rows("GrandCompany")}
    gc_of_cat = {k: _int(r["GrandCompany"]) for k, r in _rows("GCScripShopCategory")}
    gc_shop = {k: _int(r["GrandCompany"]) for k, r in _rows("GCShop")}
    ranks = {gc: {k: r["Name{Rank}"] for k, r in _rows(sheet)} for gc, sheet in GC_RANK_SHEET.items()}  # "소위" (총사령부마다 계급 이름은 같다)
    for key, r in _rows("GCScripShopItem"):
        iid, price = _int(r["Item"]), _int(r["Cost{GCSeals}"])
        gc = gc_of_cat.get(key.split(".")[0], 0)
        if iid and price and gc:
            rank = ranks.get(gc, {}).get(r["Required{GrandCompanyRank}"], "")
            shop = next((k for k, g in gc_shop.items() if g == gc), "")
            raw.append((shop, f"{gc_name.get(str(gc), '')} 보급품 교환", iid, 1, -gc, price, f"총사령부 {rank} 이상" if rank else ""))

    sellable = [x for x in raw if x[2] in items and items[x[2]].marketable
                and (x[4] < 0 or (x[4] in items and not items[x[4]].marketable))]  # 대가가 거래 가능한 템이면 '화폐'가 아니다
    shop_ids = {x[0] for x in sellable}
    npcs = _npc_shops(shop_ids)
    places = Places()

    offers = {}
    for shop, shop_name, iid, amount, cid, price, unlock in sellable:
        if cid < 0:
            currency, group, cur_id = GC_SEAL, GC_SEAL, 20
        else:
            currency, group, cur_id = items[cid].name, _group(cid, items[cid].name), cid
        key = (iid, currency, price, amount)
        o = offers.get(key)
        if not o:
            o = offers[key] = Offer(iid, amount, currency, cur_id, price, group, unlock=unlock)
        spots = [s for npc in sorted(npcs.get(shop, ()), key=int) for s in places.of(npc)] or [{}]
        for s in spots:
            src = {"shop": shop_name, **s}
            if src not in o.sources:
                o.sources.append(src)
        if unlock and unlock not in o.unlock:
            o.unlock = o.unlock or unlock
    return list(offers.values())


def source_text(src):
    """출처 한 줄: '등화 거래: 마테리아 — 아무개 · 울다하 (X 11.3, Y 12.1)'."""
    where = src.get("place", "")
    if where and src.get("x") is not None:
        where += f" (X {src['x']}, Y {src['y']})"
    who = " · ".join(x for x in (src.get("npc", ""), where) if x)
    return f"{src.get('shop', '')}{' — ' + who if who else ''}"

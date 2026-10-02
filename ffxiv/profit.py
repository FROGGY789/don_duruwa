"""수익 계산.

판매 예상가 — 보기마다 다르다
  · 서버별: min(그 서버 기간 중앙값, 그 서버 최저 매물)
  · 통합:   서버별로 거른 판매 기록을 모은 중앙값 (최저 매물은 안 씀 — 제일 싼 서버로 끌려 내려가니까)
  ※ 이상 거래·미끼 매물은 '그 서버' 중앙값 기준으로만 판단한다 (서버마다 시세 수준이 달라서)
재료 단가   = min(거래소 구매가 × (1 + 구매세), NPC 상점가, 직접 제작 원가)
              거래소 구매가는 싼 매물부터 필요 수량만큼 사들인 평균 단가
              직접 제작 원가는 하위 재료까지 재귀로 계산 (내 레벨로 가능한 레시피만)
개당 원가   = 재료비 합계 ÷ 레시피 결과물 개수
순수익      = 판매 예상가 × (1 − 판매세) − 개당 원가
수익률      = 순수익 ÷ 개당 원가

직접 실행하면 (python -m ffxiv.profit) 캐시된 시세로 상위 결과와 원가 내역을 출력합니다.
"""
import math
import statistics
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from .gamedata import can_craft_intermediate

KST = timezone(timedelta(hours=9), "KST")


def market_item_ids(gd, recipes):
    """시세가 필요한 아이템 ID: 완성품 + 재료 + 중간재료의 하위 재료까지.

    중간재료는 레벨과 상관없이 따라 내려가서, 사이드바에서 직업 레벨을 올려도 시세를 다시 받지 않게 한다.
    """
    targets = {}
    for r in recipes:
        targets.setdefault(r.result_id, []).append(r)
    ids, stack = set(), list(targets)
    while stack:
        iid = stack.pop()
        if iid in ids:
            continue
        ids.add(iid)
        subs = [r for r in gd.recipes_by_result.get(iid, [])
                if not (r.expert or r.specialist or r.stars)]
        for r in targets.get(iid, []) + subs:
            stack.extend(i for i, _ in r.ingredients)
    return sorted(i for i in ids if i in gd.items and gd.items[i].marketable)


@dataclass
class Stats:
    sale_count: int = 0
    sold_qty: int = 0
    median: float = None
    listing_count: int = 0
    min_listing: float = None
    last_upload: float = 0  # 초
    dropped: list = field(default_factory=list)  # 이상 거래로 뺀 판매 기록
    good_listings: list = field(default_factory=list)  # 미끼로 안 본 매물
    bait: list = field(default_factory=list)  # 미끼로 본 매물


def split_odd_sales(sales, ratio):
    """중앙값보다 ratio 배 넘게 비싸거나 1/ratio 보다 싼 거래를 이상 거래로 뺀다. (남긴 것, 뺀 것)

    판매가 3건 이상일 때만 따진다. ratio 가 0 이면 안 거른다.
    기준은 가운데 두 값 중 낮은 쪽 (정상 3건 + 비싼 3건일 때 비싼 쪽이 기준 되는 걸 막는다).
    """
    if not ratio or len(sales) < 3:
        return sales, []
    mid = statistics.median_low(s[0] for s in sales)
    kept = [s for s in sales if mid / ratio <= s[0] <= mid * ratio]
    return kept, [s for s in sales if s not in kept]


def clean_by_world(sales, listings, odd_ratio, outlier_ratio):
    """서버마다 따로 이상 거래·미끼 매물을 가른다. (남긴 판매, 뺀 판매, 남긴 매물, 미끼 매물)

    톤베리가 원래 1,000길대면 1,000길은 정상이다. 그 서버 중앙값이랑만 비교한다.
    """
    kept, dropped, good, bait = [], [], [], []
    for w in {s[4] for s in sales} | {l[3] for l in listings}:
        k, d = split_odd_sales([s for s in sales if s[4] == w], odd_ratio)
        kept += k
        dropped += d
        mid = statistics.median(s[0] for s in k) if k else None
        for l in listings:
            if l[3] == w:
                (bait if mid and outlier_ratio and l[0] < mid * outlier_ratio else good).append(l)
    return kept, dropped, good, bait


def market_stats(entry, hq, hours, outlier_ratio=0.0, world=None, odd_ratio=0.0):
    """hq=None 이면 품질 구분 없이, True/False 면 그 품질만. world=None 이면 데이터센터 전체, 월드ID 면 그 서버만.

    이상 거래(odd_ratio)와 미끼 매물(outlier_ratio)은 서버마다 그 서버 중앙값 기준으로 거른다.
    """
    st = Stats()
    if not entry:
        return st
    since = entry.get("fetched_at", time.time()) - hours * 3600
    sales = [s for s in entry["sales"] if s[3] >= since and (hq is None or s[2] == hq)]
    listings = [l for l in entry["listings"] if hq is None or l[2] == hq]
    kept, dropped, good, bait = clean_by_world(sales, listings, odd_ratio, outlier_ratio)
    mine = lambda w: world is None or w == world
    sales = [s for s in kept if mine(s[4])]
    st.dropped = [s for s in dropped if mine(s[4])]
    st.good_listings = sorted((l for l in good if mine(l[3])), key=lambda l: l[0])
    st.bait = [l for l in bait if mine(l[3])]
    st.sale_count = len(sales)
    st.sold_qty = sum(s[1] for s in sales)
    if sales:
        st.median = statistics.median(s[0] for s in sales)
    counts = entry.get("counts")
    if counts is None:  # 예전 캐시 형식
        st.listing_count = len(listings)
    else:  # 저장은 싼 매물만 했으니 개수는 따로 센 값으로
        st.listing_count = sum(n for key, n in counts.items()
                               if (world is None or key.split(":")[0] == str(world))
                               and (hq is None or key.split(":")[1] == str(int(hq))))
    if st.good_listings:
        st.min_listing = st.good_listings[0][0]
    st.last_upload = (entry.get("last_upload") or 0) / 1000
    return st


@dataclass
class CostNode:
    item_id: int
    need: int  # 총 필요 수량
    unit_cost: float = None  # 개당 비용 (None = 가격 모름)
    source: str = "시세 없음"  # 거래소 / NPC / 직접 제작 / 직접 채집 / 시세 없음
    note: str = ""
    recipe: object = None
    children: list = field(default_factory=list)  # [(CostNode, 1회 제작당 수량)]


class Calculator:
    def __init__(self, gd, market, cfg, seller_tax, sell_hq=False, batch_size=1, job_levels=None,
                 buy_world=None, world_names=None, home_world=None):
        self.gd = gd
        self.job_levels = job_levels or cfg["job_levels"]
        # 재료 구매 범위: None = 데이터센터 전체, 월드ID = 그 서버만
        self.buy_world = buy_world
        self.world_names = world_names or {}
        self.home_world = home_world
        # 순위 '보기': 통합(dc) + 서버별. 판매 쪽은 전부 이 보기마다 따로 계산한다
        self.views = [("dc", None)] + [(str(w), int(w)) for w in self.world_names]
        self.market = market
        self.cfg = cfg
        self.seller_tax = seller_tax
        self.buyer_tax = cfg["buyer_tax_rate"]
        self.hours = cfg["history_hours"]
        self.outlier_ratio = cfg["outlier_ratio"]
        self.sell_hq = sell_hq  # False = NQ 시세, True = HQ 시세, None = NQ·HQ 통합 시세
        self.batch = max(1, int(batch_size))
        self.self_gathered = gd.ids_by_name(cfg.get("self_gathered_items"))
        self.npc_ignore = gd.ids_by_name(cfg.get("npc_ignore_items"))
        self._memo = {}
        self._stats = {}
        self.odd_ratio = cfg.get("odd_sale_ratio", 3)
        self.furniture = set(cfg["furniture_ui_categories"])

    def stats(self, item_id, hq=None, outlier_ratio=0.0, world=None):
        """market_stats 결과를 기억해 둔다 (같은 재료를 여러 레시피가 쓰니까)."""
        key = (item_id, hq, outlier_ratio, world)
        if key not in self._stats:
            self._stats[key] = market_stats(self.market.get(item_id), hq, self.hours, outlier_ratio, world, self.odd_ratio)
        return self._stats[key]

    # ── 재료 구매 ──
    def market_buy_price(self, item_id, need):
        """거래소에서 need 개를 살 때의 평균 단가 (세금 제외). 비고에는 사러 갈 서버를 적는다."""
        entry = self.market.get(item_id)
        if not entry:
            return None, ""
        listings = sorted((l[0], l[1], l[3]) for l in entry["listings"]
                          if self.buy_world is None or l[3] == self.buy_world)
        bought, spent, worlds = 0, 0, []
        for price, qty, world in listings:
            take = min(qty, need - bought)
            bought += take
            spent += take * price
            name = self.world_names.get(str(world), str(world))
            if name not in worlds:
                worlds.append(name)
            if bought >= need:
                return spent / bought, ", ".join(worlds)
        median = self.stats(item_id, world=self.buy_world).median
        where = ", ".join(worlds)
        if bought and median:
            return max(spent / bought, median), f"{where} (매물 부족)"
        if bought:
            return spent / bought, f"{where} (매물 부족)"
        if median:
            return median, "매물 없음(최근 판매가)"
        return None, ""

    def best(self, item_id, need, stack=()):
        """재료 하나를 구하는 가장 싼 방법."""
        key = (item_id, need)
        if key in self._memo:
            return self._memo[key]
        if item_id in self.self_gathered:
            node = CostNode(item_id, need, 0, "직접 채집")
            self._memo[key] = node
            return node

        options = []
        if item_id in self.gd.npc_prices and item_id not in self.npc_ignore:
            options.append(CostNode(item_id, need, self.gd.npc_prices[item_id], "NPC"))
        price, note = self.market_buy_price(item_id, need)
        if price is not None:
            options.append(CostNode(item_id, need, price * (1 + self.buyer_tax), "거래소", note))
        if item_id not in stack:
            for r in self.gd.recipes_by_result.get(item_id, []):
                if can_craft_intermediate(r, self.cfg, self.job_levels):
                    crafted = self.craft(r, math.ceil(need / r.result_amount), stack + (item_id,))
                    if crafted.unit_cost is not None:
                        options.append(crafted)

        node = min(options, key=lambda n: n.unit_cost) if options else CostNode(item_id, need)
        self._memo[key] = node
        return node

    def craft(self, recipe, crafts, stack=()):
        """recipe 를 crafts 번 만들 때의 개당 원가."""
        node = CostNode(recipe.result_id, crafts * recipe.result_amount, source="직접 제작", recipe=recipe)
        total = 0
        for iid, amt in recipe.ingredients:
            child = self.best(iid, amt * crafts, stack + (recipe.result_id,))
            node.children.append((child, amt))
            if child.unit_cost is None:
                total = None
            elif total is not None:
                total += child.unit_cost * amt
        node.unit_cost = None if total is None else total / recipe.result_amount
        return node

    # ── 완성품 한 줄 평가 ──
    def evaluate(self, recipe):
        item = self.gd.items[recipe.result_id]
        hq = self.sell_hq if item.can_hq else None
        tree = self.craft(recipe, self.batch, ())

        extra = []  # 보기와 상관없는 뱃지
        tips = {}   # 뱃지 글자 → 마우스 올리믄 나오는 설명
        if recipe.secret_book:
            extra.append(f"비전서: {recipe.secret_book}")
        if recipe.quest_unlock:
            extra.append("퀘스트 해금")
            tips["퀘스트 해금"] = "퀘스트를 깨야 배울 수 있는 레시피다 개굴."
        if item.can_hq:
            q = {None: "NQ·HQ 통합", True: "HQ 기준", False: "NQ 기준"}[hq]
            extra.append(q)
            tips[q] = {
                False: "NQ 시세로 계산했다 개굴. 사이드바 '판매 품질' 에서 바꿀 수 있다 개굴.",
                True: "HQ 시세로 계산했다 개굴. HQ 로 만들 실력이 돼야 이 값을 받는다 개굴.",
                None: "NQ·HQ 안 가리고 팔린 거 다 섞어서 계산했다 개굴. HQ 가 많이 팔리는 템이면 NQ 로 만들 땐 이만큼 못 받는다 개굴.",
            }[hq]

        dc = self.stats(recipe.result_id, hq, self.outlier_ratio, None)
        row = {
            "recipe_id": recipe.id,
            "아이템명": self.gd.display_name(recipe),
            "직업": recipe.job_name,
            "레시피 레벨": recipe.job_level,
            "원가": tree.unit_cost,
            "업데이트": dc.last_upload or None,
            "기타": extra,
            "뱃지 설명": tips,
            "분류": "가구" if item.ui_category in self.furniture else "일반",
            "재료 여유 배수": self.material_ratio(tree),
            "결과물 개수": recipe.result_amount,
            "판매 품질": hq,
            "제외 사유": "",
            "보기": {key: self.view(recipe.result_id, item, hq, world, tree.unit_cost) for key, world in self.views},
            "근거": self.evidence(recipe.result_id, hq),
        }
        if tree.unit_cost is None:
            missing = sorted({self.gd.name(n.item_id) for n in walk(tree) if n.unit_cost is None and not n.children})
            row["제외 사유"] = "재료 시세가 없다 개굴: " + ", ".join(missing)
        elif dc.median is None:
            row["제외 사유"] = f"{self.hours // 24:.0f}일 동안 판매 기록이 없다 개굴"
            if hq is not None:
                other = self.stats(recipe.result_id, not hq, self.outlier_ratio).sale_count
                q, o = ("HQ", "NQ") if hq else ("NQ", "HQ")
                row["제외 사유"] = (f"{q} 로 팔린 기록이 없다 개굴 — {o} 로는 {other}건 팔렸으니 사이드바 판매 품질을 {o} 나 통합으로 바꿔 봐라 개굴"
                                 if other else f"{self.hours // 24:.0f}일 동안 판매 기록이 없다 개굴 (NQ·HQ 둘 다)")
        self.world_badge(row)
        return row, tree

    def view(self, item_id, item, hq, world, unit_cost):
        """한 '보기'(통합 또는 서버 하나)에서의 판매가·순수익·판매 지표·뱃지."""
        st = self.stats(item_id, hq, self.outlier_ratio, world)
        v = {"sales": st.sale_count, "soldQty": st.sold_qty, "listings": st.listing_count,
             "median": st.median, "minListing": st.min_listing, "sell": None, "net": None, "margin": None,
             "daily": None, "sellDays": None, "badges": [], "tips": {}, "cap": None, "dropped": len(st.dropped),
             "trend": self.trend(item_id, hq, world), "quality": None}
        if st.median is None or unit_cost is None:
            return v
        badges, tips = v["badges"], v["tips"]
        sell, cap = self.sale_price(item_id, hq, st, world)
        net = sell * (1 - self.seller_tax) - unit_cost
        v.update(sell=sell, net=net, cap=cap, margin=net / unit_cost * 100 if unit_cost > 0 else None,
                 daily=net * st.sold_qty / (self.hours / 24))
        if cap is not None:
            text = "🔻 HQ 시세로 깎음"
            badges.append(text)
            tips[text] = (f"HQ 가 보통 {cap:,.0f}길에 팔리는데 NQ 를 그보다 비싸게는 못 판다 개굴. 그래서 {cap:,.0f}길로 잡았다 개굴."
                          if world is None else
                          f"이 서버에 HQ 가 {cap:,.0f}길에 올라와 있어서 NQ 를 그보다 비싸게는 못 판다 개굴. 그래서 {cap:,.0f}길로 잡았다 개굴.")
        if st.dropped:
            text = "❗ 이상 거래 포착"
            badges.append(text)
            shown = ", ".join(f"{self.world_name(x[4])} {x[0]:,}길×{x[1]}" for x in sorted(st.dropped, key=lambda x: -x[0])[:3])
            tips[text] = (f"{self.hours // 24:.0f}일 판매 {st.sale_count + len(st.dropped)}건 중 {len(st.dropped)}건이 "
                          f"그 서버 보통 가격(중앙값)이랑 {self.odd_ratio:g}배 넘게 차이 나서 뺐다 개굴 ({shown}). "
                          "실수로 잘못 판 거나 짜고 치는 거래일 수 있어서 판매가·판매량 계산에 안 넣었다 개굴.")
        if st.sale_count < 5 and st.listing_count == 0:
            text = "⚠ 근거 약함"
            badges.append(text)
            tips[text] = (f"{self.hours // 24:.0f}일 동안 {st.sale_count}건 팔린 게 전부고 지금 매물도 없어서, "
                          "몇 건 안 되는 기록으로 판매가를 잡았다 개굴. 게임에서 한번 확인해 봐라 개굴.")
        v["sellDays"], cheapest = self.sell_outlook(sell, st)
        if len(cheapest) >= 2 and cheapest[0] > 0 and st.listing_count >= 5:
            gap = (cheapest[1] - cheapest[0]) / cheapest[0]
            if gap < 0.02:
                text = "🔥 덤핑 경쟁"
                badges.append(text)
                tips[text] = (f"제일 싼 매물 {cheapest[0]:,}길, 2번째 {cheapest[1]:,}길 — 차이가 {gap * 100:.1f}%밖에 안 난다 개굴. "
                              "서로 1길씩 깎아 파는 중이라 올리면 금방 밑으로 밀린다 개굴.")
        change = v["trend"]["change"]
        if change is not None and change <= -10:
            text = f"📉 하락 중 {change:.0f}%"
            badges.append(text)
            tips[text] = f"최근 2일 판매가 중앙값이 그 전 며칠보다 {-change:.0f}% 떨어졌다 개굴. 만들어 놓고 보면 값이 더 빠질 수 있다 개굴."
        if item.can_hq:
            v["quality"] = self.quality_compare(item_id, unit_cost, world)
        if item.can_hq and hq is not None:
            other_name = "NQ" if hq else "HQ"
            other = v["quality"][other_name]
            if other["net"] is not None and other["net"] > net * 1.1 and other["net"] - net >= 1000:
                text = f"✨ {other_name}면 +{other['net'] - net:,.0f}"
                badges.append(text)
                tips[text] = (f"{other_name} 로 팔면 개당 {other['net']:,.0f}길 남는다 개굴 (지금 기준 {net:,.0f}길). "
                              f"대신 {other_name} 로 만들 수 있어야 한다 개굴.")
        return v

    def world_badge(self, row):
        """통합 보기에서: 내 서버보다 확실히 더 남는 서버가 있으믄 🌐 뱃지."""
        worlds = [(key, v) for key, v in row["보기"].items() if key != "dc"]
        ranked = [(key, v) for key, v in worlds if v["net"] is not None and v["sales"] >= 2]
        if not ranked:
            return
        best_key, best = max(ranked, key=lambda kv: kv[1]["net"])
        home = row["보기"].get(str(self.home_world))
        if best_key == str(self.home_world) or not home or home["net"] is None or best["net"] <= 0:
            return
        diff = best["net"] - home["net"]
        if diff >= 1000 and diff >= abs(home["net"]) * 0.1:
            name, home_name = self.world_name(best_key), self.world_name(self.home_world)
            text = f"🌐 {name} +{diff:,.0f}"
            dc = row["보기"]["dc"]
            dc["badges"].append(text)
            dc["tips"][text] = (f"{name} 서버에서 팔면 개당 {best['net']:,.0f}길, {eun(home_name)} {home['net']:,.0f}길 남는다 개굴. "
                                "거기 리테이너 있는 캐릭터가 있어야 올릴 수 있다 개굴. 위에서 서버를 고르면 서버별 순위도 볼 수 있다 개굴.")

    def world_name(self, wid):
        return self.world_names.get(str(wid), str(wid))

    def sale_price(self, item_id, hq, st, world):
        """(판매 예상가, HQ 시세 때문에 깎은 값 또는 None).

        서버별: min(중앙값, 최저 매물), NQ 로 팔 때는 그 서버 HQ 최저 매물보다 비싸게 몬 판다.
        통합:   중앙값, NQ 로 팔 때는 HQ 중앙값보다 비싸게 몬 판다.
        """
        if world is None:
            sell = st.median
            if hq is False:
                hq_med = self.stats(item_id, True, self.outlier_ratio, None).median
                if hq_med is not None and hq_med < sell:
                    return hq_med, hq_med
            return sell, None
        sell = min(st.median, st.min_listing) if st.min_listing else st.median
        if hq is False:
            hq_min = self.stats(item_id, True, self.outlier_ratio, world).min_listing
            if hq_min is not None and hq_min < sell:
                return hq_min, hq_min
        return sell, None

    def evidence(self, item_id, hq):
        """판매가 근거를 서버별로: 서버마다 중앙값·최저 매물, 최근 판매, 싼 매물 (이상 거래·미끼 표시)."""
        entry = self.market.get(item_id) or {"sales": [], "listings": [], "fetched_at": time.time()}
        since = entry.get("fetched_at", time.time()) - self.hours * 3600
        out = []
        for wid in self.world_names:
            wid = int(wid)
            st = self.stats(item_id, hq, self.outlier_ratio, wid)
            sales = sorted((x for x in entry["sales"] if x[3] >= since and x[4] == wid and (hq is None or x[2] == hq)),
                           key=lambda x: -x[3])
            out.append({
                "world": self.world_name(wid), "home": wid == self.home_world, "median": st.median,
                "sales": st.sale_count, "dropped": len(st.dropped), "minListing": st.min_listing,
                "listings": st.listing_count,
                "recent": [{"when": datetime.fromtimestamp(x[3], KST).strftime("%m/%d %H:%M"), "hq": x[2],
                            "price": x[0], "qty": x[1], "odd": x in st.dropped} for x in sales[:5]],
                "cheap": [{"hq": l[2], "price": l[0], "qty": l[1], "bait": l in st.bait}
                          for l in sorted(st.good_listings + st.bait, key=lambda l: l[0])[:3]],
            })
        out.sort(key=lambda w: (not w["home"], w["median"] is None, -(w["median"] or 0)))
        return {"quality": "전체" if hq is None else ("HQ" if hq else "NQ"), "worlds": out}

    def sell_outlook(self, sell, st):
        """(예상 판매 소요일, 싼 매물 가격 앞의 2개).

        내 가격 이하로 올라온 매물 수량 + 내 1개를, 하루 평균 판매 수량으로 나눈다.
        """
        ahead = sum(l[1] for l in st.good_listings if l[0] <= sell)
        daily = st.sold_qty / (self.hours / 24)
        days = (ahead + 1) / daily if daily > 0 else None
        return days, [l[0] for l in st.good_listings[:2]]

    def quality_compare(self, item_id, unit_cost, world):
        """NQ 로 팔 때와 HQ 로 팔 때 비교 (재료비는 같다고 보고)."""
        out = {}
        for name, hq in (("NQ", False), ("HQ", True)):
            st = self.stats(item_id, hq, self.outlier_ratio, world)
            sell = self.sale_price(item_id, hq, st, world)[0] if st.median is not None else None
            out[name] = {
                "sell": sell,
                "net": sell * (1 - self.seller_tax) - unit_cost if sell is not None else None,
                "sales": st.sale_count,
                "listings": st.listing_count,
            }
        return out

    def trend(self, item_id, hq, world):
        """기간 내 하루 단위 판매가 중앙값·판매 수량, 그리고 최근 2일 vs 그 전 가격 변화(%). 이상 거래는 뺀다."""
        entry = self.market.get(item_id)
        n_days = max(1, int(self.hours // 24))
        if not entry:
            return {"days": [], "change": None}
        end = entry.get("fetched_at", time.time())
        start = end - n_days * 86400
        sales = [s for s in entry["sales"] if s[3] >= start and (hq is None or s[2] == hq)]
        kept = [s for s in clean_by_world(sales, [], self.odd_ratio, 0)[0] if world is None or s[4] == world]
        buckets = [[] for _ in range(n_days)]
        for s in kept:
            buckets[min(n_days - 1, int((s[3] - start) // 86400))].append(s)
        days = []
        for i, b in enumerate(buckets):
            label = datetime.fromtimestamp(start + (i + 1) * 86400 - 1, KST).strftime("%m/%d")
            days.append({"date": label, "median": statistics.median(x[0] for x in b) if b else None,
                         "units": sum(x[1] for x in b), "count": len(b)})
        recent = [x[0] for b in buckets[-2:] for x in b]
        before = [x[0] for b in buckets[:-2] for x in b]
        change = None
        if len(recent) >= 2 and len(before) >= 2:
            change = (statistics.median(recent) / statistics.median(before) - 1) * 100
        return {"days": days, "change": change}

    def material_ratio(self, tree):
        """거래소에서 사는 재료들 중 (기간 내 판매 수량 ÷ 필요 수량) 의 최솟값. 거래소 재료가 없으면 무한대."""
        ratio = math.inf
        for node in walk(tree):
            if node.source == "거래소":
                sold = self.stats(node.item_id, world=self.buy_world).sold_qty
                ratio = min(ratio, sold / node.need)
        return ratio


def eun(word):
    """받침 있으믄 '은', 없으믄 '는'."""
    last = word[-1] if word else ""
    return word + ("은" if "가" <= last <= "힣" and (ord(last) - 0xAC00) % 28 else "는")


def walk(node):
    yield node
    for child, _ in node.children:
        yield from walk(child)


def shopping_list(tree):
    """1회 제작에 실제로 사야 하는 것들 (직접 제작하는 중간재료는 그 재료로 풀어서)."""
    out = {}

    def go(node, qty):
        if node.source == "직접 제작" and node.children:
            for child, amt in node.children:
                go(child, qty * amt / node.recipe.result_amount)
            return
        world = ""
        if node.source == "거래소":
            world = node.note.split(" (")[0] if node.note and not node.note.startswith("매물 없음") else "서버 미정"
        key = (node.item_id, node.source, world)
        if key not in out:
            out[key] = {"id": node.item_id, "qty": 0.0, "unit": node.unit_cost, "source": node.source, "world": world}
        out[key]["qty"] += qty

    for child, amt in tree.children:
        go(child, amt)
    return list(out.values())


def detail_rows(calc, tree):
    """재료 상세 표 (중간재료는 들여쓰기로 하위 재료 표시)."""
    rows = []

    def add(node, amt, depth):
        st = calc.stats(node.item_id, world=calc.buy_world)
        rows.append({
            "depth": depth,
            "name": calc.gd.name(node.item_id),
            "재료": "　" * depth + ("└ " if depth else "") + calc.gd.name(node.item_id),
            "1회 제작당 수량": amt,
            "총 필요 수량": node.need,
            "단가": node.unit_cost,
            "소계(1회 제작)": node.unit_cost * amt if node.unit_cost is not None else None,
            "구매처": node.source,
            "판매 수량(기간)": st.sold_qty,
            "현재 매물 수": st.listing_count,
            "비고(구매 서버)": node.note,
        })
        for child, child_amt in node.children:
            add(child, child_amt, depth + 1)

    for child, amt in tree.children:
        add(child, amt, 0)
    return rows


def seller_tax_rate(cfg, tax_rates, city=None):
    city = city or cfg["tax_city"]
    if not tax_rates:
        return cfg["default_tax_rate"], "기본값"
    if city == "min":
        best = min(tax_rates, key=tax_rates.get)
        return tax_rates[best], best
    if city in tax_rates:
        return tax_rates[city], city
    return cfg["default_tax_rate"], "기본값"


def analyze(gd, market, cfg, targets, seller_tax, **options):
    """대상 레시피 전체를 평가해서 (rows, {recipe_id: (recipe, tree)}, calc) 를 돌려준다.

    options 는 Calculator 인자 (sell_hq, batch_size, job_levels, buy_world, world_names, home_world).
    """
    calc = Calculator(gd, market, cfg, seller_tax, **options)
    trees = {}
    rows = []
    for r in targets:
        row, tree = calc.evaluate(r)
        rows.append(row)
        trees[r.id] = (r, tree)
    return rows, trees, calc


if __name__ == "__main__":
    from .config import load_config
    from .gamedata import GameData, target_recipes
    from .market import MarketCache, Universalis, resolve_server

    cfg = load_config()
    gd = GameData()
    api = Universalis(cfg["universalis_base_url"], cfg["request_interval_sec"])
    server = resolve_server(api, cfg)
    cache = MarketCache(server)
    tax, city = seller_tax_rate(cfg, cache.tax_rates)
    targets = list(target_recipes(gd, cfg, True, cfg["recipe_level_min"], cfg["recipe_level_max"]))
    rows, trees, calc = analyze(
        gd, cache.items, cfg, targets, tax, sell_hq={"NQ": False, "HQ": True}.get(cfg.get("sell_quality", "NQ")), batch_size=cfg["batch_size"],
        buy_world=None if cfg["buy_scope"] == "dc" else server["world_id"],
        world_names=server["world_names"], home_world=server["world_id"],
    )
    dc = lambda r: r["보기"]["dc"]
    ok = sorted((r for r in rows if dc(r)["net"] is not None), key=lambda r: -dc(r)["net"])
    buy = f"{server['dc']} 전체" if cfg["buy_scope"] == "dc" else server["world"]
    print(f"판매 시세: {server['dc']} 통합 / 재료 구매: {buy} / 판매세 {tax:.0%} ({city})")
    print(f"레벨 {cfg['recipe_level_min']}~{cfg['recipe_level_max']} 계산된 레시피 {len(ok)}/{len(rows)}개 (필터 적용 전)\n")
    for i, r in enumerate(ok[:15], 1):
        v = dc(r)
        print(f"{i:>2}. [{r['직업']}] {r['아이템명']:<20} 판매 {v['sell']:>9,.0f}  원가 {r['원가']:>9,.0f}  "
              f"순수익 {v['net']:>9,.0f}  수익률 {v['margin'] or 0:>6.1f}%  판매 {v['sales']}건  매물 {v['listings']}")
    for r in ok[:3]:
        print(f"\n── {r['아이템명']} 원가 내역 ──")
        for d in detail_rows(calc, trees[r["recipe_id"]][1]):
            unit = f"{d['단가']:,.0f}" if d["단가"] is not None else "-"
            print(f"  {d['재료']:<16} x{d['1회 제작당 수량']:<3} 단가 {unit:>8}  {d['구매처']} {d['비고(구매 서버)']}")

"""수익 계산.

판매 예상가 = min(기간 내 판매 중앙값, 현재 최저 등록가)   ※ 중앙값의 outlier_ratio 미만 등록가는 미끼로 보고 무시
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


def split_odd_sales(sales, ratio):
    """중앙값보다 ratio 배 넘게 비싸거나 1/ratio 보다 싼 거래를 이상 거래로 뺀다. (남긴 것, 뺀 것)

    판매가 3건 이상일 때만 따진다. ratio 가 0 이면 안 거른다.
    """
    if not ratio or len(sales) < 3:
        return sales, []
    mid = statistics.median(s[0] for s in sales)
    kept = [s for s in sales if mid / ratio <= s[0] <= mid * ratio]
    return kept, [s for s in sales if s not in kept]


def market_stats(entry, hq, hours, outlier_ratio=0.0, world=None, odd_ratio=0.0):
    """hq=None 이면 품질 구분 없이, True/False 면 그 품질만. world=None 이면 데이터센터 전체, 월드ID 면 그 서버만."""
    st = Stats()
    if not entry:
        return st
    since = entry.get("fetched_at", time.time()) - hours * 3600
    sales = [s for s in entry["sales"]
             if s[3] >= since and (hq is None or s[2] == hq) and (world is None or s[4] == world)]
    listings = [l for l in entry["listings"] if (hq is None or l[2] == hq) and (world is None or l[3] == world)]
    sales, st.dropped = split_odd_sales(sales, odd_ratio)
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
    prices = [l[0] for l in listings]
    if st.median and outlier_ratio:
        prices = [p for p in prices if p >= st.median * outlier_ratio]
    if prices:
        st.min_listing = min(prices)
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
                 sell_world=None, buy_world=None, world_names=None, home_world=None):
        self.gd = gd
        self.job_levels = job_levels or cfg["job_levels"]
        # None = 데이터센터 전체, 월드ID = 그 서버만
        self.sell_world = sell_world
        self.buy_world = buy_world
        self.world_names = world_names or {}
        self.home_world = home_world
        self.market = market
        self.cfg = cfg
        self.seller_tax = seller_tax
        self.buyer_tax = cfg["buyer_tax_rate"]
        self.hours = cfg["history_hours"]
        self.outlier_ratio = cfg["outlier_ratio"]
        self.sell_hq = sell_hq
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
        st = self.stats(recipe.result_id, hq, self.outlier_ratio, self.sell_world)
        tree = self.craft(recipe, self.batch, ())

        extra = []
        if recipe.secret_book:
            extra.append(f"비전서: {recipe.secret_book}")
        if recipe.quest_unlock:
            extra.append("퀘스트 해금")
        tips = {}  # 뱃지 글자 → 마우스 올리믄 나오는 설명
        if recipe.quest_unlock:
            tips["퀘스트 해금"] = "퀘스트 깨야 배울 수 있는 레시피다."
        if item.can_hq:
            q = "HQ 기준" if self.sell_hq else "NQ 기준"
            extra.append(q)
            tips[q] = (f"{q[:2]} 시세로 계산했다. 사이드바 'HQ 판매' 로 바꿀 수 있데이." if not self.sell_hq
                       else "HQ 시세로 계산했다. HQ 로 만들 실력이 돼야 이 값 받는데이.")

        row = {
            "recipe_id": recipe.id,
            "아이템명": self.gd.display_name(recipe),
            "직업": recipe.job_name,
            "레시피 레벨": recipe.job_level,
            "판매 예상가": None,
            "원가": tree.unit_cost,
            "순수익": None,
            "수익률(%)": None,
            "판매 건수": st.sale_count,
            "판매 수량": st.sold_qty,
            "현재 매물 수": st.listing_count,
            "하루 잠재 이익": None,
            "업데이트": st.last_upload or None,
            "기타": extra,
            "분류": "가구" if item.ui_category in self.furniture else "일반",
            "재료 여유 배수": self.material_ratio(tree),
            "제외 사유": "",
            "판매 소요일": None,
            "추이": self.trend(recipe.result_id, hq),
            "품질 비교": None,
            "결과물 개수": recipe.result_amount,
            "뱃지 설명": tips,
            "서버 비교": [],
            "근거": None,
        }

        if st.median is None:
            row["제외 사유"] = "판매 기록 없음"
        elif tree.unit_cost is None:
            missing = sorted({self.gd.name(n.item_id) for n in walk(tree) if n.unit_cost is None and not n.children})
            row["제외 사유"] = "재료 시세 없음: " + ", ".join(missing)
        else:
            sell, cap = self.sale_price(recipe.result_id, hq, st)
            row["근거"] = self.evidence(recipe.result_id, hq, st, sell, cap)
            if cap is not None:
                text = "🔻 HQ 매물가로 깎음"
                extra.append(text)
                tips[text] = f"HQ 가 {cap:,.0f}길에 올라와 있어가 NQ 를 그보다 비싸게는 몬 판다. 그래서 판매가를 {cap:,.0f}길로 잡았데이."
            if st.dropped:
                text = "❗ 이상 거래 포착"
                extra.append(text)
                shown = ", ".join(f"{x[0]:,}길×{x[1]}" for x in sorted(st.dropped, key=lambda x: -x[0])[:3])
                tips[text] = (f"{self.hours // 24:.0f}일 판매 {st.sale_count + len(st.dropped)}건 중 {len(st.dropped)}건이 "
                              f"보통 가격(중앙값)이랑 {self.odd_ratio:g}배 넘게 차이 나가 뺐다 ({shown}). "
                              "실수로 잘못 판 거나 짜고 치는 거래일 수 있어가 판매가·판매량 계산에 안 넣었데이.")
            if st.sale_count < 5 and st.listing_count == 0:
                text = "⚠ 근거 약함"
                extra.append(text)
                tips[text] = (f"{self.hours // 24:.0f}일 동안 {st.sale_count}건 팔린 게 다고 지금 매물도 없어가, "
                              "몇 건 안 되는 기록으로 판매가를 잡았다. 게임에서 한번 확인해 봐라.")
            net = sell * (1 - self.seller_tax) - tree.unit_cost
            row["판매 예상가"] = sell
            row["순수익"] = net
            row["수익률(%)"] = net / tree.unit_cost * 100 if tree.unit_cost > 0 else None
            row["하루 잠재 이익"] = net * st.sold_qty / (self.hours / 24)

            days, cheapest = self.sell_outlook(recipe.result_id, hq, sell, st)
            row["판매 소요일"] = days
            if len(cheapest) >= 2 and cheapest[0] > 0 and st.listing_count >= 5:
                gap = (cheapest[1] - cheapest[0]) / cheapest[0]
                if gap < 0.02:
                    text = "🔥 덤핑 경쟁"
                    extra.append(text)
                    tips[text] = (f"제일 싼 매물 {cheapest[0]:,}길, 2번째 {cheapest[1]:,}길 — 차이가 {gap * 100:.1f}%밖에 안 난다. "
                                  "서로 1길씩 깎아 파는 중이라, 올리믄 금방 밑으로 밀린데이.")
            change = row["추이"]["change"]
            if change is not None and change <= -10:
                text = f"📉 하락 중 {change:.0f}%"
                extra.append(text)
                tips[text] = f"최근 2일 판매가 중앙값이 그 전 며칠보다 {-change:.0f}% 떨어졌다. 만들어 놓고 보믄 값 더 빠질 수 있데이."
            worlds = self.world_compare(recipe.result_id, hq, tree.unit_cost) if len(self.world_names) > 1 else []
            row["서버 비교"] = worlds
            best = next((w for w in worlds if w["best"]), None)
            home = next((w for w in worlds if w["home"]), None)
            # 내 서버보다 확실히 더 남는 서버가 있으믄 뱃지 (둘 다 판매 기록이 있을 때만)
            base = home["net"] if home else None
            if best and not best["home"] and base is not None and best["net"] > 0:
                diff = best["net"] - base
                if diff >= 1000 and diff >= abs(base) * 0.1:
                    text = f"🌐 {best['world']} +{diff:,.0f}"
                    extra.append(text)
                    tips[text] = (f"{best['world']} 서버에서 팔믄 개당 {best['net']:,.0f}길, "
                                  f"{eun(home['world'])} {base:,.0f}길 남는다. "
                                  "거기 리테이너 있는 캐릭터가 있어야 올릴 수 있데이. 서버별 비교는 재료 상세에 있다.")
            if item.can_hq:
                row["품질 비교"] = self.quality_compare(recipe.result_id, tree.unit_cost)
                other_name = "HQ" if not self.sell_hq else "NQ"
                other = row["품질 비교"][other_name]
                if other["net"] is not None and other["net"] > net * 1.1 and other["net"] - net >= 1000:
                    text = f"✨ {other_name}면 +{other['net'] - net:,.0f}"
                    extra.append(text)
                    tips[text] = (f"{other_name} 로 팔믄 개당 {other['net']:,.0f}길 남는다 (지금 기준 {net:,.0f}길). "
                                  f"대신 {other_name} 로 만들 수 있어야 된데이.")
        return row, tree

    def sale_price(self, item_id, hq, st, world="scope"):
        """(판매 예상가, HQ 매물 때문에 깎은 값 또는 None).

        min(기간 중앙값, 최저 매물). NQ 로 팔 때는 HQ 가 더 싸게 올라와 있으믄 그 값 이상은 못 받는다.
        """
        world = self.sell_world if world == "scope" else world
        sell = min(st.median, st.min_listing) if st.min_listing else st.median
        if hq is False:
            hq_min = self.stats(item_id, True, self.outlier_ratio, world).min_listing
            if hq_min is not None and hq_min < sell:
                return hq_min, hq_min
        return sell, None

    def evidence(self, item_id, hq, st, sell, cap):
        """판매가를 어떻게 잡았는지 보여줄 근거: 최근 판매 기록, 지금 싼 매물."""
        entry = self.market.get(item_id) or {"sales": [], "listings": []}
        since = entry.get("fetched_at", time.time()) - self.hours * 3600
        in_scope = lambda world, q: (hq is None or q == hq) and (self.sell_world is None or world == self.sell_world)
        world = lambda w: self.world_names.get(str(w), str(w))
        sales = sorted((x for x in entry["sales"] if x[3] >= since and in_scope(x[4], x[2])), key=lambda x: -x[3])
        listings = sorted((x for x in entry["listings"] if in_scope(x[3], x[2])), key=lambda x: x[0])
        bait = st.median * self.outlier_ratio if st.median and self.outlier_ratio else 0
        return {
            "median": st.median, "minListing": st.min_listing, "hqCap": cap, "sell": sell,
            "quality": "전체" if hq is None else ("HQ" if hq else "NQ"),
            "sales": [{"when": datetime.fromtimestamp(x[3], KST).strftime("%m/%d %H:%M"), "world": world(x[4]),
                       "hq": x[2], "price": x[0], "qty": x[1], "odd": x in st.dropped} for x in sales[:10]],
            "dropped": len(st.dropped),
            "listings": [{"world": world(x[3]), "hq": x[2], "price": x[0], "qty": x[1], "bait": x[0] < bait}
                         for x in listings[:6]],
        }

    def sell_outlook(self, item_id, hq, sell, st):
        """(예상 판매 소요일, 싼 매물 가격 앞의 몇 개).

        내 가격 이하로 올라온 매물 수량 + 내 1개를, 하루 평균 판매 수량으로 나눈다.
        """
        entry = self.market.get(item_id) or {"listings": []}
        listings = [l for l in entry["listings"]
                    if (hq is None or l[2] == hq) and (self.sell_world is None or l[3] == self.sell_world)]
        ahead = sum(l[1] for l in listings if l[0] <= sell)
        daily = st.sold_qty / (self.hours / 24)
        days = (ahead + 1) / daily if daily > 0 else None
        return days, sorted(l[0] for l in listings)[:2]

    def world_compare(self, item_id, hq, unit_cost):
        """서버별로 올렸을 때 판매가·순수익. 그 서버 판매 기록·매물만 본다."""
        out = []
        for wid, name in self.world_names.items():
            wid = int(wid)
            st = self.stats(item_id, hq, self.outlier_ratio, wid)
            sell = self.sale_price(item_id, hq, st, wid)[0] if st.median is not None else None
            out.append({
                "world": name, "home": wid == self.home_world, "sales": st.sale_count, "median": st.median,
                "minListing": st.min_listing, "listings": st.listing_count, "sell": sell,
                "net": sell * (1 - self.seller_tax) - unit_cost if sell is not None else None,
            })
        ranked = [w for w in out if w["net"] is not None and w["sales"] >= 2]
        best = max(ranked, key=lambda w: w["net"]) if ranked else None
        for w in out:
            w["best"] = w is best
        return sorted(out, key=lambda w: (w["net"] is None, -(w["net"] or 0)))

    def quality_compare(self, item_id, unit_cost):
        """NQ 로 팔 때와 HQ 로 팔 때 비교 (재료비는 같다고 보고)."""
        out = {}
        for name, hq in (("NQ", False), ("HQ", True)):
            st = self.stats(item_id, hq, self.outlier_ratio, self.sell_world)
            sell = self.sale_price(item_id, hq, st)[0] if st.median is not None else None
            out[name] = {
                "sell": sell,
                "net": sell * (1 - self.seller_tax) - unit_cost if sell is not None else None,
                "sales": st.sale_count,
                "listings": st.listing_count,
            }
        return out

    def trend(self, item_id, hq):
        """기간 내 하루 단위 판매가 중앙값·판매 수량, 그리고 최근 2일 vs 그 전 가격 변화(%)."""
        entry = self.market.get(item_id)
        n_days = max(1, int(self.hours // 24))
        if not entry:
            return {"days": [], "change": None}
        end = entry.get("fetched_at", time.time())
        start = end - n_days * 86400
        buckets = [[] for _ in range(n_days)]
        sales = [s for s in entry["sales"]
                 if s[3] >= start and (hq is None or s[2] == hq) and (self.sell_world is None or s[4] == self.sell_world)]
        for s in split_odd_sales(sales, self.odd_ratio)[0]:
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

    options 는 Calculator 인자 (sell_hq, batch_size, job_levels, sell_world, buy_world, world_names).
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
        gd, cache.items, cfg, targets, tax, sell_hq=cfg["sell_hq"], batch_size=cfg["batch_size"],
        sell_world=None if cfg["sell_scope"] == "dc" else server["world_id"],
        buy_world=None if cfg["buy_scope"] == "dc" else server["world_id"],
        world_names=server["world_names"],
    )
    ok = sorted((r for r in rows if r["순수익"] is not None), key=lambda r: -r["순수익"])
    scope = lambda v: f"{server['dc']} 전체" if v == "dc" else server["world"]
    print(f"판매 시세: {scope(cfg['sell_scope'])} / 재료 구매: {scope(cfg['buy_scope'])} / 판매세 {tax:.0%} ({city})")
    print(f"레벨 {cfg['recipe_level_min']}~{cfg['recipe_level_max']} 계산된 레시피 {len(ok)}/{len(rows)}개 (필터 적용 전)\n")
    for i, r in enumerate(ok[:15], 1):
        print(f"{i:>2}. [{r['직업']}] {r['아이템명']:<20} 판매 {r['판매 예상가']:>9,.0f}  원가 {r['원가']:>9,.0f}  "
              f"순수익 {r['순수익']:>9,.0f}  수익률 {r['수익률(%)'] or 0:>6.1f}%  판매 {r['판매 건수']}건  매물 {r['현재 매물 수']}")
    for r in ok[:3]:
        print(f"\n── {r['아이템명']} 원가 내역 ──")
        for d in detail_rows(calc, trees[r["recipe_id"]][1]):
            unit = f"{d['단가']:,.0f}" if d["단가"] is not None else "-"
            print(f"  {d['재료']:<16} x{d['1회 제작당 수량']:<3} 단가 {unit:>8}  {d['구매처']} {d['비고(구매 서버)']}")

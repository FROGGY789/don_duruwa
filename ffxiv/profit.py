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

from .gamedata import can_craft_intermediate


def market_item_ids(gd, cfg, targets):
    """시세가 필요한 아이템 ID: 완성품 + 재료 (직접 제작 가능한 중간재료의 하위 재료까지)."""
    ids, stack = set(), [r.result_id for r in targets]
    while stack:
        iid = stack.pop()
        if iid in ids:
            continue
        ids.add(iid)
        for r in [r for r in targets if r.result_id == iid] + [
                r for r in gd.recipes_by_result.get(iid, []) if can_craft_intermediate(r, cfg)]:
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


def market_stats(entry, hq, hours, outlier_ratio=0.0):
    """hq=None 이면 품질 구분 없이, True/False 면 그 품질만."""
    st = Stats()
    if not entry:
        return st
    since = entry.get("fetched_at", time.time()) - hours * 3600
    sales = [s for s in entry["sales"] if s[3] >= since and (hq is None or s[2] == hq)]
    listings = [l for l in entry["listings"] if hq is None or l[2] == hq]
    st.sale_count = len(sales)
    st.sold_qty = sum(s[1] for s in sales)
    if sales:
        st.median = statistics.median(s[0] for s in sales)
    st.listing_count = len(listings)
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
    def __init__(self, gd, market, cfg, seller_tax, sell_hq=False, batch_size=1):
        self.gd = gd
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

    # ── 재료 구매 ──
    def market_buy_price(self, item_id, need):
        """거래소에서 need 개를 살 때의 평균 단가 (세금 제외)."""
        entry = self.market.get(item_id)
        if not entry:
            return None, ""
        listings = sorted((l[0], l[1]) for l in entry["listings"])
        bought, spent = 0, 0
        for price, qty in listings:
            take = min(qty, need - bought)
            bought += take
            spent += take * price
            if bought >= need:
                return spent / bought, ""
        median = market_stats(entry, None, self.hours).median
        if bought and median:
            return max(spent / bought, median), "매물 부족"
        if bought:
            return spent / bought, "매물 부족"
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
                if can_craft_intermediate(r, self.cfg):
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
        st = market_stats(self.market.get(recipe.result_id), hq, self.hours, self.outlier_ratio)
        tree = self.craft(recipe, self.batch, ())

        extra = []
        if recipe.secret_book:
            extra.append(f"비전서: {recipe.secret_book}")
        if recipe.quest_unlock:
            extra.append("퀘스트 해금")
        if item.can_hq:
            extra.append("HQ 기준" if self.sell_hq else "NQ 기준")

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
            "재료 여유 배수": self.material_ratio(tree),
            "제외 사유": "",
        }

        if st.median is None:
            row["제외 사유"] = "판매 기록 없음"
        elif tree.unit_cost is None:
            missing = sorted({self.gd.name(n.item_id) for n in walk(tree) if n.unit_cost is None and not n.children})
            row["제외 사유"] = "재료 시세 없음: " + ", ".join(missing)
        else:
            sell = min(st.median, st.min_listing) if st.min_listing else st.median
            net = sell * (1 - self.seller_tax) - tree.unit_cost
            row["판매 예상가"] = sell
            row["순수익"] = net
            row["수익률(%)"] = net / tree.unit_cost * 100 if tree.unit_cost > 0 else None
            row["하루 잠재 이익"] = net * st.sold_qty / (self.hours / 24)
        return row, tree

    def material_ratio(self, tree):
        """거래소에서 사는 재료들 중 (기간 내 판매 수량 ÷ 필요 수량) 의 최솟값. 거래소 재료가 없으면 무한대."""
        ratio = math.inf
        for node in walk(tree):
            if node.source == "거래소":
                sold = market_stats(self.market.get(node.item_id), None, self.hours).sold_qty
                ratio = min(ratio, sold / node.need)
        return ratio


def walk(node):
    yield node
    for child, _ in node.children:
        yield from walk(child)



def detail_rows(calc, tree):
    """재료 상세 표 (중간재료는 들여쓰기로 하위 재료 표시)."""
    rows = []

    def add(node, amt, depth):
        st = market_stats(calc.market.get(node.item_id), None, calc.hours)
        rows.append({
            "재료": "　" * depth + ("└ " if depth else "") + calc.gd.name(node.item_id),
            "1회 제작당 수량": amt,
            "총 필요 수량": node.need,
            "단가": node.unit_cost,
            "소계(1회 제작)": node.unit_cost * amt if node.unit_cost is not None else None,
            "구매처": node.source,
            "판매 수량(기간)": st.sold_qty,
            "현재 매물 수": st.listing_count,
            "비고": node.note,
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


def analyze(gd, market, cfg, targets, seller_tax, sell_hq=False, batch_size=1):
    """대상 레시피 전체를 평가해서 (rows, {recipe_id: (recipe, tree)}, calc) 를 돌려준다."""
    calc = Calculator(gd, market, cfg, seller_tax, sell_hq, batch_size)
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
    from .market import MarketCache, Universalis, resolve_world_id

    cfg = load_config()
    gd = GameData()
    api = Universalis(cfg["universalis_base_url"], cfg["request_interval_sec"])
    cache = MarketCache(resolve_world_id(api, cfg))
    tax, city = seller_tax_rate(cfg, cache.tax_rates)
    targets = list(target_recipes(gd, cfg, cfg["include_all_crafts"], cfg["recipe_level_min"], cfg["recipe_level_max"]))
    rows, trees, calc = analyze(gd, cache.items, cfg, targets, tax, cfg["sell_hq"], cfg["batch_size"])
    ok = sorted((r for r in rows if r["순수익"] is not None), key=lambda r: -r["순수익"])
    print(f"판매세 {tax:.0%} ({city}) / 계산된 레시피 {len(ok)}/{len(rows)}개 (필터 적용 전)\n")
    for i, r in enumerate(ok[:15], 1):
        print(f"{i:>2}. [{r['직업']}] {r['아이템명']:<20} 판매 {r['판매 예상가']:>9,.0f}  원가 {r['원가']:>9,.0f}  "
              f"순수익 {r['순수익']:>9,.0f}  수익률 {r['수익률(%)'] or 0:>6.1f}%  판매 {r['판매 건수']}건  매물 {r['현재 매물 수']}")
    for r in ok[:3]:
        print(f"\n── {r['아이템명']} 원가 내역 ──")
        for d in detail_rows(calc, trees[r["recipe_id"]][1]):
            unit = f"{d['단가']:,.0f}" if d["단가"] is not None else "-"
            print(f"  {d['재료']:<16} x{d['1회 제작당 수량']:<3} 단가 {unit:>8}  {d['구매처']} {d['비고']}")

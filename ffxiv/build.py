"""정적 사이트(Cloudflare Pages)용 데이터 만들기. GitHub Actions 가 매시간 실행한다.

    python -m ffxiv.build              시세 받고 → 계산하고 → site/ 폴더에 화면 + 데이터를 만든다
    python -m ffxiv.build --no-fetch   저장해 둔 시세(cache/)로 계산만 (화면 고칠 때 빨리 확인용)

화면에서 바꾸는 필터(레벨 범위·판매 건수·수익률 등)는 전부 브라우저에서 거른다.
계산 자체가 달라지는 판매 품질(NQ/HQ/통합)만 세 벌 미리 계산해 둔다.
판매세는 화면에서 도시를 바꾸면 브라우저가 다시 계산하도록 판매가·원가를 따로 보낸다.

site/
  index.html, main.js, web.css     화면 (web/ 폴더에서 복사)
  dashboard.js, dashboard.css, tokens.css   순위 표·상세 (ffxiv/design/ 에서 복사)
  data/meta.json                   서버·기본값·업데이트 내역
  data/craft-nq.json …             순위 표에 필요한 값 (줄마다 서버별 보기)
  data/craft-nq-d7.json …          재료 상세·근거·추이 (아이템ID % 32 로 나눠서, 누를 때만 받는다)
"""
import argparse
import json
import math
import shutil
import time
from pathlib import Path

from .badges import badge
from .changelog import CHANGELOG
from .config import JOB_NAMES, ROOT, TAX_CITIES, load_config
from .exchange import SHEETS as EXCHANGE_SHEETS, load_offers, source_text
from .gamedata import GATHER_JOBS, GameData, download_csvs, scope_recipes, target_recipes
from .market import MarketCache, Universalis, refresh, resolve_server
from .profit import Calculator, analyze, analyze_gather, detail_rows, market_item_ids, seller_tax_rate, shopping_list
from .track import build_tracking, load_history, save_history, update_history

# 판매 품질: nq = 모든 템을 NQ 로 팔 때, hq = HQ 되는 템만 HQ 로 팔 때, all = 둘을 한 순위에 (HQ 줄은 ID 에 HQ_OFFSET)
HQ_OFFSET = 10_000_000
SHARDS = 32
WEB = ROOT / "web"
DESIGN = Path(__file__).resolve().parent / "design"


def clean(v):
    """JSON 에 못 넣는 값(무한대, NaN)은 None, 소수는 둘째 자리까지."""
    if isinstance(v, float):
        return None if math.isinf(v) or math.isnan(v) else round(v, 2)
    if isinstance(v, dict):
        return {k: clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [clean(x) for x in v]
    return v


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(clean(data), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def compact_trend(t):
    days = t["days"]
    return {"d": [x["date"] for x in days], "m": [None if x["median"] is None else round(x["median"]) for x in days],
            "u": [x["units"] for x in days], "c": [x["count"] for x in days], "change": t["change"]}


# 순위 표 한 칸(서버 보기 하나)의 값 순서. 이름을 매번 적으면 파일이 세 배로 커져서 배열로 보낸다 (main.js 와 순서 같아야 함)
VIEW_FIELDS = ["sell", "median", "minListing", "sales", "soldQty", "listings", "sellDays", "cap", "dropped", "badges"]


class Badges:
    """뱃지는 한 번만 적고 번호로 가리킨다 ("NQ 기준" 같은 게 수천 번 반복돼서)."""

    def __init__(self):
        self.items, self.index = [], {}

    def ref(self, text, tip=None):
        return self.ref_obj(badge(text, tip))

    def ref_obj(self, b):
        key = json.dumps(b, ensure_ascii=False, sort_keys=True)
        if key not in self.index:
            self.index[key] = len(self.items)
            self.items.append(b)
        return self.index[key]


def view_summary(v, badges):
    """순위 표에 필요한 값만. 순수익·수익률·하루 이익은 브라우저가 판매세를 넣어 다시 계산한다."""
    vals = dict(v, badges=[badges.ref(t, v["tips"].get(t)) for t in v["badges"]])
    return [vals[f] for f in VIEW_FIELDS]


def view_detail(v):
    return {"trend": compact_trend(v["trend"]), "quality": v["quality"], "bundles": v.get("bundles")}


def build_craft(gd, cache, cfg, server, tax, hq, badges):
    """제작: 레시피 레벨·직업 레벨은 화면에서 거르니까 레벨 100 까지 다 계산한다.
    중간재료를 직접 만들 수 있는지는 config.yaml 의 job_levels 기준."""
    every = {job: 100 for job in JOB_NAMES}
    targets = list(target_recipes(gd, cfg, True, 1, 100, every))
    rows, trees, calc = analyze(gd, cache.items, cfg, targets, tax, sell_hq=hq, batch_size=cfg["batch_size"],
                                job_levels=cfg["job_levels"], world_names=server["world_names"],
                                home_world=server["world_id"])
    summary, details = [], {}
    for r in rows:
        if hq and r["판매 품질"] is not True:
            continue  # HQ 로 팔 때 순위: HQ 가 안 되는 템(가구 등)은 뺀다
        recipe, tree = trees[r["recipe_id"]]
        row, detail = craft_entry(gd, cfg, calc, r, recipe, tree, badges)
        summary.append(row)
        details[row["id"]] = detail
    return summary, details


def gather_tag(gd, item_id):
    """재료 표시용: 언제든 캘 수 있는 채집물이면 {"g": "광부·원예가", "gl": 채집 레벨}, 제작템이면 {"t": 몇 차 제작}."""
    out = {}
    g = gd.gather.get(item_id)
    if g:
        out.update(g="·".join(g.jobs or (g.job,)), gl=g.level)
        if g.timed:
            out["tm"] = 1  # 시간 한정 채집물 (⏰)
    tier = gd.craft_tier(item_id)
    if tier:
        out["t"] = tier
    return out


def mat_rows(gd, calc, tree):
    """재료 상세 표 줄 (깊이 순서대로 펼침). 직접 만드는 줄엔 ra(1회 결과물 개수)."""
    rows = []

    def add(node, amt, depth):
        st = calc.stats(node.item_id, world=calc.buy_world)
        rows.append({
            "depth": depth, "id": node.item_id, "name": gd.name(node.item_id), "amount": amt, "need": node.need,
            "unit": node.unit_cost, "subtotal": node.unit_cost * amt if node.unit_cost is not None else None,
            "source": node.source, "sold": st.sold_qty, "listings": st.listing_count,
            "world": node.note if node.source in ("거래소", "교환") else "",
            **({"ra": node.recipe.result_amount} if node.source == "직접 제작" and node.recipe else {}),
            **gather_tag(gd, node.item_id),
        })
        for child, child_amt in node.children:
            add(child, child_amt, depth + 1)

    for child, amt in tree.children:
        add(child, amt, 0)
    return rows


def craft_entry(gd, cfg, calc, r, recipe, tree, badges):
    """제작 순위 한 줄(요약)과 상세."""
    ratio = r["재료 여유 배수"]
    row = {
        "id": r["recipe_id"], "item": recipe.result_id, "name": gd.name(recipe.result_id), "stars": recipe.stars, "job": r["직업"],
        "tier": gd.craft_tier(recipe.result_id),
        "level": r["레시피 레벨"], "cat": r["분류"], "sub": r["세부"], "cost": r["원가"],
        "matRatio": None if math.isinf(ratio) else ratio, "resultAmount": r["결과물 개수"],
        "updated": r["업데이트"] or 0, "hq": r["판매 품질"], "reason": r["제외 사유"],
        "badges": [badges.ref(t, r["뱃지 설명"].get(t)) for t in r["기타"]],
        "v": {k: view_summary(v, badges) for k, v in r["보기"].items()},
    }
    materials = mat_rows(gd, calc, tree)
    alts = {}  # 🔨↔🛒 바꿔 보기: 중간재료마다 안 고른 쪽 (사기: 단가·서버 / 만들기: 단가·하위 재료)

    def collect(node):
        for child, _ in node.children:
            a = child.alt
            if a is not None and a.unit_cost is not None and child.item_id not in alts:
                if a.source == "직접 제작":
                    alts[child.item_id] = {"src": a.source, "unit": a.unit_cost, "ra": a.recipe.result_amount, "kids": mat_rows(gd, calc, a)}
                    collect(a)
                else:
                    st = calc.stats(a.item_id, world=calc.buy_world)
                    alts[child.item_id] = {"src": a.source, "unit": a.unit_cost, "sold": st.sold_qty, "listings": st.listing_count,
                                           "world": a.note if a.source in ("거래소", "교환") else ""}
            collect(child)
    collect(tree)
    ratio_text = "거래소 재료 없음" if math.isinf(ratio) else f"재료 여유 배수 {ratio:.1f}배"
    detail = {
        "evidence": r["근거"], "materials": materials, **({"alts": alts} if alts else {}),
        "shopping": [{**s, "name": gd.name(s["id"]), **gather_tag(gd, s["id"])} for s in shopping_list(tree)],
        "detailDesc": f"{recipe.job_name} Lv{recipe.job_level} · 결과물 {recipe.result_amount}개 · "
                      f"{cfg['batch_size']}회 제작 기준 · {ratio_text}",
        "views": {k: view_detail(v) for k, v in r["보기"].items()},
    }
    return row, detail


EXCHANGE_CRAFT_GROUPS = ("군표", "제작자·채집가 화폐", "알라그 석판")


def build_exchange_craft(gd, cache, cfg, server, tax, hq, badges, offers):
    """⚒️ 교환 재료로 만들기: 교환으로 얻는 재료(바로 들어가는 재료)는 길 대신 화폐로 치고,
    나머지 재료는 제작 순위처럼 장터에서 사거나 만든다. 재료 하나 × 화폐 하나마다 한 줄.
    줄 ID = 레시피ID × 100 + 순번."""
    every = {job: 100 for job in JOB_NAMES}
    targets = list(target_recipes(gd, cfg, True, 1, 100, every))
    calc = Calculator(gd, cache.items, cfg, tax, sell_hq=hq, batch_size=cfg["batch_size"], job_levels=cfg["job_levels"],
                      world_names=server["world_names"], home_world=server["world_id"])
    by_item = {}
    for o in offers:  # 화폐마다 제일 싼 교환 하나 (화폐 1개로 재료 몇 개). 이벤트 증서 같은 기타 화폐는 뺀다
        if o.group not in EXCHANGE_CRAFT_GROUPS:
            continue
        best = by_item.setdefault(o.item_id, {})
        if o.currency not in best or o.price / o.amount < best[o.currency].price / best[o.currency].amount:
            best[o.currency] = o
    uses = {}
    for r in targets:
        for iid, amt in r.ingredients:
            if iid in by_item:
                uses.setdefault(iid, []).append((r, amt))
    summary, details, seq = [], {}, {}
    for iid, recipes in uses.items():
        for currency, o in sorted(by_item[iid].items()):
            calc.free = {iid: f"{currency} {o.price:,}개 → {o.amount}개"}
            calc._memo.clear()
            mat = gd.items[iid]
            mat_st = calc.stats(iid, None, calc.outlier_ratio, None)
            for recipe, amt in recipes:
                r, tree = calc.evaluate(recipe)
                if (hq and r["판매 품질"] is not True) or r["원가"] is None or r["보기"]["dc"]["median"] is None:
                    continue  # 계산 못 하는 줄(판매 기록·재료 시세 없음)은 이 순위에선 뺀다
                row, detail = craft_entry(gd, cfg, calc, r, recipe, tree, badges)
                n = seq[recipe.id] = seq.get(recipe.id, -1) + 1
                spend = amt * cfg["batch_size"] * o.price / o.amount  # 1회 제작에 드는 화폐
                places = list(dict.fromkeys(s.get("place") for s in o.sources if s.get("place")))
                tags = list(row["badges"])
                if o.unlock:
                    tags.append(badges.ref(f"🔒 {o.unlock}", "이 조건을 채워야 교환할 수 있다 개굴."))
                if places:
                    tags.append(badges.ref("📍 " + places[0] + (f" 외 {len(places) - 1}곳" if len(places) > 1 else ""),
                                           " / ".join(source_text(s) for s in o.sources[:4])))
                if mat.marketable and mat_st.median:
                    keep = mat_st.median * (1 - tax) * amt
                    tags.append(badges.ref(f"재료로 팔면 {keep:,.0f}",
                                           f"{mat.name} {amt}개를 그냥 장터에 팔면 판매세 빼고 {keep:,.0f}길 정도다 개굴. "
                                           "만들어 파는 순수익이 이것보다 커야 만드는 게 이득이다 개굴."))
                row.update(id=recipe.id * 100 + n, job=currency, cat=o.group, craftJob=r["직업"], badges=tags,
                           mat=mat.name, matQty=amt, spend=spend)
                detail["detailDesc"] += f" · {mat.name} {amt}개는 {currency} {spend:,.0f}개로 교환"
                detail["sources"] = [source_text(s) for s in o.sources[:8]]
                summary.append(row)
                details[row["id"]] = detail
    return summary, details


def build_gather(gd, cache, cfg, server, tax, hq, badges):
    gathers = [g for g in gd.gather.values() if gd.items[g.item_id].marketable]
    rows, _ = analyze_gather(gd, cache.items, cfg, gathers, tax, sell_hq=hq,
                             world_names=server["world_names"], home_world=server["world_id"])
    summary, details = [], {}
    for r in rows:
        if hq and r["판매 품질"] is not True:
            continue
        g = gd.gather[r["item_id"]]
        summary.append({
            "id": r["item_id"], "item": r["item_id"], "name": gd.name(r["item_id"]), "stars": g.stars, "job": r["직업"],
            "level": r["레벨"], "cat": r["분류"], "sub": "", "cost": 0, "matRatio": None, "resultAmount": 1,
            "updated": r["업데이트"] or 0, "hq": r["판매 품질"], "reason": r["제외 사유"],
            "badges": [badges.ref(t, r["뱃지 설명"].get(t)) for t in r["기타"]],
            "v": {k: view_summary(v, badges) for k, v in r["보기"].items()},
        })
        details[r["item_id"]] = {
            "evidence": r["근거"],
            "detailDesc": f"{g.job} Lv{g.level}{' · ' + '★' * g.stars if g.stars else ''}"
                          f"{' · ⏰ 시간 한정 채집지' if g.timed else ''} · 재료비 없음, 판매세만 뺀다 개굴",
            "views": {k: view_detail(v) for k, v in r["보기"].items()},
        }
    return summary, details


def exchange_offers(gd, offers):
    """🪙 교환: 제작·채집 순위에 없는 템만 (그건 이미 다른 탭에 있다)."""
    crafted = {r.result_id for r in gd.recipes}
    return [o for o in offers if o.item_id not in crafted and o.item_id not in gd.gather]


def build_exchange(gd, cache, cfg, server, tax, offers, badges):
    """군표·화폐·석판으로 바꿔서 파는 템. 재료비가 없으니 판매가 × (1 − 판매세) 가 개당 순수익이고,
    화폐 1개당 이익은 브라우저가 (개당 순수익 × 받는 개수 ÷ 교환가) 로 계산한다.
    줄 ID 는 아이템ID × 100 + 순번 (같은 템을 여러 화폐로 바꿀 수 있어서)."""
    calc = Calculator(gd, cache.items, cfg, tax, sell_hq=False, world_names=server["world_names"],
                      home_world=server["world_id"])
    seen = {}
    summary, details = [], {}
    for o in sorted(offers, key=lambda o: (o.item_id, o.currency, o.price)):
        item = gd.items[o.item_id]
        n = seen[o.item_id] = seen.get(o.item_id, -1) + 1
        rid = o.item_id * 100 + n
        hq = False if item.can_hq else None  # 교환해서 받는 건 NQ
        dc = calc.stats(o.item_id, hq, calc.outlier_ratio, None)
        views = {key: calc.view(o.item_id, item, hq, world, 0) for key, world in calc.views}
        row = {"보기": views}
        calc.world_badge(row)
        tags = []
        if o.unlock:
            tags.append(badges.ref(f"🔒 {o.unlock}", "이 조건을 채워야 교환할 수 있다 개굴."))
        places = list(dict.fromkeys(s.get("place") for s in o.sources if s.get("place")))
        if places:
            tags.append(badges.ref("📍 " + places[0] + (f" 외 {len(places) - 1}곳" if len(places) > 1 else ""),
                                   " / ".join(source_text(s) for s in o.sources[:4])))
        summary.append({
            "id": rid, "item": o.item_id, "name": item.name, "stars": 0, "job": o.currency, "level": o.price, "cat": o.group, "sub": "",
            "cost": 0, "matRatio": None, "resultAmount": o.amount, "updated": dc.last_upload or 0, "hq": hq,
            "reason": "" if dc.median is not None else f"{cfg['history_hours'] // 24}일 동안 판매 기록이 없다 개굴",
            "badges": tags, "v": {k: view_summary(v, badges) for k, v in row["보기"].items()},
        })
        details[rid] = {
            "evidence": calc.evidence(o.item_id, hq),
            "detailDesc": f"{o.currency} {o.price:,}개 → {item.name} {o.amount}개"
                          f"{' · ' + o.unlock if o.unlock else ''} · 재료비 없음, 판매세만 뺀다 개굴",
            "sources": [source_text(s) for s in o.sources[:8]],
            "views": {k: view_detail(v) for k, v in row["보기"].items()},
        }
    return summary, details


def combine(nq, hq):
    """통합: NQ 줄과 HQ 줄을 한 순위로. 뱃지 번호를 새로 매기고 HQ 줄은 ID 를 띄운다."""
    badges, rows, details = Badges(), [], {}
    for (summary, dets, items), offset in ((nq, 0), (hq, HQ_OFFSET)):
        remap = lambda i: badges.ref_obj(items[i])
        for r in summary:
            r = dict(r, id=r["id"] + offset, badges=[remap(i) for i in r["badges"]],
                     v={k: v[:-1] + [[remap(i) for i in v[-1]]] for k, v in r["v"].items()})
            rows.append(r)
        details.update({iid + offset: d for iid, d in dets.items()})
    return rows, details, badges.items


def write_page(out, name, summary, details, badges):
    write(out / f"{name}.json", {"fields": VIEW_FIELDS, "badges": badges, "rows": summary})
    shards = {}
    for iid, d in details.items():
        shards.setdefault(iid % SHARDS, {})[str(iid)] = d
    for n in range(SHARDS):
        write(out / f"{name}-d{n}.json", shards.get(n, {}))


SELLER_SHARDS = 512


def name_shard(name):
    """이름 → 조각 번호. 화면(main.js nameShard)이랑 똑같이 UTF-16 글자 단위로 h*31+c."""
    h = 0
    b = name.encode("utf-16-le")
    for i in range(0, len(b), 2):
        h = (h * 31 + int.from_bytes(b[i:i + 2], "little")) & 0xFFFFFFFF
    return h % SELLER_SHARDS


def build_sellers(gd, items, out):
    """🏰 우리 부대: 리테이너 이름(r)·제작자 서명(c) → 지금 올라와 있는 매물. 이름 조각별 파일로 나눠서
    화면은 부대원 이름이 든 조각만 받는다. [아이템ID, 월드ID, HQ, 단가, 수량, 확인 시각(초)]"""
    shards = {}
    n = 0
    for iid, entry in items.items():
        for ret, crafter, world, hq, price, qty, at in entry.get("sellers") or []:
            row = [iid, world, hq, price, qty, at]
            for kind, name in (("r", ret), ("c", crafter)):
                if not name:
                    continue
                sh = shards.setdefault(name_shard(name), {"r": {}, "c": {}, "n": {}})
                sh[kind].setdefault(name, []).append(row)
                if iid in gd.items:
                    sh["n"][str(iid)] = gd.items[iid].name
            n += 1
    folder = out / "sellers"
    folder.mkdir(exist_ok=True)
    for i in range(SELLER_SHARDS):
        write(folder / f"s{i}.json", shards.get(i, {"r": {}, "c": {}, "n": {}}))
    rets = sum(len(sh["r"]) for sh in shards.values())
    size = sum(f.stat().st_size for f in folder.iterdir())
    return n, rets, size


def copy_web(site):
    """화면 파일: web/ 의 껍데기 + ffxiv/design 의 표·상세 코드와 색."""
    for f in WEB.iterdir():
        if f.is_file():
            shutil.copy2(f, site / f.name)
    for name in ("dashboard.js", "dashboard.css", "tokens.css"):
        shutil.copy2(DESIGN / name, site / name)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-fetch", action="store_true", help="시세는 안 받고 저장해 둔 걸로 계산만")
    ap.add_argument("--out", default=str(ROOT / "site"))
    args = ap.parse_args()

    started = time.time()
    cfg = load_config()
    download_csvs(cfg["datamining_base_url"])
    download_csvs(cfg["datamining_base_url"], sheets=EXCHANGE_SHEETS)
    gd = GameData()
    all_offers = load_offers(gd)
    offers = exchange_offers(gd, all_offers)
    api = Universalis(cfg["universalis_base_url"], cfg["request_interval_sec"], cfg.get("request_workers", 4))
    server = resolve_server(api, cfg)
    cache = MarketCache(server)
    if not args.no_fetch:
        ids = set(market_item_ids(gd, list(scope_recipes(gd, cfg, True))))
        ids |= {iid for iid in gd.gather if gd.items[iid].marketable}
        ids |= {o.item_id for o in offers}
        last = [0]

        def progress(p, msg):
            if p - last[0] >= 0.1 or p >= 1:
                last[0] = p
                print(f"  {msg}", flush=True)

        print(f"시세 받는 중: 아이템 {len(ids)}개")
        refresh(api, cache, server, sorted(ids), cfg["history_hours"], full=True, progress=progress)
        with_sales = sum(1 for i in ids if (cache.items.get(i) or {}).get("sales"))
        with_listings = sum(1 for i in ids if (cache.items.get(i) or {}).get("listings"))
        ups = [(cache.items.get(i) or {}).get("last_upload") or 0 for i in ids]
        now_ms = time.time() * 1000
        recent = lambda h: sum(1 for u in ups if u and now_ms - u < h * 3600 * 1000)
        print(f"  Universalis 마지막 업로드: 하루 안 {recent(24)} · 3일 안 {recent(72)} · 7일 안 {recent(168)} · "
              f"30일 안 {recent(720)} / {len(ids)}")
        print(f"  판매 기록 있는 템 {with_sales}/{len(ids)} · 매물 있는 템 {with_listings}/{len(ids)} · "
              f"응답에서 빠진 템 {api.stats['missing']} (다시 받아서 채움 {api.stats['recovered']}) · "
              f"서버 오류로 건너뛴 템 {api.stats.get('skipped', 0)} (지난번 값 사용)")
    print(f"시세 준비 끝 ({time.time() - started:.0f}초)")

    site = Path(args.out)
    if site.exists():
        shutil.rmtree(site)
    data = site / "data"
    data.mkdir(parents=True)
    copy_web(site)

    default_city = cfg["tax_city"]
    tax, _ = seller_tax_rate(cfg, cache.tax_rates, default_city)
    for page, build in (("craft", build_craft), ("gather", build_gather)):
        t = time.time()
        made = {}
        for key, hq in (("nq", False), ("hq", True)):
            badges = Badges()
            summary, details = build(gd, cache, cfg, server, tax, hq, badges)
            made[key] = (summary, details, badges.items)
            write_page(data, f"{page}-{key}", *made[key])
        write_page(data, f"{page}-all", *combine(made["nq"], made["hq"]))
        # 로그: 계산 못 한 이유 (재료 시세 없음 / 판매 기록 없음) — 레벨 70 이하, 통합 기준
        rows70 = [r for r in made["nq"][0] + made["hq"][0] if r["level"] <= 70]
        nocost = [r for r in rows70 if r["cost"] is None]
        nosell = [r for r in rows70 if r["cost"] is not None and r["v"]["dc"][0] is None]
        print(f"  {page}: Lv70 이하 {len(rows70)}줄 · 계산 가능 {len(rows70) - len(nocost) - len(nosell)} · "
              f"재료 시세 없음 {len(nocost)} · 판매 기록 없음 {len(nosell)}")
        from collections import Counter
        if page == "craft":  # 로그: 내 서버 순위 위쪽이 말이 되는지 (판매가 · 원가 · 판매 건수)
            home = str(server["world_id"])
            top = sorted((r for r in made["nq"][0] + made["hq"][0] if r["cost"] is not None and r["v"][home][0]),
                         key=lambda r: -(r["v"][home][0] * (1 - tax) - r["cost"]))[:5]
            print("  " + server["world"] + " 상위: " + " / ".join(
                f"{r['name']}{'(HQ)' if r['hq'] else ''} 판매 {r['v'][home][0]:,.0f} 원가 {r['cost']:,.0f} {r['v'][home][3]}건" for r in top))
        why = Counter(m for r in nocost for m in r["reason"].split(": ", 1)[-1].split(", "))
        if why:
            print("  시세 없는 재료 상위: " + ", ".join(f"{k} {v}" for k, v in why.most_common(12)))
        print(f"계산 끝: {page} ({time.time() - t:.0f}초)")

    t = time.time()
    badges = Badges()
    summary, details = build_exchange(gd, cache, cfg, server, tax, offers, badges)
    write_page(data, "exchange", summary, details, badges.items)
    print(f"계산 끝: exchange {len(summary)}줄 ({time.time() - t:.0f}초)")
    for group in ("군표", "제작자·채집가 화폐", "알라그 석판"):  # 로그로 대충 맞는지 보려고
        top = []
        for r in summary:
            sell, sales = r["v"]["dc"][0], r["v"]["dc"][3]
            if r["cat"] == group and sell and sales >= 3:
                top.append((sell * (1 - tax) * r["resultAmount"] / r["level"], r))
        for per, r in sorted(top, key=lambda x: -x[0])[:5]:
            print(f"  {group} · {r['name']} ×{r['resultAmount']} = {r['job']} {r['level']} → 1개당 {per:,.1f}길")

    t = time.time()
    made = {}
    for key, hq in (("nq", False), ("hq", True)):
        badges = Badges()
        summary, details = build_exchange_craft(gd, cache, cfg, server, tax, hq, badges, all_offers)
        made[key] = (summary, details, badges.items)
        write_page(data, f"exchangeCraft-{key}", *made[key])
    write_page(data, "exchangeCraft-all", *combine(made["nq"], made["hq"]))
    print(f"계산 끝: exchangeCraft {len(made['nq'][0])}줄 ({time.time() - t:.0f}초)")

    # 📈 재료 트래킹: 하루 단위 기록을 쌓고 화면용 파일
    t = time.time()
    hist_path = ROOT / "cache" / "history.json.gz"
    hist = update_history(load_history(hist_path), cache.items, cfg)
    save_history(hist_path, hist)
    n = build_tracking(gd, cache.items, hist, cfg, write, data)
    print(f"트래킹: 아이템 {n}개, 기록 {len(hist['days'])}일치 ({time.time() - t:.0f}초)")

    t = time.time()
    n, rets, size = build_sellers(gd, cache.items, data)
    print(f"부대 판매 찾기: 매물 {n}개 · 리테이너 {rets}명 · {size / 1e6:.1f}MB ({time.time() - t:.0f}초)")

    home = server["world_id"]
    worlds = sorted(server["world_names"], key=lambda w: (int(w) != home, server["world_names"][w]))
    rates = {c: r for c, r in (cache.tax_rates or {}).items() if c in TAX_CITIES}
    G = cfg.get("gather") or {}
    E = cfg.get("exchange") or {}
    write(data / "meta.json", {
        "updatedAt": cache.updated_at, "builtAt": time.time(),
        "world": server["world"], "dc": server["dc"], "home": str(home),
        "servers": [{"key": "dc", "name": "통합", "home": False}]
                   + [{"key": w, "name": server["world_names"][w], "home": w == str(home)} for w in worlds],
        "hours": cfg["history_hours"], "taxCities": TAX_CITIES, "taxRates": rates,
        "defaultTaxCity": default_city, "defaultTaxRate": cfg["default_tax_rate"],
        "buyerTax": cfg["buyer_tax_rate"],
        "jobs": JOB_NAMES, "gatherJobs": GATHER_JOBS,
        "subs": {"장비": list((cfg.get("item_groups") or {}).get("장비") or {})},
        "defaults": {
            "craft": {"levelMin": cfg["recipe_level_min"], "levelMax": cfg["recipe_level_max"],
                      "jobLevels": cfg["job_levels"], "filters": cfg["filters"], "sort": cfg["sort_by"]},
            "gather": {"levelMin": G.get("level_min", 1), "levelMax": G.get("level_max", 60),
                       "jobLevels": G.get("job_levels") or {}, "filters": G.get("filters") or {},
                       "sort": G.get("sort_by", "하루 잠재 이익")},
            "exchange": {"levelMin": 0, "levelMax": 0, "jobLevels": {}, "filters": E.get("filters") or {},
                         "sort": E.get("sort_by", "화폐 1개당")},
            "exchangeCraft": {"levelMin": 0, "levelMax": 0, "jobLevels": {}, "filters": E.get("craft_filters") or {},
                              "sort": E.get("craft_sort_by", "화폐 1개당")},
            "quality": cfg.get("sell_quality", "NQ"),
        },
        "jobLevelsForIntermediates": cfg["job_levels"],
        "changelog": CHANGELOG,
    })
    size = sum(f.stat().st_size for f in site.rglob("*") if f.is_file())
    print(f"site/ 완성: {sum(1 for _ in site.rglob('*'))}개 파일, {size / 1e6:.1f}MB ({time.time() - started:.0f}초)")


if __name__ == "__main__":
    main()

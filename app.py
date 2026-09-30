"""파판14 제작 수익성 분석 웹페이지.

실행:  streamlit run app.py
"""
import math
import threading
import time
from datetime import datetime, timedelta, timezone

import requests
import streamlit as st

from ffxiv import ui
from ffxiv.config import JOB_NAMES, TAX_CITIES, load_config
from ffxiv.gamedata import GameData, download_csvs, scope_recipes, target_recipes
from ffxiv.market import MarketCache, Universalis, refresh, resolve_server
from ffxiv.changelog import CHANGELOG
from ffxiv.profit import analyze, detail_rows, market_item_ids, seller_tax_rate, shopping_list

st.set_page_config(page_title="파판14 제작 수익 분석", page_icon="🪑", layout="wide")
ui.password_gate()  # Streamlit Secrets 에 app_password 가 있으면 비밀번호 화면부터

cfg = load_config()
F = cfg["filters"]
H = cfg["history_hours"]
PERIOD = f"{H // 24}일" if H % 24 == 0 else f"{H}시간"
KST = timezone(timedelta(hours=9), "KST")  # 클라우드 서버는 시간대가 달라서 한국 시간으로 고정


@st.cache_resource(show_spinner="게임 데이터(레시피·아이템) 불러오는 중이데이…")
def load_gamedata(base_url):
    download_csvs(base_url)
    return GameData()


@st.cache_resource(show_spinner="저장해 둔 시세 불러오는 중이데이…")
def load_market_cache(world_id, dc):
    return MarketCache({"world_id": world_id, "dc": dc})


@st.cache_resource
def refresher():
    """뒤에서 도는 시세 갱신 상태. 모든 접속자가 같이 보고, 한 번에 하나만 돈다."""
    return {"thread": None, "progress": 0.0, "msg": "", "error": None, "finished_at": 0.0, "last_try": 0.0}


@st.cache_resource(show_spinner=False)
def all_market_ids():
    """시세를 받아둘 아이템 전체: 모든 제작품(레벨 무관) + 재료."""
    return market_item_ids(gd, list(scope_recipes(gd, cfg, True)))


def start_refresh(full, ids):
    """시세 갱신을 뒤에서 시작한다. 그동안 화면은 저장된 시세로 계속 쓸 수 있다."""
    r = refresher()
    if r["thread"] is not None and r["thread"].is_alive():
        return
    r.update(progress=0.0, msg="시세 받을 채비 하는 중이데이…", error=None, last_try=time.time())

    def run():
        try:
            refresh(api, cache, server, ids, H, full=full, progress=lambda p, msg: r.update(progress=p, msg=msg))
        except Exception as e:  # 네트워크 오류 등 — 저장된 시세는 그대로 둔다
            r["error"] = str(e)
        r["finished_at"] = time.time()

    r["thread"] = threading.Thread(target=run, daemon=True)
    r["thread"].start()


def fmt_time(ts):
    return datetime.fromtimestamp(ts, KST).strftime("%Y-%m-%d %H:%M") if ts else "없음"


# ── 테마 (사이드바 맨 위에서 고르고, 주소에 기억해서 새로고침해도 유지) ──
sb = st.sidebar
ui.sidebar_brand(sb)
theme = sb.segmented_control("화면 모드", list(ui.THEMES), default=ui.DEFAULT_THEME, required=True,
                             key="theme", bind="query-params", label_visibility="collapsed", width="stretch")
palette = sb.segmented_control("색감", list(ui.PALETTES), default=ui.DEFAULT_PALETTE, required=True,
                               key="palette", bind="query-params", width="stretch")
ui.apply_theme(theme, palette)

try:
    gd = load_gamedata(cfg["datamining_base_url"])
except requests.RequestException as e:
    ui.notice(st, f"게임 데이터 CSV 를 몬 받아왔다. 쪼매 있다가 새로고침 해 봐라. ({e})", "error")
    st.stop()

api = Universalis(cfg["universalis_base_url"], cfg["request_interval_sec"])
try:
    server = resolve_server(api, cfg)
except (requests.RequestException, ValueError) as e:
    ui.notice(st, f"월드 정보를 몬 찾았다. 쪼매 있다가 새로고침 해 봐라. ({e})", "error")
    st.stop()
cache = load_market_cache(server["world_id"], server["dc"])
home, dc = server["world_id"], server["dc"]

# ── 사이드바 ──
refresh_clicked = sb.button("🔄 데이터 갱신", type="primary", width="stretch")
auto_min = cfg.get("auto_refresh_minutes", 0)
st.session_state.setdefault("seen_refresh", refresher()["finished_at"])


@st.fragment(run_every=3)
def refresh_status():
    """갱신 진행 상황. 끝나면 화면 전체를 새 시세로 다시 계산한다."""
    r = refresher()
    if r["thread"] is not None and r["thread"].is_alive():
        st.progress(r["progress"], r["msg"])
    else:
        ui.sidebar_note(st, f"마지막 갱신: {fmt_time(cache.updated_at)}"
                        + (f" · {auto_min}분 지나믄 알아서 갱신한데이" if auto_min else ""))
        if r["error"]:
            ui.sidebar_note(st, "⚠ 이번 갱신은 안 됐다 — 전에 받아둔 시세로 보는 중이데이")
    if r["finished_at"] > st.session_state["seen_refresh"]:
        st.session_state["seen_refresh"] = r["finished_at"]
        st.session_state["just_refreshed"] = not r["error"]
        st.rerun(scope="app")


with sb:
    refresh_status()

ui.sidebar_title(sb, "서버 범위")
scope_names = {"dc": f"{dc} 전체" if dc else "데이터센터 전체", "world": f"{server['world']}만"}
sell_scope = sb.segmented_control(
    "판매 시세 기준", list(scope_names), format_func=scope_names.get, required=True, width="stretch",
    default="dc" if cfg["sell_scope"] == "dc" else "world",
    help="등록은 내 서버에서만 되는데, 사는 사람들이 서버 돌아댕기믄서 제일 싼 거 사 가니까 "
         "경쟁 매물이랑 판매량은 데이터센터 전체로 보는 기 기본이데이.")
buy_scope = sb.segmented_control(
    "재료 구매", list(scope_names), format_func=scope_names.get, required=True, width="stretch",
    default="dc" if cfg["buy_scope"] == "dc" else "world",
    help="데이터센터 전체믄 다른 서버 가가 제일 싼 매물 사 온다 치는 기다. "
         "재료 상세 '구매 서버'에 어데 가믄 되는지 나온데이.")

ui.sidebar_title(sb, "분석 대상")
level_range = sb.slider("레시피 레벨 범위", 1, 100, (cfg["recipe_level_min"], cfg["recipe_level_max"]))
with sb.expander(f"직업별 레벨 · {len(JOB_NAMES)}개 직업", expanded=False):
    st.caption("이 레벨보다 높은 레시피는 빼고, 중간재료 직접 만드는 것도 이 레벨까지만 친데이.")
    cols = st.columns(2)
    job_levels = {job: cols[i % 2].number_input(job, 1, 100, cfg["job_levels"][job], key=f"lv_{job}")
                  for i, job in enumerate(JOB_NAMES)}
sell_hq = sb.toggle("HQ 판매", value=cfg["sell_hq"], help="HQ 있는 아이템은 HQ 시세로 판다 치는 기다.")
batch_size = sb.number_input("한 번에 제작할 횟수", 1, 99, cfg["batch_size"],
                             help="재료를 싼 매물부터 이 횟수만큼 산다 치고 원가 계산한데이.")

ui.sidebar_title(sb, "필터")
min_sales = sb.number_input(f"{PERIOD} 판매 건수 ≥", 0, 999, F["min_sales"])
mat_ratio = sb.number_input("재료 판매 수량 배수 ≥", 0.0, 100.0, float(F["material_ratio"]), 0.5,
                            help="재료마다 팔린 수량이 필요한 수량의 몇 배는 돼야 되는지. NPC·직접 채집 재료는 안 따진데이.")
min_margin = sb.number_input("최소 수익률(%)", -100.0, 10000.0, float(F["min_margin_pct"]), 5.0)
min_profit = sb.number_input("개당 최소 순수익(길)", -1_000_000, 10_000_000, F["min_profit"], 500)
max_listings = sb.number_input("현재 등록 건수 ≤", 0, 999, F["max_listings"])
max_days = sb.number_input("예상 판매 소요일 ≤ (0 = 안 따짐)", 0.0, 365.0, float(F.get("max_sell_days", 0)), 1.0,
                           help="내 가격 이하 매물이 다 팔리고 내 거까지 팔리는 데 걸리는 날 수. "
                                "하루 판매량으로 어림잡은 기라 대충 감만 잡아라.")
stale_hours = sb.number_input("데이터 오래됨 기준(시간)", 1, 720, F["stale_hours"])

ui.sidebar_title(sb, "정렬 · 세금")
sort_names = {"net": "순수익", "margin": "수익률", "daily": "하루 잠재 이익"}
default_sort = {"순수익": "net", "수익률": "margin", "수익률(%)": "margin", "하루 잠재 이익": "daily"}.get(cfg["sort_by"], "net")
sort_by = sb.selectbox("기본 정렬", list(sort_names), index=list(sort_names).index(default_sort),
                       format_func=sort_names.get)
city_keys = ["min"] + list(TAX_CITIES)
city = sb.selectbox("판매 도시(세율)", city_keys,
                    index=city_keys.index(cfg["tax_city"]) if cfg["tax_city"] in city_keys else 1,
                    format_func=lambda c: "가장 낮은 세율" if c == "min" else TAX_CITIES[c])
seller_tax, tax_city = seller_tax_rate(cfg, cache.tax_rates, city)
sb.html(f'<div class="sb-note tax"><span>적용 판매세</span>'
        f'<b>{seller_tax:.0%} ({TAX_CITIES.get(tax_city, tax_city)})</b></div>')

if sb.button("게임 데이터 다시 받기", help="패치로 레시피 바뀌었을 때만 누르래이", width="stretch"):
    download_csvs(cfg["datamining_base_url"], force=True)
    load_gamedata.clear()
    all_market_ids.clear()
    st.rerun()

# ── 업데이트 내역 (사이드바 맨 아래) ──
ui.sidebar_title(sb, "업데이트 내역")
with sb.expander(f"v{CHANGELOG[0]['version']} · {CHANGELOG[0]['date'][5:]}", expanded=False):
    st.html(ui.changelog_html(CHANGELOG))

# ── 시세 데이터 준비 ──
# 시세는 모든 제작품·모든 레벨을 받아둔다 → 분류·레벨을 바꿔도 다시 받지 않음. 받는 건 뒤에서 돈다.
ids = all_market_ids()
targets = list(target_recipes(gd, cfg, True, *level_range, job_levels))
r = refresher()
now = time.time()
auto_due = (bool(auto_min) and cache.updated_at and now - cache.updated_at > auto_min * 60
            and now - r["last_try"] > auto_min * 60)
if refresh_clicked or auto_due:
    start_refresh(True, ids)
elif cache.missing(ids) and now - r["last_try"] > 120:
    start_refresh(False, ids)
if st.session_state.pop("just_refreshed", False):
    st.toast("시세 새로 받아왔데이!")
notice = None
if not cache.updated_at:
    notice = {"kind": "info", "text": "처음이라 시세 받아오는 중이데이. 아이템이 억수로 많아가 5~10분쯤 걸리니까 "
                                      "쪼매만 기다리래이. 다 받으믄 화면 알아서 채워진다. 우째 돼 가는지는 왼쪽에 나온데이."}

# ── 계산 ──
rows, trees, calc = analyze(
    gd, cache.items, cfg, targets, seller_tax, sell_hq=sell_hq, batch_size=batch_size, job_levels=job_levels,
    sell_world=None if sell_scope == "dc" else home, buy_world=None if buy_scope == "dc" else home,
    world_names=server["world_names"],
)


def passes(r):
    return (r["순수익"] is not None
            and r["판매 건수"] >= min_sales
            and r["재료 여유 배수"] >= mat_ratio
            and (r["수익률(%)"] if r["수익률(%)"] is not None else -math.inf) >= min_margin
            and r["순수익"] >= min_profit
            and r["현재 매물 수"] <= max_listings
            and (not max_days or (r["판매 소요일"] is not None and r["판매 소요일"] <= max_days)))


def row_data(r):
    recipe, tree = trees[r["recipe_id"]]
    stale = (r["업데이트"] or 0) < now - stale_hours * 3600
    notes = (["⚠ 데이터 오래됨"] if stale else []) + r["기타"]
    ratio = r["재료 여유 배수"]
    ratio_text = "거래소 재료 없음" if math.isinf(ratio) else f"재료 여유 배수 {ratio:.1f}배"
    materials = []
    for d in detail_rows(calc, tree):
        note = d["비고(구매 서버)"]
        materials.append({
            "depth": d["depth"], "name": d["name"], "amount": d["1회 제작당 수량"], "need": d["총 필요 수량"],
            "unit": d["단가"], "subtotal": d["소계(1회 제작)"], "source": d["구매처"],
            "sold": d["판매 수량(기간)"], "listings": d["현재 매물 수"],
            "world": note if d["구매처"] == "거래소" else "",
        })
    return {
        "id": r["recipe_id"], "name": gd.name(recipe.result_id), "stars": recipe.stars, "job": r["직업"],
        "level": r["레시피 레벨"], "sell": r["판매 예상가"], "cost": r["원가"], "net": r["순수익"],
        "margin": r["수익률(%)"], "sales": r["판매 건수"], "listings": r["현재 매물 수"],
        "daily": r["하루 잠재 이익"], "updated": r["업데이트"] or 0,
        "updatedText": ui.ago(r["업데이트"], now), "stale": stale,
        "badges": [ui.badge(t) for t in notes],
        "detailDesc": f"{recipe.job_name} Lv{recipe.job_level} · 결과물 {recipe.result_amount}개 · "
                      f"{batch_size}회 제작 기준 · {ratio_text}",
        "materials": materials,
        "sellDays": r["판매 소요일"],
        "trend": r["추이"],
        "quality": r["품질 비교"],
        "sellingHq": sell_hq,
        "resultAmount": r["결과물 개수"],
        "shopping": [{**s, "name": gd.name(s["id"])} for s in shopping_list(tree)],
    }


# ── 아이템 검색: 필터와 상관없이 그 아이템이 어디 있고, 없으면 왜 빠졌는지 ──
MAX_RESULTS = 30
query = st.text_input("아이템 검색", key="search", placeholder="🔍 아이템 이름으로 찾기 (예: 모그루 모그, 루비)",
                      label_visibility="collapsed").strip()
row_by_recipe = {x["recipe_id"]: x for x in rows}


def fail_reasons(r):
    out = []
    if r["판매 건수"] < min_sales:
        out.append(f"{PERIOD} 판매 {r['판매 건수']}건 (기준 {min_sales}건↑)")
    if r["재료 여유 배수"] < mat_ratio:
        out.append(f"재료 판매량 {r['재료 여유 배수']:.1f}배 (기준 {mat_ratio:g}배↑)")
    margin = r["수익률(%)"]
    if (margin if margin is not None else -math.inf) < min_margin:
        out.append(f"수익률 {margin:.0f}% (기준 {min_margin:g}%↑)" if margin is not None else "수익률 계산 몬 함")
    if r["순수익"] < min_profit:
        out.append(f"순수익 {r['순수익']:,.0f}길 (기준 {min_profit:,}길↑)")
    if r["현재 매물 수"] > max_listings:
        out.append(f"매물 {r['현재 매물 수']}건 (기준 {max_listings}건↓)")
    if max_days and (r["판매 소요일"] is None or r["판매 소요일"] > max_days):
        out.append("판매 소요일 모름" if r["판매 소요일"] is None else f"판매 소요 ~{math.ceil(r['판매 소요일'])}일 (기준 {max_days:g}일↓)")
    return out


def recipe_status(recipe, item):
    """(상태 종류, 설명). 종류: ok / filtered / nocalc / out"""
    r = row_by_recipe.get(recipe.id)
    if r is not None:
        if r["순수익"] is None:
            return "nocalc", r["제외 사유"]
        reasons = fail_reasons(r)
        return ("filtered", " · ".join(reasons)) if reasons else ("ok", "")
    if recipe.expert or recipe.specialist:
        return "out", "전문·고난도 레시피라 뺐다"
    if not item.marketable:
        return "out", "거래소에 몬 파는 템이다"
    if not level_range[0] <= recipe.job_level <= level_range[1]:
        return "out", f"레시피 Lv{recipe.job_level} — 레벨 범위 {level_range[0]}~{level_range[1]} 밖이다"
    return "out", f"{recipe.job_name} 레벨 {job_levels[recipe.job_name]} < 레시피 Lv{recipe.job_level}"


def search_results(q):
    key = q.replace(" ", "")
    found, total = [], 0
    for item in gd.items.values():
        if key not in item.name.replace(" ", ""):
            continue
        recipes = gd.recipes_by_result.get(item.id, [])
        total += max(1, len(recipes))
        if len(found) >= MAX_RESULTS:
            continue
        if not recipes:
            found.append({"name": item.name, "stars": 0, "job": "", "level": None, "kind": "norecipe",
                          "why": "제작 레시피가 없다 (드롭·교환템)", "id": None})
        for recipe in recipes:
            kind, why = recipe_status(recipe, item)
            r = row_by_recipe.get(recipe.id)
            found.append({"name": item.name, "stars": recipe.stars, "job": recipe.job_name, "level": recipe.job_level,
                          "kind": kind, "why": why, "id": recipe.id if kind == "ok" else None,
                          "net": r["순수익"] if r else None, "sell": r["판매 예상가"] if r else None})
    order = {"ok": 0, "filtered": 1, "nocalc": 2, "out": 3, "norecipe": 4}
    found.sort(key=lambda x: (order[x["kind"]], x["name"]))
    return {"query": q, "items": found[:MAX_RESULTS], "total": total}


CATS = {"all": "전체", "가구": "가구", "일반": "일반 제작템"}
MAX_FAILED = 400  # 계산 불가 목록은 너무 길어지지 않게


def cat_stats(cat):
    rs = [x for x in rows if cat == "all" or x["분류"] == cat]
    return {"total": len(rs), "calculable": sum(x["순수익"] is not None for x in rs),
            "passed": sum(passes(x) for x in rs)}


def failed_data(cat):
    rs = [x for x in rows if x["순수익"] is None and (cat == "all" or x["분류"] == cat)]
    return {"total": len(rs), "items": [
        {"name": gd.name(trees[x["recipe_id"]][0].result_id), "stars": trees[x["recipe_id"]][0].stars,
         "job": x["직업"], "level": x["레시피 레벨"], "reason": x["제외 사유"]} for x in rs[:MAX_FAILED]]}


ui.dashboard({
    "subtitle": [server["world"], f"판매 시세 {scope_names[sell_scope]}", f"재료 구매 {scope_names[buy_scope]}",
                 f"레시피 레벨 {level_range[0]}~{level_range[1]}", f"시세 갱신 {fmt_time(cache.updated_at)}"],
    "notice": notice,
    "search": search_results(query) if query else None,
    "cats": CATS,
    "stats": {c: cat_stats(c) for c in CATS},
    "jobs": JOB_NAMES,
    "period": PERIOD,
    "sort": sort_by,
    "taxNote": f"판매세 {seller_tax:.0%} 반영",
    "taxRate": seller_tax,
    "rows": [{**row_data(x), "cat": x["분류"]} for x in rows if passes(x)],
    "failed": {c: failed_data(c) for c in CATS},
})

"""파판14 제작·채집 수익성 분석 웹페이지. (⚒ 제작 / ⛏ 채집 두 페이지)

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
from ffxiv.gamedata import GATHER_JOBS, GameData, download_csvs, scope_recipes, target_recipes
from ffxiv.market import MarketCache, Universalis, refresh, resolve_server
from ffxiv.changelog import CHANGELOG
from ffxiv.profit import analyze, analyze_gather, detail_rows, market_item_ids, seller_tax_rate, shopping_list

st.set_page_config(page_title="파판14 제작 수익 분석", page_icon="🐸", layout="wide")
ui.password_gate()  # Streamlit Secrets 에 app_password 가 있으면 비밀번호 화면부터

cfg = load_config()
F = cfg["filters"]
H = cfg["history_hours"]
PERIOD = f"{H // 24}일" if H % 24 == 0 else f"{H}시간"
KST = timezone(timedelta(hours=9), "KST")  # 클라우드 서버는 시간대가 달라서 한국 시간으로 고정


@st.cache_resource(show_spinner="게임 데이터(레시피·아이템) 불러오는 중이다 개굴…")
def load_gamedata(base_url):
    download_csvs(base_url)
    return GameData()


@st.cache_resource(show_spinner="저장해 둔 시세 불러오는 중이다 개굴…")
def load_market_cache(world_id, dc):
    return MarketCache({"world_id": world_id, "dc": dc})


@st.cache_resource
def refresher():
    """뒤에서 도는 시세 갱신 상태. 모든 접속자가 같이 보고, 한 번에 하나만 돈다."""
    return {"thread": None, "progress": 0.0, "msg": "", "error": None, "finished_at": 0.0, "last_try": 0.0}


@st.cache_resource(show_spinner=False)
def all_market_ids():
    """시세를 받아둘 아이템 전체: 모든 제작품(레벨 무관) + 재료 + 거래소에 파는 채집템."""
    gathered = {iid for iid in gd.gather if gd.items[iid].marketable}
    return sorted(set(market_item_ids(gd, list(scope_recipes(gd, cfg, True)))) | gathered)


def start_refresh(full, ids):
    """시세 갱신을 뒤에서 시작한다. 그동안 화면은 저장된 시세로 계속 쓸 수 있다."""
    r = refresher()
    if r["thread"] is not None and r["thread"].is_alive():
        return
    r.update(progress=0.0, msg="시세 받을 준비하는 중이다 개굴…", error=None, last_try=time.time())

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
if not st.session_state.get("frogs_welcomed"):  # 들어오자마자 한 번 개구리 비
    st.session_state["frogs_welcomed"] = True
    ui.frog_rain()

try:
    gd = load_gamedata(cfg["datamining_base_url"])
except requests.RequestException as e:
    ui.notice(st, f"게임 데이터 CSV 를 못 받아왔다 개굴. 조금 있다가 새로고침 해 봐라 개굴. ({e})", "error")
    st.stop()

api = Universalis(cfg["universalis_base_url"], cfg["request_interval_sec"])
try:
    server = resolve_server(api, cfg)
except (requests.RequestException, ValueError) as e:
    ui.notice(st, f"월드 정보를 못 찾았다 개굴. 조금 있다가 새로고침 해 봐라 개굴. ({e})", "error")
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
                        + (f" · {auto_min}분 지나면 알아서 갱신한다 개굴" if auto_min else ""))
        if r["error"]:
            ui.sidebar_note(st, "⚠ 이번 갱신은 안 됐다 개굴 — 전에 받아둔 시세로 보는 중이다 개굴")
    if r["finished_at"] > st.session_state["seen_refresh"]:
        st.session_state["seen_refresh"] = r["finished_at"]
        st.session_state["just_refreshed"] = not r["error"]
        st.rerun(scope="app")


with sb:
    refresh_status()

def kept(widget, *args, key, **kwargs):
    """페이지를 오가도 사이드바에서 고른 값이 안 날아가게 한다.

    안 보이는 페이지의 위젯 값은 Streamlit 이 지워 버려서, 따로 기억해 뒀다가 다시 넣어 준다.
    """
    keep = f"_keep_{key}"
    if key not in st.session_state and keep in st.session_state:
        st.session_state[key] = st.session_state[keep]
    value = widget(*args, key=key, **kwargs)
    st.session_state[keep] = value
    return value


# 페이지마다 다른 사이드바 칸 (제작/채집 페이지가 여기에 채운다)
page_box = sb.container()

# ── 두 페이지 공통 ──
ui.sidebar_title(sb, "판매 설정")
QUALITIES = {"NQ": False, "HQ": True, "통합": None}
sell_quality = sb.segmented_control(
    "판매 품질", list(QUALITIES), default=cfg.get("sell_quality", "NQ") if cfg.get("sell_quality") in QUALITIES else "NQ",
    required=True, width="stretch",
    help="HQ 있는 템을 어느 시세로 팔 건지 고른다 개굴. NQ = NQ 로 팔린 기록만, HQ = HQ 로 팔린 기록만, "
         "통합 = 안 가리고 다 섞어서. HQ 못 만드는 템은 어느 걸 골라도 NQ 시세로 본다 개굴.")
sell_hq = QUALITIES[sell_quality]
city_keys = ["min"] + list(TAX_CITIES)
city = sb.selectbox("판매 도시(세율)", city_keys,
                    index=city_keys.index(cfg["tax_city"]) if cfg["tax_city"] in city_keys else 1,
                    format_func=lambda c: "가장 낮은 세율" if c == "min" else TAX_CITIES[c])
seller_tax, tax_city = seller_tax_rate(cfg, cache.tax_rates, city)
sb.html(f'<div class="sb-note tax"><span>적용 판매세</span>'
        f'<b>{seller_tax:.0%} ({TAX_CITIES.get(tax_city, tax_city)})</b></div>')
stale_hours = sb.number_input("데이터 오래됨 기준(시간)", 1, 720, F["stale_hours"])

if sb.button("게임 데이터 다시 받기", help="패치로 레시피 바뀌었을 때만 눌러라 개굴", width="stretch"):
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
r = refresher()
now = time.time()
auto_due = (bool(auto_min) and cache.updated_at and now - cache.updated_at > auto_min * 60
            and now - r["last_try"] > auto_min * 60)
if refresh_clicked or auto_due:
    start_refresh(True, ids)
elif cache.missing(ids) and now - r["last_try"] > 120:
    start_refresh(False, ids)
if st.session_state.pop("just_refreshed", False):
    st.toast("시세 새로 받아왔다 개굴!", icon="🐸")
notice = None
if not cache.updated_at:
    notice = {"kind": "info", "text": "처음이라 시세 받아오는 중이다 개굴. 아이템이 엄청 많아서 5~10분쯤 걸리니까 "
                                      "조금만 기다려라 개굴. 다 받으면 화면이 알아서 채워진다 개굴. 어떻게 돼 가는지는 왼쪽에 나온다 개굴."}

# 순위 보기: 통합 + 서버별 (내 서버 먼저)
world_keys = sorted(server["world_names"], key=lambda w: (int(w) != home, server["world_names"][w]))
VIEWS = {"dc": "통합"} | {w: server["world_names"][w] for w in world_keys}
MAX_RESULTS = 30  # 검색 결과
MAX_FAILED = 400  # 계산 불가 목록은 너무 길어지지 않게
SERVERS = [{"key": k, "name": n, "home": k == str(home)} for k, n in VIEWS.items()]


def badges(texts, tips):
    return [ui.badge(t, tips.get(t) or (
        f"Universalis 에 마지막으로 올라온 지 {stale_hours}시간 넘었다 개굴. 지금 게임 시세랑 다를 수 있다 개굴."
        if t.startswith("⚠ 데이터") else None)) for t in texts]


def compact_trend(t):
    """하루 단위 추이를 [날짜], [중앙값], [수량], [건수] 배열로 (보내는 양 줄이기)."""
    days = t["days"]
    return {"d": [x["date"] for x in days], "m": [None if x["median"] is None else round(x["median"]) for x in days],
            "u": [x["units"] for x in days], "c": [x["count"] for x in days], "change": t["change"]}


def view_data(r, key, ok):
    """서버 보기 하나의 값. 보기마다 같은 뱃지(비전서·데이터 오래됨 등)는 줄(row)에 한 번만 담는다."""
    v = r["보기"][key]
    return {
        "sell": v["sell"], "net": v["net"], "margin": v["margin"], "sales": v["sales"], "listings": v["listings"],
        "daily": v["daily"], "sellDays": v["sellDays"], "median": v["median"], "minListing": v["minListing"],
        "cap": v["cap"], "dropped": v["dropped"], "trend": compact_trend(v["trend"]), "bundles": v.get("bundles"), "quality": v["quality"],
        "passes": ok,
        "badges": badges(v["badges"], v["tips"]),
    }



# ── 제작 계산 ──
@st.cache_resource(max_entries=2, show_spinner="계산하는 중이다 개굴…")
def run_analysis(_gd, _items, market_version, level_range, job_levels_key, sell_hq, batch_size, buy_world, seller_tax):
    """계산 결과를 기억해 둔다. 검색·필터·정렬만 바꿀 땐 다시 계산 안 하고, 시세나 계산 조건이 바뀔 때만 다시 한다.

    밑줄 붙은 인자는 내용 대신 market_version(시세 갱신 시각 + 시세 바뀐 횟수)으로 구분한다.
    """
    levels = dict(job_levels_key)
    targets = list(target_recipes(_gd, cfg, True, *level_range, levels))
    return analyze(_gd, _items, cfg, targets, seller_tax, sell_hq=sell_hq, batch_size=batch_size, job_levels=levels,
                   buy_world=buy_world, world_names=server["world_names"], home_world=home)


def craft_page():
    """⚒ 제작 페이지."""
    pb = page_box
    ui.sidebar_title(pb, "서버 범위")
    scope_names = {"dc": f"{dc} 전체" if dc else "데이터센터 전체", "world": f"{server['world']}만"}
    buy_scope = kept(pb.segmented_control,
        "재료 구매", list(scope_names), format_func=scope_names.get, required=True, width="stretch",
        default="dc" if cfg["buy_scope"] == "dc" else "world", key="c_buy",
        help="데이터센터 전체면 다른 서버에 가서 제일 싼 매물을 사 온다고 친다 개굴. "
             "재료 상세 '구매 서버'에 어디 가면 되는지 나온다 개굴.")

    ui.sidebar_title(pb, "분석 대상")
    level_range = kept(pb.slider, "레시피 레벨 범위", 1, 100, (cfg["recipe_level_min"], cfg["recipe_level_max"]), key="c_level")
    with pb.expander(f"직업별 레벨 · {len(JOB_NAMES)}개 직업", expanded=False):
        st.caption("이 레벨보다 높은 레시피는 빼고, 중간재료 직접 만드는 것도 이 레벨까지만 친다 개굴.")
        cols = st.columns(2)
        job_levels = {job: kept(cols[i % 2].number_input, job, 1, 100, cfg["job_levels"][job], key=f"lv_{job}")
                      for i, job in enumerate(JOB_NAMES)}
    batch_size = kept(pb.number_input, "한 번에 제작할 횟수", 1, 99, cfg["batch_size"], key="c_batch",
                                 help="재료를 싼 매물부터 이 횟수만큼 산다고 치고 원가를 계산한다 개굴.")

    ui.sidebar_title(pb, "필터")
    min_sales = kept(pb.number_input, f"{PERIOD} 판매 건수 ≥", 0, 999, F["min_sales"], key="c_min_sales")
    mat_ratio = kept(pb.number_input, "재료 판매 수량 배수 ≥", 0.0, 100.0, float(F["material_ratio"]), 0.5, key="c_mat",
                                help="재료마다 팔린 수량이 필요한 수량의 몇 배는 돼야 하는지 정한다 개굴. NPC·직접 채집 재료는 안 따진다 개굴.")
    min_margin = kept(pb.number_input, "최소 수익률(%)", -100.0, 10000.0, float(F["min_margin_pct"]), 5.0, key="c_margin")
    min_profit = kept(pb.number_input, "개당 최소 순수익(길)", -1_000_000, 10_000_000, F["min_profit"], 500, key="c_profit")
    max_listings = kept(pb.number_input, "현재 등록 건수 ≤", 0, 999, F["max_listings"], key="c_listings")
    max_days = kept(pb.number_input, "예상 판매 소요일 ≤ (0 = 안 따짐)", 0.0, 365.0, float(F.get("max_sell_days", 0)), 1.0, key="c_days",
                               help="내 가격 이하 매물이 다 팔리고 내 거까지 팔리는 데 걸리는 날 수. "
                                    "하루 판매량으로 어림잡은 거라 대충 감만 잡아라 개굴.")

    ui.sidebar_title(pb, "정렬")
    sort_names = {"net": "순수익", "margin": "수익률", "daily": "하루 잠재 이익"}
    default_sort = {"순수익": "net", "수익률": "margin", "수익률(%)": "margin", "하루 잠재 이익": "daily"}.get(cfg["sort_by"], "net")
    sort_by = kept(pb.selectbox, "기본 정렬", list(sort_names), index=list(sort_names).index(default_sort),
                           format_func=sort_names.get, key="c_sort")

    rows, trees, calc = run_analysis(
        gd, cache.items, (cache.updated_at, cache.version, id(gd)), tuple(level_range),
        tuple(sorted(job_levels.items())), sell_hq, batch_size, None if buy_scope == "dc" else home, seller_tax)

    def fail_reasons(r, v):
        """필터에 걸린 이유들. 빈 목록이믄 통과."""
        out = []
        if v["sales"] < min_sales:
            out.append(f"{PERIOD} 판매 {v['sales']}건 (기준 {min_sales}건↑)")
        if r["재료 여유 배수"] < mat_ratio:
            out.append(f"재료 판매량 {r['재료 여유 배수']:.1f}배 (기준 {mat_ratio:g}배↑)")
        margin = v["margin"]
        if (margin if margin is not None else -math.inf) < min_margin:
            out.append(f"수익률 {margin:.0f}% (기준 {min_margin:g}%↑)" if margin is not None else "수익률 계산 못 했다 개굴")
        if v["net"] < min_profit:
            out.append(f"순수익 {v['net']:,.0f}길 (기준 {min_profit:,}길↑)")
        if v["listings"] > max_listings:
            out.append(f"매물 {v['listings']}건 (기준 {max_listings}건↓)")
        if max_days and (v["sellDays"] is None or v["sellDays"] > max_days):
            out.append("판매 소요일 모름" if v["sellDays"] is None else f"판매 소요 ~{math.ceil(v['sellDays'])}일 (기준 {max_days:g}일↓)")
        return out

    def passes(r, key):
        v = r["보기"][key]
        return v["net"] is not None and r["원가"] is not None and not fail_reasons(r, v)

    def row_data(r):
        recipe, tree = trees[r["recipe_id"]]
        stale = (r["업데이트"] or 0) < now - stale_hours * 3600
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
        stale_badge = ["⚠ 데이터 오래됨"] if stale else []
        return {
            "id": r["recipe_id"], "name": gd.name(recipe.result_id), "stars": recipe.stars, "job": r["직업"],
            "level": r["레시피 레벨"], "cost": r["원가"], "cat": r["분류"], "sub": r["세부"],
            "updated": r["업데이트"] or 0, "updatedText": ui.ago(r["업데이트"], now), "stale": stale,
            "badges": badges(stale_badge + r["기타"], r["뱃지 설명"]),
            "views": {key: view_data(r, key, passes(r, key)) for key in VIEWS},
            "evidence": r["근거"],
            "detailDesc": f"{recipe.job_name} Lv{recipe.job_level} · 결과물 {recipe.result_amount}개 · "
                          f"{batch_size}회 제작 기준 · {ratio_text}",
            "materials": materials,
            "sellingHq": r["판매 품질"],
            "resultAmount": r["결과물 개수"],
            "shopping": [{**s, "name": gd.name(s["id"])} for s in shopping_list(tree)],
        }


    # ── 아이템 검색: 필터와 상관없이 그 아이템이 어디 있고, 없으면 왜 빠졌는지 (통합 기준) ──
    query = st.text_input("아이템 검색", key="search_craft", placeholder="🔍 아이템 이름으로 찾기 (예: 모그루 모그, 루비)",
                          label_visibility="collapsed").strip()
    row_by_recipe = {x["recipe_id"]: x for x in rows}

    def recipe_status(recipe, item):
        """(상태 종류, 설명). 종류: ok / filtered / nocalc / out"""
        r = row_by_recipe.get(recipe.id)
        if r is not None:
            v = r["보기"]["dc"]
            if v["net"] is None or r["원가"] is None:
                return "nocalc", r["제외 사유"]
            reasons = fail_reasons(r, v)
            if not reasons:
                return "ok", ""
            ok_worlds = [VIEWS[k] for k in world_keys if passes(r, k)]
            extra = f" — 서버별로는 {', '.join(ok_worlds)} 순위에 있다 개굴" if ok_worlds else ""
            return ("ok" if ok_worlds else "filtered"), "통합: " + " · ".join(reasons) + extra
        if recipe.expert or recipe.specialist:
            return "out", "전문·고난도 레시피라 뺐다 개굴"
        if not item.marketable:
            return "out", "거래소에 못 파는 템이다 개굴"
        if not level_range[0] <= recipe.job_level <= level_range[1]:
            return "out", f"레시피 Lv{recipe.job_level} — 레벨 범위 {level_range[0]}~{level_range[1]} 밖이다 개굴"
        return "out", f"{recipe.job_name} 레벨 {job_levels[recipe.job_name]} < 레시피 Lv{recipe.job_level} 이다 개굴"

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
                              "why": "제작 레시피가 없다 개굴 (드롭·교환템)", "id": None})
            for recipe in recipes:
                kind, why = recipe_status(recipe, item)
                r = row_by_recipe.get(recipe.id)
                v = r["보기"]["dc"] if r else {}
                found.append({"name": item.name, "stars": recipe.stars, "job": recipe.job_name, "level": recipe.job_level,
                              "kind": kind, "why": why, "id": recipe.id if kind == "ok" else None,
                              "net": v.get("net"), "sell": v.get("sell")})
        order = {"ok": 0, "filtered": 1, "nocalc": 2, "out": 3, "norecipe": 4}
        found.sort(key=lambda x: (order[x["kind"]], x["name"]))
        return {"query": q, "items": found[:MAX_RESULTS], "total": total}


    CATS = {"all": "전체", "가구": "가구", "장비": "장비", "재료": "재료", "소모품": "소모품", "기타": "기타"}
    passed = {x["recipe_id"]: {k for k in VIEWS if passes(x, k)} for x in rows}

    def cat_stats(cat, key):
        rs = [x for x in rows if cat == "all" or x["분류"] == cat]
        return {"total": len(rs),
                "calculable": sum(x["보기"][key]["net"] is not None and x["원가"] is not None for x in rs),
                "passed": sum(key in passed[x["recipe_id"]] for x in rs)}

    def failed_data(cat):
        rs = [x for x in rows if (x["보기"]["dc"]["net"] is None or x["원가"] is None) and (cat == "all" or x["분류"] == cat)]
        return {"total": len(rs), "items": [
            {"name": gd.name(trees[x["recipe_id"]][0].result_id), "stars": trees[x["recipe_id"]][0].stars,
             "job": x["직업"], "level": x["레시피 레벨"], "reason": x["제외 사유"]} for x in rs[:MAX_FAILED]]}


    ui.dashboard({
        "mode": "craft",
        "subtitle": [server["world"], f"판매 시세 {dc} 서버별", f"재료 구매 {scope_names[buy_scope]}",
                     f"레시피 레벨 {level_range[0]}~{level_range[1]}", f"시세 갱신 {fmt_time(cache.updated_at)}"],
        "notice": notice,
        "search": search_results(query) if query else None,
        "servers": SERVERS,
        "cats": CATS,
        "stats": {k: {c: cat_stats(c, k) for c in CATS} for k in VIEWS},
        "jobs": JOB_NAMES,
        "period": PERIOD,
        "sort": sort_by,
        "taxNote": f"판매세 {seller_tax:.0%} 반영",
        "taxRate": seller_tax,
        "subs": {"장비": list((cfg.get("item_groups") or {}).get("장비") or {})},
        "quality": sell_quality,
        "rows": [row_data(x) for x in rows if passed[x["recipe_id"]]],
        "failed": {c: failed_data(c) for c in CATS},
    })


# ── 채집 계산 ──
@st.cache_resource(max_entries=2, show_spinner="채집템 계산하는 중이다 개굴…")
def run_gather(_gd, _items, market_version, sell_hq, seller_tax):
    """채집템은 레벨 상관없이 전부 계산해 두고, 레벨·필터는 화면에서 거른다."""
    gathers = [g for g in _gd.gather.values() if _gd.items[g.item_id].marketable]
    return analyze_gather(_gd, _items, cfg, gathers, seller_tax, sell_hq=sell_hq,
                          world_names=server["world_names"], home_world=home)


def gather_page():
    """⛏ 채집 페이지. 재료비가 없으니 판매가 × (1 − 판매세) 가 순수익이다."""
    G = cfg.get("gather") or {}
    GF = G.get("filters") or {}
    pb = page_box
    ui.sidebar_title(pb, "분석 대상")
    level_range = kept(pb.slider, "채집 레벨 범위", 1, 100, (G.get("level_min", 1), G.get("level_max", 60)), key="g_level")
    cols = pb.columns(2)
    levels = {job: kept(cols[i].number_input, job, 1, 100, (G.get("job_levels") or {}).get(job, 60), key=f"g_lv_{job}",
                                        help="이 레벨보다 높은 채집템은 뺀다 개굴.")
              for i, job in enumerate(GATHER_JOBS)}
    ui.sidebar_title(pb, "필터")
    min_sales = kept(pb.number_input, f"{PERIOD} 판매 건수 ≥", 0, 999, GF.get("min_sales", 3), key="g_min_sales")
    min_profit = kept(pb.number_input, "개당 최소 순수익(길)", 0, 10_000_000, GF.get("min_profit", 100), 50, key="g_profit",
                                 help="판매세 빼고 개당 남는 돈이다 개굴. 채집은 재료비가 없다 개굴.")
    max_listings = kept(pb.number_input, "현재 등록 건수 ≤", 0, 9999, GF.get("max_listings", 100), key="g_listings")
    max_days = kept(pb.number_input, "예상 판매 소요일 ≤ (0 = 안 따짐)", 0.0, 365.0, float(GF.get("max_sell_days", 0)), 1.0,
                               key="g_days")
    ui.sidebar_title(pb, "정렬")
    sort_names = {"daily": "하루 잠재 이익", "net": "개당 순수익"}
    default_sort = {"순수익": "net", "개당 순수익": "net"}.get(G.get("sort_by"), "daily")
    sort_by = kept(pb.selectbox, "기본 정렬", list(sort_names), index=list(sort_names).index(default_sort),
                           format_func=sort_names.get, key="g_sort",
                           help="하루 잠재 이익 = 개당 순수익 × 하루에 팔리는 개수. 채집은 많이 캐서 많이 파는 거라 기본이 이거다 개굴.")

    all_rows, _calc = run_gather(gd, cache.items, (cache.updated_at, cache.version, id(gd)), sell_hq, seller_tax)

    def in_scope(r):
        return level_range[0] <= r["레벨"] <= level_range[1] and r["레벨"] <= levels[r["직업"]]

    rows = [r for r in all_rows if in_scope(r)]

    def fail_reasons(v):
        out = []
        if v["sales"] < min_sales:
            out.append(f"{PERIOD} 판매 {v['sales']}건 (기준 {min_sales}건↑)")
        if v["net"] < min_profit:
            out.append(f"개당 순수익 {v['net']:,.0f}길 (기준 {min_profit:,}길↑)")
        if v["listings"] > max_listings:
            out.append(f"매물 {v['listings']}건 (기준 {max_listings}건↓)")
        if max_days and (v["sellDays"] is None or v["sellDays"] > max_days):
            out.append("판매 소요일 모름" if v["sellDays"] is None else f"판매 소요 ~{math.ceil(v['sellDays'])}일 (기준 {max_days:g}일↓)")
        return out

    def passes(r, key):
        v = r["보기"][key]
        return v["net"] is not None and not fail_reasons(v)

    def row_data(r):
        stale = (r["업데이트"] or 0) < now - stale_hours * 3600
        g = gd.gather[r["item_id"]]
        return {
            "id": r["item_id"], "name": gd.name(r["item_id"]), "stars": g.stars, "job": r["직업"],
            "level": r["레벨"], "cost": 0, "cat": r["분류"],
            "updated": r["업데이트"] or 0, "updatedText": ui.ago(r["업데이트"], now), "stale": stale,
            "badges": badges((["⚠ 데이터 오래됨"] if stale else []) + r["기타"], r["뱃지 설명"]),
            "views": {key: view_data(r, key, passes(r, key)) for key in VIEWS},
            "evidence": r["근거"],
            "detailDesc": f"{g.job} Lv{g.level}{' · ' + '★' * g.stars if g.stars else ''}"
                          f"{' · ⏰ 시간 한정 채집지' if g.timed else ''} · 재료비 없음, 판매세만 뺀다 개굴",
            "sellingHq": r["판매 품질"],
        }

    query = st.text_input("아이템 검색", key="search_gather", placeholder="🔍 채집템 이름으로 찾기 (예: 구리 광석, 라벤더)",
                          label_visibility="collapsed").strip()
    row_by_item = {x["item_id"]: x for x in all_rows}

    def status(item):
        g = gd.gather.get(item.id)
        if g is None:
            return "norecipe", "광부·원예가로 캐는 템이 아니다 개굴"
        if not item.marketable:
            return "out", "거래소에 못 파는 템이다 개굴"
        r = row_by_item[item.id]
        if not level_range[0] <= g.level <= level_range[1]:
            return "out", f"채집 Lv{g.level} — 레벨 범위 {level_range[0]}~{level_range[1]} 밖이다 개굴"
        if g.level > levels[g.job]:
            return "out", f"{g.job} 레벨 {levels[g.job]} < 채집 Lv{g.level} 이다 개굴"
        v = r["보기"]["dc"]
        if v["net"] is None:
            return "nocalc", r["제외 사유"]
        reasons = fail_reasons(v)
        if not reasons:
            return "ok", ""
        ok_worlds = [VIEWS[k] for k in world_keys if passes(r, k)]
        extra = f" — 서버별로는 {', '.join(ok_worlds)} 순위에 있다 개굴" if ok_worlds else ""
        return ("ok" if ok_worlds else "filtered"), "통합: " + " · ".join(reasons) + extra

    def search_results(q):
        key = q.replace(" ", "")
        found, total = [], 0
        for item in gd.items.values():
            if key not in item.name.replace(" ", ""):
                continue
            total += 1
            if len(found) >= MAX_RESULTS:
                continue
            kind, why = status(item)
            g = gd.gather.get(item.id)
            r = row_by_item.get(item.id)
            v = r["보기"]["dc"] if r else {}
            found.append({"name": item.name, "stars": g.stars if g else 0, "job": g.job if g else "",
                          "level": g.level if g else None, "kind": kind, "why": why,
                          "id": item.id if kind == "ok" else None, "net": v.get("net"), "sell": v.get("sell")})
        order = {"ok": 0, "filtered": 1, "nocalc": 2, "out": 3, "norecipe": 4}
        found.sort(key=lambda x: (order[x["kind"]], x["name"]))
        return {"query": q, "items": found[:MAX_RESULTS], "total": total}

    cats = {"all": "전체", "일반": "일반", "시간 한정": "시간 한정", "크리스탈": "크리스탈"}
    passed = {x["item_id"]: {k for k in VIEWS if passes(x, k)} for x in rows}

    def cat_stats(cat, key):
        rs = [x for x in rows if cat == "all" or x["분류"] == cat]
        return {"total": len(rs), "calculable": sum(x["보기"][key]["net"] is not None for x in rs),
                "passed": sum(key in passed[x["item_id"]] for x in rs)}

    def failed_data(cat):
        rs = [x for x in rows if x["보기"]["dc"]["net"] is None and (cat == "all" or x["분류"] == cat)]
        return {"total": len(rs), "items": [
            {"name": gd.name(x["item_id"]), "stars": gd.gather[x["item_id"]].stars, "job": x["직업"],
             "level": x["레벨"], "reason": x["제외 사유"]} for x in rs[:MAX_FAILED]]}

    ui.dashboard({
        "mode": "gather",
        "title": "파판14 채집 수익 분석",
        "statLabels": [["분석한 채집템", "레벨 조건에 맞는 채집템"], ["시세 있는 템", "최근 팔린 기록이 있는 템"],
                       ["필터 통과", "현재 필터 기준 추천 대상"]],
        "subtitle": [server["world"], f"판매 시세 {dc} 서버별", f"채집 레벨 {level_range[0]}~{level_range[1]}",
                     f"시세 갱신 {fmt_time(cache.updated_at)}"],
        "notice": notice,
        "search": search_results(query) if query else None,
        "servers": SERVERS,
        "cats": cats,
        "catIcons": {"all": "✦", "일반": "⛏", "시간 한정": "⏰", "크리스탈": "💎"},
        "stats": {k: {c: cat_stats(c, k) for c in cats} for k in VIEWS},
        "jobs": GATHER_JOBS,
        "period": PERIOD,
        "sort": sort_by,
        "taxNote": f"판매세 {seller_tax:.0%} 반영",
        "taxRate": seller_tax,
        "rows": [row_data(x) for x in rows if passed[x["item_id"]]],
        "failed": {c: failed_data(c) for c in cats},
        "failedTitle": "시세를 몰라서 빠진 채집템",
    })


# ── 페이지 (사이드바 맨 위 메뉴) ──
st.navigation([
    st.Page(craft_page, title="제작", icon="⚒️", url_path="craft", default=True),
    st.Page(gather_page, title="채집", icon="⛏️", url_path="gather"),
]).run()

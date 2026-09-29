"""파판14 제작 수익성 분석 웹페이지.

실행:  streamlit run app.py
"""
import math
import time
from datetime import datetime, timedelta, timezone

import requests
import streamlit as st

from ffxiv import ui
from ffxiv.config import JOB_NAMES, TAX_CITIES, load_config
from ffxiv.gamedata import GameData, download_csvs, scope_recipes, target_recipes
from ffxiv.market import MarketCache, Universalis, refresh, resolve_server
from ffxiv.profit import analyze, detail_rows, market_item_ids, seller_tax_rate

st.set_page_config(page_title="파판14 제작 수익 분석", page_icon="🪑", layout="wide")
ui.password_gate()  # Streamlit Secrets 에 app_password 가 있으면 비밀번호 화면부터

cfg = load_config()
F = cfg["filters"]
H = cfg["history_hours"]
PERIOD = f"{H // 24}일" if H % 24 == 0 else f"{H}시간"
KST = timezone(timedelta(hours=9), "KST")  # 클라우드 서버는 시간대가 달라서 한국 시간으로 고정


@st.cache_resource(show_spinner="게임 데이터(레시피/아이템) 불러오는 중…")
def load_gamedata(base_url):
    download_csvs(base_url)
    return GameData()


@st.cache_resource(show_spinner="저장된 시세 불러오는 중…")
def load_market_cache(world_id, dc):
    return MarketCache({"world_id": world_id, "dc": dc})


@st.cache_resource
def auto_refresh_state():
    """자동 갱신을 마지막으로 시도한 시각. 실패해도 매 클릭마다 재시도하지 않게 기억해 둔다."""
    return {"last_try": 0.0}


def fmt_time(ts):
    return datetime.fromtimestamp(ts, KST).strftime("%Y-%m-%d %H:%M") if ts else "없음"


# ── 테마 (사이드바 맨 위에서 고르고, 주소에 기억해서 새로고침해도 유지) ──
sb = st.sidebar
ui.sidebar_brand(sb)
theme = sb.segmented_control("화면 모드", list(ui.THEMES), default="다크", required=True,
                             key="theme", bind="query-params", label_visibility="collapsed", width="stretch")
palette = sb.segmented_control("색감", list(ui.PALETTES), default="골드", required=True,
                               key="palette", bind="query-params", width="stretch")
ui.apply_theme(theme, palette)

try:
    gd = load_gamedata(cfg["datamining_base_url"])
except requests.RequestException as e:
    st.error(f"게임 데이터 CSV 를 받지 못했습니다: {e}")
    st.stop()

api = Universalis(cfg["universalis_base_url"], cfg["request_interval_sec"])
try:
    server = resolve_server(api, cfg)
except (requests.RequestException, ValueError) as e:
    st.error(f"월드 정보를 확인하지 못했습니다: {e}")
    st.stop()
cache = load_market_cache(server["world_id"], server["dc"])
home, dc = server["world_id"], server["dc"]

# ── 사이드바 ──
refresh_clicked = sb.button("🔄 데이터 갱신", type="primary", width="stretch")
auto_min = cfg.get("auto_refresh_minutes", 0)
ui.sidebar_note(sb, f"마지막 갱신: {fmt_time(cache.updated_at)}"
                + (f" · {auto_min}분 지나면 자동 갱신" if auto_min else ""))

ui.sidebar_title(sb, "서버 범위")
scope_names = {"dc": f"{dc} 전체" if dc else "데이터센터 전체", "world": f"{server['world']}만"}
sell_scope = sb.segmented_control(
    "판매 시세 기준", list(scope_names), format_func=scope_names.get, required=True, width="stretch",
    default="dc" if cfg["sell_scope"] == "dc" else "world",
    help="등록은 내 서버에서만 되지만, 사는 사람들이 서버를 돌아다니며 제일 싼 걸 사가니 "
         "경쟁 매물과 판매량을 데이터센터 전체로 보는 게 기본입니다.")
buy_scope = sb.segmented_control(
    "재료 구매", list(scope_names), format_func=scope_names.get, required=True, width="stretch",
    default="dc" if cfg["buy_scope"] == "dc" else "world",
    help="데이터센터 전체면 다른 서버에 가서 제일 싼 매물을 사 온다고 가정합니다. "
         "재료 상세의 '구매 서버'에 어디로 가면 되는지 나옵니다.")

ui.sidebar_title(sb, "분석 대상")
include_all = sb.toggle("전체 제작품", value=cfg["include_all_crafts"], help="끄면 하우징 가구만 봅니다.")
level_range = sb.slider("레시피 레벨 범위", 1, 100, (cfg["recipe_level_min"], cfg["recipe_level_max"]))
with sb.expander(f"직업별 레벨 · {len(JOB_NAMES)}개 직업", expanded=False):
    st.caption("이 레벨보다 높은 레시피는 빠지고, 중간재료 직접 제작도 이 레벨까지만 고려합니다.")
    cols = st.columns(2)
    job_levels = {job: cols[i % 2].number_input(job, 1, 100, cfg["job_levels"][job], key=f"lv_{job}")
                  for i, job in enumerate(JOB_NAMES)}
sell_hq = sb.toggle("HQ 판매", value=cfg["sell_hq"], help="HQ 가 있는 아이템을 HQ 시세로 판다고 가정합니다.")
batch_size = sb.number_input("한 번에 제작할 횟수", 1, 99, cfg["batch_size"],
                             help="재료를 싼 매물부터 이 횟수만큼 사는 비용으로 원가를 계산합니다.")

ui.sidebar_title(sb, "필터")
min_sales = sb.number_input(f"{PERIOD} 판매 건수 ≥", 0, 999, F["min_sales"])
mat_ratio = sb.number_input("재료 판매 수량 배수 ≥", 0.0, 100.0, float(F["material_ratio"]), 0.5,
                            help="재료별 판매 수량이 필요 수량의 몇 배 이상인지. NPC·직접 채집 재료는 검사하지 않습니다.")
min_margin = sb.number_input("최소 수익률(%)", -100.0, 10000.0, float(F["min_margin_pct"]), 5.0)
min_profit = sb.number_input("개당 최소 순수익(길)", -1_000_000, 10_000_000, F["min_profit"], 500)
max_listings = sb.number_input("현재 등록 건수 ≤", 0, 999, F["max_listings"])
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

if sb.button("게임 데이터 다시 받기", help="패치 후 레시피가 바뀌었을 때만", width="stretch"):
    download_csvs(cfg["datamining_base_url"], force=True)
    load_gamedata.clear()
    st.rerun()

# ── 시세 데이터 준비 ──
# 시세는 레벨과 상관없이 전체 범위를 받아둔다 → 레벨 범위/직업 레벨을 바꿔도 다시 받지 않음
ids = market_item_ids(gd, scope_recipes(gd, cfg, include_all))
targets = list(target_recipes(gd, cfg, include_all, *level_range, job_levels))
missing = cache.missing(ids)
auto = auto_refresh_state()
now = time.time()
auto_due = (bool(auto_min) and cache.updated_at and now - cache.updated_at > auto_min * 60
            and now - auto["last_try"] > auto_min * 60)
full = refresh_clicked or auto_due
if full or missing:
    auto["last_try"] = now
    todo = len(ids) if full else len(missing)
    why = "시세가 오래돼서 자동으로 " if auto_due and not refresh_clicked else ""
    bar = st.progress(0.0, f"{why}시세 받는 중… ({todo:,}개 아이템, 1~5분 걸릴 수 있어요)")
    try:
        n = refresh(api, cache, server, ids, cfg["history_hours"], full=full,
                    progress=lambda p, msg: bar.progress(p, msg))
        bar.empty()
        if full:
            st.toast(f"{n}개 아이템 시세를 새로 받았습니다.")
    except requests.RequestException as e:
        bar.empty()
        st.warning(f"Universalis 에서 시세를 받지 못했습니다. 저장된 데이터로 계산합니다. ({e})")

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
            and r["현재 매물 수"] <= max_listings)


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
        "badges": [{"kind": ui.badge_kind(t), "text": t} for t in notes],
        "detailDesc": f"{recipe.job_name} Lv{recipe.job_level} · 결과물 {recipe.result_amount}개 · "
                      f"{batch_size}회 제작 기준 · {ratio_text}",
        "materials": materials,
    }


calculable = [r for r in rows if r["순수익"] is not None]
passed = [r for r in rows if passes(r)]
failed = [r for r in rows if r["순수익"] is None]

ui.dashboard({
    "subtitle": [server["world"], f"판매 시세 {scope_names[sell_scope]}", f"재료 구매 {scope_names[buy_scope]}",
                 f"레시피 레벨 {level_range[0]}~{level_range[1]}", "전체 제작품" if include_all else "하우징 가구",
                 f"시세 갱신 {fmt_time(cache.updated_at)}"],
    "stats": {"total": len(rows), "calculable": len(calculable), "passed": len(passed)},
    "jobs": JOB_NAMES,
    "period": PERIOD,
    "sort": sort_by,
    "taxNote": f"판매세 {seller_tax:.0%} 반영",
    "rows": [row_data(r) for r in passed],
    "failed": [{"name": gd.name(trees[r["recipe_id"]][0].result_id), "stars": trees[r["recipe_id"]][0].stars,
                "job": r["직업"], "level": r["레시피 레벨"], "reason": r["제외 사유"]} for r in failed],
})

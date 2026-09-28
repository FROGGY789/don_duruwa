"""파판14 제작 수익성 분석 웹페이지.

실행:  streamlit run app.py
"""
import math
from datetime import datetime

import pandas as pd
import requests
import streamlit as st

from ffxiv.config import JOB_NAMES, TAX_CITIES, load_config
from ffxiv.gamedata import GameData, download_csvs, target_recipes
from ffxiv.market import MarketCache, Universalis, refresh, resolve_world_id
from ffxiv.profit import analyze, detail_rows, market_item_ids, seller_tax_rate

st.set_page_config(page_title="파판14 제작 수익 분석", page_icon="🪑", layout="wide")

cfg = load_config()
F = cfg["filters"]


@st.cache_resource(show_spinner="게임 데이터(레시피/아이템) 불러오는 중…")
def load_gamedata(base_url):
    download_csvs(base_url)
    return GameData()


def fmt_time(ts):
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M") if ts else "없음"


try:
    gd = load_gamedata(cfg["datamining_base_url"])
except requests.RequestException as e:
    st.error(f"게임 데이터 CSV 를 받지 못했습니다: {e}")
    st.stop()

api = Universalis(cfg["universalis_base_url"], cfg["request_interval_sec"])
try:
    world_id = resolve_world_id(api, cfg)
except (requests.RequestException, ValueError) as e:
    st.error(f"월드 ID 를 확인하지 못했습니다: {e}")
    st.stop()
cache = MarketCache(world_id)

# ── 사이드바 ──
sb = st.sidebar
sb.title("⚙️ 설정")

refresh_clicked = sb.button("🔄 데이터 갱신", type="primary", width="stretch")
sb.caption(f"마지막 갱신: {fmt_time(cache.updated_at)}")

sb.subheader("분석 대상")
include_all = sb.toggle("전체 제작품 (가구 외 포함)", value=cfg["include_all_crafts"])
level_range = sb.slider("레시피 레벨", 1, 100, (cfg["recipe_level_min"], cfg["recipe_level_max"]))
sell_hq = sb.toggle("HQ 가능 아이템은 HQ 로 판매", value=cfg["sell_hq"])
batch_size = sb.number_input("한 번에 제작할 횟수", 1, 99, cfg["batch_size"],
                             help="재료를 싼 매물부터 이 횟수만큼 사는 비용으로 원가를 계산합니다.")

sb.subheader("필터")
min_sales = sb.number_input(f"최근 {cfg['history_hours']}시간 판매 건수 ≥", 0, 999, F["min_sales"])
mat_ratio = sb.number_input("재료 판매 수량 ≥ 필요 수량 × (배)", 0.0, 100.0, float(F["material_ratio"]), 0.5,
                            help="NPC 에서 사거나 직접 채집하는 재료는 검사하지 않습니다.")
min_margin = sb.number_input("최소 수익률(%)", -100.0, 10000.0, float(F["min_margin_pct"]), 5.0)
min_profit = sb.number_input("개당 최소 순수익(길)", -1_000_000, 10_000_000, F["min_profit"], 500)
max_listings = sb.number_input("현재 등록 건수 ≤", 0, 999, F["max_listings"])
stale_hours = sb.number_input("데이터 오래됨 기준(시간)", 1, 720, F["stale_hours"])

sb.subheader("정렬 / 세금")
sort_options = ["순수익", "수익률(%)", "하루 잠재 이익"]
default_sort = {"수익률": "수익률(%)"}.get(cfg["sort_by"], cfg["sort_by"])
sort_by = sb.radio("기본 정렬", sort_options,
                   index=sort_options.index(default_sort) if default_sort in sort_options else 0)
city_keys = ["min"] + list(TAX_CITIES)
city = sb.selectbox("판매 도시(세율)", city_keys,
                    index=city_keys.index(cfg["tax_city"]) if cfg["tax_city"] in city_keys else 1,
                    format_func=lambda c: "가장 낮은 세율" if c == "min" else TAX_CITIES[c])
seller_tax, tax_city = seller_tax_rate(cfg, cache.tax_rates, city)
sb.caption(f"적용 판매세: {seller_tax:.0%} ({TAX_CITIES.get(tax_city, tax_city)}) · 구매세 {cfg['buyer_tax_rate']:.0%}")

with sb.expander("직업 레벨 (config.yaml 에서 수정)"):
    st.write(" / ".join(f"{j} {cfg['job_levels'][j]}" for j in JOB_NAMES))
if sb.button("게임 데이터 다시 받기", help="패치 후 레시피가 바뀌었을 때만"):
    download_csvs(cfg["datamining_base_url"], force=True)
    load_gamedata.clear()
    st.rerun()

# ── 시세 데이터 준비 ──
targets = list(target_recipes(gd, cfg, include_all, *level_range))
ids = market_item_ids(gd, cfg, targets)
missing = cache.missing(ids)
if refresh_clicked or missing:
    bar = st.progress(0.0, "시세 받는 중…")
    try:
        n = refresh(api, cache, world_id, ids, cfg["history_hours"], full=refresh_clicked,
                    progress=lambda p, msg: bar.progress(p, msg))
        bar.empty()
        if refresh_clicked:
            st.toast(f"{n}개 아이템 시세를 새로 받았습니다.")
    except requests.RequestException as e:
        bar.empty()
        st.warning(f"Universalis 에서 시세를 받지 못했습니다. 저장된 데이터로 계산합니다. ({e})")

# ── 계산 ──
rows, trees, calc = analyze(gd, cache.items, cfg, targets, seller_tax, sell_hq, batch_size)
df = pd.DataFrame(rows)

st.title("🪑 파판14 제작 수익 분석")
st.caption(f"{cfg['world']} · 레시피 레벨 {level_range[0]}~{level_range[1]} · "
           f"{'전체 제작품' if include_all else '하우징 가구'} · 시세 갱신 {fmt_time(cache.updated_at)}")

if df.empty:
    st.info("조건에 맞는 레시피가 없습니다.")
    st.stop()

now = datetime.now().timestamp()
stale = df["업데이트"].fillna(0) < now - stale_hours * 3600
df["기타"] = [(["⚠ 데이터 오래됨"] if s else []) + extra for s, extra in zip(stale, df["기타"])]
df["기타"] = df["기타"].apply(" · ".join)
df["업데이트"] = pd.to_datetime(df["업데이트"], unit="s", utc=True).dt.tz_convert(datetime.now().astimezone().tzinfo)

calculable = df["순수익"].notna()
passed = (
    calculable
    & (df["판매 건수"] >= min_sales)
    & (df["재료 여유 배수"] >= mat_ratio)
    & (df["수익률(%)"].fillna(-math.inf) >= min_margin)
    & (df["순수익"] >= min_profit)
    & (df["현재 매물 수"] <= max_listings)
)
result = df[passed].sort_values(sort_by, ascending=False)

m1, m2, m3 = st.columns(3)
m1.metric("분석한 레시피", f"{len(df)}개")
m2.metric("계산 가능", f"{int(calculable.sum())}개")
m3.metric("필터 통과", f"{len(result)}개")

COLUMNS = ["순위", "아이템명", "직업", "레시피 레벨", "판매 예상가", "원가", "순수익", "수익률(%)",
           "판매 건수", "현재 매물 수", "하루 잠재 이익", "업데이트", "기타"]
COLUMN_CONFIG = {
    "판매 예상가": st.column_config.NumberColumn(format="localized"),
    "원가": st.column_config.NumberColumn(format="localized"),
    "순수익": st.column_config.NumberColumn(format="localized"),
    "수익률(%)": st.column_config.NumberColumn(format="%.1f%%"),
    "판매 건수": st.column_config.NumberColumn(f"{cfg['history_hours']}h 판매 건수"),
    "하루 잠재 이익": st.column_config.NumberColumn(
        format="localized", help="순수익 × 시장 전체 하루 판매량. 내가 다 팔 수 있다는 뜻은 아닌 상한값."),
    "업데이트": st.column_config.DatetimeColumn("데이터 업데이트", format="MM-DD HH:mm"),
}


def show_detail(recipe_id):
    recipe, tree = trees[recipe_id]
    row = df[df["recipe_id"] == recipe_id].iloc[0]
    st.subheader(f"📦 {row['아이템명']} — 재료 상세")
    ratio = row["재료 여유 배수"]
    ratio_text = "∞ (거래소 재료 없음)" if math.isinf(ratio) else f"{ratio:.1f}배"
    st.caption(f"{recipe.job_name} Lv{recipe.job_level} · 결과물 {recipe.result_amount}개 · "
               f"{batch_size}회 제작 기준 · 재료 여유 배수 {ratio_text}"
               + (f" · {row['기타']}" if row["기타"] else ""))
    st.dataframe(
        pd.DataFrame(detail_rows(calc, tree)), hide_index=True, width="stretch",
        column_config={
            "단가": st.column_config.NumberColumn(format="localized"),
            "소계(1회 제작)": st.column_config.NumberColumn(format="localized"),
            "판매 수량(기간)": st.column_config.NumberColumn(f"{cfg['history_hours']}h 판매 수량"),
        },
    )


def show_table(data, key):
    if data.empty:
        st.info("필터를 통과한 아이템이 없습니다. 사이드바에서 조건을 완화해 보세요.")
        return
    data = data.reset_index(drop=True)
    data.insert(0, "순위", range(1, len(data) + 1))
    event = st.dataframe(
        data[COLUMNS], hide_index=True, width="stretch", column_config=COLUMN_CONFIG,
        on_select="rerun", selection_mode="single-row", key=key,
    )
    st.caption("행을 클릭하면 재료 상세가 아래에 나옵니다. 컬럼 제목을 클릭하면 정렬됩니다.")
    if event.selection.rows:
        show_detail(int(data.iloc[event.selection.rows[0]]["recipe_id"]))


tabs = st.tabs(["🏆 통합 순위"] + JOB_NAMES)
with tabs[0]:
    show_table(result, "all")
for tab, job in zip(tabs[1:], JOB_NAMES):
    with tab:
        show_table(result[result["직업"] == job], f"job_{job}")

with st.expander(f"계산할 수 없었던 레시피 ({int((~calculable).sum())}개)"):
    st.dataframe(df[~calculable][["아이템명", "직업", "레시피 레벨", "제외 사유"]],
                 hide_index=True, width="stretch")

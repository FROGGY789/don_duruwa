// 정적 사이트 껍데기: 사이드바(설정·필터), 데이터 받기, 브라우저에서 순수익·필터·검색 계산 → dashboard.js 로 그리기
// 데이터는 GitHub Actions 가 매시간 만든다 (python -m ffxiv.build). 서버는 없다.
import dashboard from "./dashboard.js";

const THEMES = { "다크": "dark", "화이트": "light" };
const PALETTES = { "초록": "jade", "골드": "gold", "크리스탈": "crystal", "에테르": "aether", "로즈": "rose", "실버": "silver" };
const QUALITY_KEY = { NQ: "nq", HQ: "hq", "통합": "all" };
const SHARDS = 32;
const CRAFT_CATS = { all: "전체", "가구": "가구", "장비": "장비", "재료": "재료", "소모품": "소모품", "기타": "기타" };
const GATHER_CATS = { all: "전체", "일반": "일반", "시간 한정": "시간 한정", "크리스탈": "크리스탈" };
const MAX_RESULTS = 30, MAX_FAILED = 400;

let meta = null;
const datasets = {}; // "craft-nq" → {rows, details, shards}
let S = null; // 설정 (브라우저에 기억)

// ── 저장 ──
function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 저장 못 해도 화면은 그대로 */ }
}
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
async function getJSON(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

function defaults() {
  const D = meta.defaults;
  const page = (p) => ({
    levelMin: D[p].levelMin, levelMax: D[p].levelMax, jobLevels: { ...D[p].jobLevels },
    minSales: D[p].filters.min_sales ?? 3, minProfit: D[p].filters.min_profit ?? 0,
    maxListings: D[p].filters.max_listings ?? 100, maxDays: D[p].filters.max_sell_days ?? 0,
    matRatio: D[p].filters.material_ratio ?? 0, minMargin: D[p].filters.min_margin_pct ?? 0,
    sort: { "순수익": "net", "개당 순수익": "net", "수익률": "margin", "수익률(%)": "margin", "하루 잠재 이익": "daily" }[D[p].sort] || (p === "gather" ? "daily" : "net"),
  });
  return {
    theme: "화이트", palette: "초록", quality: D.quality in QUALITY_KEY ? D.quality : "NQ",
    taxCity: meta.defaultTaxCity, staleHours: D.craft.filters.stale_hours ?? 72,
    craft: page("craft"), gather: page("gather"),
  };
}
// 기본값이 바뀌면 숫자를 올린다. 예전에 저장된 설정에서 그 값만 새 기본값으로 바꿔 준다
const SETTINGS_VERSION = 3; // 2: 예상 판매 소요일 기본 7일, 3: 판매 품질 기본 통합
function loadSettings() {
  const d = defaults(), s = load("ffxivSettings", {});
  if ((s.v || 1) < 2) { delete (s.craft || {}).maxDays; delete (s.gather || {}).maxDays; }
  if ((s.v || 1) < 3) delete s.quality;
  if (!(s.palette in PALETTES)) delete s.palette; // 예전 버그로 이상한 값이 저장됐을 수 있다
  s.v = SETTINGS_VERSION;
  return { ...d, ...s, craft: { ...d.craft, ...(s.craft || {}), jobLevels: { ...d.craft.jobLevels, ...((s.craft || {}).jobLevels || {}) } },
    gather: { ...d.gather, ...(s.gather || {}), jobLevels: { ...d.gather.jobLevels, ...((s.gather || {}).jobLevels || {}) } } };
}

// 설정 저장: 이 브라우저 + 캐릭터별로 서버에도 (다른 기기에서도 따라오게). 연달아 바꾸면 모아서 한 번만 올린다
let pushTimer = 0;
function saveSettings() {
  save("ffxivSettings", S);
  if (!who()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    fetch("/__settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(S) }).catch(() => {});
  }, 1500);
}
async function remoteSettings() {
  if (!who()) return null;
  try {
    const res = await fetch("/__settings", { cache: "no-cache" });
    return res.ok ? (await res.json()).settings || null : null;
  } catch { return null; }
}

// 로그인한 캐릭터 (Cloudflare 문지기가 넣어 준 쿠키, 없으면 빈칸)
function who() {
  const m = document.cookie.match(/(?:^|;\s*)ffx_who=([^;]*)/);
  try { return m ? decodeURIComponent(m[1]) : ""; } catch { return ""; }
}
// 관리자 메뉴를 보여줄지 (화면 표시용일 뿐, 진짜 확인은 Cloudflare 문지기가 한다)
const adminUI = () => /(?:^|;\s*)ffx_admin=1/.test(document.cookie);
const page = () => (location.hash === "#gather" ? "gather" : location.hash === "#track" ? "track"
  : location.hash === "#admin" && adminUI() ? "admin" : "craft");
let adminPending = 0;
const days = () => meta.hours / 24;
const PERIOD = () => (meta.hours % 24 === 0 ? `${meta.hours / 24}일` : `${meta.hours}시간`);

function taxRate() {
  const rates = meta.taxRates || {};
  if (S.taxCity === "min") {
    const vals = Object.values(rates);
    return vals.length ? Math.min(...vals) : meta.defaultTaxRate;
  }
  return rates[S.taxCity] ?? meta.defaultTaxRate;
}
function fmtTime(ts) {
  if (!ts) return "없음";
  const t = new Date(ts * 1000), p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
}
function ago(ts) {
  if (!ts) return "기록 없음";
  const sec = Math.max(0, Date.now() / 1000 - ts);
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
  return `${Math.floor(sec / 86400)}일 전`;
}

// ── 데이터 ──
async function dataset(name) {
  if (!datasets[name]) {
    const d = await getJSON(`data/${name}.json`);
    // 서버 보기 값은 배열, 뱃지는 번호로 와서 풀어 준다 (ffxiv/build.py 참고)
    for (const r of d.rows) {
      r.badges = r.badges.map((i) => d.badges[i]);
      for (const k of Object.keys(r.v)) {
        const o = {};
        d.fields.forEach((f, i) => (o[f] = r.v[k][i]));
        o.badges = o.badges.map((i) => d.badges[i]);
        r.v[k] = o;
      }
    }
    datasets[name] = { rows: d.rows, details: {}, shards: {}, cache: {} };
  }
  return datasets[name];
}
function loadDetail(name, id) {
  const ds = datasets[name];
  const n = id % SHARDS;
  if (!ds.shards[n]) {
    ds.shards[n] = getJSON(`data/${name}-d${n}.json`).then((shard) => {
      Object.assign(ds.details, shard);
      for (const key of Object.keys(shard)) mergeDetail(ds, Number(key));
    });
  }
  return ds.shards[n];
}
// 상세(근거·재료·추이)를 받으면 그 줄에 붙인다
function mergeDetail(ds, id) {
  const row = ds.cache[id], d = ds.details[id];
  if (!row || !d) return;
  row.evidence = d.evidence;
  row.detailDesc = d.detailDesc;
  if (d.materials) { row.materials = d.materials; row.shopping = d.shopping; }
  for (const [k, v] of Object.entries(d.views || {})) Object.assign(row.views[k] || (row.views[k] = {}), v);
  row.loaded = true;
}

// ── 계산: 판매세 넣은 순수익, 필터, 통계, 검색 ──
function compute(p, ds, name) {
  const F = S[p], tax = taxRate(), now = Date.now() / 1000;
  const keys = meta.servers.map((s) => s.key);
  const inScope = (r) => r.level >= F.levelMin && r.level <= F.levelMax && r.level <= (F.jobLevels[r.job] ?? 100);
  const staleTip = `Universalis 에 마지막으로 올라온 지 ${S.staleHours}시간 넘었다 개굴. 지금 게임 시세랑 다를 수 있다 개굴.`;

  function failReasons(r, v) {
    const out = [];
    if (v.sales < F.minSales) out.push(`${PERIOD()} 판매 ${v.sales}건 (기준 ${F.minSales}건↑)`);
    if (p === "craft" && (r.matRatio ?? Infinity) < F.matRatio) out.push(`재료 판매량 ${r.matRatio.toFixed(1)}배 (기준 ${F.matRatio}배↑)`);
    if (p === "craft" && (v.margin ?? -Infinity) < F.minMargin) out.push(v.margin == null ? "수익률 계산 못 했다 개굴" : `수익률 ${v.margin.toFixed(0)}% (기준 ${F.minMargin}%↑)`);
    if (v.net < F.minProfit) out.push(`${p === "gather" ? "개당 " : ""}순수익 ${Math.round(v.net).toLocaleString("ko-KR")}길 (기준 ${Number(F.minProfit).toLocaleString("ko-KR")}길↑)`);
    if (v.listings > F.maxListings) out.push(`매물 ${v.listings}건 (기준 ${F.maxListings}건↓)`);
    if (F.maxDays && (v.sellDays == null || v.sellDays > F.maxDays)) out.push(v.sellDays == null ? "판매 소요일 모름" : `판매 소요 ~${Math.ceil(v.sellDays)}일 (기준 ${F.maxDays}일↓)`);
    return out;
  }

  const rows = ds.rows.map((r) => {
    const row = ds.cache[r.id] || (ds.cache[r.id] = { views: {} });
    const stale = (r.updated || 0) < now - S.staleHours * 3600;
    const scope = inScope(r);
    Object.assign(row, {
      id: r.id, name: r.name, stars: r.stars, job: r.job, level: r.level, cost: r.cost, cat: r.cat, sub: r.sub,
      updated: r.updated, updatedText: ago(r.updated), stale, sellingHq: r.hq, resultAmount: r.resultAmount,
      badges: (stale ? [{ kind: "stale", text: "⚠ 데이터 오래됨", tip: staleTip }] : []).concat(r.badges),
      scope, raw: r,
    });
    for (const k of keys) {
      const s = r.v[k];
      const v = row.views[k] || (row.views[k] = {});
      const net = s.sell != null && r.cost != null ? s.sell * (1 - tax) - r.cost : null;
      Object.assign(v, s, {
        net, margin: net != null && r.cost > 0 ? (net / r.cost) * 100 : null,
        daily: net != null ? (net * s.soldQty) / days() : null,
      });
      v.reasons = net == null ? null : failReasons(row, v);
      v.passes = scope && net != null && !v.reasons.length;
    }
    if (ds.details[r.id]) mergeDetail(ds, r.id);
    return row;
  });

  const cats = p === "craft" ? CRAFT_CATS : GATHER_CATS;
  const scoped = rows.filter((r) => r.scope);
  const stats = {};
  for (const k of keys) {
    stats[k] = {};
    for (const c of Object.keys(cats)) {
      const rs = scoped.filter((r) => c === "all" || r.cat === c);
      stats[k][c] = { total: rs.length, calculable: rs.filter((r) => r.views[k].net != null).length,
        passed: rs.filter((r) => r.views[k].passes).length };
    }
  }
  const failed = {};
  for (const c of Object.keys(cats)) {
    const rs = scoped.filter((r) => r.views.dc.net == null && (c === "all" || r.cat === c));
    failed[c] = { total: rs.length, items: rs.slice(0, MAX_FAILED).map((r) => ({ name: r.name, stars: r.stars, hq: r.sellingHq === true, job: r.job, level: r.level, reason: r.raw.reason || "판매 기록이 없다 개굴" })) };
  }
  return { rows, stats, failed, cats, tax };
}

function search(p, rows, q) {
  if (!q) return null;
  const F = S[p], key = q.replace(/\s/g, "");
  const servers = meta.servers.filter((s) => s.key !== "dc");
  const found = rows.filter((r) => r.name.replace(/\s/g, "").includes(key));
  const items = found.slice(0, 200).map((r) => {
    let kind, why = "";
    const v = r.views.dc;
    if (!(r.level >= F.levelMin && r.level <= F.levelMax)) { kind = "out"; why = `${p === "craft" ? "레시피" : "채집"} Lv${r.level} — 레벨 범위 ${F.levelMin}~${F.levelMax} 밖이다 개굴`; }
    else if (r.level > (F.jobLevels[r.job] ?? 100)) { kind = "out"; why = `${r.job} 레벨 ${F.jobLevels[r.job]} < Lv${r.level} 이다 개굴`; }
    else if (v.net == null) { kind = "nocalc"; why = r.raw.reason || "판매 기록이 없다 개굴"; }
    else if (v.passes) kind = "ok";
    else {
      const okWorlds = servers.filter((s) => r.views[s.key].passes).map((s) => s.name);
      kind = okWorlds.length ? "ok" : "filtered";
      why = "통합: " + v.reasons.join(" · ") + (okWorlds.length ? ` — 서버별로는 ${okWorlds.join(", ")} 순위에 있다 개굴` : "");
    }
    return { name: r.name, stars: r.stars, hq: r.sellingHq === true, job: r.job, level: r.level, kind, why, id: kind === "ok" ? r.id : null, net: v.net, sell: v.sell };
  });
  const order = { ok: 0, filtered: 1, nocalc: 2, out: 3 };
  items.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name, "ko"));
  return { query: q, items: items.slice(0, MAX_RESULTS), total: found.length };
}

// ── 그리기 ──
let query = "";
async function render() {
  if (page() === "admin") return renderAdmin();
  if (page() === "track") return renderTrack();
  const p = page(), name = `${p}-${QUALITY_KEY[S.quality]}`;
  let ds;
  try { ds = await dataset(name); } catch (e) {
    document.getElementById("app").innerHTML = `<div class="boot">⚠ 데이터를 못 받아왔다 개굴. 조금 있다가 새로고침 해 봐라 개굴. (${esc(e.message)})</div>`;
    return;
  }
  const { rows, stats, failed, cats, tax } = compute(p, ds, name);
  const F = S[p];
  const app = document.getElementById("app");
  let host = app.querySelector(".dash-host");
  if (!host) {
    app.innerHTML = `<div class="search-wrap"><input id="search" type="search" placeholder="${p === "craft" ? "🔍 아이템 이름으로 찾기 (예: 모그루 모그, 루비)" : "🔍 채집템 이름으로 찾기 (예: 구리 광석, 라벤더)"}" autocomplete="off"></div><div class="dash-host"></div>`;
    host = app.querySelector(".dash-host");
    const input = app.querySelector("#search");
    input.value = query;
    let timer;
    input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { query = input.value.trim(); render(); }, 250); });
  }
  const data = {
    mode: p,
    title: p === "craft" ? "파판14 제작 수익 분석" : "파판14 채집 수익 분석",
    statLabels: p === "gather" ? [["분석한 채집템", "레벨 조건에 맞는 채집템"], ["시세 있는 템", "최근 팔린 기록이 있는 템"], ["필터 통과", "현재 필터 기준 추천 대상"]] : undefined,
    subtitle: [meta.world, `판매 시세 ${meta.dc} 서버별`, ...(p === "craft" ? [`재료 구매 ${meta.dc} 전체`] : []),
      `${p === "craft" ? "레시피" : "채집"} 레벨 ${F.levelMin}~${F.levelMax}`, `시세 갱신 ${fmtTime(meta.updatedAt)}`],
    notice: null,
    search: search(p, rows, query),
    servers: meta.servers,
    cats,
    catIcons: p === "gather" ? { all: "✦", "일반": "⛏", "시간 한정": "⏰", "크리스탈": "💎" } : undefined,
    subs: p === "craft" ? meta.subs : {},
    quality: S.quality,
    stats,
    jobs: p === "craft" ? meta.jobs : meta.gatherJobs,
    period: PERIOD(),
    sort: F.sort,
    taxNote: `판매세 ${Math.round(tax * 100)}% 반영`,
    taxRate: tax,
    rows,
    failed,
    failedTitle: p === "gather" ? "시세를 몰라서 빠진 채집템" : undefined,
    loadDetail: (id) => loadDetail(name, id),
  };
  dashboard({ data, parentElement: host });
}

// ── 📈 재료 트래킹 ──
const TRACK_SHARDS = 64;
const trackShards = {};
let trackNames = null;
let trackQuery = "";
const tracked = () => load("ffxivTrack", null) ?? [{ id: 8026, qty: 99 }]; // 처음엔 안개비단
const saveTracked = (list) => save("ffxivTrack", list);
const gil = (v) => (v == null ? "-" : Math.round(v).toLocaleString("ko-KR"));
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (a, q) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), i = (s.length - 1) * q, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
function trackShard(id) {
  const n = id % TRACK_SHARDS;
  return (trackShards[n] = trackShards[n] || getJSON(`data/track/t${n}.json`));
}

// 한 재료 분석: 서버별 지금 매물, 살 때 판단, 구매 계획
function analyzeTrack(id, d, qty) {
  const servers = meta.servers.filter((x) => x.key !== "dc");
  const worlds = servers.map((sv) => {
    const w = (d.w || {})[sv.key] || { lst: [], cnt: 0 };
    const real = w.lst.filter((l) => !l[3]);
    const recent = d.h.slice(-7).map((h) => (h[1][sv.key] || [])[0]).filter((x) => x != null);
    return { ...sv, lst: w.lst, cnt: w.cnt, min: real[0]?.[0] ?? null, minQty: real.filter((l) => l[0] === real[0]?.[0]).reduce((a, l) => a + l[1], 0),
      med7: median(recent), sold7: d.h.slice(-7).reduce((a, h) => a + ((h[1][sv.key] || [])[1] || 0), 0) };
  });
  const listed = worlds.filter((w) => w.min != null).sort((a, b) => a.min - b.min);
  const cur = listed[0]?.min ?? null;
  const days = d.h.map((h) => ({ date: h[0], med: (h[1].dc || [])[0] ?? null, units: (h[1].dc || [])[1] || 0,
    min: Object.values(h[2] || {}).length ? Math.min(...Object.values(h[2])) : null }));
  // 판단 기준: 같은 것끼리 비교한다 (서버마다 시세 수준이 달라서)
  //  1) 그날 최저 매물 기록이 5일치 넘게 쌓였으면: 지금 최저가 vs 지난날들의 최저 매물
  //  2) 아직이면: 제일 싼 서버의 지금 최저가 vs 그 서버의 하루 판매 중앙값
  const today = days.length ? days[days.length - 1].date : null;
  const pastMins = days.slice(-29).filter((x) => x.date !== today).map((x) => x.min).filter((x) => x != null);
  const bestW = listed[0];
  let refs, basis;
  if (pastMins.length >= 5) { refs = pastMins; basis = `최근 ${refs.length}일 그날 최저 매물`; }
  else {
    refs = bestW ? d.h.slice(-28).map((h) => (h[1][bestW.key] || [])[0]).filter((x) => x != null) : [];
    basis = bestW ? `${bestW.name} 최근 ${refs.length}일 판매 중앙값` : "";
  }
  const ref = median(refs), p25 = quantile(refs, 0.25), p75 = quantile(refs, 0.75);
  const r3 = median(days.slice(-3).map((x) => x.med).filter((x) => x != null));
  const before = median(days.slice(-10, -3).map((x) => x.med).filter((x) => x != null));
  const trend = r3 && before ? (r3 / before - 1) * 100 : null;
  let signal;
  if (cur == null) signal = { kind: "none", icon: "⚪", label: "매물 없음", text: "지금 올라온 매물이 없다 개굴. 조금 있다가 다시 봐라 개굴." };
  else if (refs.length < 3) signal = { kind: "none", icon: "⚪", label: "판단 보류", text: `비교할 기록이 ${refs.length}일치밖에 없어서 아직 판단을 못 한다 개굴. 며칠 쌓이면 알려준다 개굴.` };
  else {
    const diff = (cur / ref - 1) * 100, pct = Math.abs(diff).toFixed(0);
    const base = `지금 최저 ${gil(cur)}길 (${bestW.name}) — ${basis} ${gil(ref)}길보다 ${pct}% ${diff < 0 ? "싸다" : "비싸다"} 개굴.`;
    if (cur <= p25 || diff <= -10) signal = { kind: "buy", icon: "🟢", label: "지금 살 때", text: `${base} 쌀 때 사 둬라 개굴.` };
    else if (cur >= p75 || diff >= 15) signal = { kind: "wait", icon: "🔴", label: "기다려라", text: `${base} 급한 거 아니면 며칠 기다려 봐라 개굴.` };
    else signal = { kind: "ok", icon: "🟡", label: "보통", text: `${base} 평소 가격대다 개굴.` };
  }
  if (trend != null && Math.abs(trend) >= 10) signal.trend = `최근 3일 ${trend > 0 ? "📈 +" : "📉 "}${trend.toFixed(0)}% ${trend > 0 ? "오르는 중" : "내리는 중"}이다 개굴.`;
  // 구매 계획: 모든 서버의 싼 매물부터 필요 수량만큼 (미끼는 빼고)
  const pool = worlds.flatMap((w) => w.lst.filter((l) => !l[3]).map((l) => ({ w: w.name, price: l[0], qty: l[1] }))).sort((a, b) => a.price - b.price);
  const plan = {}; let got = 0, spend = 0;
  for (const l of pool) {
    if (got >= qty) break;
    const take = Math.min(l.qty, qty - got);
    got += take; spend += take * l.price;
    const p = (plan[l.w] = plan[l.w] || { qty: 0, spend: 0, lots: 0 });
    p.qty += take; p.spend += take * l.price; p.lots += 1;
  }
  // 그래프: 판단에 쓴 서버의 하루 판매 중앙값도 같이 (보통 가격대 띠랑 같은 기준)
  if (bestW && pastMins.length < 5) d.h.forEach((h, i) => (days[i].wmed = (h[1][bestW.key] || [])[0] ?? null));
  return { worlds, cur, ref, p25, p75, days, signal, plan, got, spend, bestName: bestW && pastMins.length < 5 ? bestW.name : null };
}

function trackChart(a) {
  const pts = a.days.filter((x) => x.med != null || x.min != null || x.wmed != null);
  if (pts.length < 2) return `<div class="chart-empty">기록이 쌓이면 그래프가 나온다 개굴.</div>`;
  const W = 640, H = 170, L = 52, R = 10, T = 12, B = 24;
  const vals = pts.flatMap((x) => [x.med, x.min, x.wmed]).filter((v) => v != null).concat([a.p25, a.p75].filter((v) => v != null));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo === hi) { lo *= 0.9; hi *= 1.1; }
  const x = (i) => L + (i * (W - L - R)) / Math.max(1, pts.length - 1);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const line = (key) => { let d = "", prev = false; pts.forEach((p, i) => { if (p[key] == null) { prev = false; return; } d += `${prev ? "L" : "M"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`; prev = true; }); return d; };
  const band = a.p25 != null ? `<rect x="${L}" y="${y(a.p75)}" width="${W - L - R}" height="${Math.max(1, y(a.p25) - y(a.p75))}" class="band"><title>보통 가격대 (하위 25% ~ 상위 25%)</title></rect>` : "";
  const grid = [lo, (lo + hi) / 2, hi].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 3}" class="axis" text-anchor="end">${gil(v)}</text>`).join("");
  const labels = pts.map((p, i) => (i === 0 || i === pts.length - 1 || i === Math.floor(pts.length / 2)) ? `<text x="${x(i)}" y="${H - 6}" class="axis" text-anchor="middle">${esc(p.date)}</text>` : "").join("");
  const dots = pts.map((p, i) => p.med != null ? `<circle cx="${x(i)}" cy="${y(p.med)}" r="3" class="dot"><title>${esc(p.date)} 판매 중앙값 ${gil(p.med)}길 · ${p.units}개 팔림</title></circle>` : "").join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart track-chart">${band}${grid}${labels}<path d="${line("min")}" class="line-min"/>${a.bestName ? `<path d="${line("wmed")}" class="line-w"/>` : ""}<path d="${line("med")}" class="line"/>${dots}</svg>
    <div class="legend"><span><i class="sw sw-med"></i>한국 전체 판매 중앙값</span>${a.bestName ? `<span><i class="sw sw-w"></i>${esc(a.bestName)} 판매 중앙값</span>` : ""}
      <span><i class="sw sw-min"></i>그날 최저 매물</span>${a.p25 != null ? `<span><i class="sw sw-band"></i>보통 가격대 (판단 기준)</span>` : ""}</div>`;
}

function trackCard(t, name, d) {
  if (!d) return `<section class="track-card"><div class="track-head"><h2>${esc(name || `#${t.id}`)}</h2>
    <button type="button" class="chip-x" data-untrack="${t.id}" title="빼기">✕</button></div><p class="faint">시세 기록이 없다 개굴.</p></section>`;
  const a = analyzeTrack(t.id, d, t.qty);
  const best = a.worlds.filter((w) => w.min != null).sort((x, y) => x.min - y.min)[0];
  const rows = a.worlds.map((w) => `<tr class="${best && w.key === best.key ? "best" : ""}">
      <td>${best && w.key === best.key ? "👑 " : ""}${esc(w.name)}${w.home ? ' <span class="badge nq">내 서버</span>' : ""}</td>
      <td class="num">${w.min == null ? '<span class="dash">-</span>' : `${gil(w.min)} <small class="faint">×${w.minQty}</small>`}</td>
      <td class="num">${w.cnt}</td><td class="num">${gil(w.med7)}</td><td class="num">${w.sold7.toLocaleString("ko-KR")}</td>
      <td class="lots">${w.lst.slice(0, 5).map((l) => `<span class="lot${l[3] ? " bait" : ""}${l[2] ? " hq" : ""}" title="${l[3] ? "미끼 매물 (그 서버 보통 가격의 절반도 안 된다)" : ""}">${gil(l[0])}×${l[1]}${l[2] ? " HQ" : ""}</span>`).join("")}</td></tr>`).join("");
  const plan = Object.entries(a.plan).sort((x, y) => y[1].qty - x[1].qty).map(([w, p]) => `<li><b>${esc(w)}</b> ${p.qty.toLocaleString("ko-KR")}개 <span class="faint">(평균 ${gil(p.spend / p.qty)}길 · 매물 ${p.lots}개)</span></li>`).join("");
  return `<section class="track-card">
    <div class="track-head">
      <h2>${esc(name)}</h2>
      <span class="signal ${a.signal.kind}">${a.signal.icon} ${a.signal.label}</span>
      <span class="faint">데이터 ${ago(d.upd)}</span>
      <button type="button" class="chip-x" data-untrack="${t.id}" title="빼기">✕</button>
    </div>
    <p class="signal-text">${esc(a.signal.text)}${a.signal.trend ? ` ${esc(a.signal.trend)}` : ""}</p>
    <div class="track-grid">
      <div>
        <div class="ev-cap">가격 추이 (${a.days.length}일)</div>
        ${trackChart(a)}
      </div>
      <div class="buy-plan">
        <div class="ev-cap">🛒 구매 계획</div>
        <label class="field"><span>필요 수량</span><input type="number" min="1" max="99999" value="${t.qty}" data-track-qty="${t.id}"></label>
        ${a.got ? `<div class="plan-total"><b>${gil(a.spend)}</b>길 <span class="faint">(개당 평균 ${gil(a.spend / a.got)}길${a.got < t.qty ? ` · 지금 매물로는 ${a.got}개까지만` : ""})</span></div>
          <ul class="plan-list">${plan}</ul>` : `<p class="faint">살 수 있는 매물이 없다 개굴.</p>`}
      </div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>서버</th><th class="num">최저 매물</th><th class="num">매물 수</th><th class="num">7일 판매 중앙값</th><th class="num">7일 판매량</th><th>싼 매물 (가격×수량)</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
  </section>`;
}

async function renderTrack() {
  const app = document.getElementById("app");
  if (!trackNames) {
    app.innerHTML = `<div class="boot">🐸 재료 목록 불러오는 중이다 개굴…</div>`;
    try { trackNames = new Map(await getJSON("data/track/items.json")); } catch (e) {
      app.innerHTML = `<div class="boot">⚠ 트래킹 데이터를 못 받아왔다 개굴. (${esc(e.message)})</div>`; return;
    }
  }
  const list = tracked();
  const datas = await Promise.all(list.map((t) => trackShard(t.id).then((sh) => sh[t.id]).catch(() => null)));
  const q = trackQuery.replace(/\s/g, "");
  const sugg = q ? [...trackNames].filter(([, n]) => n.replace(/\s/g, "").includes(q)).slice(0, 12) : [];
  const keep = app.querySelector("#track-search");
  const caret = keep && document.activeElement === keep ? keep.selectionStart : null;
  app.innerHTML = `<section class="track">
    <div class="eyebrow">MATERIAL TRACKER</div><h1>📈 재료 트래킹</h1>
    <div class="track-add">
      <input id="track-search" type="search" placeholder="🔍 재료 이름으로 추가 (예: 안개비단, 다마스쿠스 주괴)" autocomplete="off" value="${esc(trackQuery)}">
      ${sugg.length ? `<div class="track-sugg">${sugg.map(([id, n]) => `<button type="button" data-track-add="${id}"${list.some((t) => t.id === id) ? " disabled" : ""}>${esc(n)}${list.some((t) => t.id === id) ? " ✓" : ""}</button>`).join("")}</div>`
        : q ? `<div class="track-sugg"><span class="faint">그런 이름은 없다 개굴.</span></div>` : ""}
    </div>
    ${list.length ? list.map((t, i) => trackCard(t, trackNames.get(t.id), datas[i])).join("") : `<div class="detail-hint">🐸 위에서 재료를 검색해서 추가해라 개굴.</div>`}
  </section>`;
  if (caret != null) { const el = app.querySelector("#track-search"); el.focus(); el.setSelectionRange(caret, caret); }
}

document.getElementById("app").addEventListener("input", (e) => {
  if (e.target.id !== "track-search") return;
  trackQuery = e.target.value;
  clearTimeout(window.__trackTimer);
  window.__trackTimer = setTimeout(renderTrack, 200);
});
document.getElementById("app").addEventListener("change", (e) => {
  const q = e.target.closest("[data-track-qty]");
  if (!q) return;
  const list = tracked(), t = list.find((x) => x.id === Number(q.dataset.trackQty));
  if (t) { t.qty = Math.max(1, Math.round(Number(q.value) || 1)); saveTracked(list); renderTrack(); }
});
document.getElementById("app").addEventListener("click", (e) => {
  const add = e.target.closest("[data-track-add]");
  if (add) {
    const list = tracked(), id = Number(add.dataset.trackAdd);
    if (!list.some((t) => t.id === id)) list.unshift({ id, qty: 99 });
    saveTracked(list); trackQuery = ""; renderTrack(); return;
  }
  const rm = e.target.closest("[data-untrack]");
  if (rm) { saveTracked(tracked().filter((t) => t.id !== Number(rm.dataset.untrack))); renderTrack(); }
});

// ── 🔑 권한 관리 (관리자만) ──
const fmtMs = (ms) => (ms ? fmtTime(ms / 1000) : "-");
async function adminList() {
  const res = await fetch("/__admin/list", { cache: "no-store" });
  const data = await res.json().catch(() => ({ error: `응답이 이상하다 개굴 (${res.status})` }));
  if (!res.ok && !data.error) data.error = `못 불러왔다 개굴 (${res.status})`;
  return data;
}
async function refreshPending() {
  if (!adminUI()) return;
  try {
    const d = await adminList();
    const n = (d.items || []).filter((x) => x.status === "pending").length;
    if (n !== adminPending) { adminPending = n; renderSide(); }
  } catch { /* 관리 메뉴 숫자만 못 띄운다 */ }
}
async function renderAdmin() {
  const app = document.getElementById("app");
  app.innerHTML = `<section class="admin"><div class="eyebrow">ACCESS</div><h1>🔑 권한 관리</h1><p class="faint">불러오는 중이다 개굴…</p></section>`;
  const d = await adminList();
  const items = d.items || [];
  adminPending = items.filter((x) => x.status === "pending").length;
  renderSide();
  const group = (status, title, empty, buttons) => {
    const rs = items.filter((x) => x.status === status).sort((a, b) => (b.requestedAt || 0) - (a.requestedAt || 0));
    const body = rs.length ? rs.map((x) => `<tr><td><b>${esc(x.who)}</b></td><td>${esc(x.note || "")}</td>
        <td class="num">${fmtMs(x.requestedAt)}</td><td class="num">${fmtMs(x.decidedAt)}</td>
        <td class="admin-btns">${buttons.map(([act, label, cls]) => `<button type="button" class="cart-btn ${cls}" data-decide="${act}" data-who="${esc(x.who)}">${label}</button>`).join("")}</td></tr>`).join("")
      : `<tr><td colspan="5" class="faint">${empty}</td></tr>`;
    return `<div class="admin-group"><h2>${title} <span class="cnt">${rs.length}</span></h2>
      <div class="table-wrap"><table><thead><tr><th>캐릭터</th><th>한마디</th><th class="num">신청</th><th class="num">처리</th><th></th></tr></thead>
      <tbody>${body}</tbody></table></div></div>`;
  };
  app.innerHTML = `<section class="admin">
    <div class="eyebrow">ACCESS</div><h1>🔑 권한 관리</h1>
    <p class="desc">신청한 캐릭터를 허락하면 공용 비밀번호로 들어올 수 있다 개굴. 내보내면 1분 안에 막힌다 개굴.</p>
    ${d.error ? `<div class="notice error"><span>⚠</span><span>${esc(d.error)}</span></div>` : ""}
    ${group("pending", "⏳ 허락 대기", "기다리는 신청이 없다 개굴.", [["approve", "허락", "primary"], ["deny", "거절", ""]])}
    ${group("approved", "✅ 허락됨", "아직 허락한 캐릭터가 없다 개굴.", [["remove", "내보내기", ""]])}
    ${group("denied", "🚫 거절됨", "거절한 신청이 없다 개굴.", [["approve", "허락", ""], ["remove", "지우기", ""]])}
    <p class="faint">관리자: ${esc((d.admins || []).join(", ") || "-")}${(d.preset || []).length ? ` · 설정으로 바로 허락: ${esc(d.preset.join(", "))}` : ""}</p>
  </section>`;
}
document.getElementById("app").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-decide]");
  if (!b) return;
  const action = b.dataset.decide, whoName = b.dataset.who;
  if (action === "remove" && !window.confirm(`${whoName} 내보내도 되나 개굴?`)) return;
  b.disabled = true;
  const res = await fetch("/__admin/decide", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ who: whoName, action }) });
  if (!res.ok) window.alert((await res.json().catch(() => ({}))).error || "처리 못 했다 개굴");
  renderAdmin();
});

// ── 사이드바 ──
function num(label, path, min, max, step = 1, help = "") {
  const v = path.split(".").reduce((o, k) => o[k], S);
  return `<label class="field"${help ? ` title="${esc(help)}"` : ""}><span>${esc(label)}</span>
    <input type="number" data-path="${path}" min="${min}" max="${max}" step="${step}" value="${v}"></label>`;
}
function seg(path, options, value) {
  return `<div class="seg" data-seg="${path}">${options.map((o) => `<button type="button" class="${o === value ? "on" : ""}" data-val="${esc(o)}">${esc(o)}</button>`).join("")}</div>`;
}
function sideHead(p) {
  return `
    <nav class="nav">
      <a href="#craft" class="${p === "craft" ? "on" : ""}">⚒️ 제작</a>
      <a href="#gather" class="${p === "gather" ? "on" : ""}">⛏️ 채집</a>
      <a href="#track" class="${p === "track" ? "on" : ""}">📈 재료 트래킹</a>
    </nav>
    <div class="brand"><button type="button" class="side-fold" data-fold="1" title="사이드바 접기" aria-label="사이드바 접기">«</button><span class="brand-frog">🐸</span><span class="brand-name">에오르제아에서 장사꾼으로 살아남기</span></div>
    ${who() ? `<div class="sb-who">🐸 <b>${esc(who())}</b> 왔다 개굴 <a href="/__logout">나가기</a></div>` : ""}
    ${seg("theme", Object.keys(THEMES), S.theme)}
    <div class="palette">${Object.entries(PALETTES).map(([k, v]) => `<button type="button" class="dot dot-${v}${S.palette === k ? " on" : ""}" data-pal="${esc(k)}" title="${esc(k)}"></button>`).join("")}</div>`;
}

// 🔑 권한 관리 (관리자만, 사이드바 맨 아래)
function adminLink(p) {
  if (!adminUI()) return "";
  return `<div class="sb-title">관리</div>
    <nav class="nav nav-admin"><a href="#admin" class="${p === "admin" ? "on" : ""}">🔑 권한 관리${adminPending ? ` <span class="nav-cnt">${adminPending}</span>` : ""}</a></nav>`;
}

function renderSide() {
  const p = page(), side = document.getElementById("side");
  if (p === "admin") { side.innerHTML = sideHead(p) + adminLink(p); return; }
  if (p === "track") {
    side.innerHTML = sideHead(p) + `
      <div class="sb-note">마지막 갱신: ${fmtTime(meta.updatedAt)} (${ago(meta.updatedAt)})<br>매시간 알아서 갱신된다 개굴</div>
      <p class="hint">관심 재료를 등록해 두면 서버별 최저가, 살 때인지 기다릴 때인지, 어디서 몇 개 사면 제일 싼지 알려준다 개굴.
      가격 기록은 매일 쌓여서 최대 ${60}일까지 본다 개굴.</p>
      <p class="hint">🟢 지금 살 때 · 🟡 보통 · 🔴 기다려라 — 지금 최저가를 지난날 최저 매물이랑 비교한다 개굴.
      기록이 아직 적으면 제일 싼 서버의 평소 판매가랑 비교한다 개굴 (서버마다 시세가 달라서).</p>
      ${adminLink(p)}`;
    return;
  }
  const F = S[p];
  const jobs = p === "craft" ? meta.jobs : meta.gatherJobs;
  const sortNames = p === "craft" ? { net: "순수익", margin: "수익률", daily: "하루 잠재 이익" } : { daily: "하루 잠재 이익", net: "개당 순수익" };
  const cities = ["min", ...Object.keys(meta.taxCities)];
  side.innerHTML = `${sideHead(p)}
    <div class="sb-note">마지막 갱신: ${fmtTime(meta.updatedAt)} (${ago(meta.updatedAt)})<br>매시간 알아서 갱신된다 개굴</div>
    <button type="button" class="btn" data-reload="1">🔄 새 데이터 불러오기</button>

    <div class="sb-title">분석 대상</div>
    <div class="row2">${num(`${p === "craft" ? "레시피" : "채집"} 레벨 ≥`, `${p}.levelMin`, 1, 100)}${num("≤", `${p}.levelMax`, 1, 100)}</div>
    <details class="jobs"${p === "gather" ? " open" : ""}><summary>직업별 레벨 · ${jobs.length}개 직업</summary>
      <p class="hint">이 레벨보다 높은 ${p === "craft" ? "레시피" : "채집템"}는 뺀다 개굴.</p>
      <div class="row2 wrap">${jobs.map((j) => num(j, `${p}.jobLevels.${j}`, 1, 100)).join("")}</div>
    </details>

    <div class="sb-title">필터</div>
    <label class="field"><span>판매 품질</span></label>
    ${seg("quality", Object.keys(QUALITY_KEY), S.quality)}
    <p class="hint">${{ NQ: "모든 템을 NQ 로 팔 때 순위다 개굴.", HQ: "HQ 로 만들 수 있는 템만, HQ 로 팔 때 순위다 개굴. 가구처럼 HQ 가 없는 템은 빠진다 개굴.", "통합": "NQ 로 팔 때랑 HQ 로 팔 때를 한 순위에 같이 놓는다 개굴. HQ 줄은 이름 끝에 HQ 마크가 붙는다 개굴." }[S.quality]}</p>
    ${num(`${PERIOD()} 판매 건수 ≥`, `${p}.minSales`, 0, 999)}
    ${p === "craft" ? num("재료 판매 수량 배수 ≥", "craft.matRatio", 0, 100, 0.5, "재료마다 팔린 수량이 필요한 수량의 몇 배는 돼야 하는지 정한다 개굴. NPC·직접 채집 재료는 안 따진다 개굴.") : ""}
    ${p === "craft" ? num("최소 수익률(%)", "craft.minMargin", -100, 10000, 5) : ""}
    ${num("개당 최소 순수익(길)", `${p}.minProfit`, -1000000, 10000000, p === "craft" ? 500 : 50)}
    ${num("현재 등록 건수 ≤", `${p}.maxListings`, 0, 9999)}
    ${num("예상 판매 소요일 ≤ (0 = 안 따짐)", `${p}.maxDays`, 0, 365, 1, "내 가격 이하 매물이 다 팔리고 내 거까지 팔리는 데 걸리는 날 수. 하루 판매량으로 어림잡은 거라 대충 감만 잡아라 개굴.")}

    <div class="sb-title">정렬</div>
    <label class="field"><span>기본 정렬</span><select data-path="${p}.sort">${Object.entries(sortNames).map(([k, v]) => `<option value="${k}"${F.sort === k ? " selected" : ""}>${v}</option>`).join("")}</select></label>

    <div class="sb-title">판매 설정</div>
    <label class="field"><span>판매 도시(세율)</span><select data-path="taxCity">${cities.map((c) => `<option value="${c}"${S.taxCity === c ? " selected" : ""}>${c === "min" ? "가장 낮은 세율" : esc(meta.taxCities[c])}</option>`).join("")}</select></label>
    <div class="sb-note tax"><span>적용 판매세</span><b>${Math.round(taxRate() * 100)}%</b></div>
    ${num("데이터 오래됨 기준(시간)", "staleHours", 1, 720)}
    <p class="hint">중간재료 직접 제작은 직업 레벨 ${Math.min(...Object.values(meta.jobLevelsForIntermediates))}~${Math.max(...Object.values(meta.jobLevelsForIntermediates))} 기준으로 미리 계산해 뒀다 개굴.</p>

    <button type="button" class="link-btn" data-onboard="1">⚙ 기본 설정 다시 하기</button>

    <div class="sb-title">업데이트 내역</div>
    <details class="changelog-box"><summary>v${esc(meta.changelog[0].version)} · ${esc(meta.changelog[0].date.slice(5))}</summary>
      <div class="changelog">${meta.changelog.map((e) => `<div class="cl-entry"><div class="cl-head"><b>v${esc(e.version)}</b><span>${esc(e.date)}</span></div><ul>${e.changes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div>`).join("")}</div>
    </details>
    ${adminLink(p)}`;
}

function applyTheme() {
  document.documentElement.dataset.theme = THEMES[S.theme] || "light";
  document.documentElement.dataset.palette = PALETTES[S.palette] || "jade";
}
function setPath(path, value) {
  const keys = path.split(".");
  let o = S;
  for (const k of keys.slice(0, -1)) o = o[k];
  o[keys.at(-1)] = value;
  saveSettings();
}

function bindSide() {
  const side = document.getElementById("side");
  side.addEventListener("change", (e) => {
    const el = e.target.closest("[data-path]");
    if (!el) return;
    const v = el.type === "number" ? (el.value === "" ? 0 : Number(el.value)) : el.value;
    setPath(el.dataset.path, v);
    if (el.dataset.path === "taxCity") renderSide();
    render();
  });
  side.addEventListener("click", (e) => {
    const segBtn = e.target.closest("[data-seg] [data-val]");
    if (segBtn) {
      const key = segBtn.closest("[data-seg]").dataset.seg;
      S[key] = segBtn.dataset.val;
      saveSettings();
      if (key === "theme") applyTheme();
      renderSide();
      if (key !== "theme") render();
      return;
    }
    // 색감 버튼 (data-palette 는 <html> 에도 붙어 있어서 이름을 다르게 둔다)
    const dot = e.target.closest("[data-pal]");
    if (dot) { S.palette = dot.dataset.pal; saveSettings(); applyTheme(); renderSide(); return; }
    if (e.target.closest("[data-fold]")) { setFold(true); return; }
    if (e.target.closest("[data-onboard]")) { onboard(); return; }
    if (e.target.closest("[data-reload]")) { Object.keys(datasets).forEach((k) => delete datasets[k]); start(); }
  });
  document.getElementById("side-toggle").addEventListener("click", () => {
    if (wide()) setFold(false);
    else document.body.classList.toggle("side-open");
  });
  if (wide() && load("ffxivSideFolded", false)) document.body.classList.add("side-folded");
}
// 사이드바 접기: 넓은 화면은 접은 상태를 기억하고, 폰은 원래처럼 열고 닫기만 한다
const wide = () => window.matchMedia("(min-width: 901px)").matches;
function setFold(folded) {
  if (!wide()) { document.body.classList.remove("side-open"); return; }
  document.body.classList.toggle("side-folded", folded);
  save("ffxivSideFolded", folded);
}

// ⚙ 처음 설정: 권한 받고 처음 들어온 캐릭터(이 기기·서버 둘 다 설정이 없을 때)한테 한 번 보여준다
function onboard() {
  const O = JSON.parse(JSON.stringify(S));
  const box = document.createElement("div");
  box.className = "onboard";
  const get = (path) => path.split(".").reduce((o, k) => o[k], O);
  const set = (path, v) => { const k = path.split("."); k.slice(0, -1).reduce((o, x) => o[x], O)[k.at(-1)] = v; };
  const n = (label, path, min, max, step = 1) => `<label class="field"><span>${esc(label)}</span>
    <input type="number" data-o="${path}" min="${min}" max="${max}" step="${step}" value="${get(path)}"></label>`;
  const all = (p) => { const v = Object.values(O[p].jobLevels); return v.every((x) => x === v[0]) ? v[0] : ""; };
  const jobsBlock = (p, jobs, title) => `
    <div class="ob-sec"><div class="ob-title">${title}</div>
      <div class="row2">${n(`${p === "craft" ? "레시피" : "채집"} 레벨 ≥`, `${p}.levelMin`, 1, 100)}${n("≤", `${p}.levelMax`, 1, 100)}</div>
      <label class="field ob-all"><span>${p === "craft" ? "제작" : "채집"} 직업 레벨 한 번에</span>
        <input type="number" data-all="${p}" min="1" max="100" value="${all(p)}" placeholder="직업마다 다르다"></label>
      <div class="ob-jobs">${jobs.map((j) => n(j, `${p}.jobLevels.${j}`, 1, 100)).join("")}</div>
    </div>`;
  const draw = () => {
    box.innerHTML = `<div class="ob-card" role="dialog" aria-modal="true" aria-label="기본 설정">
      <div class="ob-head"><span class="brand-frog">🐸</span><div><b>어서 와라 개굴!</b>
        <p class="hint">처음이니까 기본 설정부터 정하자 개굴. 직업 레벨보다 높은 레시피·채집템은 순위에서 뺀다 개굴.
        여기서 정한 건 이 캐릭터에 저장돼서 다른 기기에서도 따라온다 개굴. 나중에 사이드바에서 언제든 바꿀 수 있다 개굴.</p></div></div>
      <div class="ob-sec"><div class="ob-title">판매 품질</div>
        <div class="seg">${Object.keys(QUALITY_KEY).map((q) => `<button type="button" class="${O.quality === q ? "on" : ""}" data-oq="${esc(q)}">${esc(q)}</button>`).join("")}</div>
        <p class="hint">통합은 NQ·HQ 로 팔 때를 한 순위에 같이 보여준다 개굴.</p></div>
      ${jobsBlock("craft", meta.jobs, "⚒️ 제작")}
      ${jobsBlock("gather", meta.gatherJobs, "⛏️ 채집")}
      <div class="ob-sec"><div class="ob-title">제작 필터</div>
        <div class="row2">${n("최소 수익률(%)", "craft.minMargin", -100, 10000, 5)}${n("개당 최소 순수익(길)", "craft.minProfit", -1000000, 10000000, 500)}
        ${n("현재 등록 건수 ≤", "craft.maxListings", 0, 9999)}${n("예상 판매 소요일 ≤", "craft.maxDays", 0, 365)}</div></div>
      <div class="ob-foot">
        <button type="button" class="btn-ghost" data-ob="default">기본값으로 시작</button>
        <button type="button" class="btn" data-ob="ok">🐸 이대로 시작</button>
      </div></div>`;
  };
  draw();
  box.addEventListener("change", (e) => {
    const el = e.target;
    const v = el.value === "" ? null : Number(el.value);
    // 다시 그리면 입력 칸 포커스가 날아가니까 값만 바꿔 준다
    if (el.dataset.all && v !== null) {
      const p = el.dataset.all;
      for (const j in O[p].jobLevels) O[p].jobLevels[j] = v;
      box.querySelectorAll(`[data-o^="${p}.jobLevels."]`).forEach((x) => { x.value = v; });
      return;
    }
    if (el.dataset.o && v !== null) {
      set(el.dataset.o, v);
      const p = el.dataset.o.split(".")[0];
      if (el.dataset.o.includes(".jobLevels.")) box.querySelector(`[data-all="${p}"]`).value = all(p);
    }
  });
  box.addEventListener("click", (e) => {
    const q = e.target.closest("[data-oq]");
    if (q) { O.quality = q.dataset.oq; draw(); return; }
    const b = e.target.closest("[data-ob]");
    if (!b) return;
    if (b.dataset.ob === "default") {
      const d = defaults();
      S = { ...d, theme: S.theme, palette: S.palette, v: SETTINGS_VERSION };
    } else S = O;
    saveSettings();
    box.remove();
    renderSide();
    render();
  });
  document.body.appendChild(box);
}

function frogRain() {
  if (sessionStorage.getItem("frogs")) return;
  try { sessionStorage.setItem("frogs", "1"); } catch { /* 괜찮다 */ }
  const rain = document.createElement("div");
  rain.className = "frog-rain";
  for (let i = 0; i < 28; i++) {
    const f = document.createElement("span");
    f.textContent = "🐸";
    f.style.left = Math.random() * 97 + "vw";
    f.style.fontSize = 1.2 + Math.random() * 1.6 + "rem";
    f.style.animationDelay = Math.random() * 1.8 + "s";
    f.style.animationDuration = 2.2 + Math.random() * 1.6 + "s";
    f.style.setProperty("--spin", (Math.random() < 0.5 ? -1 : 1) * (90 + Math.random() * 450) + "deg");
    f.style.setProperty("--drift", Math.random() * 16 - 8 + "vw");
    rain.appendChild(f);
  }
  document.body.appendChild(rain);
  setTimeout(() => rain.remove(), 6000);
}

async function start() {
  try { meta = await getJSON("data/meta.json"); } catch (e) {
    document.getElementById("app").innerHTML = `<div class="boot">⚠ 데이터를 못 받아왔다 개굴. 조금 있다가 새로고침 해 봐라 개굴. (${esc(e.message)})</div>`;
    return;
  }
  let first = false;
  if (!S) {
    if (load("ffxivSettings", null) === null) {
      const remote = await remoteSettings();
      if (remote) save("ffxivSettings", remote);
      else first = true;
    }
    S = loadSettings();
  }
  applyTheme();
  renderSide();
  if (first) onboard();
  await render();
  refreshPending();
}

window.addEventListener("hashchange", () => {
  query = "";
  document.getElementById("app").innerHTML = "";
  document.body.classList.remove("side-open");
  renderSide();
  render();
});
bindSide();
frogRain();
start();

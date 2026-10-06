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
function loadSettings() {
  const d = defaults(), s = load("ffxivSettings", {});
  return { ...d, ...s, craft: { ...d.craft, ...(s.craft || {}), jobLevels: { ...d.craft.jobLevels, ...((s.craft || {}).jobLevels || {}) } },
    gather: { ...d.gather, ...(s.gather || {}), jobLevels: { ...d.gather.jobLevels, ...((s.gather || {}).jobLevels || {}) } } };
}

// 로그인한 캐릭터 (Cloudflare 문지기가 넣어 준 쿠키, 없으면 빈칸)
function who() {
  const m = document.cookie.match(/(?:^|;\s*)ffx_who=([^;]*)/);
  try { return m ? decodeURIComponent(m[1]) : ""; } catch { return ""; }
}
// 관리자 메뉴를 보여줄지 (화면 표시용일 뿐, 진짜 확인은 Cloudflare 문지기가 한다)
const adminUI = () => /(?:^|;\s*)ffx_admin=1/.test(document.cookie);
const page = () => (location.hash === "#gather" ? "gather" : location.hash === "#admin" && adminUI() ? "admin" : "craft");
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
    failed[c] = { total: rs.length, items: rs.slice(0, MAX_FAILED).map((r) => ({ name: r.name, stars: r.stars, job: r.job, level: r.level, reason: r.raw.reason || "판매 기록이 없다 개굴" })) };
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
    return { name: r.name, stars: r.stars, job: r.job, level: r.level, kind, why, id: kind === "ok" ? r.id : null, net: v.net, sell: v.sell };
  });
  const order = { ok: 0, filtered: 1, nocalc: 2, out: 3 };
  items.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name, "ko"));
  return { query: q, items: items.slice(0, MAX_RESULTS), total: found.length };
}

// ── 그리기 ──
let query = "";
async function render() {
  if (page() === "admin") return renderAdmin();
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
      ${adminUI() ? `<a href="#admin" class="${p === "admin" ? "on" : ""}">🔑 권한 관리${adminPending ? ` <span class="nav-cnt">${adminPending}</span>` : ""}</a>` : ""}
    </nav>
    <div class="brand"><span class="brand-frog">🐸</span><span class="brand-name">제작·채집 수익 분석</span></div>
    ${who() ? `<div class="sb-who">🐸 <b>${esc(who())}</b> 왔다 개굴 <a href="/__logout">나가기</a></div>` : ""}
    ${seg("theme", Object.keys(THEMES), S.theme)}
    <div class="palette">${Object.entries(PALETTES).map(([k, v]) => `<button type="button" class="dot dot-${v}${S.palette === k ? " on" : ""}" data-palette="${esc(k)}" title="${esc(k)}"></button>`).join("")}</div>`;
}

function renderSide() {
  const p = page(), side = document.getElementById("side");
  if (p === "admin") { side.innerHTML = sideHead(p); return; }
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
    ${num(`${PERIOD()} 판매 건수 ≥`, `${p}.minSales`, 0, 999)}
    ${p === "craft" ? num("재료 판매 수량 배수 ≥", "craft.matRatio", 0, 100, 0.5, "재료마다 팔린 수량이 필요한 수량의 몇 배는 돼야 하는지 정한다 개굴. NPC·직접 채집 재료는 안 따진다 개굴.") : ""}
    ${p === "craft" ? num("최소 수익률(%)", "craft.minMargin", -100, 10000, 5) : ""}
    ${num("개당 최소 순수익(길)", `${p}.minProfit`, -1000000, 10000000, p === "craft" ? 500 : 50)}
    ${num("현재 등록 건수 ≤", `${p}.maxListings`, 0, 9999)}
    ${num("예상 판매 소요일 ≤ (0 = 안 따짐)", `${p}.maxDays`, 0, 365, 1, "내 가격 이하 매물이 다 팔리고 내 거까지 팔리는 데 걸리는 날 수. 하루 판매량으로 어림잡은 거라 대충 감만 잡아라 개굴.")}

    <div class="sb-title">정렬</div>
    <label class="field"><span>기본 정렬</span><select data-path="${p}.sort">${Object.entries(sortNames).map(([k, v]) => `<option value="${k}"${F.sort === k ? " selected" : ""}>${v}</option>`).join("")}</select></label>

    <div class="sb-title">판매 설정</div>
    <label class="field" title="HQ 있는 템을 어느 시세로 팔 건지 고른다 개굴. 통합 = 안 가리고 다 섞어서."><span>판매 품질</span></label>
    ${seg("quality", Object.keys(QUALITY_KEY), S.quality)}
    <label class="field"><span>판매 도시(세율)</span><select data-path="taxCity">${cities.map((c) => `<option value="${c}"${S.taxCity === c ? " selected" : ""}>${c === "min" ? "가장 낮은 세율" : esc(meta.taxCities[c])}</option>`).join("")}</select></label>
    <div class="sb-note tax"><span>적용 판매세</span><b>${Math.round(taxRate() * 100)}%</b></div>
    ${num("데이터 오래됨 기준(시간)", "staleHours", 1, 720)}
    <p class="hint">중간재료 직접 제작은 직업 레벨 ${Math.min(...Object.values(meta.jobLevelsForIntermediates))}~${Math.max(...Object.values(meta.jobLevelsForIntermediates))} 기준으로 미리 계산해 뒀다 개굴.</p>

    <div class="sb-title">업데이트 내역</div>
    <details class="changelog-box"><summary>v${esc(meta.changelog[0].version)} · ${esc(meta.changelog[0].date.slice(5))}</summary>
      <div class="changelog">${meta.changelog.map((e) => `<div class="cl-entry"><div class="cl-head"><b>v${esc(e.version)}</b><span>${esc(e.date)}</span></div><ul>${e.changes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div>`).join("")}</div>
    </details>`;
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
  save("ffxivSettings", S);
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
      save("ffxivSettings", S);
      if (key === "theme") applyTheme();
      renderSide();
      if (key !== "theme") render();
      return;
    }
    const dot = e.target.closest("[data-palette]");
    if (dot) { S.palette = dot.dataset.palette; save("ffxivSettings", S); applyTheme(); renderSide(); return; }
    if (e.target.closest("[data-reload]")) { Object.keys(datasets).forEach((k) => delete datasets[k]); start(); }
  });
  document.getElementById("side-toggle").addEventListener("click", () => document.body.classList.toggle("side-open"));
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
  S = S || loadSettings();
  applyTheme();
  renderSide();
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

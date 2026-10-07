// 메인 대시보드: 헤더 · 요약 카드 · 탭 · 순위 표 · 재료 상세 · 계산 불가 목록
// 탭 전환, 정렬, 행 선택은 전부 브라우저에서 처리해서 클릭할 때 페이지가 다시 계산되지 않는다.

const COLUMNS = [
  { key: "pick", label: "🛒" },
  { key: "rank", label: "순위" },
  { key: "name", label: "아이템명", sortable: true },
  { key: "job", label: "직업", sortable: true },
  { key: "level", label: "레시피 레벨", num: true, sortable: true },
  { key: "sell", label: "판매 예상가", num: true, sortable: true },
  { key: "cost", label: "원가", num: true, sortable: true },
  { key: "net", label: "순수익", num: true, sortable: true },
  { key: "margin", label: "수익률(%)", num: true, sortable: true },
  { key: "sales", label: "{period} 판매 건수", num: true, sortable: true },
  { key: "listings", label: "현재 매물 수", num: true, sortable: true },
  { key: "sellDays", label: "판매 소요", num: true, sortable: true, asc: true },
  { key: "daily", label: "하루 잠재 이익", num: true, sortable: true },
  { key: "updated", label: "데이터 업데이트", sortable: true },
  { key: "etc", label: "기타" },
  { key: "log", label: "📒", tip: "📒 를 누르면 장보기 없이 오늘 제작일지에 1회 적힌다 개굴. 여러 번 누르면 그만큼 적힌다 개굴" }, // 제작일지에 바로 적기 (제작 페이지만)
];

const SOURCE_CLASS = { "거래소": "src-market", "NPC": "src-npc", "직접 제작": "src-craft", "직접 채집": "src-gather", "교환": "src-gather" };

// 탭·정렬·선택 상태는 다시 그려져도 유지되게 페이지에 보관
const state = (window.__ffxivDash = window.__ffxivDash || { server: "dc", cat: "all", tab: "all", sort: null, dir: -1, selected: null, sortSeed: null,
  cart: loadJSON("ffxivCart", {}), done: loadJSON("ffxivCartDone", {}), saved: loadJSON("ffxivSavedCarts", []) });

state.done = state.done || loadJSON("ffxivCartDone", {});
state.saved = state.saved || loadJSON("ffxivSavedCarts", []);
state.qty = state.qty || loadJSON("ffxivCartQty", {}); // 장보기에서 직접 고친 살 수량 {"서버|재료": 개수}

// 장보기에 담은 것 {레시피ID: 제작 횟수}, 산 재료 체크 {"서버|재료": true}, 저장해 둔 목록 — 브라우저에 기억해 둔다
function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch { return fallback; }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 저장 못 해도 화면은 그대로 */ }
}
function saveCart() {
  saveJSON("ffxivCart", state.cart);
  saveJSON("ffxivCartDone", state.done);
  saveJSON("ffxivCartQty", state.qty);
}
function nowText() {
  const t = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
}
function fmtDays(v) {
  if (v == null) return '<span class="dash">-</span>';
  if (v < 1) return '<span class="days fast">하루 안</span>';
  const d = Math.ceil(v);
  return `<span class="days${d > 14 ? " slow" : ""}">~${d}일</span>`;
}
const CAT_ICON = { all: "✦", "가구": "🪑", "장비": "⚔", "재료": "🧱", "소모품": "🍲", "기타": "✨", "일반": "⚒" };
const SUB_ICON = { "무기": "🗡", "방어구": "🛡", "액세서리": "💍", "도구": "🔨" };
// 채집 페이지는 재료비가 없어서 원가·수익률·장보기 칸을 뺀다
const isGather = (d) => d.mode === "gather";
// 교환 페이지: 직업 칸 = 화폐, 레벨 칸 = 교환가, 수익률 대신 화폐 1개당 이익
const isExchange = (d) => d.mode === "exchange";
// 교환 재료로 만들기: 화폐 · 교환 재료 · 드는 화폐 칸, 원가는 나머지 재료비
const isExCraft = (d) => d.mode === "exchangeCraft";
const hasCart = (d) => !d.mode || d.mode === "craft";
function columns(d) {
  if (isExCraft(d)) {
    const pick = (k) => COLUMNS.find((c) => c.key === k);
    return [pick("rank"), pick("name"), { ...pick("job"), label: "화폐" }, { key: "mat", label: "교환 재료", sortable: true },
      { key: "spend", label: "드는 화폐", num: true, sortable: true, asc: true }, pick("sell"), { ...pick("cost"), label: "나머지 재료비" },
      pick("net"), { key: "perCur", label: "화폐 1개당", num: true, sortable: true }, pick("sales"), pick("listings"), pick("sellDays"),
      pick("daily"), pick("updated"), pick("etc")];
  }
  if (isExchange(d)) {
    return COLUMNS.filter((c) => !["pick", "cost", "log"].includes(c.key)).map((c) => (
      c.key === "job" ? { ...c, label: "화폐" } : c.key === "level" ? { ...c, label: "교환가" }
        : c.key === "net" ? { ...c, label: "개당 순수익" } : c.key === "margin" ? { key: "perCur", label: "화폐 1개당", num: true, sortable: true } : c));
  }
  if (!isGather(d)) return d.logCraft ? COLUMNS : COLUMNS.filter((c) => c.key !== "log");
  return COLUMNS.filter((c) => !["pick", "cost", "margin", "log"].includes(c.key))
    .map((c) => (c.key === "level" ? { ...c, label: "채집 레벨" } : c.key === "net" ? { ...c, label: "개당 순수익" } : c));
}

// 지금 고른 서버 보기(통합 또는 서버 하나)의 값
function V(r) {
  return r.views[state.server];
}
// 지금 고른 서버에서 필터 통과했고, 고른 분류(전체/가구/일반)에 해당하는 행만
function catRows(d) {
  return d.rows.filter((r) => V(r).passes && (state.cat === "all" || r.cat === state.cat) && (!state.sub || r.sub === state.sub));
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function gil(v) {
  return v == null ? '<span class="dash">-</span>' : Math.round(v).toLocaleString("ko-KR");
}
function signed(v) {
  const cls = v >= 0 ? "pos" : "neg";
  return `<span class="${cls}">${v >= 0 ? "+" : "−"}${Math.abs(Math.round(v)).toLocaleString("ko-KR")}</span>`;
}
// 파판 HQ 마크 (와이파이 같은 곡선 세 줄)
const HQ_MARK = `<svg class="hq-mark" viewBox="0 0 16 16" aria-label="HQ"><title>HQ (고품질)</title>
  <path d="M3 13a1.6 1.6 0 1 0 .01 0Z"/><path d="M2 8.5a5.5 5.5 0 0 1 5.5 5.5" fill="none"/><path d="M2 4a10 10 0 0 1 10 10" fill="none"/></svg>`;
// 언제든 캘 수 있는 채집물(시간 한정 아님): ⛏ 광부 / 🌿 원예가 — 직접 캐면 재료비가 안 들어서 처음 장사할 때 좋다
function gatherMarks(jobs, lv) {
  if (!jobs) return "";
  return jobs.split("·").map((j) => ` <span class="gather-mark ${j === "광부" ? "mine" : "botany"}" data-tip="${esc(j)} Lv${lv} 로 언제든 캘 수 있다 개굴. 직접 캐면 재료비가 안 든다 개굴">${j === "광부" ? "⛏" : "🌿"}</span>`).join("");
}
// 몇 차 제작인지: 1차 = 캐거나 산 재료로 바로 만드는 것, 2차 = 만든 걸 또 넣어 만드는 것
function tierMark(t) {
  if (!t) return "";
  const tip = t === 1 ? "1차 제작: 캔 재료로 바로 만든다 개굴" : `${t}차 제작: 만든 재료를 또 넣는다 개굴`;
  return ` <span class="tier-mark t${Math.min(t, 3)}" data-tip="${esc(tip)}">${t}차</span>`;
}
function itemName(name, stars, hq) {
  return (stars ? `<span class="stars">${"★".repeat(stars)}</span>` : "") + `<span class="item">${esc(name)}</span>` + (hq ? HQ_MARK : "");
}

function renderHeader(d) {
  const sub = d.subtitle.map((s) => `<span>${esc(s)}</span>`).join("");
  const stats = d.stats[state.server][state.cat];
  const L = d.statLabels || [["분석한 레시피", "조건에 맞는 전체 레시피"], ["계산 가능", "시세 데이터가 모두 있는 레시피"],
    ["필터 통과", "현재 필터 기준 추천 대상"]];
  const stat = (label, value, sub, accent) => `
    <div class="stat${accent ? " accent" : ""}">
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value">${value.toLocaleString("ko-KR")}<small>개</small></div>
      <div class="stat-sub">${esc(sub)}</div>
    </div>`;
  return `
    <header class="page-head">
      <div class="eyebrow">${isExchange(d) || isExCraft(d) ? "EXCHANGE" : isGather(d) ? "GATHERING" : "CRAFTING"} PROFIT REPORT</div>
      <h1>${esc(d.title || "파판14 제작 수익 분석")}<button type="button" class="frog-peek" data-frogs="1" title="눌러 봐라 개굴">🐸</button></h1>
      ${d.tagline ? `<p class="tagline">${esc(d.tagline)}</p>` : ""}
      <div class="subtitle">${sub}</div>
    </header>
    ${renderServers(d)}
    ${renderCats(d)}
    <div class="stats">
      ${stat(L[0][0], stats.total, L[0][1])}
      ${stat(L[1][0], stats.calculable, L[1][1])}
      ${stat(L[2][0], stats.passed, L[2][1], true)}
    </div>`;
}

function renderServers(d) {
  const btn = (s) =>
    `<button class="cat server${state.server === s.key ? " active" : ""}" data-server="${esc(s.key)}">${s.key === "dc" ? "🌏 " : s.home ? "🏠 " : ""}${esc(s.name)}` +
    `${s.home ? '<small class="home">내 서버</small>' : ""}<span class="cnt">${d.stats[s.key].all.passed}</span></button>`;
  return `<div class="cats servers">${d.servers.map(btn).join("")}</div>`;
}

function serverName(d) {
  return (d.servers.find((s) => s.key === state.server) || { name: "통합" }).name;
}

function renderCats(d) {
  const btn = (key) =>
    `<button class="cat${state.cat === key ? " active" : ""}" data-cat="${esc(key)}">${(d.catIcons || CAT_ICON)[key] || ""} ${esc(d.cats[key])}` +
    `<span class="cnt">${d.stats[state.server][key].passed}</span></button>`;
  return `<div class="cats">${Object.keys(d.cats).map(btn).join("")}</div>${renderSubs(d)}`;
}

// 장비처럼 세부 분류가 있으면 한 줄 더: [장비 전체 | 무기 | 방어구 | …]
function renderSubs(d) {
  const subs = (d.subs || {})[state.cat];
  if (!subs || !subs.length) return "";
  const pool = d.rows.filter((r) => V(r).passes && r.cat === state.cat);
  const btn = (key, label) =>
    `<button class="cat sub${(state.sub || "") === key ? " active" : ""}" data-sub="${esc(key)}">${label}` +
    `<span class="cnt">${key ? pool.filter((r) => r.sub === key).length : pool.length}</span></button>`;
  const hint = state.cat === "장비" && d.quality === "NQ"
    ? `<span class="sub-hint">장비는 거의 HQ 로 팔린다 개굴. 사이드바 판매 품질을 HQ 나 통합으로 바꾸면 더 많이 보인다 개굴.</span>` : "";
  return `<div class="subs-row"><div class="cats subs">${btn("", `${CAT_ICON[state.cat] || ""} ${esc(state.cat)} 전체`)}${subs.map((x) => btn(x, `${SUB_ICON[x] || ""} ${esc(x)}`)).join("")}</div>${hint}</div>`;
}

// 교환 페이지는 화폐가 너무 많아서, 지금 분류에 순위가 있는 화폐만 탭으로 (많은 순)
function tabJobs(d) {
  if (!d.dynamicTabs) return d.jobs;
  const counts = {};
  catRows(d).forEach((r) => (counts[r.job] = (counts[r.job] || 0) + 1));
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b, "ko"));
}
function renderTabs(d) {
  const counts = {};
  const rows = catRows(d);
  rows.forEach((r) => (counts[r.job] = (counts[r.job] || 0) + 1));
  const tab = (key, label) =>
    `<button class="tab${state.tab === key ? " active" : ""}" data-tab="${esc(key)}">${label}<span class="cnt">${
      key === "all" ? rows.length : counts[key] || 0
    }</span></button>`;
  return `<nav class="tabs${d.dynamicTabs ? " wrap" : ""}">${tab("all", "🏆 통합 순위")}${tabJobs(d).map((j) => tab(j, esc(j))).join("")}</nav>`;
}

function sortedRows(d) {
  const rows = catRows(d).filter((r) => state.tab === "all" || r.job === state.tab);
  const key = state.sort;
  return rows.slice().sort((a, b) => {
    const val = (r) => (key in V(r) ? V(r)[key] : r[key]);
    const x = val(a), y = val(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === "string") return x.localeCompare(y, "ko") * -state.dir;
    return (x - y) * state.dir;
  });
}

function renderTable(d, rows) {
  const cols = columns(d);
  const head = cols.map((c) => {
    const cls = [`col-${c.key}`, c.num ? "num" : "", c.sortable ? "sortable" : "", state.sort === c.key ? "sorted" : "", state.sort === c.key && state.dir > 0 ? "asc" : ""]
      .filter(Boolean)
      .join(" ");
    return `<th class="${cls}"${c.tip ? ` data-tip="${esc(c.tip)}"` : ""} ${c.sortable ? `data-sort="${c.key}" data-asc="${c.asc ? 1 : 0}"` : ""}>${esc(c.label.replace("{period}", d.period))}</th>`;
  }).join("");

  if (!rows.length) {
    return `<div class="table-wrap"><div class="empty">🐸 필터 통과한 게 하나도 없다 개굴. 왼쪽에서 조건을 조금 풀어 봐라 개굴.</div></div>`;
  }
  const body = rows.map((r, i) => {
    const v = V(r);
    const fc = d.fcSelling ? d.fcSelling(r, state.server) : null; // 🏰 부대원이 이미 올려 둔 템이면 옅은 회색 줄
    const fcTag = fc ? `<span class="fc-tag" data-tip="${esc(fc.tip)}">${esc(fc.text)}</span>` : "";
    const badges = [...r.badges, ...v.badges].map((b) => b.detail
      ? `<button type="button" class="badge ${esc(b.kind)} has-pop" data-pop="${esc(b.detail)}">${esc(b.text)}</button>`
      : `<span class="badge ${esc(b.kind)}${b.tip ? " has-tip" : ""}"${b.tip ? ` data-tip="${esc(b.tip)}"` : ""}>${esc(b.text)}</span>`).join("");
    const cell = {
      pick: `<td><button type="button" class="pick${state.cart[r.id] ? " on" : ""}" data-pick="${r.id}"
          title="${state.cart[r.id] ? "장보기에서 빼기" : "장보기에 담기"}">${state.cart[r.id] ? "✓" : "+"}</button></td>`,
      rank: `<td><span class="rank${i < 3 ? " top" : ""}">${i + 1}</span></td>`,
      name: `<td>${itemName(r.name, r.stars, r.sellingHq === true)}${tierMark(r.tier)}${fcTag}</td>`,
      job: `<td><span class="job">${esc(r.job)}</span></td>`,
      mat: `<td>${esc(r.mat || "")}${r.matQty > 1 ? ` <small class="per">×${r.matQty}</small>` : ""}</td>`,
      spend: `<td class="num">${gil(r.spend)}</td>`,
      level: `<td class="num">${isExchange(d) ? `${r.level.toLocaleString("ko-KR")}${r.resultAmount > 1 ? `<small class="per"> /${r.resultAmount}개</small>` : ""}` : r.level}</td>`,
      sell: `<td class="num">${gil(v.sell)}</td>`,
      cost: `<td class="num">${gil(r.cost)}</td>`,
      net: `<td class="num">${signed(v.net)}</td>`,
      perCur: `<td class="num">${v.perCur == null ? '<span class="dash">-</span>' : `<span class="pct ${v.perCur >= 0 ? "pos" : "neg"}">${v.perCur >= 100 ? gil(v.perCur) : v.perCur.toFixed(1)}</span>`}</td>`,
      margin: `<td class="num">${v.margin == null ? "-" : `<span class="pct ${v.margin >= 0 ? "pos" : "neg"}">${v.margin.toFixed(1)}%</span>`}</td>`,
      sales: `<td class="num">${v.sales}</td>`,
      listings: `<td class="num">${v.listings}</td>`,
      sellDays: `<td class="num">${fmtDays(v.sellDays)}</td>`,
      daily: `<td class="num">${gil(v.daily)}</td>`,
      updated: `<td><span class="upd${r.stale ? " stale" : ""}">${esc(r.updatedText)}</span></td>`,
      etc: `<td><div class="badges">${badges}</div></td>`,
      log: `<td><button type="button" class="log-btn" data-log-row="${r.id}" aria-label="제작일지에 1회 적기">📒</button></td>`,
    };
    return `
      <tr class="clickable${state.selected === r.id ? " selected" : ""}${fc ? " fc-selling" : ""}" data-id="${r.id}">${cols.map((c) => cell[c.key].replace("<td", `<td data-col="${c.key}"`)).join("")}</tr>` +
      // 누른 줄 바로 아래에 상세를 펼친다 (다시 누르면 접힘)
      (state.selected === r.id ? `<tr class="detail-row"><td colspan="${cols.length}"><div class="detail-inline">
        <div class="detail-close"><button type="button" data-close-detail="1">▲ 접기</button></div>${renderDetail(d, r)}</div></td></tr>` : "");
  }).join("");
  return `<div class="table-wrap rank-table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderDetail(d, row) {
  if (!row) return `<div class="detail-hint">🐸 표에서 아이템 하나 눌러 봐라 개굴. ${hasCart(d) ? "재료" : "판매"} 상세가 여기 뜬다 개굴.</div>`;
  if (d.loadDetail && !row.loaded) {
    return `<section class="detail"><div class="detail-card"><div class="detail-top"><div>
      <h2>${itemName(row.name, row.stars, row.sellingHq === true)}</h2><div class="desc">🐸 상세 불러오는 중이다 개굴…</div></div></div></div></section>`;
  }
  const L = row.live, liveMats = L && L.mats, waiting = L && L.loading;
  const body = (row.materials || []).map((m, i) => {
    const lm = liveMats && liveMats[i] && liveMats[i].live ? liveMats[i] : null;
    const ch = lm && m.unit ? ((lm.now - m.unit) / m.unit) * 100 : null;
    const tree = m.depth ? `<span class="tree">${"　".repeat(m.depth - 1)}└</span>` : "";
    const src = `<span class="badge ${SOURCE_CLASS[m.source] || "src-npc"}">${esc(m.source)}</span>`;
    const market = m.source === "거래소";
    return `
      <tr class="${m.depth ? "sub" : ""}">
        <td>${tree}${m.id && d.trackMaterial ? `<button type="button" class="mat-link" data-track-mat="${m.id}" data-need="${m.need}" title="눌러서 재료 트래킹에 담고 보러 간다 개굴">${esc(m.name)}<span class="mat-go">📈</span></button>` : esc(m.name)}${tierMark(m.t)}${gatherMarks(m.g, m.gl)}</td>
        <td class="num">${m.amount}</td>
        <td class="num">${m.need}</td>
        <td class="num">${gil(m.unit)}</td>
        <td class="num live-col">${lm ? `<b>${gil(lm.now)}</b>${lm.live.short ? ' <small class="short">부족</small>' : ""}` : market && waiting ? '<span class="faint">…</span>' : '<span class="dash">-</span>'}</td>
        <td class="num live-col">${ch == null ? '<span class="dash">-</span>' : `<span class="pct ${ch > 5 ? "neg" : ch < -5 ? "pos" : ""}">${ch > 0 ? "+" : ""}${ch.toFixed(0)}%</span>`}</td>
        <td class="num">${gil(m.subtotal)}</td>
        <td>${src}</td>
        <td class="num">${market ? m.sold.toLocaleString("ko-KR") : '<span class="dash">-</span>'}</td>
        <td class="num">${market ? m.listings.toLocaleString("ko-KR") : '<span class="dash">-</span>'}</td>
        <td>${lm ? `⚡ ${esc(lm.live.worlds)}` : m.world ? esc(m.world) : '<span class="dash">-</span>'}</td>
      </tr>`;
  }).join("");
  return `
    <section class="detail">
      <div class="detail-card">
        <div class="detail-top">
          <div>
            <h2>${row.materials ? "📦" : isExchange(d) ? "🪙" : "⛏"} ${itemName(row.name, row.stars, row.sellingHq === true)} — ${row.materials ? "재료 상세" : "판매 상세"}</h2>
            <div class="desc">${esc(row.detailDesc)}</div>
          </div>
          <div class="kv">
            ${row.materials ? `<div><span>원가</span><b>${gil(row.cost)}</b></div>` : ""}
            <div><span>판매 예상가 · ${esc(serverName(d))}</span><b>${gil(V(row).sell)}</b></div>
            <div><span>순수익</span><b>${V(row).net == null ? '<span class="dash">-</span>' : signed(V(row).net)}</b></div>
            ${isExchange(d) || isExCraft(d) ? `<div><span>화폐 1개당</span><b>${V(row).perCur == null ? '<span class="dash">-</span>' : gil(V(row).perCur)}</b></div>` : ""}
          </div>
        </div>
        ${row.sources && row.sources.length ? `<div class="sources"><h3>📍 어디서 바꾸나</h3><ul>${row.sources.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
        ${renderLive(d, row)}
        ${renderInsights(d, row)}
        ${row.materials ? `<div class="table-wrap"><table>
          <thead><tr>
            <th>재료</th><th class="num">1회 제작당 수량</th><th class="num">총 필요 수량</th><th class="num">표 단가</th>
            <th class="num live-col" data-tip="품목을 누를 때 방금 받은 매물로, 필요 수량만큼 싼 것부터 샀을 때 개당 값 (구매세 포함) 개굴">⚡ 지금 단가</th><th class="num live-col">차이</th>
            <th class="num">소계</th><th>구매처</th><th class="num">${esc(d.period)} 판매 수량</th><th class="num">현재 매물 수</th><th>구매 서버</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table></div>` : ""}
      </div>
    </section>`;
}

// ⚡ 방금 받은 시세 (정적 사이트에서 품목을 누르면 그 템만 Universalis 에서 다시 받는다)
function renderLive(d, row) {
  if (!d.loadLive) return "";
  const L = row.live;
  if (!L || L.loading) return `<div class="live"><div class="live-head"><h3>⚡ 지금 시세</h3><span class="faint">방금 시세 받는 중이다 개굴…</span></div></div>`;
  if (L.error) return `<div class="live"><div class="live-head"><h3>⚡ 지금 시세</h3><span class="faint">못 받아왔다 개굴 (${esc(L.error)}). 표 숫자는 매시간 받아 둔 값이다 개굴.</span>
    <button type="button" class="live-retry" data-live-retry="1">다시 받기</button></div></div>`;
  const diff = L.net != null && V(row).net != null ? L.net - V(row).net : null;
  const rows = L.worlds.map((w) => `<tr class="${w.key === "dc" ? "dc" : ""}">
    <td>${esc(w.name)}</td><td class="num">${gil(w.min)}</td><td class="num">${w.listings}</td>
    <td class="num">${gil(w.median)}</td><td class="num">${w.sales}</td>
    <td>${w.last ? `${gil(w.last.price)} ×${w.last.qty} <span class="faint">${esc(w.last.ago)}</span>` : '<span class="dash">-</span>'}</td>
    <td class="faint">${esc(w.uploaded)}</td></tr>`).join("");
  return `<div class="live">
    <div class="live-head"><h3>⚡ 지금 시세 · ${esc(L.time)} 받음</h3>
      <span class="faint">표 숫자는 매시간 받아 둔 값이고, 이건 방금 다시 받은 값이다 개굴. 이상 거래·미끼는 안 뺐다 개굴.</span>
      <button type="button" class="live-retry" data-live-retry="1">다시 받기</button></div>
    <div class="live-kv">
      <div><span>지금 판매 예상가 (${esc(L.period)} 중앙값)</span><b>${gil(L.sell)}</b></div>
      ${L.mats ? `<div><span>지금 재료 원가</span><b>${gil(L.cost)}</b></div>` : ""}
      <div><span>지금 기준 순수익</span><b>${L.net == null ? '<span class="dash">-</span>' : signed(L.net)}</b></div>
      ${diff != null ? `<div><span>표보다</span><b>${signed(diff)}</b></div>` : ""}
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>서버</th><th class="num">지금 최저 매물</th><th class="num">매물 수</th><th class="num">${esc(L.period)} 판매 중앙값</th><th class="num">판매 건수</th><th>마지막 판매</th><th>마지막 업로드</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
  </div>`;
}

// ── 시세 추이 (판매가 선 그래프 + 판매 수량 막대, 축은 각자 하나) ──
function lineChart(days) {
  const W = 320, H = 120, L = 44, R = 8, T = 10, B = 22;
  const pts = days.map((x, i) => ({ ...x, i })).filter((x) => x.median != null);
  if (!pts.length) return `<div class="chart-empty">팔린 기록이 없어서 그래프를 못 그린다 개굴.</div>`;
  let lo = Math.min(...pts.map((p) => p.median)), hi = Math.max(...pts.map((p) => p.median));
  if (lo === hi) { lo *= 0.9; hi *= 1.1; }
  const x = (i) => L + (days.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (days.length - 1));
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  let path = "", prev = null;
  for (const p of pts) { path += `${prev !== null && p.i === prev + 1 ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.median).toFixed(1)}`; prev = p.i; }
  const grid = [lo, (lo + hi) / 2, hi].map((v) =>
    `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 3}" class="axis" text-anchor="end">${Math.round(v).toLocaleString("ko-KR")}</text>`).join("");
  const labels = days.map((dd, i) => (i === 0 || i === days.length - 1 || i === Math.floor(days.length / 2))
    ? `<text x="${x(i)}" y="${H - 6}" class="axis" text-anchor="middle">${esc(dd.date)}</text>` : "").join("");
  const dots = pts.map((p) => `<circle cx="${x(p.i)}" cy="${y(p.median)}" r="4" class="dot"/>`).join("");
  const colW = (W - L - R) / Math.max(1, days.length - 1);
  const hits = days.map((dd, i) => `<rect x="${x(i) - colW / 2}" y="0" width="${colW}" height="${H - B}" class="hit"
    data-tip="${esc(dd.date)} · ${dd.median == null ? "판매 없음" : `중앙값 ${Math.round(dd.median).toLocaleString("ko-KR")}길 (${dd.count}건)`}"/>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart">${grid}${labels}<path d="${path}" class="line"/>${dots}${hits}</svg>`;
}

function barChart(days) {
  const W = 320, H = 120, L = 44, R = 8, T = 10, B = 22;
  const hi = Math.max(1, ...days.map((d) => d.units));
  const slot = (W - L - R) / days.length, bw = Math.min(22, slot - 4);
  const y = (v) => T + (1 - v / hi) * (H - T - B);
  const base = H - B;
  const bars = days.map((dd, i) => {
    const cx = L + slot * i + slot / 2, top = y(dd.units), r = Math.min(4, (base - top) / 2, bw / 2);
    const bar = dd.units ? `<path class="bar" d="M${cx - bw / 2},${base}V${top + r}Q${cx - bw / 2},${top} ${cx - bw / 2 + r},${top}H${cx + bw / 2 - r}Q${cx + bw / 2},${top} ${cx + bw / 2},${top + r}V${base}Z"/>` : "";
    const label = (i === 0 || i === days.length - 1 || i === Math.floor(days.length / 2)) ? `<text x="${cx}" y="${H - 6}" class="axis" text-anchor="middle">${esc(dd.date)}</text>` : "";
    return `${bar}${label}<rect x="${cx - slot / 2}" y="0" width="${slot}" height="${base}" class="hit" data-tip="${esc(dd.date)} · ${dd.units.toLocaleString("ko-KR")}개 팔림"/>`;
  }).join("");
  const grid = [0, hi / 2, hi].map((v) =>
    `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 3}" class="axis" text-anchor="end">${Math.round(v).toLocaleString("ko-KR")}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart">${grid}${bars}</svg>`;
}

function renderInsights(d, row) {
  const v = V(row);
  const ct = v.trend || { d: [] };
  const t = { change: ct.change, days: ct.d.map((date, i) => ({ date, median: ct.m[i], units: ct.u[i], count: ct.c[i] })) };
  let change = "";
  if (t.change != null) {
    const down = t.change <= -10, up = t.change >= 10;
    change = `<span class="trend-note ${down ? "down" : up ? "up" : ""}">${down ? "📉" : up ? "📈" : "➖"} 최근 2일 판매가가 그 전보다 ${t.change > 0 ? "+" : ""}${t.change.toFixed(0)}%${down ? " — 떨어지는 중이다 개굴, 조심해라 개굴" : ""}</span>`;
  }
  const charts = t.days.length ? `
    <div class="insight">
      <div class="insight-head"><h3>📈 ${esc(d.period)} 시세 추이 · ${esc(serverName(d))}</h3>${change}</div>
      <div class="charts">
        <figure><figcaption>하루 판매가 (중앙값, 길)</figcaption>${lineChart(t.days)}</figure>
        <figure><figcaption>하루 판매 수량 (개)</figcaption>${barChart(t.days)}</figure>
      </div>
    </div>` : "";
  let quality = "";
  if (v.quality) {
    const box = (name) => {
      const q = v.quality[name], cur = (name === "HQ") === row.sellingHq;
      return `<div class="q-box${cur ? " current" : ""}"><div class="q-name">${name}${cur ? " <small>지금 기준</small>" : ""}</div>
        <div class="q-row"><span>판매 예상가</span><b>${gil(q.sell)}</b></div>
        <div class="q-row"><span>순수익</span><b>${q.net == null ? '<span class="dash">-</span>' : signed(q.net)}</b></div>
        <div class="q-row"><span>판매 건수 · 매물</span><b>${q.sales} · ${q.listings}</b></div></div>`;
    };
    quality = `
      <div class="insight">
        <div class="insight-head"><h3>✨ NQ · HQ 비교 · ${esc(serverName(d))}</h3><span class="faint">재료비는 똑같이 쳤다 개굴. HQ 로 팔려면 HQ 재료나 제작 실력이 받쳐줘야 한다 개굴.</span></div>
        <div class="q-grid">${box("NQ")}${box("HQ")}</div>
      </div>`;
  }
  return (charts || quality ? `<div class="insights">${charts}${quality}</div>` : "") + renderBundles(d, row) + renderWorlds(d, row) + renderEvidence(d, row);
}

// ── 잘 팔리는 묶음 크기 (여러 개 겹치는 아이템만) ──
function renderBundles(d, row) {
  const b = V(row).bundles;
  if (!b) return "";
  const shown = b.bands.filter((x) => x.sales || x.listed);
  let note;
  if (!b.sales) note = `${esc(d.period)} 동안 팔린 기록이 없어서 묶음 추천은 못 한다 개굴.`;
  else {
    const best = b.bands[b.best];
    note = `<b>${esc(best.label)}</b>씩 올리는 게 제일 자주 팔렸다 개굴 (${b.sales}건 중 ${best.sales}건).`;
    const most = b.listedMost != null ? b.bands[b.listedMost] : null;
    if (most && b.listedMost > b.best) note += ` 지금 매물은 대부분 <b>${esc(most.label)}</b> 짜리라, 작게 나눠 올리면 먼저 팔릴 수 있다 개굴.`;
  }
  const home = d.servers.find((x) => x.home);
  const hb = home && state.server === "dc" ? row.views[home.key].bundles : null;
  if (hb && hb.best != null && hb.sales && hb.best !== b.best) {
    note += ` 단, <b>${esc(home.name)}</b>에서는 <b>${esc(hb.bands[hb.best].label)}</b> 묶음이 제일 많이 팔렸다 개굴 (${hb.sales}건 중 ${hb.bands[hb.best].sales}건).`;
  }
  const body = shown.map((x) => {
    const i = b.bands.indexOf(x);
    return `<tr class="${i === b.best ? "best" : ""}">
      <td>${i === b.best ? "👍 " : ""}${esc(x.label)}</td><td class="num">${x.sales}</td>
      <td class="num">${x.units.toLocaleString("ko-KR")}</td><td class="num">${gil(x.unit)}</td><td class="num">${x.listed}</td></tr>`;
  }).join("");
  // 서버별로 어떤 묶음이 팔렸나 (서버마다 사는 사람들 습관이 달라서)
  const worlds = d.servers.filter((x) => x.key !== "dc").map((x) => ({ ...x, b: row.views[x.key].bundles })).filter((x) => x.b);
  const used = b.bands.map((_, i) => i).filter((i) => worlds.some((w) => w.b.bands[i].sales));
  const worldRows = worlds.map((w) => {
    const best = w.b.best;
    return `<tr class="clickable${w.key === state.server ? " selected" : ""}" data-server="${esc(w.key)}">
      <td>${esc(w.name)}${w.home ? ' <span class="badge nq">내 서버</span>' : ""}</td>
      ${used.map((i) => {
        const n = w.b.bands[i].sales;
        return `<td class="num${i === best && n ? " bundle-best" : ""}">${n ? (i === best ? "👍 " : "") + n : '<span class="dash">-</span>'}</td>`;
      }).join("")}
      <td>${best != null && w.b.sales ? esc(w.b.bands[best].label) : '<span class="dash">-</span>'}</td></tr>`;
  }).join("");
  const byWorld = used.length && worlds.length > 1 ? `
      <div class="ev-cap bundle-cap">서버별 판매 건수 (묶음 크기별) — 줄 누르면 그 서버 기준으로 바뀐다 개굴</div>
      <div class="table-wrap"><table>
        <thead><tr><th>서버</th>${used.map((i) => `<th class="num">${esc(b.bands[i].label)}</th>`).join("")}<th>제일 잘 팔린 묶음</th></tr></thead>
        <tbody>${worldRows}</tbody>
      </table></div>` : "";
  return `
    <div class="evidence worlds bundles">
      <div class="insight-head"><h3>📦 잘 팔리는 묶음 · ${esc(serverName(d))}</h3><span class="faint">한 번에 최대 ${b.stack.toLocaleString("ko-KR")}개까지 묶을 수 있다 개굴</span></div>
      <div class="ev-note">${note}</div>
      ${shown.length ? `<div class="table-wrap"><table>
        <thead><tr><th>묶음 크기</th><th class="num">판매 건수</th><th class="num">팔린 수량</th><th class="num">개당 중앙값</th><th class="num">지금 매물 수</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div>` : ""}
      ${byWorld}
    </div>`;
}

// ── 서버별 판매 비교 (서버별 순위 값 그대로) ──
function renderWorlds(d, row) {
  const ws = d.servers.filter((s) => s.key !== "dc").map((s) => ({ ...s, v: row.views[s.key] }));
  if (ws.length < 2) return "";
  const ranked = ws.filter((w) => w.v.net != null && w.v.sales >= 2);
  const best = ranked.length ? ranked.reduce((a, b) => (b.v.net > a.v.net ? b : a)).key : null;
  const body = ws.map((w) => `
    <tr class="clickable${w.key === best ? " best" : ""}${w.key === state.server ? " selected" : ""}" data-server="${esc(w.key)}">
      <td>${w.key === best ? "👑 " : ""}${esc(w.name)}${w.home ? ' <span class="badge nq">내 서버</span>' : ""}</td>
      <td class="num">${w.v.sales}${w.v.dropped ? ` <span class="faint" data-tip="이상 거래 ${w.v.dropped}건 빼고">(−${w.v.dropped})</span>` : ""}</td>
      <td class="num">${gil(w.v.median)}</td><td class="num">${gil(w.v.minListing)}</td>
      <td class="num">${w.v.listings}</td><td class="num">${gil(w.v.sell)}</td>
      <td class="num">${w.v.net == null ? '<span class="dash">-</span>' : signed(w.v.net)}</td>
      <td>${w.v.passes ? "✅" : '<span class="faint">필터 밖</span>'}</td>
    </tr>`).join("");
  return `
    <div class="evidence worlds">
      <div class="insight-head"><h3>🌐 서버별 판매 비교</h3>
        <span class="faint">서버마다 그 서버 기록·매물만 보고 계산했다 개굴. 줄 누르면 그 서버 순위로 넘어간다 개굴. 👑 = 판매 2건 이상 중 제일 많이 남는 곳</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>서버</th><th class="num">판매 건수</th><th class="num">판매 중앙값</th><th class="num">최저 매물</th>
          <th class="num">매물 수</th><th class="num">예상 판매가</th><th class="num">순수익</th><th>순위</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div>
    </div>`;
}

// ── 판매가 근거: 서버마다 그 서버 중앙값 기준으로 이상 거래·미끼를 가른다 ──
function renderEvidence(d, row) {
  const ev = row.evidence;
  if (!ev || !ev.worlds) return "";
  const v = V(row);
  const q = (hq) => `<span class="badge ${hq ? "src-craft" : "nq"}">${hq ? "HQ" : "NQ"}</span>`;
  const name = serverName(d);
  let formula;
  if (state.server === "dc") {
    formula = `통합 판매 예상가 = 서버마다 이상 거래 뺀 ${esc(d.period)} 판매 전체의 중앙값 <b>${gil(v.median)}</b>`;
  } else {
    formula = `${esc(name)} 판매 예상가 = min(판매 중앙값 <b>${gil(v.median)}</b>, 최저 매물 <b>${v.minListing == null ? "없음" : gil(v.minListing)}</b>)`;
  }
  if (v.cap != null) formula += ` → HQ <b>${gil(v.cap)}</b> 보다 비싸게는 못 파니까 깎았다 개굴`;
  formula += ` = <b class="ev-sell">${gil(v.sell)}</b>길 <span class="faint">(${esc(ev.quality)} 기준${v.dropped ? ` · 이상 거래 ${v.dropped}건 빼고` : ""})</span>`;
  const worlds = ev.worlds.slice().sort((a, b) => (b.world === name) - (a.world === name));
  const blocks = worlds.map((w) => {
    const sales = w.recent.length ? w.recent.map((x) => `<tr class="${x.odd ? "odd" : ""}"${x.odd ? ` data-tip="${esc(w.world)} 보통 가격(${gil(w.median)}길)이랑 너무 달라서 이상 거래로 보고 뺐다 개굴"` : ""}>
        <td>${x.odd ? "❗ " : ""}${esc(x.when)}</td><td>${q(x.hq)}</td><td class="num">${gil(x.price)}</td><td class="num">${x.qty}</td></tr>`).join("")
      : `<tr><td colspan="4" class="faint">팔린 기록이 없다 개굴</td></tr>`;
    const cheap = w.cheap.length ? w.cheap.map((x) => `<tr class="${x.bait ? "bait" : ""}"${x.bait ? ` data-tip="${esc(w.world)} 보통 가격의 절반도 안 돼서 미끼 매물로 보고 뺐다 개굴"` : ""}>
        <td>${q(x.hq)}</td><td class="num">${gil(x.price)}</td><td class="num">${x.qty}</td><td>${x.bait ? '<span class="faint">미끼</span>' : ""}</td></tr>`).join("")
      : `<tr><td colspan="4" class="faint">지금 매물이 없다 개굴</td></tr>`;
    return `
      <div class="ev-world${w.world === name ? " current" : ""}">
        <div class="ev-world-head"><b>${esc(w.world)}</b>${w.home ? ' <span class="badge nq">내 서버</span>' : ""}
          <span class="faint">중앙값 ${gil(w.median)} · 최저 ${w.minListing == null ? "없음" : gil(w.minListing)} · 판매 ${w.sales}건${w.dropped ? ` (❗${w.dropped}건 뺌)` : ""} · 매물 ${w.listings}</span></div>
        <div class="ev-cap">최근 판매</div>
        <table><thead><tr><th>일시</th><th>품질</th><th class="num">가격</th><th class="num">수량</th></tr></thead><tbody>${sales}</tbody></table>
        <div class="ev-cap">지금 싼 매물</div>
        <table><thead><tr><th>품질</th><th class="num">가격</th><th class="num">수량</th><th></th></tr></thead><tbody>${cheap}</tbody></table>
      </div>`;
  }).join("");
  return `
    <div class="evidence">
      <div class="insight-head"><h3>💰 판매가 근거</h3><span class="ev-formula">${formula}</span></div>
      <div class="faint ev-note">이상 거래(❗)랑 미끼 매물은 서버마다 <b>그 서버</b> 보통 가격 기준으로 가른다 개굴. 원래 싼 서버를 싸다고 빼진 않는다 개굴.</div>
      <div class="ev-worlds">${blocks}</div>
    </div>`;
}

// ── 아이템 검색 결과 ──
const SEARCH_KIND = {
  ok: ["✅", "목록에 있다 개굴 — 누르면 표에서 보여준다"],
  filtered: ["🚫", "필터에 걸렸다 개굴"],
  nocalc: ["❓", "계산 못 했다 개굴"],
  out: ["⛔", "분석 범위 밖이다 개굴"],
  norecipe: ["🙅", "제작 못 하는 템이다 개굴"],
};
function renderSearch(d) {
  const sr = d.search;
  if (!sr) return "";
  if (!sr.items.length) {
    return `<section class="search-box"><div class="search-head"><b>🔍 "${esc(sr.query)}"</b><span class="faint">🐸 그런 이름은 하나도 없다 개굴. 글자 다시 봐 봐라 개굴.</span></div></section>`;
  }
  const items = sr.items.map((x) => {
    const [icon, label] = SEARCH_KIND[x.kind];
    const meta = [x.job, x.level != null ? `Lv${x.level}` : ""].filter(Boolean).join(" · ");
    const money = x.net != null ? `<span class="sr-money">순수익 ${signed(x.net)}</span>` : "";
    return `
      <div class="sr ${x.kind}${x.id ? " go" : ""}" ${x.id ? `data-goto="${x.id}"` : ""}>
        <div class="sr-main">${itemName(x.name, x.stars, x.hq)}${meta ? `<span class="sr-meta">${esc(meta)}</span>` : ""}${money}</div>
        <div class="sr-why"><span class="sr-kind">${icon} ${esc(label)}</span>${x.why ? ` — ${esc(x.why)}` : ""}</div>
      </div>`;
  }).join("");
  const more = sr.total > sr.items.length ? `<div class="sr-more faint">… ${sr.total - sr.items.length}개 더 있다 개굴. 좀 더 자세히 쳐 봐라 개굴.</div>` : "";
  return `
    <section class="search-box">
      <div class="search-head"><b>🔍 "${esc(sr.query)}" 검색 결과 ${sr.total.toLocaleString("ko-KR")}개</b>
        <span class="faint">필터랑 상관없이 다 찾아준다 개굴</span></div>
      <div class="sr-list">${items}</div>${more}
    </section>`;
}

// ── 장보기 목록 ──
// 장보기 계산: 담은 아이템 → 구매 서버별 재료 묶음
function cartPlan(d) {
  const ids = Object.keys(state.cart).map(Number);
  const rows = ids.map((id) => d.rows.find((r) => r.id === id)).filter(Boolean);
  const missing = ids.length - rows.length;
  const groups = {};
  let cost = 0, revenue = 0;
  for (const r of rows) {
    const n = state.cart[r.id];
    revenue += (V(r).sell || 0) * (1 - d.taxRate) * n * r.resultAmount;
    for (const s of r.shopping) {
      // ⚡ 지금 시세로 다시 받았으면 그 값·서버로 (거래소 재료만)
      const live = s.source === "거래소" && state.liveCart ? state.liveCart[s.id] : null;
      const g = live ? live.world : s.source === "거래소" ? s.world || "서버 미정" : s.source === "NPC" ? "🏪 NPC 상점" : s.source === "직접 채집" ? "⛏ 직접 채집" : "❓ 시세 없음";
      const key = s.name;
      groups[g] = groups[g] || { name: g, market: s.source === "거래소", items: {} };
      const it = (groups[g].items[key] = groups[g].items[key] || { id: s.id, name: s.name, gather: s.g, gatherLv: s.gl, tier: s.t, qty: 0, spend: 0, for: [] });
      if (!it.for.includes(r.name)) it.for.push(r.name); // 어느 완성품에 들어가는 재료인지
      it.qty += s.qty * n;
      it.spend += s.qty * n * ((live ? live.unit : s.unit) || 0);
      if (live) { it.live = true; it.short = live.short; }
    }
  }
  const list = Object.values(groups).map((g) => {
    // need = 레시피대로 필요한 수량, qty = 실제로 살 수량 (가진 거 빼고 직접 고친 값이 있으면 그걸로)
    const items = Object.values(g.items).map((it) => {
      const need = Math.ceil(it.qty - 1e-9), key = `${g.name}|${it.name}`;
      const fixed = state.qty[key];
      return { ...it, key, need, qty: fixed != null ? fixed : need, edited: fixed != null, unit: it.qty ? it.spend / it.qty : 0 };
    });
    items.forEach((it) => (it.total = it.qty * it.unit));
    const total = items.reduce((a, it) => a + it.total, 0);
    cost += total;
    return { ...g, items, total };
  }).sort((a, b) => (b.market - a.market) || (b.total - a.total));
  return { ids, rows, missing, list, cost, revenue };
}

// 텍스트 파일·복사용 장보기 목록
function cartText(d) {
  const { rows, list, cost, revenue } = cartPlan(d);
  const out = [`🛒 장보기 목록 (${nowText()})`, ""];
  rows.forEach((r) => out.push(`- ${"★".repeat(r.stars || 0)}${r.name}${r.sellingHq === true ? " (HQ)" : ""} ×${state.cart[r.id]}회 (${state.cart[r.id] * r.resultAmount}개)`));
  out.push("", `재료비 ${Math.round(cost).toLocaleString("ko-KR")}길 · 판매액(세후) ${Math.round(revenue).toLocaleString("ko-KR")}길 · 예상 순이익 ${Math.round(revenue - cost).toLocaleString("ko-KR")}길`);
  list.forEach((g, i) => {
    out.push("", `== ${g.market ? `${i + 1}. ` : ""}${g.name} (${Math.round(g.total).toLocaleString("ko-KR")}길) ==`);
    g.items.forEach((it) => out.push(`[${state.done[it.key] ? "x" : " "}] ${it.name} ×${it.qty.toLocaleString("ko-KR")}${it.edited ? ` (필요 ${it.need.toLocaleString("ko-KR")})` : ""}${it.for.length ? ` [${it.for.join(", ")}]` : ""} @${Math.round(it.unit).toLocaleString("ko-KR")} = ${Math.round(it.total).toLocaleString("ko-KR")}`));
  });
  return out.join("\n");
}

function renderCart(d) {
  if (!Object.keys(state.cart).length || !state.cartOpen) return "";
  // 정적 사이트: 담은 아이템의 재료 목록을 아직 안 받았으면 받아 온다
  const waiting = d.loadDetail ? Object.keys(state.cart).map(Number).map((id) => d.rows.find((r) => r.id === id)).filter((r) => r && !r.loaded) : [];
  if (waiting.length) {
    Promise.all(waiting.map((r) => d.loadDetail(r.id))).then(() => d.rerender && d.rerender(), () => {});
    return `<aside class="cart drawer" id="cart"><div class="drawer-head"><h2>🛒 장보기 목록</h2>
      <button type="button" class="drawer-x" data-close-cart="1" title="닫기 (Esc)">✕</button></div>
      <div class="drawer-body"><div class="detail-top"><div class="desc">🐸 재료 목록 불러오는 중이다 개굴…</div></div></div></aside>`;
  }
  const { rows, missing, list, cost, revenue } = cartPlan(d);
  const worlds = list.filter((g) => g.market).length;
  const all = list.flatMap((g) => g.items);
  const bought = all.filter((it) => state.done[it.key]).length;
  const chips = rows.map((r) => `
    <span class="cart-chip">${itemName(r.name, r.stars, r.sellingHq === true)}
      <input type="number" min="1" max="999" value="${state.cart[r.id]}" data-count="${r.id}" aria-label="제작 횟수"/>회
      <small>(${(state.cart[r.id] * r.resultAmount).toLocaleString("ko-KR")}개)</small>
      <button type="button" class="chip-x" data-unpick="${r.id}" title="빼기">✕</button></span>`).join("");
  const tables = list.map((g, i) => {
    const n = g.items.filter((it) => state.done[it.key]).length;
    const complete = n === g.items.length;
    return `
    <div class="cart-group${complete ? " done" : ""}">
      <div class="cart-group-head"><b>${g.market ? `${i + 1}. ` : ""}${esc(g.name)}</b>
        <span>${n ? `<em class="cart-count">${complete ? "✓ 다 샀다 개굴" : `✓ ${n}/${g.items.length}`}</em> · ` : ""}${gil(g.total)}길</span></div>
      <table><tbody>${g.items.map((it) => `<tr class="${state.done[it.key] ? "done" : ""}">
        <td><label class="buy"><input type="checkbox" data-done="${esc(it.key)}"${state.done[it.key] ? " checked" : ""} aria-label="${esc(it.name)} 샀다"/></label>
          <span class="cart-mat">${tierMark(it.tier)}${it.id && d.trackMaterial ? `<button type="button" class="mat-link" data-track-mat="${it.id}" data-need="${it.qty}">${esc(it.name)}</button>` : esc(it.name)}<span class="cart-mat-tail"><button type="button" class="mat-copy" data-copy-name="${esc(it.name)}" title="이름 복사 (장터 검색창에 붙여 넣기)" aria-label="${esc(it.name)} 이름 복사">📋</button>${gatherMarks(it.gather, it.gatherLv)}</span></span>
          ${it.for.length ? `<div class="mat-for" title="${esc(it.for.join(", "))}">↳ ${esc(it.for.join(" · "))}</div>` : ""}</td>
        <td class="num qty-cell${it.edited ? " edited" : ""}">×<input type="number" class="qty-in" min="0" max="99999" value="${it.qty}" data-qty="${esc(it.key)}"
          title="가진 거 빼고 살 만큼만 적어라 개굴 (필요 ${it.need.toLocaleString("ko-KR")}개)" aria-label="${esc(it.name)} 살 수량">${it.edited
          ? `<button type="button" class="qty-reset" data-qty-reset="${esc(it.key)}" title="필요 수량 ${it.need.toLocaleString("ko-KR")}개로 되돌리기">↺${it.need.toLocaleString("ko-KR")}</button>` : ""}</td>
        <td class="num faint">${it.live ? `<span class="live-mark" title="방금 받은 값${it.short ? " · 매물이 모자라서 있는 만큼만 쳤다 개굴" : ""}">⚡</span>` : ""}@${gil(it.unit)}${it.short ? '<small class="short">부족</small>' : ""}</td><td class="num">${gil(it.total)}</td></tr>`).join("")}</tbody></table>
    </div>`;
  }).join("");
  const saved = state.saved.map((x, i) => `
    <li><div><b>${esc(x.name)}</b><small>${esc(x.savedAt)} · ${Object.keys(x.cart).length}개 · ${esc((x.names || []).slice(0, 3).join(", "))}${(x.names || []).length > 3 ? " …" : ""}</small></div>
      <span><button type="button" class="cart-btn" data-load="${i}">불러오기</button>
      <button type="button" class="chip-x" data-del-saved="${i}" title="지우기">✕</button></span></li>`).join("");
  const save = `
    <div class="cart-save">
      <div class="cart-save-row">
        <input type="text" class="cart-name" data-save-name="1" maxlength="40" placeholder="목록 이름 (예: 금요일 장보기)" value="${esc(state.saveName || "")}"/>
        <button type="button" class="cart-btn primary" data-save="1">💾 저장</button>
      </div>
      <div class="cart-save-row">
        <button type="button" class="cart-btn" data-download="1">⬇ 텍스트 파일로 받기</button>
        <button type="button" class="cart-btn" data-copy="1">📋 복사</button>
        ${bought ? `<button type="button" class="cart-btn" data-undone="1">체크 다 풀기</button>` : ""}
        ${d.logCraft ? `<button type="button" class="cart-btn" data-log-craft="1" data-tip="담은 완성품이랑 횟수를 오늘 날짜로 📒 나의 제작일지에 적는다 개굴">📒 만들었다</button>` : ""}
      </div>
      ${state.cartMsg ? `<div class="cart-msg">${esc(state.cartMsg)}</div>` : ""}
      ${saved ? `<div class="ev-cap">저장한 목록 (이 브라우저에만 저장된다 개굴)</div><ul class="cart-saved">${saved}</ul>` : ""}
    </div>`;
  return `
    <aside class="cart drawer${state.cartAnim ? " anim" : ""}" id="cart" aria-label="장보기 목록">
      <div class="drawer-head">
        <h2>🛒 장보기 목록</h2>
        <button type="button" class="drawer-x" data-close-cart="1" title="닫기 (Esc)">✕</button>
      </div>
      <div class="drawer-body">
        <div class="detail-top">
          <div>
            <div class="desc">담은 거 ${rows.length}개${all.length ? ` · 산 거 ${bought}/${all.length}` : ""} · ${esc(serverName(d))} 판매가 기준 · 거래소 ${worlds}곳 돌면 된다 개굴 (재료비 큰 서버부터)${missing ? ` · 지금은 어느 순위에도 없어서 빠진 거 ${missing}개` : ""}</div>
          </div>
          <div class="kv">
            <div><span>재료비</span><b>${gil(cost)}</b></div>
            <div><span>판매액 (세후)</span><b>${gil(revenue)}</b></div>
            <div><span>예상 순이익</span><b>${signed(revenue - cost)}</b></div>
          </div>
        </div>
        <div class="cart-chips">${chips}<button type="button" class="cart-clear" data-clear="1">전부 비우기</button></div>
        <div class="cart-live">
          ${d.fetchListings ? `<button type="button" class="cart-btn primary" data-cart-live="1"${state.liveBusy ? " disabled" : ""}>${state.liveBusy ? "⚡ 받는 중이다 개굴…" : "⚡ 지금 시세로 다시 받기"}</button>` : ""}
          <span class="faint">${state.liveCart ? `⚡ ${esc(state.liveTime)} 에 다시 받은 값이다 개굴 (구매세 포함, 필요 수량만큼 싼 매물부터)`
            : "지금은 매시간 받아 둔 값이다 개굴. 사러 가기 전에 눌러서 지금 값으로 다시 짜라 개굴"}${state.liveMsg ? ` · ⚠ ${esc(state.liveMsg)}` : ""}</span>
        </div>
        <div class="cart-groups">${tables}</div>
        ${save}
      </div>
    </aside>`;
}

// 화면 오른쪽 아래에 떠 있는 장보기 버튼
function renderCartFab() {
  const n = Object.keys(state.cart).length;
  if (!n || state.cartOpen) return "";
  return `<button type="button" class="cart-fab${state.fabBump ? " bump" : ""}" data-open-cart="1">🛒 장보기 <b>${n}</b></button>`;
}

function renderFailed(d) {
  const failed = d.failed[state.cat];
  if (!failed.total) return "";
  const more = failed.total > failed.items.length
    ? `<tr><td colspan="4" class="faint">… 외 ${(failed.total - failed.items.length).toLocaleString("ko-KR")}개</td></tr>` : "";
  const body = failed.items.map((f) => `
    <tr><td>${itemName(f.name, f.stars, f.hq)}</td><td><span class="job">${esc(f.job)}</span></td>
    <td class="num">${f.level}</td><td class="reason">${esc(f.reason)}</td></tr>`).join("");
  return `
    <details class="failed"${state.failedOpen ? " open" : ""}>
      <summary>${esc(d.failedTitle || "계산할 수 없었던 레시피")} (${failed.total.toLocaleString("ko-KR")}개)<span class="muted">${esc(d.failedNote || "팔린 기록이나 재료 시세가 없어서 계산 못 한 거다 개굴")}</span></summary>
      <div class="failed-body"><div class="table-wrap"><table>
        <thead><tr><th>아이템명</th><th>${esc((d.failedHead || [])[0] || "직업")}</th><th class="num">${esc((d.failedHead || [])[1] || "레시피 레벨")}</th><th>제외 사유</th></tr></thead>
        <tbody>${body}${more}</tbody>
      </table></div></div>
    </details>`;
}

export default function (component) {
  const { data, parentElement } = component;
  if (!data) return;

  let root = parentElement.querySelector(".ffx");
  if (!root) {
    root = document.createElement("div");
    root.className = "ffx";
    parentElement.appendChild(root);
  }

  // 사이드바의 "기본 정렬"이 바뀌면 표 정렬도 그걸로 되돌린다
  if (state.sortSeed !== data.sort) {
    state.sortSeed = data.sort;
    state.sort = data.sort;
    state.dir = -1;
  }
  if (state.tab !== "all" && !data.dynamicTabs && !data.jobs.includes(state.tab)) state.tab = "all";
  if (!(state.cat in data.cats)) state.cat = "all";
  if (state.sub && !((data.subs || {})[state.cat] || []).includes(state.sub)) state.sub = "";
  if (!data.servers.some((s) => s.key === state.server)) state.server = "dc";

  data.rerender = () => render();
  function render() {
    const keepScroll = root.querySelector(".drawer-body")?.scrollTop;
    renderInner();
    const body = root.querySelector(".drawer-body");
    if (body && keepScroll != null) body.scrollTop = keepScroll;
  }
  function renderInner() {
    if (data.dynamicTabs && state.tab !== "all" && !tabJobs(data).includes(state.tab)) state.tab = "all";
    const rows = sortedRows(data);
    if (state.selected != null && !rows.some((r) => r.id === state.selected)) state.selected = null; // 지금 표에 없으면 접는다
    const selected = data.rows.find((r) => r.id === state.selected);
    // 정적 사이트: 상세(근거·재료·추이)는 누를 때 받아온다
    if (selected && data.loadDetail && !selected.loaded) data.loadDetail(selected.id).then(() => render(), () => {});
    // 누를 때마다 그 템 시세를 다시 받는다 (1분 안에 또 누르면 그대로)
    if (selected && data.loadLive && selected.item && (!selected.live || (!selected.live.loading && Date.now() - (selected.live.at || 0) > 60000))) {
      const target = selected;
      target.live = { loading: true, at: Date.now() };
      // 재료 목록(상세)이 와야 재료값도 다시 계산할 수 있다
      Promise.resolve(data.loadDetail && !target.loaded ? data.loadDetail(target.id) : null).then(() => data.loadLive(target)).then((live) => { target.live = live; render(); },
        (e) => { target.live = { error: e.message || "오류", at: Date.now() }; render(); });
    }
    const cartCount = Object.keys(state.cart).length;
    const notice = data.notice
      ? `<div class="notice ${esc(data.notice.kind)}"><span>${data.notice.kind === "error" ? "⚠" : "⏳"}</span><span>${esc(data.notice.text)}</span></div>`
      : "";
    root.innerHTML =
      notice +
      renderSearch(data) +
      renderHeader(data) +
      renderTabs(data) +
      `<div class="section-head"><h2>순위 · ${esc(serverName(data))}</h2><span class="desc">${!hasCart(data)
        ? `줄 누르면 바로 밑에 판매 상세${isExchange(data) ? "랑 어디서 바꾸는지" : ""}가 펼쳐진다 개굴 · 다시 누르면 접힌다 개굴`
        : "줄 누르면 바로 밑에 재료 상세가 펼쳐진다 개굴 · 다시 누르면 접힌다 개굴 · <b>+</b> 누르면 장보기에 담긴다 개굴"}</span>
         <span class="right">${cartCount && hasCart(data) ? `<button type="button" class="cart-jump" data-jump="1">🛒 장보기 ${cartCount}개 열기</button> · ` : ""}${esc(data.taxNote)} · 단위: 길</span></div>` +
      renderTable(data, rows) +
      renderFailed(data) +
      (hasCart(data) ? renderCart(data) + renderCartFab() : "") +
      `<footer class="frog-foot"><span class="frog-sit">🐸</span> 개구리 좋아하는 <b>로살리아@초코보</b> 가 만들었다 개굴 · 문의도 여기로 해라 개굴</footer>`;
    // 펼친 상세는 가로로 긴 표 안에서도 화면 폭에 맞게
    const wrap = root.querySelector(".rank-table");
    if (wrap) wrap.style.setProperty("--wrap-w", wrap.clientWidth + "px");
    state.cartAnim = false;
    state.fabBump = false;
    root.classList.toggle("with-drawer", !!(state.cartOpen && cartCount && hasCart(data)));
  }

  // 🐸 제목 옆 개구리를 누르믄 개구리 비가 한 번 더 온다
  function frogRain() {
    root.querySelector(".frog-rain")?.remove();
    const rain = document.createElement("div");
    rain.className = "frog-rain";
    for (let i = 0; i < 24; i++) {
      const f = document.createElement("span");
      f.textContent = "🐸";
      f.style.left = Math.random() * 97 + "vw";
      f.style.fontSize = 1.2 + Math.random() * 1.6 + "rem";
      f.style.animationDelay = Math.random() * 1.5 + "s";
      f.style.animationDuration = 2.2 + Math.random() * 1.6 + "s";
      f.style.setProperty("--spin", (Math.random() < 0.5 ? -1 : 1) * (90 + Math.random() * 450) + "deg");
      f.style.setProperty("--drift", (Math.random() * 16 - 8) + "vw");
      rain.appendChild(f);
    }
    root.appendChild(rain);
    setTimeout(() => rain.remove(), 5500);
  }

  // 비전서 팝오버: 뱃지를 누르면 뜨고, 다른 데를 누르거나 스크롤하면 닫힌다
  function closePop() {
    root.querySelector(".pop")?.remove();
  }
  function openPop(btn) {
    closePop();
    const pop = document.createElement("div");
    pop.className = "pop";
    pop.innerHTML = `<div class="pop-title">📖 필요한 비전서</div><div class="pop-body">${esc(btn.dataset.pop)}</div>
      <div class="pop-hint">이 비전서를 읽어야 만들 수 있다 개굴.</div>`;
    root.appendChild(pop);
    const b = btn.getBoundingClientRect();
    const w = pop.offsetWidth;
    pop.style.left = Math.max(8, Math.min(b.right - w, window.innerWidth - w - 8)) + "px";
    pop.style.top = b.bottom + 6 + "px";
  }
  if (!root.__popBound) {
    root.__popBound = true;
    window.addEventListener("scroll", closePop, true);
    window.addEventListener("resize", closePop);
    document.addEventListener("click", (e) => { if (!e.composedPath().includes(root)) closePop(); });
  }

  root.onclick = (e) => {
    const popBtn = e.target.closest(".has-pop");
    if (popBtn) {
      e.stopPropagation();
      const open = root.querySelector(".pop");
      if (open && open.dataset.for === popBtn.dataset.pop + popBtn.closest("tr")?.dataset.id) return closePop();
      openPop(popBtn);
      root.querySelector(".pop").dataset.for = popBtn.dataset.pop + popBtn.closest("tr")?.dataset.id;
      return;
    }
    if (!e.target.closest(".pop")) closePop();
    if (e.target.closest("[data-frogs]")) return frogRain();
    if (e.target.closest("[data-live-retry]")) {
      const sel = data.rows.find((r) => r.id === state.selected);
      if (sel) { sel.live = null; return render(); }
    }
    const mat = e.target.closest("[data-track-mat]");
    if (mat && data.trackMaterial) hideMatPop();
    if (mat && data.trackMaterial) return data.trackMaterial(Number(mat.dataset.trackMat), Number(mat.dataset.need) || 1);
    // 📒 순위 표에서 바로 제작일지에 1회 적기
    const logBtn = e.target.closest("[data-log-row]");
    if (logBtn && data.logCraft) {
      logBtn.disabled = true;
      data.logCraft([{ id: Number(logBtn.dataset.logRow), n: 1 }]).then(() => {
        logBtn.textContent = "✓+1"; logBtn.classList.add("done");
        setTimeout(() => { logBtn.textContent = "📒"; logBtn.classList.remove("done"); logBtn.disabled = false; }, 1200);
      }, () => { logBtn.textContent = "⚠"; logBtn.disabled = false; });
      return;
    }
    const pick = e.target.closest("[data-pick]");
    if (pick) {
      const id = Number(pick.dataset.pick);
      if (state.cart[id]) delete state.cart[id]; else { state.cart[id] = 1; state.fabBump = true; }
      if (!Object.keys(state.cart).length) state.cartOpen = false;
      saveCart();
      return render();
    }
    const unpick = e.target.closest("[data-unpick]");
    if (unpick) {
      delete state.cart[Number(unpick.dataset.unpick)];
      if (!Object.keys(state.cart).length) state.cartOpen = false;
      saveCart();
      return render();
    }
    if (e.target.closest("[data-cart-live]")) { refreshCartLive(); return; }
    if (e.target.closest("[data-log-craft]")) {
      data.logCraft(Object.entries(state.cart).map(([id, n]) => ({ id: Number(id), n }))).then(
        () => flash("📒 제작일지에 적었다 개굴. 사이드바 📒 나의 제작일지에서 볼 수 있다 개굴"), () => flash("제작일지에 못 적었다 개굴"));
      return;
    }
    // 재료 이름 복사 (게임 장터 검색창에 붙여 넣기용)
    const cp = e.target.closest("[data-copy-name]");
    if (cp) {
      const name = cp.dataset.copyName;
      const done = () => { cp.textContent = "✓"; cp.classList.add("copied"); setTimeout(() => { cp.textContent = "📋"; cp.classList.remove("copied"); }, 1200); };
      (navigator.clipboard ? navigator.clipboard.writeText(name) : Promise.reject()).then(done, () => {
        const t = document.createElement("textarea"); t.value = name; document.body.appendChild(t); t.select();
        try { document.execCommand("copy"); done(); } catch { /* 못 해도 괜찮다 */ } t.remove();
      });
      return;
    }
    if (e.target.closest("[data-clear]")) { state.liveCart = null; state.cart = {}; state.done = {}; state.qty = {}; state.cartOpen = false; saveCart(); return render(); }
    const reset = e.target.closest("[data-qty-reset]");
    if (reset) { delete state.qty[reset.dataset.qtyReset]; saveCart(); return render(); }
    if (e.target.closest("[data-save]")) return saveList();
    if (e.target.closest("[data-download]")) {
      const blob = new Blob([cartText(data)], { type: "text/plain;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `장보기_${nowText().replace(/[: ]/g, "-")}.txt`;
      root.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return flash("텍스트 파일로 받았다 개굴.");
    }
    if (e.target.closest("[data-copy]")) {
      navigator.clipboard?.writeText(cartText(data)).then(() => flash("복사했다 개굴. 메모장이나 디스코드에 붙여 넣어라 개굴."),
        () => flash("복사가 막혔다 개굴. 텍스트 파일로 받아라 개굴."));
      return;
    }
    if (e.target.closest("[data-undone]")) { state.done = {}; saveCart(); return render(); }
    const load = e.target.closest("[data-load]");
    if (load) {
      const x = state.saved[Number(load.dataset.load)];
      if (x && (!Object.keys(state.cart).length || window.confirm(`지금 장보기를 "${x.name}" 로 바꿔도 되나 개굴?`))) {
        state.cart = { ...x.cart }; state.done = { ...(x.done || {}) }; state.qty = { ...(x.qty || {}) }; saveCart();
        flash(`"${x.name}" 불러왔다 개굴.`);
      }
      return;
    }
    const del = e.target.closest("[data-del-saved]");
    if (del) {
      const i = Number(del.dataset.delSaved);
      if (window.confirm(`"${state.saved[i]?.name}" 지워도 되나 개굴?`)) {
        state.saved.splice(i, 1); saveJSON("ffxivSavedCarts", state.saved); render();
      }
      return;
    }
    if (e.target.closest("[data-jump], [data-open-cart]")) { state.cartOpen = true; state.cartAnim = true; return render(); }
    if (e.target.closest("[data-close-cart]")) { state.cartOpen = false; return render(); }
    if (e.target.closest(".cart")) return;
    const go = e.target.closest("[data-goto]");
    if (go) {
      state.cat = "all";
      state.sub = "";
      state.tab = "all";
      state.selected = Number(go.dataset.goto);
      // 지금 서버 순위에 없으믄 들어 있는 서버(통합 먼저)로 넘어간다
      const target = data.rows.find((r) => r.id === state.selected);
      if (target && !V(target).passes) {
        const where = data.servers.find((s) => target.views[s.key].passes);
        if (where) state.server = where.key;
      }
      render();
      const row = root.querySelector(`tr[data-id="${state.selected}"]`);
      row?.scrollIntoView({ behavior: "smooth", block: "center" });
      row?.classList.add("flash");
      return;
    }
    const server = e.target.closest("[data-server]");
    if (server) {
      state.server = server.dataset.server;
      const fromDetail = !!server.closest(".worlds");
      if (!fromDetail) { state.tab = "all"; state.selected = null; }
      render();
      if (fromDetail) root.querySelector(".detail")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }
    const sub = e.target.closest("[data-sub]");
    if (sub) {
      state.sub = sub.dataset.sub;
      state.tab = "all";
      state.selected = null;
      return render();
    }
    const cat = e.target.closest("[data-cat]");
    if (cat) {
      state.cat = cat.dataset.cat;
      state.sub = "";
      state.tab = "all";
      state.selected = null;
      return render();
    }
    const tab = e.target.closest("[data-tab]");
    if (tab) {
      state.tab = tab.dataset.tab;
      state.selected = null;
      return render();
    }
    const th = e.target.closest("[data-sort]");
    if (th) {
      const key = th.dataset.sort;
      state.dir = state.sort === key ? -state.dir : th.dataset.asc === "1" ? 1 : -1;
      state.sort = key;
      return render();
    }
    if (e.target.closest("[data-close-detail]")) {
      const id = state.selected;
      state.selected = null;
      render();
      root.querySelector(`tr[data-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
      return;
    }
    const tr = e.target.closest("tr[data-id]");
    if (tr) {
      // 같은 줄을 또 누르면 접고, 다른 줄이면 그 줄 밑에 펼친다
      const id = Number(tr.dataset.id);
      state.selected = state.selected === id ? null : id;
      render();
      // 펼치면 그 줄을 화면 위쪽으로 올려서 밑에 펼친 상세가 바로 보이게
      const row = root.querySelector(`tr[data-id="${id}"]`);
      if (row && state.selected === id) window.scrollTo({ top: row.getBoundingClientRect().top + window.scrollY - 12, behavior: "smooth" });
      else row?.scrollIntoView({ block: "nearest" });
    }
  };
  // 재료 이름에 마우스 올리면: 서버별 지금 최저가 · 최근 평균 판매가 (📈 재료 트래킹 데이터)
  // 다시 그릴 때마다 이 함수가 새로 불리니까 지금 뜬 창이 누구 건지는 root 에 둔다
  function hideMatPop() { root.__popFor = null; document.querySelector(".mat-pop")?.remove(); }
  function placeMatPop(pop, el) {
    const r = el.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    let top = r.bottom + 6;
    if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
    pop.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + "px";
    pop.style.top = top + "px";
  }
  root.onmouseover = (e) => {
    const el = e.target.closest("[data-track-mat]");
    if (!el || !data.materialInfo || el === root.__popFor) return;
    hideMatPop();
    root.__popFor = el;
    const pop = document.createElement("div");
    pop.className = "mat-pop";
    pop.innerHTML = `<b>${esc(el.textContent.replace("📈", "").trim())}</b><div class="faint">🐸 시세 불러오는 중이다 개굴…</div>`;
    document.body.appendChild(pop);
    placeMatPop(pop, el);
    const liveInfo = state.liveCart && state.liveCart[Number(el.dataset.trackMat)];
    data.materialInfo(Number(el.dataset.trackMat)).catch(() => null).then((info) => {
      if (liveInfo) info = { ...(info || {}), worlds: liveInfo.mins, live: true }; // 매물은 방금 받은 값, 평균 판매가는 매시간 기록
      if (root.__popFor !== el) return;
      const best = info && info.worlds[0];
      pop.innerHTML = `<b>${esc(el.textContent.replace("📈", "").trim())}</b>` + (!info || !info.worlds.length
        ? `<div class="faint">지금 올라온 매물이 없다 개굴.</div>`
        : `<div class="mp-best">🏆 제일 싼 곳 <b>${esc(best.name)}</b> ${gil(best.min)}길 <small>(${best.qty}개)</small></div>
          <table><tbody>${info.worlds.map((w, i) => `<tr class="${i ? "" : "best"}"><td>${esc(w.name)}</td><td class="num">${gil(w.min)}</td>
            <td class="num faint">매물 ${w.cnt}</td></tr>`).join("")}</tbody></table>`) +
        `<div class="mp-avg">한국 전체 최근 7일 평균 판매가 <b>${info && info.avg != null ? gil(info.avg) + "길" : "-"}</b>${info && info.sold ? ` <small>(${info.sold.toLocaleString("ko-KR")}개 팔림)</small>` : ""}</div>
        <div class="faint">${info && info.live ? `⚡ ${esc(state.liveTime)} 에 방금 받은 매물이다 개굴` : "매시간 받아 둔 값이다 개굴"} · 누르면 📈 재료 트래킹으로 간다 개굴</div>`;
      placeMatPop(pop, el);
    }, () => { if (root.__popFor === el) pop.innerHTML = `<div class="faint">시세를 못 받아왔다 개굴.</div>`; });
  };
  root.onmouseout = (e) => {
    const el = e.target.closest("[data-track-mat]");
    if (el && el === root.__popFor && !el.contains(e.relatedTarget)) hideMatPop();
  };
  if (!root.__matPopBound) { root.__matPopBound = true; window.addEventListener("scroll", hideMatPop, { passive: true, capture: true }); }

  // ⚡ 장보기 재료 시세를 지금 다시 받아서, 필요 수량만큼 싼 매물부터 샀을 때 값·서버로 다시 짠다
  async function refreshCartLive() {
    const need = {};
    for (const g of cartPlan(data).list) for (const it of g.items) {
      if (it.id && (g.market || it.live)) need[it.id] = (need[it.id] || 0) + it.qty;
    }
    const ids = Object.keys(need).map(Number);
    if (!ids.length) return;
    state.liveBusy = true; state.liveMsg = null; render();
    try {
      const res = await data.fetchListings(ids);
      const tax = data.buyerTax ?? 0.05, out = {};
      for (const id of ids) {
        const ls = (res[id] || []).slice().sort((a, b) => a.price - b.price);
        if (!ls.length) continue;
        let got = 0, spent = 0, world = null;
        for (const l of ls) {
          const take = Math.min(l.qty, Math.max(need[id] - got, 0));
          if (!take) break;
          world = world || l.world;
          got += take; spent += take * l.price;
        }
        const mins = {};
        for (const l of ls) {
          const m = mins[l.world] || (mins[l.world] = { name: l.world, min: l.price, qty: l.qty, cnt: 0 });
          m.cnt += 1;
        }
        out[id] = { unit: got ? (spent / got) * (1 + tax) : ls[0].price * (1 + tax), world: world || ls[0].world, short: got < need[id],
          mins: Object.values(mins).sort((a, b) => a.min - b.min) };
      }
      state.liveCart = out;
      const t = new Date(), p2 = (x) => String(x).padStart(2, "0");
      state.liveTime = `${p2(t.getHours())}:${p2(t.getMinutes())}`;
    } catch (err) {
      state.liveMsg = `못 받아왔다 개굴 (${err.message || err})`;
    }
    state.liveBusy = false;
    render();
  }

  root.onchange = (e) => {
    // 살 수량을 직접 고침 (필요 수량이랑 같으면 고친 거 없앰)
    const q = e.target.closest("[data-qty]");
    if (q) {
      const n = Math.max(0, Math.min(99999, Math.round(Number(q.value) || 0)));
      const it = cartPlan(data).list.flatMap((g) => g.items).find((x) => x.key === q.dataset.qty);
      if (it && n === it.need) delete state.qty[q.dataset.qty]; else state.qty[q.dataset.qty] = n;
      saveCart();
      return render();
    }
    const box = e.target.closest("[data-done]");
    if (box) {
      if (box.checked) state.done[box.dataset.done] = true; else delete state.done[box.dataset.done];
      saveCart();
      return render();
    }
    const input = e.target.closest("[data-count]");
    if (!input) return;
    const n = Math.max(1, Math.min(999, Math.round(Number(input.value) || 1)));
    state.cart[Number(input.dataset.count)] = n;
    saveCart();
    render();
  };

  // 목록 이름 칸: 치는 동안 기억해 두고, 엔터 치면 저장
  root.oninput = (e) => { if (e.target.closest("[data-save-name]")) state.saveName = e.target.value; };
  root.onkeydown = (e) => { if (e.key === "Enter" && e.target.closest("[data-save-name]")) saveList(); };
  function saveList() {
    const name = (state.saveName || "").trim() || `장보기 ${nowText()}`;
    const names = Object.keys(state.cart).map((id) => data.rows.find((r) => r.id === Number(id))?.name).filter(Boolean);
    const same = state.saved.findIndex((x) => x.name === name);
    const entry = { name, savedAt: nowText(), cart: { ...state.cart }, done: { ...state.done }, qty: { ...state.qty }, names };
    if (same >= 0) state.saved[same] = entry; else state.saved.unshift(entry);
    state.saved = state.saved.slice(0, 20);
    saveJSON("ffxivSavedCarts", state.saved);
    state.saveName = "";
    flash(same >= 0 ? `"${name}" 덮어썼다 개굴.` : `"${name}" 저장했다 개굴.`);
  }
  function flash(msg) {
    state.cartMsg = msg;
    render();
    clearTimeout(root.__msgTimer);
    root.__msgTimer = setTimeout(() => { state.cartMsg = ""; render(); }, 3000);
  }

  // 그래프 툴팁: data-tip 이 있는 곳에 마우스를 올리면 뜬다
  root.onmousemove = (e) => {
    const hit = e.target.closest?.("[data-tip]");
    let tip = root.querySelector(".tip");
    if (!hit) { tip?.remove(); return; }
    if (!tip) { tip = document.createElement("div"); tip.className = "tip"; root.appendChild(tip); }
    if (tip.textContent !== hit.dataset.tip) tip.textContent = hit.dataset.tip;
    tip.style.left = "0px"; // 먼저 왼쪽 끝에서 원래 폭을 잰다 (오른쪽 끝에서 재면 잴 때마다 폭이 줄어든다)
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const x = e.clientX + 12 + w > window.innerWidth - 8 ? e.clientX - 12 - w : e.clientX + 12; // 오른쪽이 모자라면 커서 왼쪽에
    tip.style.left = Math.max(8, x) + "px";
    tip.style.top = (e.clientY - 12 - h < 8 ? e.clientY + 20 : e.clientY - 12 - h) + "px"; // 위가 모자라면 커서 밑에
  };
  root.onmouseleave = () => root.querySelector(".tip")?.remove();

  if (!root.__escBound) {
    root.__escBound = true;
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.cartOpen) { state.cartOpen = false; root.__render?.(); }
    });
  }
  root.__render = render;

  if (!root.__toggleBound) {
    root.__toggleBound = true;
    root.addEventListener("toggle", (e) => {
      if (e.target.matches("details.failed")) state.failedOpen = e.target.open;
    }, true);
  }

  render();
}

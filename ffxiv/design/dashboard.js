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
];

const SOURCE_CLASS = { "거래소": "src-market", "NPC": "src-npc", "직접 제작": "src-craft", "직접 채집": "src-gather" };

// 탭·정렬·선택 상태는 다시 그려져도 유지되게 페이지에 보관
const state = (window.__ffxivDash = window.__ffxivDash || { server: "dc", cat: "all", tab: "all", sort: null, dir: -1, selected: null, sortSeed: null, cart: loadCart() });

// 장보기에 담은 것 {레시피ID: 제작 횟수} — 브라우저에 기억해 둔다
function loadCart() {
  try { return JSON.parse(localStorage.getItem("ffxivCart") || "{}"); } catch { return {}; }
}
function saveCart() {
  try { localStorage.setItem("ffxivCart", JSON.stringify(state.cart)); } catch { /* 저장 못 해도 화면은 그대로 */ }
}
function fmtDays(v) {
  if (v == null) return '<span class="dash">-</span>';
  if (v < 1) return '<span class="days fast">하루 안</span>';
  const d = Math.ceil(v);
  return `<span class="days${d > 14 ? " slow" : ""}">~${d}일</span>`;
}
const CAT_ICON = { all: "✦", "가구": "🪑", "일반": "⚒" };

// 지금 고른 서버 보기(통합 또는 서버 하나)의 값
function V(r) {
  return r.views[state.server];
}
// 지금 고른 서버에서 필터 통과했고, 고른 분류(전체/가구/일반)에 해당하는 행만
function catRows(d) {
  return d.rows.filter((r) => V(r).passes && (state.cat === "all" || r.cat === state.cat));
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
function itemName(name, stars) {
  return (stars ? `<span class="stars">${"★".repeat(stars)}</span>` : "") + `<span class="item">${esc(name)}</span>`;
}

function renderHeader(d) {
  const sub = d.subtitle.map((s) => `<span>${esc(s)}</span>`).join("");
  const stats = d.stats[state.server][state.cat];
  const stat = (label, value, sub, accent) => `
    <div class="stat${accent ? " accent" : ""}">
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value">${value.toLocaleString("ko-KR")}<small>개</small></div>
      <div class="stat-sub">${esc(sub)}</div>
    </div>`;
  return `
    <header class="page-head">
      <div class="eyebrow">CRAFTING PROFIT REPORT</div>
      <h1>파판14 제작 수익 분석<button type="button" class="frog-peek" data-frogs="1" title="눌러 봐라 개굴">🐸</button></h1>
      <div class="subtitle">${sub}</div>
    </header>
    ${renderServers(d)}
    ${renderCats(d)}
    <div class="stats">
      ${stat("분석한 레시피", stats.total, "조건에 맞는 전체 레시피")}
      ${stat("계산 가능", stats.calculable, "시세 데이터가 모두 있는 레시피")}
      ${stat("필터 통과", stats.passed, "현재 필터 기준 추천 대상", true)}
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
    `<button class="cat${state.cat === key ? " active" : ""}" data-cat="${esc(key)}">${CAT_ICON[key] || ""} ${esc(d.cats[key])}` +
    `<span class="cnt">${d.stats[state.server][key].passed}</span></button>`;
  return `<div class="cats">${Object.keys(d.cats).map(btn).join("")}</div>`;
}

function renderTabs(d) {
  const counts = {};
  const rows = catRows(d);
  rows.forEach((r) => (counts[r.job] = (counts[r.job] || 0) + 1));
  const tab = (key, label) =>
    `<button class="tab${state.tab === key ? " active" : ""}" data-tab="${esc(key)}">${label}<span class="cnt">${
      key === "all" ? rows.length : counts[key] || 0
    }</span></button>`;
  return `<nav class="tabs">${tab("all", "🏆 통합 순위")}${d.jobs.map((j) => tab(j, esc(j))).join("")}</nav>`;
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
  const head = COLUMNS.map((c) => {
    const cls = [c.num ? "num" : "", c.sortable ? "sortable" : "", state.sort === c.key ? "sorted" : "", state.sort === c.key && state.dir > 0 ? "asc" : ""]
      .filter(Boolean)
      .join(" ");
    return `<th class="${cls}" ${c.sortable ? `data-sort="${c.key}" data-asc="${c.asc ? 1 : 0}"` : ""}>${esc(c.label.replace("{period}", d.period))}</th>`;
  }).join("");

  if (!rows.length) {
    return `<div class="table-wrap"><div class="empty">🐸 필터 통과한 게 하나도 없다 개굴. 왼쪽에서 조건을 조금 풀어 봐라 개굴.</div></div>`;
  }
  const body = rows.map((r, i) => {
    const v = V(r);
    const badges = [...r.badges, ...v.badges].map((b) => b.detail
      ? `<button type="button" class="badge ${esc(b.kind)} has-pop" data-pop="${esc(b.detail)}">${esc(b.text)}</button>`
      : `<span class="badge ${esc(b.kind)}${b.tip ? " has-tip" : ""}"${b.tip ? ` data-tip="${esc(b.tip)}"` : ""}>${esc(b.text)}</span>`).join("");
    return `
      <tr class="clickable${state.selected === r.id ? " selected" : ""}" data-id="${r.id}">
        <td><button type="button" class="pick${state.cart[r.id] ? " on" : ""}" data-pick="${r.id}"
          title="${state.cart[r.id] ? "장보기에서 빼기" : "장보기에 담기"}">${state.cart[r.id] ? "✓" : "+"}</button></td>
        <td><span class="rank${i < 3 ? " top" : ""}">${i + 1}</span></td>
        <td>${itemName(r.name, r.stars)}</td>
        <td><span class="job">${esc(r.job)}</span></td>
        <td class="num">${r.level}</td>
        <td class="num">${gil(v.sell)}</td>
        <td class="num">${gil(r.cost)}</td>
        <td class="num">${signed(v.net)}</td>
        <td class="num">${v.margin == null ? "-" : `<span class="pct ${v.margin >= 0 ? "pos" : "neg"}">${v.margin.toFixed(1)}%</span>`}</td>
        <td class="num">${v.sales}</td>
        <td class="num">${v.listings}</td>
        <td class="num">${fmtDays(v.sellDays)}</td>
        <td class="num">${gil(v.daily)}</td>
        <td><span class="upd${r.stale ? " stale" : ""}">${esc(r.updatedText)}</span></td>
        <td><div class="badges">${badges}</div></td>
      </tr>`;
  }).join("");
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderDetail(d, row) {
  if (!row) return `<div class="detail-hint">🐸 표에서 아이템 하나 눌러 봐라 개굴. 재료 상세가 여기 뜬다 개굴.</div>`;
  const body = row.materials.map((m) => {
    const tree = m.depth ? `<span class="tree">${"　".repeat(m.depth - 1)}└</span>` : "";
    const src = `<span class="badge ${SOURCE_CLASS[m.source] || "src-npc"}">${esc(m.source)}</span>`;
    const market = m.source === "거래소";
    return `
      <tr class="${m.depth ? "sub" : ""}">
        <td>${tree}${esc(m.name)}</td>
        <td class="num">${m.amount}</td>
        <td class="num">${m.need}</td>
        <td class="num">${gil(m.unit)}</td>
        <td class="num">${gil(m.subtotal)}</td>
        <td>${src}</td>
        <td class="num">${market ? m.sold.toLocaleString("ko-KR") : '<span class="dash">-</span>'}</td>
        <td class="num">${market ? m.listings.toLocaleString("ko-KR") : '<span class="dash">-</span>'}</td>
        <td>${m.world ? esc(m.world) : '<span class="dash">-</span>'}</td>
      </tr>`;
  }).join("");
  return `
    <section class="detail">
      <div class="detail-card">
        <div class="detail-top">
          <div>
            <h2>📦 ${itemName(row.name, row.stars)} — 재료 상세</h2>
            <div class="desc">${esc(row.detailDesc)}</div>
          </div>
          <div class="kv">
            <div><span>원가</span><b>${gil(row.cost)}</b></div>
            <div><span>판매 예상가 · ${esc(serverName(d))}</span><b>${gil(V(row).sell)}</b></div>
            <div><span>순수익</span><b>${V(row).net == null ? '<span class="dash">-</span>' : signed(V(row).net)}</b></div>
          </div>
        </div>
        ${renderInsights(d, row)}
        <div class="table-wrap"><table>
          <thead><tr>
            <th>재료</th><th class="num">1회 제작당 수량</th><th class="num">총 필요 수량</th><th class="num">단가</th>
            <th class="num">소계</th><th>구매처</th><th class="num">${esc(d.period)} 판매 수량</th><th class="num">현재 매물 수</th><th>구매 서버</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table></div>
      </div>
    </section>`;
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
  return (charts || quality ? `<div class="insights">${charts}${quality}</div>` : "") + renderWorlds(d, row) + renderEvidence(d, row);
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
        <div class="sr-main">${itemName(x.name, x.stars)}${meta ? `<span class="sr-meta">${esc(meta)}</span>` : ""}${money}</div>
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
function renderCart(d) {
  const ids = Object.keys(state.cart).map(Number);
  if (!ids.length || !state.cartOpen) return "";
  const rows = ids.map((id) => d.rows.find((r) => r.id === id)).filter(Boolean);
  const missing = ids.length - rows.length;
  const groups = {};
  let cost = 0, revenue = 0;
  for (const r of rows) {
    const n = state.cart[r.id];
    revenue += (V(r).sell || 0) * (1 - d.taxRate) * n * r.resultAmount;
    for (const s of r.shopping) {
      const g = s.source === "거래소" ? s.world || "서버 미정" : s.source === "NPC" ? "🏪 NPC 상점" : s.source === "직접 채집" ? "⛏ 직접 채집" : "❓ 시세 없음";
      const key = s.name;
      groups[g] = groups[g] || { name: g, market: s.source === "거래소", items: {} };
      const it = (groups[g].items[key] = groups[g].items[key] || { name: s.name, qty: 0, spend: 0 });
      it.qty += s.qty * n;
      it.spend += s.qty * n * (s.unit || 0);
    }
  }
  const list = Object.values(groups).map((g) => {
    const items = Object.values(g.items).map((it) => ({ ...it, qty: Math.ceil(it.qty - 1e-9), unit: it.qty ? it.spend / it.qty : 0 }));
    items.forEach((it) => (it.total = it.qty * it.unit));
    const total = items.reduce((a, it) => a + it.total, 0);
    cost += total;
    return { ...g, items, total };
  }).sort((a, b) => (b.market - a.market) || (b.total - a.total));
  const worlds = list.filter((g) => g.market).length;
  const chips = rows.map((r) => `
    <span class="cart-chip">${itemName(r.name, r.stars)}
      <input type="number" min="1" max="999" value="${state.cart[r.id]}" data-count="${r.id}" aria-label="제작 횟수"/>회
      <small>(${(state.cart[r.id] * r.resultAmount).toLocaleString("ko-KR")}개)</small>
      <button type="button" class="chip-x" data-unpick="${r.id}" title="빼기">✕</button></span>`).join("");
  const tables = list.map((g, i) => `
    <div class="cart-group">
      <div class="cart-group-head"><b>${g.market ? `${i + 1}. ` : ""}${esc(g.name)}</b><span>${gil(g.total)}길</span></div>
      <table><tbody>${g.items.map((it) => `<tr><td>${esc(it.name)}</td><td class="num">×${it.qty.toLocaleString("ko-KR")}</td>
        <td class="num faint">@${gil(it.unit)}</td><td class="num">${gil(it.total)}</td></tr>`).join("")}</tbody></table>
    </div>`).join("");
  return `
    <aside class="cart drawer${state.cartAnim ? " anim" : ""}" id="cart" aria-label="장보기 목록">
      <div class="drawer-head">
        <h2>🛒 장보기 목록</h2>
        <button type="button" class="drawer-x" data-close-cart="1" title="닫기 (Esc)">✕</button>
      </div>
      <div class="drawer-body">
        <div class="detail-top">
          <div>
            <div class="desc">담은 거 ${rows.length}개 · ${esc(serverName(d))} 판매가 기준 · 거래소 ${worlds}곳 돌면 된다 개굴 (재료비 큰 서버부터)${missing ? ` · 지금은 어느 순위에도 없어서 빠진 거 ${missing}개` : ""}</div>
          </div>
          <div class="kv">
            <div><span>재료비</span><b>${gil(cost)}</b></div>
            <div><span>판매액 (세후)</span><b>${gil(revenue)}</b></div>
            <div><span>예상 순이익</span><b>${signed(revenue - cost)}</b></div>
          </div>
        </div>
        <div class="cart-chips">${chips}<button type="button" class="cart-clear" data-clear="1">전부 비우기</button></div>
        <div class="cart-groups">${tables}</div>
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
    <tr><td>${itemName(f.name, f.stars)}</td><td><span class="job">${esc(f.job)}</span></td>
    <td class="num">${f.level}</td><td class="reason">${esc(f.reason)}</td></tr>`).join("");
  return `
    <details class="failed"${state.failedOpen ? " open" : ""}>
      <summary>계산할 수 없었던 레시피 (${failed.total.toLocaleString("ko-KR")}개)<span class="muted">팔린 기록이나 재료 시세가 없어서 계산 못 한 거다 개굴</span></summary>
      <div class="failed-body"><div class="table-wrap"><table>
        <thead><tr><th>아이템명</th><th>직업</th><th class="num">레시피 레벨</th><th>제외 사유</th></tr></thead>
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
  if (state.tab !== "all" && !data.jobs.includes(state.tab)) state.tab = "all";
  if (!(state.cat in data.cats)) state.cat = "all";
  if (!data.servers.some((s) => s.key === state.server)) state.server = "dc";

  function render() {
    const keepScroll = root.querySelector(".drawer-body")?.scrollTop;
    renderInner();
    const body = root.querySelector(".drawer-body");
    if (body && keepScroll != null) body.scrollTop = keepScroll;
  }
  function renderInner() {
    const rows = sortedRows(data);
    if (!data.rows.some((r) => r.id === state.selected)) state.selected = rows.length ? rows[0].id : null;
    const selected = data.rows.find((r) => r.id === state.selected);
    const cartCount = Object.keys(state.cart).length;
    const notice = data.notice
      ? `<div class="notice ${esc(data.notice.kind)}"><span>${data.notice.kind === "error" ? "⚠" : "⏳"}</span><span>${esc(data.notice.text)}</span></div>`
      : "";
    root.innerHTML =
      notice +
      renderSearch(data) +
      renderHeader(data) +
      renderTabs(data) +
      `<div class="section-head"><h2>순위 · ${esc(serverName(data))}</h2><span class="desc">줄 누르면 밑에 재료 상세가 나온다 개굴 · <b>+</b> 누르면 장보기에 담긴다 개굴</span>
         <span class="right">${cartCount ? `<button type="button" class="cart-jump" data-jump="1">🛒 장보기 ${cartCount}개 열기</button> · ` : ""}${esc(data.taxNote)} · 단위: 길</span></div>` +
      renderTable(data, rows) +
      renderDetail(data, selected) +
      renderFailed(data) +
      renderCart(data) +
      renderCartFab() +
      `<footer class="frog-foot"><span class="frog-sit">🐸</span> 개구리 좋아하는 <b>로살리아@초코보</b> 가 만들었다 개굴 · 문의도 여기로 해라 개굴</footer>`;
    state.cartAnim = false;
    state.fabBump = false;
    root.classList.toggle("with-drawer", !!(state.cartOpen && cartCount));
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
    if (e.target.closest("[data-clear]")) { state.cart = {}; state.cartOpen = false; saveCart(); return render(); }
    if (e.target.closest("[data-jump], [data-open-cart]")) { state.cartOpen = true; state.cartAnim = true; return render(); }
    if (e.target.closest("[data-close-cart]")) { state.cartOpen = false; return render(); }
    if (e.target.closest(".cart")) return;
    const go = e.target.closest("[data-goto]");
    if (go) {
      state.cat = "all";
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
    const cat = e.target.closest("[data-cat]");
    if (cat) {
      state.cat = cat.dataset.cat;
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
    const tr = e.target.closest("tr[data-id]");
    if (tr) {
      state.selected = Number(tr.dataset.id);
      render();
      root.querySelector(".detail")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  };
  root.onchange = (e) => {
    const input = e.target.closest("[data-count]");
    if (!input) return;
    const n = Math.max(1, Math.min(999, Math.round(Number(input.value) || 1)));
    state.cart[Number(input.dataset.count)] = n;
    saveCart();
    render();
  };

  // 그래프 툴팁: data-tip 이 있는 곳에 마우스를 올리면 뜬다
  root.onmousemove = (e) => {
    const hit = e.target.closest?.("[data-tip]");
    let tip = root.querySelector(".tip");
    if (!hit) { tip?.remove(); return; }
    if (!tip) { tip = document.createElement("div"); tip.className = "tip"; root.appendChild(tip); }
    tip.textContent = hit.dataset.tip;
    tip.style.left = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8) + "px";
    tip.style.top = e.clientY - 34 + "px";
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

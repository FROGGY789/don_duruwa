// 메인 대시보드: 헤더 · 요약 카드 · 탭 · 순위 표 · 재료 상세 · 계산 불가 목록
// 탭 전환, 정렬, 행 선택은 전부 브라우저에서 처리해서 클릭할 때 페이지가 다시 계산되지 않는다.

const COLUMNS = [
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
  { key: "daily", label: "하루 잠재 이익", num: true, sortable: true },
  { key: "updated", label: "데이터 업데이트", sortable: true },
  { key: "etc", label: "기타" },
];

const SOURCE_CLASS = { "거래소": "src-market", "NPC": "src-npc", "직접 제작": "src-craft", "직접 채집": "src-gather" };

// 탭·정렬·선택 상태는 다시 그려져도 유지되게 페이지에 보관
const state = (window.__ffxivDash = window.__ffxivDash || { cat: "all", tab: "all", sort: null, dir: -1, selected: null, sortSeed: null });
const CAT_ICON = { all: "✦", "가구": "🪑", "일반": "⚒" };

// 지금 고른 분류(전체/가구/일반)에 해당하는 행만
function catRows(d) {
  return d.rows.filter((r) => state.cat === "all" || r.cat === state.cat);
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
  const stats = d.stats[state.cat];
  const stat = (label, value, sub, accent) => `
    <div class="stat${accent ? " accent" : ""}">
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value">${value.toLocaleString("ko-KR")}<small>개</small></div>
      <div class="stat-sub">${esc(sub)}</div>
    </div>`;
  return `
    <header class="page-head">
      <div class="eyebrow">CRAFTING PROFIT REPORT</div>
      <h1>파판14 제작 수익 분석</h1>
      <div class="subtitle">${sub}</div>
    </header>
    ${renderCats(d)}
    <div class="stats">
      ${stat("분석한 레시피", stats.total, "조건에 맞는 전체 레시피")}
      ${stat("계산 가능", stats.calculable, "시세 데이터가 모두 있는 레시피")}
      ${stat("필터 통과", stats.passed, "현재 필터 기준 추천 대상", true)}
    </div>`;
}

function renderCats(d) {
  const btn = (key) =>
    `<button class="cat${state.cat === key ? " active" : ""}" data-cat="${esc(key)}">${CAT_ICON[key] || ""} ${esc(d.cats[key])}` +
    `<span class="cnt">${d.stats[key].passed}</span></button>`;
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
    const x = a[key], y = b[key];
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
    return `<th class="${cls}" ${c.sortable ? `data-sort="${c.key}"` : ""}>${esc(c.label.replace("{period}", d.period))}</th>`;
  }).join("");

  if (!rows.length) {
    return `<div class="table-wrap"><div class="empty">필터 통과한 기 하나도 없다. 왼쪽에서 조건 쪼매 풀어 봐라.</div></div>`;
  }
  const body = rows.map((r, i) => {
    const badges = r.badges.map((b) => `<span class="badge ${esc(b.kind)}">${esc(b.text)}</span>`).join("");
    return `
      <tr class="clickable${state.selected === r.id ? " selected" : ""}" data-id="${r.id}">
        <td><span class="rank${i < 3 ? " top" : ""}">${i + 1}</span></td>
        <td>${itemName(r.name, r.stars)}</td>
        <td><span class="job">${esc(r.job)}</span></td>
        <td class="num">${r.level}</td>
        <td class="num">${gil(r.sell)}</td>
        <td class="num">${gil(r.cost)}</td>
        <td class="num">${signed(r.net)}</td>
        <td class="num">${r.margin == null ? "-" : `<span class="pct ${r.margin >= 0 ? "pos" : "neg"}">${r.margin.toFixed(1)}%</span>`}</td>
        <td class="num">${r.sales}</td>
        <td class="num">${r.listings}</td>
        <td class="num">${gil(r.daily)}</td>
        <td><span class="upd${r.stale ? " stale" : ""}">${esc(r.updatedText)}</span></td>
        <td><div class="badges">${badges}</div></td>
      </tr>`;
  }).join("");
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderDetail(d, row) {
  if (!row) return `<div class="detail-hint">표에서 아이템 하나 눌러 봐라. 재료 상세 여기 뜬데이.</div>`;
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
            <div><span>판매 예상가</span><b>${gil(row.sell)}</b></div>
            <div><span>순수익</span><b>${signed(row.net)}</b></div>
          </div>
        </div>
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
      <summary>계산할 수 없었던 레시피 (${failed.total.toLocaleString("ko-KR")}개)<span class="muted">팔린 기록이나 재료 시세가 없어가 계산 몬 한 기다</span></summary>
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

  function render() {
    const rows = sortedRows(data);
    if (!rows.some((r) => r.id === state.selected)) state.selected = rows.length ? rows[0].id : null;
    const selected = data.rows.find((r) => r.id === state.selected);
    const notice = data.notice
      ? `<div class="notice ${esc(data.notice.kind)}"><span>${data.notice.kind === "error" ? "⚠" : "⏳"}</span><span>${esc(data.notice.text)}</span></div>`
      : "";
    root.innerHTML =
      notice +
      renderHeader(data) +
      renderTabs(data) +
      `<div class="section-head"><h2>순위</h2><span class="desc">줄 누르믄 밑에 재료 상세 나온데이</span>
         <span class="right">${esc(data.taxNote)} · 단위: 길</span></div>` +
      renderTable(data, rows) +
      renderDetail(data, selected) +
      renderFailed(data);
  }

  root.onclick = (e) => {
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
      state.dir = state.sort === key ? -state.dir : -1;
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
  if (!root.__toggleBound) {
    root.__toggleBound = true;
    root.addEventListener("toggle", (e) => {
      if (e.target.matches("details.failed")) state.failedOpen = e.target.open;
    }, true);
  }

  render();
}

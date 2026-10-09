// 정적 사이트 껍데기: 사이드바(설정·필터), 데이터 받기, 브라우저에서 순수익·필터·검색 계산 → dashboard.js 로 그리기
// 데이터는 GitHub Actions 가 매시간 만든다 (python -m ffxiv.build). 서버는 없다.
import dashboard from "./dashboard.js";

const THEMES = { "다크": "dark", "화이트": "light" };
const PALETTES = { "초록": "jade", "골드": "gold", "크리스탈": "crystal", "에테르": "aether", "로즈": "rose", "실버": "silver" };
const QUALITY_KEY = { NQ: "nq", HQ: "hq", "통합": "all" };
const SHARDS = 32;
const CRAFT_CATS = { all: "전체", "가구": "가구", "장비": "장비", "재료": "재료", "소모품": "소모품", "기타": "기타" };
const GATHER_CATS = { all: "전체", "일반": "일반", "시간 한정": "시간 한정", "크리스탈": "크리스탈" };
const EXCHANGE_CRAFT_CATS = { all: "전체", "군표": "군표", "제작자·채집가 화폐": "제작자·채집가 화폐", "알라그 석판": "알라그 석판" };
const EXCHANGE_CATS = { all: "전체", "군표": "군표", "제작자·채집가 화폐": "제작자·채집가 화폐", "알라그 석판": "알라그 석판", "기타 화폐": "기타 화폐" };
const MAX_RESULTS = 30, MAX_FAILED = 400;
const SITE_NAME = "에오르제아에서 장사꾼으로 살아남기";
const TAGLINE = {
  craft: "한국 데이터센터 거래소 시세로 뭘 만들어 팔면 남는지 수익을 분석해 준다 개굴. 시세는 매시간 새로 받아온다 개굴.",
  gather: "캐서 바로 팔면 얼마나 남는지, 하루에 얼마나 벌 수 있는지 순위를 매겨 준다 개굴. 시세는 매시간 새로 받아온다 개굴.",
  exchangeCraft: "군표·화폐·석판으로 바꾼 재료를 넣고, 나머지 재료는 장터에서 사서 만들면 얼마나 남는지 순위를 매겨 준다 개굴. 화폐 1개당 이익으로 비교해라 개굴.",
  exchange: "군표·화폐·석판으로 바꿔서 팔면 화폐 1개당 얼마나 남는지 알려준다 개굴. 어디서 바꾸는지도 같이 적어 뒀다 개굴.",
};

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
    sort: { "순수익": "net", "개당 순수익": "net", "수익률": "margin", "수익률(%)": "margin", "하루 잠재 이익": "daily", "화폐 1개당": "perCur" }[D[p].sort]
      || ({ gather: "daily", exchange: "perCur", exchangeCraft: "perCur" }[p] || "net"),
  });
  return {
    theme: "화이트", palette: "초록", quality: D.quality in QUALITY_KEY ? D.quality : "NQ",
    taxCity: meta.defaultTaxCity, staleHours: D.craft.filters.stale_hours ?? 72,
    craft: page("craft"), gather: page("gather"), exchange: page("exchange"), exchangeCraft: page("exchangeCraft"),
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
  if (who()) save("ffxivSettingsWho", who()); // 이 브라우저 설정이 어느 캐릭터 건지
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
const page = () => (location.hash === "#gather" ? "gather" : location.hash === "#track" ? "track" : location.hash === "#journal" ? "journal" : location.hash === "#fc" ? "fc" : location.hash === "#exchange" ? "exchange" : location.hash === "#exchange-craft" ? "exchangeCraft"
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
// ── 🔨 만들기 ↔ 🛒 사기: 중간재료마다 내가 고른 방법 (아이템ID → "craft" | "buy", 모든 레시피에 같이 적용) ──
let MAKE = load("ffxivMake", {});
function setMake(id, to) {
  if (to) MAKE[id] = to; else delete MAKE[id];
  save("ffxivMake", MAKE);
  render();
}
// 상세 재료(깊이 순 펼침)에 내 선택을 반영해서 재료 표·장보기·원가를 다시 만든다
function applyMakes(d, resultAmount) {
  const alts = d.alts || {};
  const tree = (rows) => {
    const top = [], stack = [];
    for (const r of rows) {
      const n = { ...r, kids: [] };
      while (stack.length && stack[stack.length - 1].depth >= r.depth) stack.pop();
      (stack.length ? stack[stack.length - 1].kids : top).push(n);
      stack.push(n);
    }
    return top;
  };
  let changed = false;
  const choose = (n, seen) => {
    const alt = alts[n.id], want = MAKE[n.id], made = n.source === "직접 제작";
    // 바꿔 볼 수 있는 쪽 (상세 표 버튼용)
    if (alt) n.other = { to: made ? "buy" : "craft", unit: alt.unit, src: alt.src };
    if (alt && want && (want === "craft") !== made && !seen.has(n.id)) {
      changed = true;
      const back = { to: made ? "craft" : "buy", unit: n.unit, src: n.source };
      if (want === "buy") Object.assign(n, { source: alt.src, unit: alt.unit, world: alt.world || "", sold: alt.sold, listings: alt.listings, ra: undefined, kids: [] });
      else Object.assign(n, { source: "직접 제작", unit: alt.unit, world: "", ra: alt.ra, kids: tree(alt.kids || []) });
      n.other = back;
      n.picked = true;
    }
    const next = new Set(seen).add(n.id);
    n.kids.forEach((k) => choose(k, next));
  };
  const top = tree(d.materials);
  top.forEach((n) => choose(n, new Set()));
  // 필요 수량은 위에서 아래로, 직접 만드는 단가는 아래에서 위로 다시
  const needs = (n) => {
    if (!n.kids.length) return;
    const crafts = Math.ceil(n.need / (n.ra || 1) - 1e-9);
    n.kids.forEach((k) => { k.need = k.amount * crafts; needs(k); });
  };
  const units = (n) => {
    if (!n.kids.length) return n.unit;
    let sum = 0;
    for (const k of n.kids) { const u = units(k); if (u == null) { sum = null; break; } sum += u * k.amount; }
    if (changed) n.unit = sum == null ? null : sum / (n.ra || 1);
    return n.unit;
  };
  top.forEach((n) => { needs(n); units(n); });
  const materials = [], shop = {}, makes = {};
  const flat = (n, depth, qty, via) => {
    n.subtotal = n.unit != null ? n.unit * n.amount : null;
    const { kids, ...row } = n;
    materials.push({ ...row, depth });
    if (n.source === "직접 제작" && kids.length) {
      const mk = makes[n.id] || (makes[n.id] = { id: n.id, name: n.name, t: n.t, qty: 0, ra: n.ra || 1, via: via.slice() });
      mk.qty += qty;
      kids.forEach((k) => flat(k, depth + 1, (qty * k.amount) / (n.ra || 1), [n.name, ...via]));
      return;
    }
    const world = n.source === "거래소" ? (n.world && !n.world.startsWith("매물 없음") ? n.world.split(" (")[0] : "서버 미정") : "";
    const key = `${n.id}|${n.source}|${world}`;
    const s = shop[key] || (shop[key] = { id: n.id, name: n.name, qty: 0, unit: n.unit, source: n.source, world, g: n.g, gl: n.gl, t: n.t, via: [],
      canCraft: !!(alts[n.id] && alts[n.id].src === "직접 제작") });
    s.qty += qty;
    if (via.length && !s.via.some((v) => v.join() === via.join())) s.via.push(via.slice());
  };
  top.forEach((n) => flat(n, 0, n.amount, []));
  const cost = top.every((n) => n.unit != null) ? top.reduce((a, n) => a + n.unit * n.amount, 0) / resultAmount : null;
  return { materials, shopping: Object.values(shop), makes: Object.values(makes), cost, changed };
}

// 상세(근거·재료·추이)를 받으면 그 줄에 붙인다
function mergeDetail(ds, id) {
  const row = ds.cache[id], d = ds.details[id];
  if (!row || !d) return;
  row.evidence = d.evidence;
  row.detailDesc = d.detailDesc;
  if (d.sources) row.sources = d.sources;
  if (d.materials) {
    const m = applyMakes(d, row.resultAmount || 1);
    Object.assign(row, { materials: m.materials, shopping: m.shopping, makes: m.makes, madeChanged: m.changed });
    if (m.changed && m.cost != null) row.cost = m.cost;
  }
  for (const [k, v] of Object.entries(d.views || {})) Object.assign(row.views[k] || (row.views[k] = {}), v);
  row.loaded = true;
}

// ── ⚡ 품목을 누르면 그 템 시세만 Universalis 에서 바로 다시 받는다 (표는 매시간 받아 둔 값) ──
const UNIVERSALIS = "https://universalis.app/api/v2";
async function loadLive(row) {
  const dc = encodeURIComponent(meta.dc), id = row.item;
  const [cur, hist] = await Promise.all([
    fetch(`${UNIVERSALIS}/${dc}/${id}?listings=100&entries=0`).then((r) => { if (!r.ok) throw new Error(`시세 ${r.status}`); return r.json(); }),
    fetch(`${UNIVERSALIS}/history/${dc}/${id}?entriesWithin=${meta.hours * 3600}&entriesToReturn=999`).then((r) => (r.ok ? r.json() : { entries: [] })),
  ]);
  fcLive(id, cur.listings || []);
  const want = (x) => row.sellingHq == null || !!x.hq === row.sellingHq; // 판매 품질에 맞는 것만
  const names = Object.fromEntries(meta.servers.filter((s) => s.key !== "dc").map((s) => [s.key, s.name]));
  const listings = (cur.listings || []).filter(want), sales = (hist.entries || []).filter(want);
  const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const one = (key) => {
    const ls = key === "dc" ? listings : listings.filter((l) => String(l.worldID) === key);
    const ss = key === "dc" ? sales : sales.filter((x) => String(x.worldID) === key);
    const last = ss.reduce((a, x) => (!a || x.timestamp > a.timestamp ? x : a), null);
    const up = key === "dc" ? cur.lastUploadTime : (cur.worldUploadTimes || {})[key];
    return { key, name: key === "dc" ? "통합" : names[key] || key, min: ls.length ? Math.min(...ls.map((l) => l.pricePerUnit)) : null,
      listings: ls.length, sales: ss.length, median: med(ss.map((x) => x.pricePerUnit)),
      last: last ? { price: last.pricePerUnit, qty: last.quantity, ago: ago(last.timestamp) } : null,
      uploaded: up ? ago(up / 1000) : "기록 없음" };
  };
  const tax = taxRate(), dcv = one("dc");
  const mats = row.materials ? await liveMaterials(row) : null;
  const cost = mats ? mats.cost : row.cost;
  return { at: Date.now(), time: fmtTime(Date.now() / 1000).slice(11), period: PERIOD(), tax,
    sell: dcv.median, cost, mats: mats && mats.rows,
    net: dcv.median != null && cost != null ? dcv.median * (1 - tax) - cost : null,
    worlds: ["dc", ...Object.keys(names)].map(one) };
}

// 거래소에서 사는 재료는 지금 매물로 필요 수량만큼 싼 것부터 샀을 때 값을 다시 계산한다 (구매세 포함)
async function liveMaterials(row) {
  const ms = row.materials, buy = ms.filter((m) => m.source === "거래소" && m.id);
  const ids = [...new Set(buy.map((m) => m.id))];
  if (!ids.length) return null;
  const res = await fetch(`${UNIVERSALIS}/${encodeURIComponent(meta.dc)}/${ids.join(",")}?listings=100&entries=0`);
  if (!res.ok) throw new Error(`재료 시세 ${res.status}`);
  const data = await res.json();
  const items = ids.length === 1 ? { [ids[0]]: data } : data.items || {};
  const names = Object.fromEntries(meta.servers.map((s) => [s.key, s.name]));
  const buyTax = meta.buyerTax ?? 0.05;
  const price = (id, need) => {
    const ls = ((items[id] || {}).listings || []).slice().sort((a, b) => a.pricePerUnit - b.pricePerUnit);
    let got = 0, spent = 0; const worlds = [];
    for (const l of ls) {
      const take = Math.min(l.quantity, need - got);
      got += take; spent += take * l.pricePerUnit;
      const w = names[String(l.worldID)] || l.worldName || "";
      if (w && !worlds.includes(w)) worlds.push(w);
      if (got >= need) break;
    }
    return got ? { unit: (spent / got) * (1 + buyTax), short: got < need, worlds: worlds.join(", "), cheapest: ls[0].pricePerUnit } : null;
  };
  // 아래에서 위로: 산 재료는 지금 값, 직접 만드는 중간재료는 하위 재료값이 바뀐 비율만큼
  const now = ms.map((m) => ({ ...m, now: m.unit, live: null }));
  for (let i = now.length - 1; i >= 0; i--) {
    const m = now[i];
    if (m.source === "거래소" && m.id) {
      const p = price(m.id, m.need);
      if (p) { m.now = p.unit; m.live = p; }
      continue;
    }
    let j = i + 1, oldSum = 0, newSum = 0;
    while (j < now.length && now[j].depth > m.depth) {
      if (now[j].depth === m.depth + 1) { oldSum += (now[j].unit || 0) * now[j].amount; newSum += (now[j].now || 0) * now[j].amount; }
      j++;
    }
    if (j > i + 1 && oldSum > 0 && m.unit != null) m.now = m.unit * (newSum / oldSum);
  }
  const top = now.filter((m) => m.depth === 0);
  const oldTop = top.reduce((a, m) => a + (m.unit || 0) * m.amount, 0), newTop = top.reduce((a, m) => a + (m.now || 0) * m.amount, 0);
  return { cost: row.cost != null && oldTop > 0 ? row.cost * (newTop / oldTop) : row.cost, rows: now };
}

// ── 계산: 판매세 넣은 순수익, 필터, 통계, 검색 ──
function compute(p, ds, name) {
  const F = S[p], tax = taxRate(), now = Date.now() / 1000;
  const keys = meta.servers.map((s) => s.key);
  const C = S.craft; // 교환 재료로 만들기는 레시피·직업 레벨을 제작 설정으로 거른다
  const inScope = (r) => {
    if (p === "exchange") return true;
    if (p === "exchangeCraft") return r.level >= C.levelMin && r.level <= C.levelMax && r.level <= (C.jobLevels[r.craftJob] ?? 100);
    return r.level >= F.levelMin && r.level <= F.levelMax && r.level <= (F.jobLevels[r.job] ?? 100);
  };
  const staleTip = `시세가 마지막으로 올라온 지 ${S.staleHours}시간 넘었다 개굴. 지금 게임 시세랑 다를 수 있다 개굴.`;

  function failReasons(r, v) {
    const out = [];
    if (v.sales < F.minSales) out.push(`${PERIOD()} 판매 ${v.sales}건 (기준 ${F.minSales}건↑)`);
    if (p === "craft" && (r.matRatio ?? Infinity) < F.matRatio) out.push(`재료 판매량 ${r.matRatio.toFixed(1)}배 (기준 ${F.matRatio}배↑)`);
    if (p === "craft" && (v.margin ?? -Infinity) < F.minMargin) out.push(v.margin == null ? "수익률 계산 못 했다 개굴" : `수익률 ${v.margin.toFixed(0)}% (기준 ${F.minMargin}%↑)`);
    if (v.net < F.minProfit) out.push(`${p === "craft" ? "" : "개당 "}순수익 ${Math.round(v.net).toLocaleString("ko-KR")}길 (기준 ${Number(F.minProfit).toLocaleString("ko-KR")}길↑)`);
    if (v.listings > F.maxListings) out.push(`매물 ${v.listings}건 (기준 ${F.maxListings}건↓)`);
    if (F.maxDays && (v.sellDays == null || v.sellDays > F.maxDays)) out.push(v.sellDays == null ? "판매 소요일 모름" : `판매 소요 ~${Math.ceil(v.sellDays)}일 (기준 ${F.maxDays}일↓)`);
    return out;
  }

  const rows = ds.rows.map((r) => {
    const row = ds.cache[r.id] || (ds.cache[r.id] = { views: {} });
    const stale = (r.updated || 0) < now - S.staleHours * 3600;
    const scope = inScope(r);
    Object.assign(row, {
      mat: r.mat, matQty: r.matQty, spend: r.spend,
      tier: r.tier, id: r.id, item: r.item, name: r.name, stars: r.stars, job: r.job, level: r.level, cost: r.cost, cat: r.cat, sub: r.sub,
      updated: r.updated, updatedText: ago(r.updated), stale, sellingHq: r.hq, resultAmount: r.resultAmount,
      badges: (stale ? [{ kind: "stale", text: "⚠ 데이터 오래됨", tip: staleTip }] : []).concat(r.badges),
      scope, raw: r,
    });
    if (ds.details[r.id]) mergeDetail(ds, r.id); // 🔨↔🛒 내 선택이 있으면 원가가 바뀐다
    for (const k of keys) {
      const s = r.v[k];
      const v = row.views[k] || (row.views[k] = {});
      const net = s.sell != null && row.cost != null ? s.sell * (1 - tax) - row.cost : null;
      Object.assign(v, s, {
        net, margin: net != null && row.cost > 0 ? (net / row.cost) * 100 : null,
        daily: net != null ? (net * s.soldQty) / days() : null,
        // 화폐 1개당 이익: 교환템 팔기 = 개당 순수익 × 받는 개수 ÷ 교환가, 교환 재료로 만들기 = 1회 제작 순수익 ÷ 드는 화폐
        perCur: net == null ? null : p === "exchange" ? (net * r.resultAmount) / r.level : p === "exchangeCraft" ? (net * r.resultAmount) / r.spend : null,
      });
      v.reasons = net == null ? null : failReasons(row, v);
      v.passes = scope && net != null && !v.reasons.length;
    }
    if (ds.details[r.id]) mergeDetail(ds, r.id);
    return row;
  });

  const cats = { craft: CRAFT_CATS, gather: GATHER_CATS, exchange: EXCHANGE_CATS, exchangeCraft: EXCHANGE_CRAFT_CATS }[p];
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
    if (p === "exchangeCraft" && !r.scope) { kind = "out"; why = `${r.raw.craftJob} Lv${r.level} — ⚒️ 제작 설정의 레시피·직업 레벨 밖이다 개굴`; }
    else if (!p.startsWith("exchange") && !(r.level >= F.levelMin && r.level <= F.levelMax)) { kind = "out"; why = `${p === "craft" ? "레시피" : "채집"} Lv${r.level} — 레벨 범위 ${F.levelMin}~${F.levelMax} 밖이다 개굴`; }
    else if (!p.startsWith("exchange") && r.level > (F.jobLevels[r.job] ?? 100)) { kind = "out"; why = `${r.job} 레벨 ${F.jobLevels[r.job]} < Lv${r.level} 이다 개굴`; }
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
let lastPage = null;
async function render() {
  if (page() === "admin") return renderAdmin();
  if (page() === "track") return renderTrack();
  if (page() === "journal") return renderJournal();
  if (page() === "fc") return renderFc();
  const p = page(), name = p === "exchange" ? "exchange" : `${p}-${QUALITY_KEY[S.quality]}`;
  // 교환은 화폐마다 값어치가 달라서, 처음 들어오면 군표부터 보여준다
  if (p !== lastPage) {
    const st = window.__ffxivDash;
    if (st && p === "exchange") { st.cat = "군표"; st.tab = "all"; }
    else if (st && p === "exchangeCraft") { st.cat = "제작자·채집가 화폐"; st.tab = "all"; }
    else if (st && String(lastPage).startsWith("exchange")) { st.cat = "all"; st.tab = "all"; }
    lastPage = p;
  }
  let ds;
  try { ds = await dataset(name); } catch (e) {
    document.getElementById("app").innerHTML = `<div class="boot">⚠ 데이터를 못 받아왔다 개굴. 조금 있다가 새로고침 해 봐라 개굴. (${esc(e.message)})</div>`;
    return;
  }
  if (!FCS && !fcLoading) fcLoading = fcSalesLoad().then(() => { if (!["admin", "track", "journal", "fc"].includes(page())) render(); }, () => {});
  const { rows, stats, failed, cats, tax } = compute(p, ds, name);
  const F = S[p];
  const app = document.getElementById("app");
  let host = app.querySelector(".dash-host");
  if (!host) {
    app.innerHTML = `<div class="search-wrap"><input id="search" type="search" placeholder="${{ craft: "🔍 아이템 이름으로 찾기 (예: 모그루 모그, 루비)", gather: "🔍 채집템 이름으로 찾기 (예: 구리 광석, 라벤더)", exchange: "🔍 교환템 이름으로 찾기 (예: 마테리쟈, 암흑물질)", exchangeCraft: "🔍 만들 템 이름으로 찾기" }[p]}" autocomplete="off"></div><div class="dash-host"></div>`;
    host = app.querySelector(".dash-host");
    const input = app.querySelector("#search");
    input.value = query;
    let timer;
    input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { query = input.value.trim(); render(); }, 250); });
  }
  const data = {
    mode: p,
    title: SITE_NAME,
    titleHtml: `<b class="initial">에</b>오르제아에서 <b class="initial">장</b>사꾼으로 <b class="initial">살</b>아남기`, // 줄임말 에·장·살 을 굵게
    tagline: TAGLINE[p],
    statLabels: { gather: [["분석한 채집템", "레벨 조건에 맞는 채집템"], ["시세 있는 템", "최근 팔린 기록이 있는 템"], ["필터 통과", "현재 필터 기준 추천 대상"]],
      exchangeCraft: [["교환 재료 레시피", "교환 재료가 들어가는 레시피 × 화폐"], ["계산 가능", "시세 데이터가 모두 있는 레시피"], ["필터 통과", "현재 필터 기준 추천 대상"]],
      exchange: [["교환템", "제작·채집 순위에 없는 교환템"], ["시세 있는 템", "최근 팔린 기록이 있는 템"], ["필터 통과", "현재 필터 기준 추천 대상"]] }[p],
    subtitle: [meta.world, `판매 시세 ${meta.dc} 서버별`, ...(p === "craft" ? [`재료 구매 ${meta.dc} 전체`] : []),
      ...(p === "exchange" ? [] : p === "exchangeCraft" ? [`레시피 레벨 ${S.craft.levelMin}~${S.craft.levelMax} (제작 설정)`]
        : [`${p === "craft" ? "레시피" : "채집"} 레벨 ${F.levelMin}~${F.levelMax}`]), `시세 갱신 ${fmtTime(meta.updatedAt)}`],
    notice: null,
    search: search(p, rows, query),
    servers: meta.servers,
    cats,
    catIcons: { gather: { all: "✦", "일반": "⛏", "시간 한정": "⏰", "크리스탈": "💎" },
      exchangeCraft: { all: "✦", "군표": "🎖", "제작자·채집가 화폐": "🪙", "알라그 석판": "🔷" },
      exchange: { all: "✦", "군표": "🎖", "제작자·채집가 화폐": "🪙", "알라그 석판": "🔷", "기타 화폐": "🎟" } }[p],
    subs: p === "craft" ? meta.subs : {},
    quality: S.quality,
    stats,
    jobs: { craft: meta.jobs, gather: meta.gatherJobs }[p] || [],
    dynamicTabs: p.startsWith("exchange"),
    period: PERIOD(),
    sort: F.sort,
    taxNote: `판매세 ${Math.round(tax * 100)}% 반영`,
    taxRate: tax,
    rows,
    failed,
    failedTitle: { gather: "시세를 몰라서 빠진 채집템", exchange: "시세를 몰라서 빠진 교환템", exchangeCraft: "계산 못 한 레시피" }[p],
    failedHead: { gather: ["직업", "채집 레벨"], exchange: ["화폐", "교환가"], exchangeCraft: ["화폐", "레시피 레벨"] }[p],
    failedNote: p === "craft" ? undefined : "최근 팔린 기록이 없어서 계산 못 한 거다 개굴",
    loadDetail: (id) => loadDetail(name, id),
    loadLive,
    materialInfo,
    setMake: (id, to) => { const sel = ds.cache[window.__ffxivDash?.selected]; if (sel) sel.live = null; setMake(id, to); },
    makeChoice: (id) => MAKE[id] || null,
    fcSelling,
    fcMarked,
    fcToggle,
    // 장보기 '📒 만들었다': 담은 걸 오늘 제작일지에 적는다 (HQ 줄은 ID 를 원래 레시피로)
    logCraft: async (list) => {
      await journalLoad();
      journalAdd(list.map(({ id, n }) => ({ rid: id >= 10_000_000 ? id - 10_000_000 : id, n })));
    },
    buyerTax: meta.buyerTax,
    // 장보기 ⚡: 여러 재료 매물을 한 번에 (100개씩)
    fetchListings: async (ids) => {
      const names = Object.fromEntries(meta.servers.map((s) => [s.key, s.name]));
      const out = {};
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const res = await fetch(`${UNIVERSALIS}/${encodeURIComponent(meta.dc)}/${chunk.join(",")}?listings=100&entries=0`);
        if (!res.ok) throw new Error(`시세 ${res.status}`);
        const data = await res.json();
        const items = chunk.length === 1 ? { [chunk[0]]: data } : data.items || {};
        for (const id of chunk) {
          out[id] = ((items[id] || {}).listings || []).map((l) => ({ price: l.pricePerUnit, qty: l.quantity, hq: !!l.hq, world: names[String(l.worldID)] || l.worldName || "?" }));
        }
      }
      return out;
    },
    // 재료 이름을 누르면 📈 재료 트래킹에 담고 그리로 간다
    trackMaterial: (id, need) => {
      const list = tracked();
      if (!list.some((t) => t.id === id)) { list.unshift({ id, qty: need }); saveTracked(list); }
      location.hash = "#track";
    },
  };
  dashboard({ data, parentElement: host });
}

// ── 📒 나의 제작일지 ──
// 기록: {e: [[날짜 "YYYY-MM-DD", 레시피ID, 제작 횟수], ...], at: 고친 시각} — 캐릭터마다 서버(KV)에 저장, 이 브라우저에도 복사
let J = null, jQuery = "", jPick = null, jTimer = 0;
const jOpen = new Set(); // 단골 재료 중 펼쳐 본 것
// 최근 판매: 7일에 기록이 없으면 14일까지 넓혀서 (한국 전체, 하루 중앙값을 팔린 개수로 가중 평균)
function saleStats(d) {
  for (const n of [7, 14]) {
    const hs = d.h.slice(-n).map((h) => h[1].dc).filter((x) => x && x[0] != null);
    const units = hs.reduce((a, x) => a + (x[1] || 0), 0);
    if (!hs.length || !units) continue;
    return { days: n, units, count: hs.reduce((a, x) => a + (x[2] || 0), 0), med: median(hs.map((x) => x[0])),
      avg: hs.reduce((a, x) => a + x[0] * (x[1] || 0), 0) / units };
  }
  return null;
}
const JOURNAL_DAYS = 365, JOURNAL_MAX = 5000;
const ymd = (t) => { const p2 = (n) => String(n).padStart(2, "0"); return `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}`; };
const daysAgo = (n) => ymd(new Date(Date.now() - n * 86400000));
async function journalLoad() {
  if (J) return J;
  const key = `ffxivJournal:${who()}`;
  J = load(key, null);
  if (who()) {
    try {
      const res = await fetch("/__journal", { cache: "no-cache" });
      const remote = res.ok ? (await res.json()).journal : null;
      if (remote && (!J || (remote.at || 0) >= (J.at || 0))) J = remote;
    } catch { /* 서버 못 가면 이 브라우저 것만 */ }
  }
  J = J && Array.isArray(J.e) ? J : { e: [], at: 0 };
  return J;
}
function journalSave() {
  const cut = daysAgo(JOURNAL_DAYS);
  J.e = J.e.filter((x) => x[0] >= cut).slice(-JOURNAL_MAX);
  J.at = Date.now();
  save(`ffxivJournal:${who()}`, J);
  if (!who()) return;
  clearTimeout(jTimer);
  jTimer = setTimeout(() => fetch("/__journal", { method: "PUT", body: JSON.stringify(J) }).catch(() => {}), 800);
}
function journalAdd(list, day = ymd(new Date())) {
  for (const { rid, n } of list) {
    if (!rid || !(n > 0)) continue;
    const same = J.e.find((x) => x[0] === day && x[1] === rid);
    if (same) same[2] += n; else J.e.push([day, rid, n]);
  }
  J.e.sort((a, b) => a[0].localeCompare(b[0]));
  journalSave();
}
const jTier = (t) => (t ? ` <span class="tier-mark t${Math.min(t, 3)}" data-tip="${t}차 제작">${t}차</span>` : "");
const jGather = (g) => (g ? g.split("·").map((j) => ` <span class="gather-mark ${j === "광부" ? "mine" : "botany"}" title="${esc(j)} 로 언제든 캘 수 있다 개굴">${j === "광부" ? "⛏" : "🌿"}</span>`).join("") : "");
async function renderJournal() {
  const app = document.getElementById("app");
  if (!app.querySelector(".journal")) app.innerHTML = `<div class="boot">🐸 제작일지 불러오는 중이다 개굴…</div>`;
  await journalLoad();
  let ds;
  try { ds = await dataset("craft-nq"); } catch (e) { app.innerHTML = `<div class="boot">⚠ 레시피 목록을 못 받아왔다 개굴. (${esc(e.message)})</div>`; return; }
  const byId = new Map(ds.rows.map((r) => [r.id, r]));
  const q = jQuery.replace(/\s/g, "");
  const sugg = q ? ds.rows.filter((r) => r.name.replace(/\s/g, "").includes(q)).slice(0, 10) : [];
  // 최근 30일: 자주 만든 것, 거기 들어간 재료
  const since = daysAgo(30), freq = {};
  J.e.filter((x) => x[0] >= since).forEach(([, rid, n]) => (freq[rid] = (freq[rid] || 0) + n));
  const rids = Object.keys(freq).map(Number).filter((id) => byId.has(id));
  await Promise.all(rids.map((id) => loadDetail("craft-nq", id).catch(() => null)));
  const mats = {};
  for (const rid of rids) {
    for (const s of (ds.details[rid] || {}).shopping || []) {
      const m = mats[s.id] || (mats[s.id] = { id: s.id, name: s.name, qty: 0, for: [], t: s.t, g: s.g, market: false });
      m.qty += s.qty * freq[rid];
      if (s.source === "거래소") m.market = true;
      const nm = byId.get(rid).name;
      if (!m.for.includes(nm)) m.for.push(nm);
    }
  }
  const matList = Object.values(mats).filter((m) => m.market).sort((a, b) => b.qty - a.qty).slice(0, 40);
  // 판단은 📈 재료 트래킹이랑 같은 방법 (있는 기록만큼 써서, 근거를 같이 보여준다)
  const tds = await Promise.all(matList.map((m) => trackShard(m.id).then((sh) => sh[m.id] || null).catch(() => null)));
  const SIG = { buy: "good", wait: "bad" };
  const matRows = matList.map((m, i) => {
    const d = tds[i], need = Math.ceil(m.qty), open = jOpen.has(m.id);
    const a = d ? analyzeTrack(m.id, d, need) : null, s = d ? saleStats(d) : null;
    const head = `<tr class="${a ? SIG[a.signal.kind] || "" : ""}${open ? " j-on" : ""}">
      <td><button type="button" class="mat-link" data-j-open="${m.id}" title="눌러서 그래프·서버별 매물 보기">${open ? "▾" : "▸"} ${esc(m.name)}</button>${jTier(m.t)}${jGather(m.g)}
        <div class="mat-for">↳ ${esc(m.for.slice(0, 3).join(" · "))}${m.for.length > 3 ? " …" : ""}</div></td>
      <td class="num">${need.toLocaleString("ko-KR")}</td>
      <td>${a && a.best ? `${esc(a.best.name)} <b>${gil(a.cur)}</b>` : '<span class="faint">매물 없음</span>'}</td>
      <td class="num">${a && a.refDays ? `<b>${gil(a.ref)}</b><div class="j-basis">${esc(a.basis)}${a.basis.includes("중앙값") ? "" : "의 중앙값"}</div>` : '<span class="faint">기록 없음</span>'}</td>
      <td class="num">${s ? `평균 <b>${gil(s.avg)}</b> · 중앙값 ${gil(s.med)}<div class="j-basis">최근 ${s.days}일 · ${s.count.toLocaleString("ko-KR")}건 · ${s.units.toLocaleString("ko-KR")}개</div>`
        : '<span class="faint">최근 14일 판매 없음</span>'}</td>
      <td class="sig">${a ? `${a.signal.icon} ${esc(a.signal.label)}` : "-"}</td></tr>`;
    if (!open) return head;
    return head + `<tr class="j-detail"><td colspan="6">${a ? `<div class="track-card j-track">${trackBody(a, { id: m.id, qty: need }, false)}</div>` : '<p class="faint">시세 기록이 없다 개굴.</p>'}
      <div class="j-detail-foot"><button type="button" class="cart-btn" data-j-track="${m.id}" data-need="${need}">📈 재료 트래킹에 담기</button></div></td></tr>`;
  }).join("");
  const top = Object.entries(freq).filter(([id]) => byId.has(Number(id))).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([id, n]) => `<li><span>${esc(byId.get(Number(id)).name)}</span><b>×${n}</b></li>`).join("");
  // 날짜별 기록 (최근 것부터)
  const days = {};
  J.e.forEach((x, i) => (days[x[0]] = days[x[0]] || []).push([x, i]));
  const log = Object.keys(days).sort().reverse().slice(0, 30).map((d) => `<div class="j-day"><div class="j-date">${esc(d)}</div><ul>${days[d].map(([x, i]) =>
    `<li><span>${esc((byId.get(x[1]) || { name: `레시피 ${x[1]}` }).name)}</span><b>×${x[2]}</b><button type="button" class="chip-x" data-j-del="${i}" title="지우기">✕</button></li>`).join("")}</ul></div>`).join("");
  const keep = app.querySelector("#j-search");
  const caret = keep && document.activeElement === keep ? keep.selectionStart : null;
  app.innerHTML = `<section class="journal">
    <div class="eyebrow">CRAFTING JOURNAL</div><h1>📒 나의 제작일지</h1>
    <p class="tagline">만든 걸 적어 두면 자주 쓰는 재료를 모아서, 평소보다 싸게 올라왔을 때 미리 사 두라고 알려준다 개굴.</p>
    <div class="j-card j-add">
      <h2>✏️ 만든 거 적기</h2>
      <input id="j-search" type="search" placeholder="🔍 만든 템 이름 (예: 파인애플 케이크)" autocomplete="off" value="${esc(jQuery)}">
      ${sugg.length ? `<div class="track-sugg">${sugg.map((r) => `<button type="button" data-j-pick="${r.id}">${esc(r.name)} <small>${esc(r.job)} Lv${r.level}</small></button>`).join("")}</div>`
        : q ? `<div class="track-sugg"><span class="faint">그런 레시피는 없다 개굴.</span></div>` : ""}
      ${jPick && byId.has(jPick) ? `<div class="j-pick"><b>${esc(byId.get(jPick).name)}</b>
        <label>횟수 <input type="number" id="j-n" min="1" max="999" value="1"></label>
        <label>날짜 <input type="date" id="j-d" value="${ymd(new Date())}"></label>
        <button type="button" class="btn" data-j-add="1">📒 기록</button></div>` : ""}
    </div>
    <div class="j-grid">
      <div class="j-card"><div class="j-head"><h2>🧺 단골 재료 · 최근 30일</h2>
        ${matList.length ? `<button type="button" class="cart-btn" data-j-trackall="1">📈 전부 트래킹에 담기</button>` : ""}</div>
        ${matList.length ? `<div class="table-wrap"><table><thead><tr><th>재료</th><th class="num">30일 사용</th><th>제일 싼 곳 (지금 매물)</th><th class="num" title="상태(🟢🟡🔴)를 정할 때 비교한 값 개굴">평소 가격 (판단 기준)</th><th class="num">최근 판매가</th><th>상태</th></tr></thead>
          <tbody>${matRows}</tbody></table></div>` : `<div class="detail-hint">🐸 아직 기록이 없다 개굴. 위에서 만든 걸 적거나, 장보기에서 '📒 만들었다' 를 눌러라 개굴.</div>`}</div>
      <div class="j-card"><h2>🏆 자주 만드는 것 · 최근 30일</h2>${top ? `<ul class="j-top">${top}</ul>` : `<div class="faint">아직 없다 개굴.</div>`}</div>
    </div>
    <div class="j-card"><h2>🗓 기록</h2>${log || `<div class="faint">아직 없다 개굴.</div>`}</div>
  </section>`;
  if (caret != null) { const el = app.querySelector("#j-search"); el.focus(); el.setSelectionRange(caret, caret); }
}
document.getElementById("app").addEventListener("input", (e) => {
  if (e.target.id !== "j-search") return;
  jQuery = e.target.value;
  clearTimeout(renderJournal.t);
  renderJournal.t = setTimeout(renderJournal, 200);
});
document.getElementById("app").addEventListener("click", (e) => {
  if (page() !== "journal") return;
  const op = e.target.closest("[data-j-open]");
  if (op) { const id = Number(op.dataset.jOpen); if (jOpen.has(id)) jOpen.delete(id); else jOpen.add(id); renderJournal(); return; }
  const pick = e.target.closest("[data-j-pick]");
  if (pick) { jPick = Number(pick.dataset.jPick); jQuery = ""; renderJournal(); return; }
  if (e.target.closest("[data-j-add]")) {
    const n = Math.max(1, Math.min(999, Math.round(Number(document.getElementById("j-n").value) || 1)));
    const d = document.getElementById("j-d").value || ymd(new Date());
    journalAdd([{ rid: jPick, n }], d);
    jPick = null; renderJournal(); return;
  }
  const del = e.target.closest("[data-j-del]");
  if (del) { J.e.splice(Number(del.dataset.jDel), 1); journalSave(); renderJournal(); return; }
  const one = e.target.closest("[data-j-track]");
  if (one) {
    const list = tracked(), id = Number(one.dataset.jTrack);
    if (!list.some((t) => t.id === id)) { list.unshift({ id, qty: Number(one.dataset.need) || 1 }); saveTracked(list); }
    location.hash = "#track"; return;
  }
  if (e.target.closest("[data-j-trackall]")) {
    const list = tracked();
    app_journalMats().forEach(({ id, qty }) => { if (!list.some((t) => t.id === id)) list.push({ id, qty }); });
    saveTracked(list);
    location.hash = "#track";
  }
});
// 지금 화면의 단골 재료 (전부 트래킹에 담기용)
function app_journalMats() {
  return [...document.querySelectorAll(".journal [data-j-track]")].map((b) => ({ id: Number(b.dataset.jTrack), qty: Number(b.dataset.need) || 1 }));
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
// 재료에 마우스 올렸을 때: 서버별 지금 최저 매물(미끼 뺌), 한국 전체 최근 7일 평균 판매가
const matInfoCache = {};
function materialInfo(id) {
  return (matInfoCache[id] = matInfoCache[id] || trackShard(id).then((sh) => {
    const d = sh[id];
    if (!d) return null;
    const names = Object.fromEntries(meta.servers.filter((s) => s.key !== "dc").map((s) => [s.key, s.name]));
    const worlds = Object.entries(d.w).map(([wid, w]) => {
      const good = w.lst.filter((l) => !l[3]);
      return { name: names[wid] || wid, min: good.length ? good[0][0] : null, qty: good.length ? good[0][1] : 0, cnt: w.cnt };
    }).filter((x) => x.min != null).sort((a, b) => a.min - b.min);
    const recent = d.h.slice(-7).map((h) => h[1].dc).filter(Boolean); // [중앙값, 팔린 수량, 건수]
    const sold = recent.reduce((a, x) => a + x[1], 0);
    // 지난날(오늘 빼고 최근 14일) 하루 최저 매물들의 가운데 값 — "평소 제일 쌀 때 얼마였나"
    const lows = d.h.slice(-15, -1).map((h) => Math.min(...Object.values(h[2] || {}))).filter((x) => Number.isFinite(x));
    const lowMed = lows.length >= 5 ? median(lows) : null;
    return { worlds, sold, lowMed, lowDays: lows.length, avg: sold ? recent.reduce((a, x) => a + x[0] * x[1], 0) / sold : null };
  }));
}
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
  return { worlds, cur, ref, p25, p75, days, signal, plan, got, spend, bestName: bestW && pastMins.length < 5 ? bestW.name : null,
    basis, refDays: refs.length, best: bestW || null };
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
  return `<section class="track-card">
    <div class="track-head">
      <h2>${esc(name)}</h2>
      <span class="signal ${a.signal.kind}">${a.signal.icon} ${a.signal.label}</span>
      <span class="faint">데이터 ${ago(d.upd)}</span>
      <button type="button" class="chip-x" data-untrack="${t.id}" title="빼기">✕</button>
    </div>
    ${trackBody(a, t, true)}
  </section>`;
}
// 트래킹 카드 본문 (판단 멘트 · 그래프 · 구매 계획 · 서버별 매물). 제작일지 펼침에서도 같이 쓴다
function trackBody(a, t, editable) {
  const best = a.worlds.filter((w) => w.min != null).sort((x, y) => x.min - y.min)[0];
  const rows = a.worlds.map((w) => `<tr class="${best && w.key === best.key ? "best" : ""}">
      <td>${best && w.key === best.key ? "👑 " : ""}${esc(w.name)}${w.home ? ' <span class="badge nq">내 서버</span>' : ""}</td>
      <td class="num">${w.min == null ? '<span class="dash">-</span>' : `${gil(w.min)} <small class="faint">×${w.minQty}</small>`}</td>
      <td class="num">${w.cnt}</td><td class="num">${gil(w.med7)}</td><td class="num">${w.sold7.toLocaleString("ko-KR")}</td>
      <td class="lots">${w.lst.slice(0, 5).map((l) => `<span class="lot${l[3] ? " bait" : ""}${l[2] ? " hq" : ""}" title="${l[3] ? "미끼 매물 (그 서버 보통 가격의 절반도 안 된다)" : ""}">${gil(l[0])}×${l[1]}${l[2] ? " HQ" : ""}</span>`).join("")}</td></tr>`).join("");
  const plan = Object.entries(a.plan).sort((x, y) => y[1].qty - x[1].qty).map(([w, p]) => `<li><b>${esc(w)}</b> ${p.qty.toLocaleString("ko-KR")}개 <span class="faint">(평균 ${gil(p.spend / p.qty)}길 · 매물 ${p.lots}개)</span></li>`).join("");
  return `<p class="signal-text">${esc(a.signal.text)}${a.signal.trend ? ` ${esc(a.signal.trend)}` : ""}</p>
    <div class="track-grid">
      <div>
        <div class="ev-cap">가격 추이 (${a.days.length}일)</div>
        ${trackChart(a)}
      </div>
      <div class="buy-plan">
        <div class="ev-cap">🛒 구매 계획</div>
        ${editable ? `<label class="field"><span>필요 수량</span><input type="number" min="1" max="99999" value="${t.qty}" data-track-qty="${t.id}"></label>`
          : `<p class="faint">최근 30일 쓴 만큼 (${t.qty.toLocaleString("ko-KR")}개) 살 때</p>`}
        ${a.got ? `<div class="plan-total"><b>${gil(a.spend)}</b>길 <span class="faint">(개당 평균 ${gil(a.spend / a.got)}길${a.got < t.qty ? ` · 지금 매물로는 ${a.got}개까지만` : ""})</span></div>
          <ul class="plan-list">${plan}</ul>` : `<p class="faint">살 수 있는 매물이 없다 개굴.</p>`}
      </div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>서버</th><th class="num">최저 매물</th><th class="num">매물 수</th><th class="num">7일 판매 중앙값</th><th class="num">7일 판매량</th><th>싼 매물 (가격×수량)</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
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
  // 관리자 캐릭터는 신청 기록이 없어도 허락됨에 같이 보여서 부대를 정할 수 있게
  for (const a of d.admins || []) if (!items.some((x) => x.who === a)) items.push({ who: a, status: "approved", note: "관리자", admin: true });
  const fcs = [...new Set(items.map((x) => x.fc).filter(Boolean))].sort();
  const group = (status, title, empty, buttons) => {
    const rs = items.filter((x) => x.status === status).sort((a, b) => (b.requestedAt || 0) - (a.requestedAt || 0));
    const withFc = status === "approved";
    const body = rs.length ? rs.map((x) => `<tr><td><b>${esc(x.who)}</b></td><td>${esc(x.note || "")}</td>
        ${withFc ? `<td class="fc-cell"><input type="text" class="fc-in" list="fc-names" maxlength="20" placeholder="부대 이름" value="${esc(x.fc || "")}" data-fc-who="${esc(x.who)}"><button type="button" class="cart-btn" data-fc-set="${esc(x.who)}">저장</button></td>` : ""}
        <td class="num">${fmtMs(x.requestedAt)}</td><td class="num">${fmtMs(x.decidedAt)}</td>
        <td class="admin-btns">${((d.admins || []).includes(x.who) ? [] : buttons).map(([act, label, cls]) => `<button type="button" class="cart-btn ${cls}" data-decide="${act}" data-who="${esc(x.who)}">${label}</button>`).join("")}</td></tr>`).join("")
      : `<tr><td colspan="${withFc ? 6 : 5}" class="faint">${empty}</td></tr>`;
    return `<div class="admin-group"><h2>${title} <span class="cnt">${rs.length}</span></h2>
      <div class="table-wrap"><table><thead><tr><th>캐릭터</th><th>한마디</th>${withFc ? '<th title="같은 부대 이름끼리 묶여서 서로 판매 중인 템이 보인다 개굴. 비우고 저장하면 부대에서 빠진다 개굴">🏰 부대</th>' : ""}<th class="num">신청</th><th class="num">처리</th><th></th></tr></thead>
      <tbody>${body}</tbody></table></div></div>`;
  };
  app.innerHTML = `<section class="admin">
    <div class="eyebrow">ACCESS</div><h1>🔑 권한 관리</h1>
    <p class="desc">신청한 캐릭터를 허락하면 공용 비밀번호로 들어올 수 있다 개굴. 내보내면 1분 안에 막힌다 개굴.</p>
    ${d.error ? `<div class="notice error"><span>⚠</span><span>${esc(d.error)}</span></div>` : ""}
    ${group("pending", "⏳ 허락 대기", "기다리는 신청이 없다 개굴.", [["approve", "허락", "primary"], ["deny", "거절", ""]])}
    ${group("approved", "✅ 허락됨", "아직 허락한 캐릭터가 없다 개굴.", [["remove", "내보내기", ""]])}
    ${group("denied", "🚫 거절됨", "거절한 신청이 없다 개굴.", [["approve", "허락", ""], ["remove", "지우기", ""]])}
    <datalist id="fc-names">${fcs.map((f) => `<option value="${esc(f)}">`).join("")}</datalist>
    <p class="faint">관리자: ${esc((d.admins || []).join(", ") || "-")}${(d.preset || []).length ? ` · 설정으로 바로 허락: ${esc(d.preset.join(", "))}` : ""}</p>
  </section>`;
}
document.getElementById("app").addEventListener("click", async (e) => {
  const f = e.target.closest("[data-fc-set]");
  if (f) {
    const whoName = f.dataset.fcSet, input = [...document.querySelectorAll("[data-fc-who]")].find((x) => x.dataset.fcWho === whoName);
    f.disabled = true;
    const res = await fetch("/__admin/decide", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ who: whoName, action: "fc", fc: input ? input.value.trim() : "" }) });
    if (!res.ok) window.alert((await res.json().catch(() => ({}))).error || "처리 못 했다 개굴");
    FC = null; FCS = null;
    renderAdmin();
    return;
  }
  const b = e.target.closest("[data-decide]");
  if (!b) return;
  const action = b.dataset.decide, whoName = b.dataset.who;
  if (action === "remove" && !window.confirm(`${whoName} 내보내도 되나 개굴?`)) return;
  b.disabled = true;
  const res = await fetch("/__admin/decide", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ who: whoName, action }) });
  if (!res.ok) window.alert((await res.json().catch(() => ({}))).error || "처리 못 했다 개굴");
  renderAdmin();
});

// ── 🏰 우리 부대 ──
// 부대원(나 포함) 리테이너 이름·제작자 서명으로, 매시간 받아 둔 매물(data/sellers)에서 지금 올려 둔 걸 찾는다
let FC = null, FCS = null, fcLoading = null;
const SELLER_SHARDS = 512;
const nameShard = (name) => { let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0; return h % SELLER_SHARDS; }; // build.py name_shard 랑 같게
const charName = (w) => String(w).split("@")[0];
async function fcLoad(force = false) {
  if (FC && !force) return FC;
  try { const res = await fetch("/__fc", { cache: "no-store" }); FC = res.ok ? await res.json() : null; } catch { FC = null; }
  if (!FC || !Array.isArray(FC.members)) FC = { fc: "", members: who() ? [{ who: who(), retainers: [] }] : [] };
  return FC;
}
function fcKeys() {
  const keys = [];
  for (const m of FC.members) {
    for (const r of m.retainers || []) keys.push(["r", r, m.who]);
    keys.push(["c", charName(m.who), m.who]);
  }
  return keys;
}
function fcAdd(sales, id, x) {
  const list = sales.get(id) || [];
  if (!list.some((y) => y.who === x.who && y.w === x.w && y.hq === x.hq && y.price === x.price && y.qty === x.qty)) list.push(x);
  sales.set(id, list);
}
async function fcSalesLoad(force = false) {
  if (FCS && !force) return FCS;
  await fcLoad(force);
  const keys = fcKeys(), files = {};
  await Promise.all([...new Set(keys.map((k) => nameShard(k[1])))].map(async (n) => {
    try { files[n] = await getJSON(`data/sellers/s${n}.json`); } catch { files[n] = null; }
  }));
  const sales = new Map(), names = {};
  for (const [t, name, w] of keys) {
    const f = files[nameShard(name)];
    for (const [id, world, hq, price, qty, at] of ((f || {})[t] || {})[name] || []) {
      fcAdd(sales, id, { who: w, by: t, ret: t === "r" ? name : "", w: String(world), hq: !!hq, price, qty, at });
      if (f.n && f.n[id]) names[id] = f.n[id];
    }
  }
  const old = Date.now() / 1000 - 7 * 86400;
  for (const m of FC.members) for (const x of m.sell || []) {
    if (x.n && !names[x.i]) names[x.i] = x.n;
    if (x.at > old) fcAdd(sales, x.i, { who: m.who, by: "m", ret: "", w: String(x.w), hq: x.q == null ? null : !!x.q, price: null, qty: null, at: x.at });
  }
  FCS = { sales, names };
  fcLoading = null;
  return FCS;
}
// ⚡ 품목을 누르면 받은 매물로 그 템만 바로 고친다 (매물 100개 다 오면 뒤쪽은 몰라서 더하기만)
function fcLive(id, listings) {
  if (!FCS || !FC) return;
  const byRet = {}, byMaker = {};
  for (const m of FC.members) { for (const r of m.retainers || []) byRet[r] = m.who; byMaker[charName(m.who)] = m.who; }
  if (listings.length < 100) FCS.sales.set(id, (FCS.sales.get(id) || []).filter((x) => x.by === "m")); // 🔔 직접 표시는 남긴다
  for (const l of listings) {
    const w = byRet[l.retainerName] || byMaker[l.creatorName];
    if (w) fcAdd(FCS.sales, id, { who: w, by: byRet[l.retainerName] ? "r" : "c", ret: l.retainerName || "", w: String(l.worldID), hq: !!l.hq,
      price: l.pricePerUnit, qty: l.quantity, at: l.lastReviewTime || Date.now() / 1000 });
  }
}
// 순위 줄: 부대원이 이 템(같은 품질)을 이 서버(통합이면 아무 서버)에 올려 뒀나
function fcSelling(row, server) {
  const list = (FCS && FCS.sales.get(row.item)) || [];
  const hit = list.filter((x) => (row.sellingHq == null || x.hq == null || x.hq === row.sellingHq) && (server === "dc" || x.w === server));
  if (!hit.length) return null;
  const names = Object.fromEntries(meta.servers.map((x) => [x.key, x.name]));
  const people = [...new Set(hit.map((x) => (x.who === who() ? "내가" : charName(x.who))))];
  return {
    text: `🏷 ${people[0]}${people.length > 1 ? ` 외 ${people.length - 1}명` : ""} 판매중`,
    tip: hit.sort((a, b) => (a.price ?? -1) - (b.price ?? -1)).slice(0, 6).map((x) => `${x.who === who() ? "나" : charName(x.who)} · ${names[x.w] || x.w} ${x.hq ? "HQ " : ""}`
      + (x.by === "m" ? `🔔 직접 표시 (${ago(x.at)})` : `${Math.round(x.price).toLocaleString("ko-KR")}길 ×${x.qty} (${x.by === "r" ? x.ret : "제작 서명"} · ${ago(x.at)} 확인)`)).join("\n")
      + "\n부대원이 이미 올려 둔 템이다 개굴",
  };
}
// 🔔 직접 표시: 리테이너로 못 잡힐 때 내가 '판매 중' 이라고 찍어 둔다 (내 서버, 그 줄 품질, 7일 지나면 풀림)
const homeWorld = () => (meta.servers.find((x) => x.key !== "dc" && x.name === String(who()).split("@")[1]) || {}).key || String(meta.home);
const fcMe = () => FC && FC.members.find((m) => m.who === who());
const fcMyMarks = () => [...((fcMe() || {}).sell || [])];
const markQ = (row) => (row.sellingHq == null ? null : row.sellingHq ? 1 : 0);
async function fcSaveMarks(sell) {
  const res = await fetch("/__fc", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sell }) });
  if (!res.ok) throw new Error(`저장 ${res.status}`);
  FC = null; FCS = null;
  await fcSalesLoad();
}
function fcMarked(row) {
  return fcMyMarks().some((x) => x.i === row.item && x.q === markQ(row) && String(x.w) === homeWorld());
}
async function fcToggle(row) {
  await fcLoad();
  const on = fcMarked(row), w = homeWorld(), q = markQ(row);
  const rest = fcMyMarks().filter((x) => !(x.i === row.item && x.q === q && String(x.w) === w));
  await fcSaveMarks(on ? rest : [{ i: row.item, q, w, n: row.name, at: Math.floor(Date.now() / 1000) }, ...rest]);
  render();
}

async function renderFc() {
  const app = document.getElementById("app");
  if (!app.querySelector(".fc-page")) app.innerHTML = `<div class="boot">🐸 부대 불러오는 중이다 개굴…</div>`;
  await fcSalesLoad(true);
  if (page() !== "fc") return;
  const names = Object.fromEntries(meta.servers.map((x) => [x.key, x.name]));
  const me = FC.members.find((m) => m.who === who()) || { retainers: [] };
  const byWho = {};
  for (const [id, list] of FCS.sales) for (const x of list) (byWho[x.who] = byWho[x.who] || []).push({ id, ...x });
  const card = (m) => {
    const rows = (byWho[m.who] || []).sort((a, b) => b.at - a.at);
    const body = rows.map((x) => `<tr><td>${esc(FCS.names[x.id] || `아이템 ${x.id}`)}${x.hq ? ' <span class="fc-hq">HQ</span>' : ""}</td><td>${esc(names[x.w] || x.w)}</td>
      <td class="num">${x.price == null ? '<span class="dash">-</span>' : Math.round(x.price).toLocaleString("ko-KR")}</td><td class="num">${x.qty ?? '<span class="dash">-</span>'}</td>
      <td>${x.by === "m" ? `🔔 직접 표시${m.who === who() ? ` <button type="button" class="chip-x" data-fc-unmark="${x.id}" data-q="${x.hq == null ? "" : x.hq ? 1 : 0}" data-w="${esc(x.w)}" title="표시 풀기">✕</button>` : ""}` : esc(x.by === "r" ? x.ret : "제작 서명")}</td><td class="num faint">${esc(ago(x.at))}</td></tr>`).join("");
    return `<div class="j-card fc-member"><div class="j-head"><h2>${m.who === who() ? "🐸 " : "🧑‍🌾 "}${esc(m.who)} <span class="cnt">${rows.length}</span></h2>
      <div class="fc-rets">${(m.retainers || []).map((r) => `<span class="fc-ret">${esc(r)}</span>`).join("") || '<span class="faint">리테이너를 아직 안 적었다 개굴</span>'}</div></div>
      ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>아이템</th><th>서버</th><th class="num">단가</th><th class="num">수량</th><th>리테이너</th><th class="num">확인</th></tr></thead><tbody>${body}</tbody></table></div>`
        : `<div class="detail-hint">지금 장터에서 찾은 매물이 없다 개굴.</div>`}</div>`;
  };
  app.innerHTML = `<section class="journal fc-page">
    <div class="eyebrow">FREE COMPANY</div><h1>🏰 우리 부대${FC.fc ? ` · ${esc(FC.fc)}` : ""}</h1>
    <p class="tagline">부대원이 장터에 올려 둔 템은 순위 표에서 옅은 회색 줄로 바뀐다 개굴. 같은 템 겹쳐서 만들지 말자 개굴.</p>
    ${FC.fc ? "" : `<div class="notice"><span>🏰</span><span>아직 부대에 안 들어가 있다 개굴. 로살리아@초코보 한테 부대 묶어 달라고 해라 개굴. 그래도 내 리테이너를 적어 두면 내가 올린 템은 회색으로 보인다 개굴.</span></div>`}
    <div class="j-card fc-mine"><h2>🧾 내 리테이너 이름</h2>
      <p class="faint">게임 속 리테이너 이름 그대로 적어라 개굴. 여러 명이면 쉼표로 (최대 10명).</p>
      <div class="fc-form"><input id="fc-rets" type="text" maxlength="230" placeholder="예: 개굴이, 올챙이" value="${esc((me.retainers || []).join(", "))}">
        <button type="button" class="btn" data-fc-save="1">💾 저장</button><span class="fc-msg faint"></span></div></div>
    ${FC.members.map(card).join("")}
    <p class="faint">매시간 받은 시세 기준이다 개굴. 누가 장터를 열어서 시세가 올라와야 잡히니까, 막 올린 건 늦게 뜰 수 있다 개굴. 순위에서 품목을 누르면 그 템은 바로 다시 확인한다 개굴.</p>
  </section>`;
}
document.getElementById("app").addEventListener("click", async (e) => {
  const un = e.target.closest("[data-fc-unmark]");
  if (un && page() === "fc") {
    const q = un.dataset.q === "" ? null : Number(un.dataset.q);
    await fcSaveMarks(fcMyMarks().filter((x) => !(x.i === Number(un.dataset.fcUnmark) && x.q === q && String(x.w) === un.dataset.w)));
    renderFc();
    return;
  }
  const b = e.target.closest("[data-fc-save]");
  if (!b || page() !== "fc") return;
  const retainers = document.getElementById("fc-rets").value.split(/[,，、\n]/).map((x) => x.replace(/\s+/g, "")).filter(Boolean);
  b.disabled = true;
  const res = await fetch("/__fc", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ retainers }) }).catch(() => null);
  b.disabled = false;
  if (!res || !res.ok) { document.querySelector(".fc-msg").textContent = "⚠ 저장 못 했다 개굴. 다시 해 봐라 개굴."; return; }
  FC = null; FCS = null;
  renderFc();
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
const QUAL_SEG = () => `<div class="sb-title">필터</div>
    <label class="field"><span>판매 품질</span></label>
    ${seg("quality", Object.keys(QUALITY_KEY), S.quality)}`;
function sideHead(p) {
  return `
    <div class="sb-top"><span class="brand-frog">🐸</span><span class="sb-fold-hint">누르면 접힌다 개굴</span><button type="button" class="side-fold" data-fold="1" title="사이드바 접기" aria-label="사이드바 접기">«</button></div>
    <nav class="nav">
      <a href="#craft" class="${p === "craft" ? "on" : ""}">⚒️ 제작</a>
      <a href="#gather" class="${p === "gather" ? "on" : ""}">⛏️ 채집</a>
      <a href="#exchange" class="${p === "exchange" ? "on" : ""}">🪙 교환템 팔기</a>
      <a href="#exchange-craft" class="${p === "exchangeCraft" ? "on" : ""}">🧪 교환 재료로 만들기</a>
      <a href="#track" class="${p === "track" ? "on" : ""}">📈 재료 트래킹</a>
      <a href="#journal" class="${p === "journal" ? "on" : ""}">📒 나의 제작일지</a>
      <a href="#fc" class="${p === "fc" ? "on" : ""}">🏰 우리 부대</a>
    </nav>
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
  if (p === "journal") {
    side.innerHTML = sideHead(p) + `
      <div class="sb-note">마지막 갱신: ${fmtTime(meta.updatedAt)} (${ago(meta.updatedAt)})<br>매시간 알아서 갱신된다 개굴</div>
      <p class="hint">만든 걸 적어 두면 최근 30일 동안 자주 쓴 재료를 모아서, 평소보다 싸게 올라왔을 때 미리 사 두라고 알려준다 개굴.</p>
      <p class="hint">장보기에서 '📒 만들었다' 를 누르면 담은 걸 한 번에 적는다 개굴. 기록은 이 캐릭터에만 저장되고 다른 기기에서도 따라온다 개굴 (최근 1년치).</p>
      <p class="hint">🟢 쌀 때 · 🟡 보통 · 🔴 비쌈 — 📈 재료 트래킹이랑 같은 기준이다 개굴. 제일 싼 서버 지금 매물을 지난날 그날 최저 매물(5일 넘게 쌓였으면)이나 그 서버 최근 판매 중앙값이랑 비교한다 개굴. 표에 비교한 값이랑 며칠치인지 같이 나온다 개굴.</p>
      <p class="hint">재료 이름을 누르면 바로 밑에 가격 그래프·서버별 매물·구매 계획이 펼쳐진다 개굴.</p>
      ${adminLink(p)}`;
    return;
  }
  if (p === "fc") {
    side.innerHTML = sideHead(p) + `
      <div class="sb-note">마지막 갱신: ${fmtTime(meta.updatedAt)} (${ago(meta.updatedAt)})<br>매시간 알아서 갱신된다 개굴</div>
      <p class="hint">리테이너 이름을 적어 두면, 매시간 시세 받을 때 장터 매물에서 그 이름을 찾아 부대원이 뭘 팔고 있는지 알아낸다 개굴.</p>
      <p class="hint">부대원이 팔고 있는 템은 제작·채집 순위에서 옅은 회색 줄 + 🏷 표시로 바뀐다 개굴. 서버 탭이면 그 서버에서 파는 것만, 🌏 통합이면 어느 서버든 친다 개굴.</p>
      <p class="hint">부대는 로살리아@초코보가 🔑 권한 관리에서 묶어 준다 개굴.</p>
      ${adminLink(p)}`;
    return;
  }
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
  const sortNames = { craft: { net: "순수익", margin: "수익률", daily: "하루 잠재 이익" }, gather: { daily: "하루 잠재 이익", net: "개당 순수익" },
    exchange: { perCur: "화폐 1개당", net: "개당 순수익", daily: "하루 잠재 이익" },
    exchangeCraft: { perCur: "화폐 1개당", net: "순수익", daily: "하루 잠재 이익" } }[p];
  const cities = ["min", ...Object.keys(meta.taxCities)];
  side.innerHTML = `${sideHead(p)}
    <div class="sb-note">마지막 갱신: ${fmtTime(meta.updatedAt)} (${ago(meta.updatedAt)})<br>매시간 알아서 갱신된다 개굴</div>
    <button type="button" class="btn" data-reload="1">🔄 새 데이터 불러오기</button>

    ${p === "exchangeCraft" ? `${QUAL_SEG()}
    <p class="hint">레시피 레벨·직업 레벨은 ⚒️ 제작 설정을 따른다 개굴. 교환 재료는 길 대신 화폐로 치고, 나머지 재료는 제작 순위처럼 장터에서 산다 개굴.
    화폐 1개당 = 1회 제작 순수익 ÷ 드는 화폐 개굴.</p>` : p === "exchange" ? `<div class="sb-title">필터</div>
    <p class="hint">교환해서 받는 건 NQ 라서 NQ 시세로 친다 개굴. 화폐 1개당 = 개당 순수익 × 받는 개수 ÷ 교환가 개굴.</p>` : `<div class="sb-title">분석 대상</div>
    <div class="row2">${num(`${p === "craft" ? "레시피" : "채집"} 레벨 ≥`, `${p}.levelMin`, 1, 100)}${num("≤", `${p}.levelMax`, 1, 100)}</div>
    <details class="jobs"${p === "gather" ? " open" : ""}><summary>직업별 레벨 · ${jobs.length}개 직업</summary>
      <p class="hint">이 레벨보다 높은 ${p === "craft" ? "레시피" : "채집템"}는 뺀다 개굴.</p>
      <div class="row2 wrap">${jobs.map((j) => num(j, `${p}.jobLevels.${j}`, 1, 100)).join("")}</div>
    </details>

    ${QUAL_SEG()}
    <p class="hint">${{ NQ: "모든 템을 NQ 로 팔 때 순위다 개굴.", HQ: "HQ 로 만들 수 있는 템만, HQ 로 팔 때 순위다 개굴. 가구처럼 HQ 가 없는 템은 빠진다 개굴.", "통합": "NQ 로 팔 때랑 HQ 로 팔 때를 한 순위에 같이 놓는다 개굴. HQ 줄은 이름 끝에 HQ 마크가 붙는다 개굴." }[S.quality]}</p>`}
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
    <button type="button" class="link-btn" data-tour="1">❓ 사용법 다시 보기</button>

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
    if (e.target.closest("[data-tour]")) { tour(); return; }
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
    <div class="ob-sec ob-${p}"><div class="ob-title">${title}<small>${p === "craft" ? "레시피 레벨 범위랑 직업 레벨" : "채집 레벨 범위랑 직업 레벨"}</small></div>
      <div class="row2">${n(`${p === "craft" ? "레시피" : "채집"} 레벨 ≥`, `${p}.levelMin`, 1, 100)}${n("≤", `${p}.levelMax`, 1, 100)}</div>
      <label class="field ob-all"><span>⭐ ${p === "craft" ? "제작" : "채집"} 직업 레벨 한 번에 맞추기</span>
        <input type="number" data-all="${p}" min="1" max="100" value="${all(p)}" placeholder="직업마다 다르다"></label>
      <div class="ob-jobs">${jobs.map((j) => n(j, `${p}.jobLevels.${j}`, 1, 100)).join("")}</div>
    </div>`;
  const draw = () => {
    box.innerHTML = `<div class="ob-card" role="dialog" aria-modal="true" aria-label="기본 설정">
      <div class="ob-head"><span class="brand-frog">🐸</span><div><b>어서 와라 개굴!</b>
        <p class="hint">처음이니까 기본 설정부터 정하자 개굴. 직업 레벨보다 높은 레시피·채집템은 순위에서 뺀다 개굴.
        여기서 정한 건 이 캐릭터에 저장돼서 다른 기기에서도 따라온다 개굴. 나중에 사이드바에서 언제든 바꿀 수 있다 개굴.</p></div></div>
      <div class="ob-sec ob-quality"><div class="ob-title">💰 판매 품질<small>어떤 품질로 팔 때 순위를 볼지</small></div>
        <div class="seg">${Object.keys(QUALITY_KEY).map((q) => `<button type="button" class="${O.quality === q ? "on" : ""}" data-oq="${esc(q)}">${esc(q)}</button>`).join("")}</div>
        <p class="hint">통합은 NQ·HQ 로 팔 때를 한 순위에 같이 보여준다 개굴.</p></div>
      ${jobsBlock("craft", meta.jobs, "⚒️ 제작")}
      ${jobsBlock("gather", meta.gatherJobs, "⛏️ 채집")}
      <div class="ob-sec ob-filter"><div class="ob-title">🔍 제작 필터<small>이 기준에 안 맞는 레시피는 순위에서 뺀다 개굴</small></div>
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
    // 처음 들어온 사람은 설정 끝나면 바로 사용법 둘러보기
    render().then(() => { if (!load(TOUR_KEY(), false)) tour(); });
  });
  document.body.appendChild(box);
}

// ❓ 사용법 둘러보기: 화면을 어둡게 깔고 설명할 곳만 하얗게 빛나는 네모로 비춘다
const TOUR_KEY = () => `ffxivTourDone:${who()}`; // 사용법 봤는지도 캐릭터마다
const TOUR = [
  { sel: ".nav", side: true, title: "메뉴", text: "⚒️ 제작 · ⛏️ 채집 순위, 🪙 교환템 팔기 · 🧪 교환 재료로 만들기, 📈 재료 트래킹, 📒 제작일지, 🏰 우리 부대로 옮겨 다닌다 개굴." },
  { sel: "[data-seg=quality]", side: true, title: "판매 품질", text: "NQ 로 팔지, HQ 로 팔지, 둘 다 한 순위에 볼지(통합) 고른다 개굴. 통합에선 HQ 줄 이름 끝에 HQ 마크가 붙는다 개굴." },
  { sel: "[data-path$='.minSales']", up: ".field", side: true, title: "필터", text: "판매 건수, 수익률, 순수익, 매물 수, 판매 소요일로 순위를 거른다 개굴. 숫자 바꾸면 바로 다시 계산된다 개굴." },
  { sel: ".cats.servers", title: "서버 고르기", text: "🌏 통합은 한국 전체 시세, 서버 버튼은 그 서버에서 팔 때 순위다 개굴. 🏠 가 내 서버다 개굴." },
  { sel: ".cats:not(.servers)", title: "분류", text: "가구·장비·재료·소모품처럼 종류별로 나눠 본다 개굴. 숫자는 필터 통과한 개수다 개굴." },
  { sel: ".rank-table thead", title: "순위 표", text: "칸 제목을 누르면 그걸로 정렬된다 개굴. 판매 예상가는 최근 판매 중앙값이고, 이상 거래·미끼 매물은 뺀 값이다 개굴." },
  { sel: ".rank-table tbody tr", title: "품목 누르기", text: "줄을 누르면 바로 밑에 재료 상세가 펼쳐진다 개굴. 다시 누르면 접힌다 개굴. 누르는 순간 그 템이랑 재료 시세를 새로 받아온다 개굴." },
  { sel: ".live", open: true, title: "⚡ 지금 시세", text: "방금 받은 서버별 최저 매물, 재료 지금 값, 지금 기준 순수익이다 개굴. 만들기 전에 여기서 재료값이 표보다 비싸졌는지 꼭 봐라 개굴." },
  { sel: ".mat-link", open: true, title: "재료 → 트래킹", text: "재료 이름을 누르면 📈 재료 트래킹에 담기고 그리로 간다 개굴. 서버별 최저가랑 살 때인지 알려준다 개굴." },
  { sel: ".rank-table .pick", title: "장보기", text: "+ 를 누르면 장보기에 담긴다 개굴. 오른쪽 아래 장바구니에서 서버별로 뭘 몇 개 살지 정리해 준다 개굴." },
  { sel: ".rank-table th.col-log", to: ".rank-table .log-btn", title: "📒 제작일지 · 🔔 판매 중 표시", text: "표 맨 오른쪽 📒 를 누르면 장보기 없이 그 템을 오늘 📒 나의 제작일지에 1회 적는다 개굴. 3개 만들었으면 3번 눌러라 개굴. 옆의 회색 🔔 는 '내가 이거 팔고 있다' 표시다 개굴. 누르면 부대원 화면에서 그 줄이 회색이 되고, 7일 지나면 저절로 풀린다 개굴." },
  { sel: ".side-fold", side: true, title: "사이드바 접기", text: "표를 넓게 보고 싶으면 « 를 눌러 접어라 개굴. 왼쪽 위 ☰ 설정으로 다시 편다 개굴. 사용법은 사이드바 맨 아래에서 다시 볼 수 있다 개굴." },
];
function tour() {
  if (page() !== "craft") { location.hash = "#craft"; setTimeout(tour, 900); return; }
  document.querySelector(".tour")?.remove();
  document.body.classList.remove("side-folded");
  const box = document.createElement("div");
  box.className = "tour";
  box.innerHTML = `<div class="tour-spot"></div><div class="tour-card" role="dialog" aria-live="polite"></div>`;
  document.body.appendChild(box);
  const spot = box.querySelector(".tour-spot"), card = box.querySelector(".tour-card");
  const steps = TOUR;
  let i = 0;
  const target = (st) => { const el = document.querySelector(st.sel); return el && st.up ? el.closest(st.up) || el : el; };
  const end = () => {
    save(TOUR_KEY(), true);
    box.remove();
    document.body.classList.remove("side-open");
    window.removeEventListener("resize", place);
    window.removeEventListener("scroll", place, true);
  };
  function place() {
    const st = steps[i], el = target(st);
    if (!el) return;
    const pad = 6, a = el.getBoundingClientRect(), b = st.to && document.querySelector(st.to)?.getBoundingClientRect();
    const r = b ? { left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) } : a; // to: 두 곳을 한 네모로
    r.height = r.bottom - r.top;
    const x1 = Math.max(4, r.left - pad), x2 = Math.min(innerWidth - 4, r.right + pad); // 가로로 넘치는 표는 화면 안까지만
    Object.assign(spot.style, { left: x1 + "px", top: r.top - pad + "px", width: x2 - x1 + "px", height: r.height + pad * 2 + "px" });
    const cw = card.offsetWidth, ch = card.offsetHeight, vw = innerWidth, vh = innerHeight;
    let top = r.bottom + 14;
    if (top + ch > vh - 8) top = Math.max(8, r.top - ch - 14);
    let left = Math.min(Math.max(8, r.left), vw - cw - 8);
    if (st.side && vw > 900) { left = Math.min(r.right + 16, vw - cw - 8); top = Math.min(Math.max(8, r.top), vh - ch - 8); }
    Object.assign(card.style, { left: left + "px", top: top + "px" });
  }
  function show(n) {
    // 상세 단계는 첫 줄을 펼쳐 놓고 보여준다
    const want = steps[n];
    if (want && want.open && !document.querySelector(".detail-row")) {
      document.querySelector(".rank-table tbody tr.clickable")?.click();
      setTimeout(() => show(n), 500);
      return;
    }
    // 화면에 없는 단계(예: 장보기 없는 페이지)는 건너뛴다
    while (n >= 0 && n < steps.length && !target(steps[n])) n += n >= i ? 1 : -1;
    if (n < 0 || n >= steps.length) return end();
    i = n;
    const st = steps[i];
    document.body.classList.toggle("side-open", !!st.side && innerWidth <= 900);
    const el = target(st);
    el.scrollIntoView({ block: "center", behavior: "instant" });
    card.innerHTML = `<div class="tour-step">${i + 1} / ${steps.length}</div><b>${esc(st.title)}</b><p>${esc(st.text)}</p>
      <div class="tour-btns"><button type="button" class="link-btn" data-t="skip">건너뛰기</button>
      ${i ? '<button type="button" class="btn-ghost" data-t="prev">이전</button>' : ""}
      <button type="button" class="btn" data-t="next">${i === steps.length - 1 ? "🐸 다 봤다" : "다음"}</button></div>`;
    requestAnimationFrame(place);
  }
  box.addEventListener("click", (e) => {
    const b = e.target.closest("[data-t]");
    if (!b) return;
    if (b.dataset.t === "skip") return end();
    show(b.dataset.t === "prev" ? i - 1 : i + 1);
  });
  window.addEventListener("resize", place);
  window.addEventListener("scroll", place, true);
  show(0);
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
    // 설정은 캐릭터마다 따로: 이 브라우저에 다른 캐릭터 설정이 남아 있으면 내 것으로 안 친다
    const owner = load("ffxivSettingsWho", null), mine = !who() || owner === who();
    if (load("ffxivSettings", null) === null || !mine) {
      const remote = await remoteSettings();
      if (remote) save("ffxivSettings", remote);
      else {
        first = true;
        if (owner && !mine) try { localStorage.removeItem("ffxivSettings"); } catch { /* 괜찮다 */ }
        // owner 가 없으면 예전 설정(캐릭터 구분 전) — 그 값으로 처음 설정 화면을 채워 둔다
      }
      if (who()) save("ffxivSettingsWho", who());
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

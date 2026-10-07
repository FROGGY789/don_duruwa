// Cloudflare Pages 문지기: 캐릭터명@서버 + 비밀번호를 맞혀야 사이트(데이터 포함)를 보여준다.
// 확인은 Cloudflare 서버에서 하니까, 로그인 안 하면 순위 데이터 파일도 못 받는다.
//
// 권한: 처음 온 사람은 "권한 신청" → 관리자(로살리아@초코보)가 사이트 안 🔑 권한 관리에서 허락 → 그다음부터 들어옴
//
// Cloudflare 대시보드 → Workers & Pages → don-duruwa → Settings 에서:
//   Variables and Secrets
//     SITE_PASSWORD       공용 비밀번호 (없으면 문지기 꺼짐 = 누구나 들어옴). 신청할 때도 이걸 알아야 한다
//     ADMIN_PASSWORD      관리자 비밀번호 (관리자 캐릭터는 이걸로만 들어온다. 공용 비번으로 관리자 행세 못 하게)
//     ADMIN_CHARACTERS    관리자 캐릭터, 쉼표로 (없으면 로살리아@초코보)
//     ALLOWED_CHARACTERS  (선택) 신청 없이 바로 들어올 캐릭터, 쉼표로
//   Bindings → KV namespace, 변수 이름 ACCESS   신청·허락 기록 저장소 (없으면 신청 기능 없이 ALLOWED_CHARACTERS 만 씀)
// 바꾼 뒤에는 GitHub Actions 에서 "사이트 갱신" 을 한 번 돌려야 적용된다.

const SERVERS = ["카벙클", "초코보", "모그리", "톤베리", "펜리르"];
const COOKIE = "ffx_auth";
const DAYS = 30;
// 로그인 화면이 쓰는 파일은 비밀번호 없이도 받게 둔다 (색·글꼴뿐이라 숨길 게 없다)
const PUBLIC = new Set(["/tokens.css", "/web.css", "/dashboard.css", "/favicon.ico"]);

const enc = new TextEncoder();

async function sign(secret, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(mac))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function cookies(request) {
  const out = {};
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// "로살리아@초코보" → {name, server, full} (서버 이름이 틀리면 null)
export function parseCharacter(text) {
  const m = String(text || "").trim().replace(/\s+/g, "").match(/^([^@]{1,20})@([^@]+)$/);
  if (!m || !SERVERS.includes(m[2])) return null;
  return { name: m[1], server: m[2], full: `${m[1]}@${m[2]}` };
}

const list = (s) => String(s || "").split(",").map((x) => x.trim().replace(/\s+/g, "")).filter(Boolean);
const admins = (env) => (list(env.ADMIN_CHARACTERS).length ? list(env.ADMIN_CHARACTERS) : ["로살리아@초코보"]);
const isAdmin = (env, who) => admins(env).includes(who);

// 신청·허락 기록: KV 의 "char:캐릭터" → {status: pending|approved|denied, note, requestedAt, decidedAt}
async function record(env, who, fresh = false) {
  if (!env.ACCESS) return null;
  return env.ACCESS.get(`char:${who}`, fresh ? { type: "json" } : { type: "json", cacheTtl: 60 });
}

// 들어올 수 있나: 관리자, 신청 없이 허락된 목록, 또는 관리자가 허락한 캐릭터
async function approved(env, who) {
  if (isAdmin(env, who)) return true;
  if (list(env.ALLOWED_CHARACTERS).includes(who)) return true;
  if (!env.ACCESS) return !list(env.ALLOWED_CHARACTERS).length; // 저장소도 목록도 없으면 비밀번호만 맞으면 통과
  return (await record(env, who))?.status === "approved";
}

// 출입증: 캐릭터|만료시각|서명. 비밀번호를 바꾸면 서명이 안 맞아서 전부 다시 로그인해야 한다
const secret = (env) => `${env.SITE_PASSWORD}|${env.ADMIN_PASSWORD || ""}`;
async function makeToken(env, who) {
  const exp = Math.floor(Date.now() / 1000) + DAYS * 86400;
  const body = `${encodeURIComponent(who)}|${exp}`;
  return `${body}|${await sign(secret(env), body)}`;
}
async function checkToken(env, token) {
  try {
    const [who, exp, sig] = decodeURIComponent(token || "").split("|");
    if (!who || !exp || !sig || Number(exp) < Date.now() / 1000) return null;
    if (sig !== (await sign(secret(env), `${who}|${exp}`))) return null;
    const name = decodeURIComponent(who);
    return (await approved(env, name)) ? name : null; // 내보낸 사람은 출입증이 남아 있어도 막힌다
  } catch {
    return null; // 깨진 쿠키는 그냥 로그인 안 한 걸로
  }
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const NO_STORE = { "Cache-Control": "no-store" };

// 로그인 화면. mode: "login" (들어가기) / "request" (권한 신청) / "sent" (신청 끝)
function loginPage({ error = "", info = "", who = "", mode = "login", status = 200 } = {}) {
  const frogs = Array.from({ length: 24 }, () =>
    `<span style="left:${(Math.random() * 97).toFixed(1)}vw;font-size:${(1.2 + Math.random() * 1.6).toFixed(2)}rem;` +
    `animation-delay:${(Math.random() * 1.8).toFixed(2)}s;animation-duration:${(2.2 + Math.random() * 1.6).toFixed(2)}s;` +
    `--spin:${(Math.random() < 0.5 ? -1 : 1) * Math.round(90 + Math.random() * 450)}deg;--drift:${(Math.random() * 16 - 8).toFixed(1)}vw">🐸</span>`).join("");
  const form = mode === "request" ? `
  <form method="post" action="/__request" class="login-form">
    <div class="login-mode">📝 권한 신청</div>
    <label class="field"><span>캐릭터명@서버</span>
      <input name="who" value="${esc(who)}" placeholder="예: 로살리아@초코보" autocomplete="username" required></label>
    <label class="field"><span>공용 비밀번호</span>
      <input name="pw" type="password" placeholder="받은 비밀번호" autocomplete="current-password" required></label>
    <label class="field"><span>한마디 (선택)</span>
      <input name="note" maxlength="80" placeholder="예: 우리 FC 개구리 친구다 개굴"></label>
    <button type="submit" class="btn">신청하기</button>
    <a class="login-switch" href="/">← 들어가기로 돌아가기</a>
  </form>` : mode === "sent" ? "" : `
  <form method="post" action="/__login" class="login-form">
    <label class="field"><span>캐릭터명@서버</span>
      <input name="who" value="${esc(who)}" placeholder="예: 로살리아@초코보" autocomplete="username" required></label>
    <label class="field"><span>비밀번호</span>
      <input name="pw" type="password" placeholder="비밀번호" autocomplete="current-password" required></label>
    <button type="submit" class="btn">들어가기</button>
    <a class="login-switch" href="/__request${who ? `?who=${encodeURIComponent(who)}` : ""}">처음이면 📝 권한 신청</a>
  </form>`;
  return new Response(`<!doctype html>
<html lang="ko" data-theme="light" data-palette="jade"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>에오르제아 거상되기</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🐸</text></svg>">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600&family=Noto+Serif+KR:wght@600&display=swap">
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/dashboard.css"><link rel="stylesheet" href="/web.css">
<script>try{const s=JSON.parse(localStorage.getItem("ffxivSettings")||"{}");const T={"다크":"dark","화이트":"light"},P={"초록":"jade","골드":"gold","크리스탈":"crystal","에테르":"aether","로즈":"rose","실버":"silver"};
if(T[s.theme])document.documentElement.dataset.theme=T[s.theme];if(P[s.palette])document.documentElement.dataset.palette=P[s.palette];}catch(e){}</script>
</head><body class="login">
<div class="frog-rain" aria-hidden="true">${frogs}</div>
<main class="login-box">
  <div class="eyebrow">FFXIV CRAFTING · GATHERING PROFIT</div>
  <h1>에오르제아에서<br>장사꾼으로 살아남기 🐸</h1>
  <p class="login-sub">${mode === "request" ? "신청하면 로살리아@초코보가 보고 허락해 준다 개굴." : "캐릭터명@서버랑 비밀번호를 쳐야 화면을 열어준다 개굴."}</p>
  ${form}
  ${error ? `<div class="login-error">🐸 ${esc(error)}</div>` : ""}
  ${info ? `<div class="login-info">🐸 ${esc(info)}</div>` : ""}
  ${mode === "sent" ? `<a class="login-switch" href="/">← 들어가기로 돌아가기</a>` : ""}
  <div class="login-contact">🐸 문의는 <b>로살리아@초코보</b> 한테 해라 개굴</div>
</main></body></html>`, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE } });
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...NO_STORE } });

function signedIn(who, token, admin) {
  const age = DAYS * 86400;
  return new Response(null, { status: 302, headers: [
    ["Location", "/"],
    ["Set-Cookie", `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`],
    // 화면 인사·관리 메뉴 표시용 (비밀 아님, 진짜 확인은 서버가 출입증으로 한다)
    ["Set-Cookie", `ffx_who=${encodeURIComponent(who)}; Path=/; Max-Age=${age}; Secure; SameSite=Lax`],
    ["Set-Cookie", `ffx_admin=${admin ? 1 : 0}; Path=/; Max-Age=${age}; Secure; SameSite=Lax`],
  ] });
}

async function handleLogin(env, form) {
  const who = parseCharacter(form.get("who"));
  if (!who) return loginPage({ error: "캐릭터명@서버 로 쳐라 개굴. 서버는 카벙클·초코보·모그리·톤베리·펜리르 중 하나다 개굴.", who: form.get("who"), status: 401 });
  const pw = form.get("pw");
  if (isAdmin(env, who.full)) {
    // 관리자는 관리자 비밀번호로만 (정해 두지 않았으면 관리자 캐릭터로는 못 들어온다)
    if (!env.ADMIN_PASSWORD || pw !== env.ADMIN_PASSWORD) return loginPage({ error: "관리자 비밀번호가 틀렸다 개굴.", who: who.full, status: 401 });
  } else {
    if (pw !== env.SITE_PASSWORD) return loginPage({ error: "비밀번호가 틀렸다 개굴. 다시 쳐 봐라 개굴.", who: who.full, status: 401 });
    if (!(await approved(env, who.full))) {
      const rec = await record(env, who.full, true);
      const msg = !env.ACCESS ? "등록 안 된 캐릭터다 개굴. 로살리아@초코보 한테 물어봐라 개굴."
        : rec?.status === "pending" ? "아직 허락 대기 중이다 개굴. 로살리아@초코보가 보면 허락해 줄 거다 개굴."
        : rec?.status === "denied" ? "신청이 거절됐다 개굴. 로살리아@초코보 한테 물어봐라 개굴."
        : "처음 온 캐릭터다 개굴. 아래 📝 권한 신청부터 해라 개굴.";
      return loginPage({ error: msg, who: who.full, status: 403 });
    }
  }
  return signedIn(who.full, await makeToken(env, who.full), isAdmin(env, who.full));
}

async function handleRequest(env, form) {
  const who = parseCharacter(form.get("who"));
  const back = (error) => loginPage({ mode: "request", error, who: form.get("who"), status: 400 });
  if (!env.ACCESS) return back("지금은 신청을 못 받는다 개굴. 로살리아@초코보 한테 직접 말해라 개굴.");
  if (!who) return back("캐릭터명@서버 로 쳐라 개굴. 서버는 카벙클·초코보·모그리·톤베리·펜리르 중 하나다 개굴.");
  if (form.get("pw") !== env.SITE_PASSWORD) return back("공용 비밀번호가 틀렸다 개굴. 받은 비밀번호를 쳐라 개굴.");
  if (isAdmin(env, who.full)) return back("그 캐릭터는 관리자다 개굴. 들어가기에서 관리자 비밀번호로 들어와라 개굴.");
  const rec = await record(env, who.full, true);
  if (rec?.status === "approved") return loginPage({ info: "이미 허락된 캐릭터다 개굴. 바로 들어와라 개굴.", who: who.full });
  if (rec?.status === "pending") return loginPage({ mode: "sent", info: "이미 신청돼 있다 개굴. 허락해 줄 때까지 기다려라 개굴." });
  await env.ACCESS.put(`char:${who.full}`, JSON.stringify({
    status: "pending", note: String(form.get("note") || "").slice(0, 80), requestedAt: Date.now(),
  }));
  return loginPage({ mode: "sent", info: `${who.full} 신청했다 개굴. 로살리아@초코보가 허락하면 들어올 수 있다 개굴.` });
}

// 🏰 자유부대: "char:캐릭터".fc 에 부대 이름, "fc:부대" 에 부대원 목록, "ret:캐릭터" 에 리테이너 이름들
const SELL_DAYS = 7;
const fcList = async (env, fc) => (fc ? (await env.ACCESS.get(`fc:${fc}`, { type: "json" })) || [] : []);
async function setFc(env, who, fc) {
  const key = `char:${who}`, rec = (await env.ACCESS.get(key, { type: "json" })) || null;
  const old = rec?.fc || "";
  if (old && old !== fc) {
    const left = (await fcList(env, old)).filter((x) => x !== who);
    if (left.length) await env.ACCESS.put(`fc:${old}`, JSON.stringify(left));
    else await env.ACCESS.delete(`fc:${old}`);
  }
  if (fc) {
    const members = await fcList(env, fc);
    if (!members.includes(who)) await env.ACCESS.put(`fc:${fc}`, JSON.stringify([...members, who]));
  }
  return rec;
}

async function handleFc(env, request, me) {
  if (!env.ACCESS) return json({ fc: "", members: [{ who: me, retainers: [] }] });
  if (request.method === "PUT") {
    const body = await request.json().catch(() => null);
    // 🔔 직접 표시한 판매 중: [{i: 아이템ID, q: 0|1|null(품질 상관없음), w: 월드ID, at: 표시 시각(초)}] — 7일 지나면 저절로 풀린다
    if (Array.isArray(body?.sell)) {
      const old = Date.now() / 1000 - SELL_DAYS * 86400;
      const sell = body.sell.map((x) => ({ i: Math.floor(Number(x?.i)), q: x?.q == null ? null : x.q ? 1 : 0, w: String(x?.w || "").slice(0, 8), n: String(x?.n || "").slice(0, 40), at: Number(x?.at) || 0 }))
        .filter((x) => x.i > 0 && x.w && x.at > old).slice(0, 300);
      await env.ACCESS.put(`sell:${me}`, JSON.stringify(sell));
      return json({ ok: true, sell });
    }
    const names = [...new Set((Array.isArray(body?.retainers) ? body.retainers : [])
      .map((x) => String(x || "").replace(/\s+/g, "")).filter((x) => x && x.length <= 20))].slice(0, 10);
    await env.ACCESS.put(`ret:${me}`, JSON.stringify(names));
    return json({ ok: true, retainers: names });
  }
  if (request.method !== "GET") return json({ error: "없는 방법이다 개굴" }, 405);
  const fc = (await record(env, me, true))?.fc || "";
  const whos = fc ? await fcList(env, fc) : [];
  if (!whos.includes(me)) whos.unshift(me);
  const old = Date.now() / 1000 - SELL_DAYS * 86400;
  const members = await Promise.all(whos.map(async (w) => ({ who: w,
    retainers: (await env.ACCESS.get(`ret:${w}`, { type: "json" })) || [],
    sell: ((await env.ACCESS.get(`sell:${w}`, { type: "json" })) || []).filter((x) => x.at > old) })));
  return json({ fc, members });
}

// 🔑 권한 관리 (관리자만): 목록 보기, 허락·거절·내보내기
async function handleAdmin(env, request, me, url) {
  if (!isAdmin(env, me)) return json({ error: "관리자만 된다 개굴" }, 403);
  if (!env.ACCESS) return json({ error: "신청 저장소(ACCESS)가 아직 연결 안 됐다 개굴", items: [] }, 200);
  if (url.pathname === "/__admin/list") {
    const items = [];
    let cursor;
    do {
      const page = await env.ACCESS.list({ prefix: "char:", cursor });
      for (const k of page.keys) {
        const rec = await env.ACCESS.get(k.name, { type: "json" });
        if (rec) items.push({ who: k.name.slice(5), ...rec });
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    return json({ items, admins: admins(env), preset: list(env.ALLOWED_CHARACTERS) });
  }
  if (url.pathname === "/__admin/decide" && request.method === "POST") {
    const { who, action, fc: fcName } = await request.json();
    const ch = parseCharacter(who);
    if (!ch || !["approve", "deny", "remove", "fc"].includes(action)) return json({ error: "잘못된 요청이다 개굴" }, 400);
    const key = `char:${ch.full}`;
    if (action === "fc") {
      const fc = String(fcName || "").trim().replace(/\s+/g, " ").slice(0, 20);
      const rec = await env.ACCESS.get(key, { type: "json" });
      const ok = rec?.status === "approved" || isAdmin(env, ch.full) || list(env.ALLOWED_CHARACTERS).includes(ch.full);
      if (!ok) return json({ error: "허락된 캐릭터만 부대에 넣을 수 있다 개굴" }, 400);
      await setFc(env, ch.full, fc);
      await env.ACCESS.put(key, JSON.stringify({ ...(rec || { note: "", requestedAt: Date.now(), decidedAt: Date.now() }), status: "approved", fc }));
      return json({ ok: true });
    }
    if (action !== "approve") await setFc(env, ch.full, ""); // 내보내거나 거절하면 부대에서도 뺀다
    if (action === "remove") await env.ACCESS.delete(key);
    else {
      const rec = (await env.ACCESS.get(key, { type: "json" })) || { note: "", requestedAt: Date.now() };
      await env.ACCESS.put(key, JSON.stringify({ ...rec, ...(action === "deny" ? { fc: "" } : {}), status: action === "approve" ? "approved" : "denied", decidedAt: Date.now() }));
    }
    return json({ ok: true });
  }
  return json({ error: "없는 주소다 개굴" }, 404);
}

// 캐릭터별 기본 설정 (처음 설정 화면에서 정한 것). 다른 기기에서 로그인해도 따라온다
async function handleSettings(env, request, me, prefix = "set", field = "settings", limit = 8000) {
  if (!env.ACCESS) return json({ [field]: null });
  const key = `${prefix}:${me}`;
  if (request.method === "GET") return json({ [field]: await env.ACCESS.get(key, { type: "json" }) });
  if (request.method === "PUT") {
    const text = await request.text();
    if (text.length > limit) return json({ error: "너무 크다 개굴" }, 413);
    try { JSON.parse(text); } catch { return json({ error: "설정 모양이 이상하다 개굴" }, 400); }
    await env.ACCESS.put(key, text);
    return json({ ok: true });
  }
  return json({ error: "없는 방법이다 개굴" }, 405);
}

export async function onRequest(ctx) {
  const { request, env, next } = ctx;
  if (!env.SITE_PASSWORD) return next(); // 비밀번호를 안 정해 두면 문지기 꺼짐
  const url = new URL(request.url);

  if (url.pathname === "/__logout") {
    return new Response(null, { status: 302, headers: [
      ["Location", "/"],
      ["Set-Cookie", `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`],
      ["Set-Cookie", "ffx_who=; Path=/; Max-Age=0; Secure; SameSite=Lax"],
      ["Set-Cookie", "ffx_admin=; Path=/; Max-Age=0; Secure; SameSite=Lax"],
    ] });
  }
  if (url.pathname === "/__login" && request.method === "POST") return handleLogin(env, await request.formData());
  if (url.pathname === "/__request") {
    if (request.method === "POST") return handleRequest(env, await request.formData());
    return loginPage({ mode: "request", who: url.searchParams.get("who") || "" });
  }
  if (PUBLIC.has(url.pathname)) return next();

  const me = await checkToken(env, cookies(request)[COOKIE]);
  if (url.pathname === "/__settings") return me ? handleSettings(env, request, me) : json({ error: "로그인이 필요하다 개굴" }, 401);
  // 📒 제작일지: 캐릭터마다 따로 (한 줄 50바이트쯤, 최대 400KB)
  if (url.pathname === "/__journal") return me ? handleSettings(env, request, me, "log", "journal", 400000) : json({ error: "로그인이 필요하다 개굴" }, 401);
  if (url.pathname === "/__fc") return me ? handleFc(env, request, me) : json({ error: "로그인이 필요하다 개굴" }, 401);
  if (url.pathname.startsWith("/__admin/")) return me ? handleAdmin(env, request, me, url) : json({ error: "로그인이 필요하다 개굴" }, 401);
  if (me) return next();

  // 데이터·스크립트 요청은 그냥 막고, 페이지를 열려고 하면 로그인 화면
  const wantsPage = (request.headers.get("Accept") || "").includes("text/html");
  return wantsPage ? loginPage() : new Response("로그인이 필요하다 개굴", { status: 401, headers: NO_STORE });
}

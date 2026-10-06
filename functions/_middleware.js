// Cloudflare Pages 문지기: 캐릭터명@서버 + 공용 비밀번호를 맞혀야 사이트(데이터 포함)를 보여준다.
// 확인은 Cloudflare 서버에서 하니까, 비밀번호를 모르면 순위 데이터 파일도 못 받는다.
//
// Cloudflare 대시보드 → Workers & Pages → don-duruwa → Settings → Variables and Secrets 에 넣는다:
//   SITE_PASSWORD        공용 비밀번호 (없으면 문지기 꺼짐 = 누구나 들어옴)
//   ALLOWED_CHARACTERS   들어올 수 있는 캐릭터 목록, 쉼표로 (예: 로살리아@초코보,친구@모그리). 비워 두면 아무 캐릭터나
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

// "로살리아@초코보" → {name, server} (서버 이름이 틀리면 null)
export function parseCharacter(text) {
  const m = String(text || "").trim().replace(/\s+/g, "").match(/^([^@]{1,20})@([^@]+)$/);
  if (!m || !SERVERS.includes(m[2])) return null;
  return { name: m[1], server: m[2], full: `${m[1]}@${m[2]}` };
}

function allowed(env, who) {
  const list = String(env.ALLOWED_CHARACTERS || "").split(",").map((s) => s.trim().replace(/\s+/g, "")).filter(Boolean);
  return !list.length || list.includes(who);
}

// 출입증: 캐릭터|만료시각|서명. 비밀번호를 바꾸면 서명이 안 맞아서 전부 다시 로그인해야 한다
async function makeToken(env, who) {
  const exp = Math.floor(Date.now() / 1000) + DAYS * 86400;
  const body = `${encodeURIComponent(who)}|${exp}`;
  return `${body}|${await sign(env.SITE_PASSWORD, body)}`;
}
async function checkToken(env, token) {
  try {
    return await readToken(env, token);
  } catch {
    return null; // 깨진 쿠키는 그냥 로그인 안 한 걸로
  }
}
async function readToken(env, token) {
  const [who, exp, sig] = decodeURIComponent(token || "").split("|");
  if (!who || !exp || !sig || Number(exp) < Date.now() / 1000) return null;
  if (sig !== (await sign(env.SITE_PASSWORD, `${who}|${exp}`))) return null;
  const name = decodeURIComponent(who);
  return allowed(env, name) ? name : null;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function loginPage(error = "", who = "") {
  const frogs = Array.from({ length: 24 }, () =>
    `<span style="left:${(Math.random() * 97).toFixed(1)}vw;font-size:${(1.2 + Math.random() * 1.6).toFixed(2)}rem;` +
    `animation-delay:${(Math.random() * 1.8).toFixed(2)}s;animation-duration:${(2.2 + Math.random() * 1.6).toFixed(2)}s;` +
    `--spin:${(Math.random() < 0.5 ? -1 : 1) * Math.round(90 + Math.random() * 450)}deg;--drift:${(Math.random() * 16 - 8).toFixed(1)}vw">🐸</span>`).join("");
  return new Response(`<!doctype html>
<html lang="ko" data-theme="light" data-palette="jade"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>파판14 제작·채집 수익 분석</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🐸</text></svg>">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600&family=Noto+Serif+KR:wght@600&display=swap">
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/dashboard.css"><link rel="stylesheet" href="/web.css">
<script>try{const s=JSON.parse(localStorage.getItem("ffxivSettings")||"{}");const T={"다크":"dark","화이트":"light"},P={"초록":"jade","골드":"gold","크리스탈":"crystal","에테르":"aether","로즈":"rose","실버":"silver"};
if(T[s.theme])document.documentElement.dataset.theme=T[s.theme];if(P[s.palette])document.documentElement.dataset.palette=P[s.palette];}catch(e){}</script>
</head><body class="login">
<div class="frog-rain" aria-hidden="true">${frogs}</div>
<main class="login-box">
  <div class="eyebrow">CRAFTING PROFIT REPORT</div>
  <h1>파판14 제작 수익 분석</h1>
  <p class="login-sub">캐릭터명@서버랑 비밀번호를 쳐야 화면을 열어준다 개굴.</p>
  <form method="post" action="/__login" class="login-form">
    <label class="field"><span>캐릭터명@서버</span>
      <input name="who" value="${esc(who)}" placeholder="예: 로살리아@초코보" autocomplete="username" required></label>
    <label class="field"><span>비밀번호</span>
      <input name="pw" type="password" placeholder="비밀번호" autocomplete="current-password" required></label>
    <button type="submit" class="btn">들어가기</button>
  </form>
  ${error ? `<div class="login-error">🐸 ${esc(error)}</div>` : ""}
  <div class="login-contact">🐸 문의는 <b>로살리아@초코보</b> 한테 해라 개굴</div>
</main></body></html>`, { status: error ? 401 : 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
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
    ] });
  }

  if (url.pathname === "/__login" && request.method === "POST") {
    const form = await request.formData();
    const who = parseCharacter(form.get("who"));
    if (!who) return loginPage("캐릭터명@서버 로 쳐라 개굴. 서버는 카벙클·초코보·모그리·톤베리·펜리르 중 하나다 개굴.", form.get("who"));
    if (form.get("pw") !== env.SITE_PASSWORD) return loginPage("비밀번호가 틀렸다 개굴. 다시 쳐 봐라 개굴.", who.full);
    if (!allowed(env, who.full)) return loginPage("등록 안 된 캐릭터다 개굴. 로살리아@초코보 한테 물어봐라 개굴.", who.full);
    const token = await makeToken(env, who.full);
    return new Response(null, { status: 302, headers: [
      ["Location", "/"],
      ["Set-Cookie", `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`],
      // 화면 인사용 (비밀 아님)
      ["Set-Cookie", `ffx_who=${encodeURIComponent(who.full)}; Path=/; Max-Age=${DAYS * 86400}; Secure; SameSite=Lax`],
    ] });
  }

  if (PUBLIC.has(url.pathname)) return next();
  if (await checkToken(env, cookies(request)[COOKIE])) return next();

  // 데이터·스크립트 요청은 그냥 막고, 페이지를 열려고 하면 로그인 화면
  const wantsPage = (request.headers.get("Accept") || "").includes("text/html");
  return wantsPage ? loginPage() : new Response("로그인이 필요하다 개굴", { status: 401, headers: { "Cache-Control": "no-store" } });
}

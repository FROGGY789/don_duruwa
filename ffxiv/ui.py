"""화면 디자인 (Claude Design 시안 이식).

- design/tokens.css     색상·폰트 변수. 다크/화이트 × 색감 5종
- design/streamlit.css  사이드바 등 Streamlit 기본 위젯을 디자인에 맞추는 스타일
- design/dashboard.*    메인 영역(헤더·카드·탭·순위 표·재료 상세)을 그리는 컴포넌트
"""
import base64
import hmac
from html import escape as html_escape
import math
import random
import re
from pathlib import Path

import streamlit as st

from .badges import badge  # noqa: F401  (app.py 가 ui.badge 로 쓴다)

DESIGN = Path(__file__).resolve().parent / "design"
FONTS = ("@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600"
         "&family=Noto+Serif+KR:wght@600&display=swap');")
# 화면에 보이는 이름 → 디자인 내부 이름. 주소창(?theme=화이트)에도 이 이름이 들어간다.
THEMES = {"다크": "dark", "화이트": "light"}
PALETTES = {"초록": "jade", "골드": "gold", "크리스탈": "crystal", "에테르": "aether", "로즈": "rose", "실버": "silver"}
DEFAULT_THEME, DEFAULT_PALETTE = "화이트", "초록"  # 처음 열었을 때


def _read(name):
    return (DESIGN / name).read_text(encoding="utf-8")


def theme_tokens(theme, palette):
    """tokens.css 에서 고른 테마·색감의 변수만 모아 :root 하나로 만든다."""
    css = _read("tokens.css")
    root = re.search(r":root\{([^}]*)\}", css).group(1)
    blocks = dict(re.findall(r'(\[data-theme="\w+"\](?:\[data-palette="\w+"\])?)\{([^}]*)\}', css))
    parts = [root]
    if theme == "light":
        parts.append(blocks['[data-theme="light"]'])
    parts.append(blocks.get(f'[data-theme="{theme}"][data-palette="{palette}"]', ""))
    scheme = "light" if theme == "light" else "dark"
    return ":root{color-scheme:%s;%s}" % (scheme, ";".join(parts))


def apply_theme(theme, palette):
    tokens = theme_tokens(THEMES.get(theme, "light"), PALETTES.get(palette, "jade"))
    st.html(f"<style>{FONTS}{tokens}{_read('streamlit.css')}</style>")


def sidebar_brand(sb):
    sb.html('<div class="brand"><span class="brand-frog" title="개굴">🐸</span><span class="brand-name">에오르제아에서 장사꾼으로 살아남기</span></div>')


def frog_rain(where=st, count=28):
    """하늘에서 개구리가 우수수 떨어진다 (만든 사람이 개구리를 좋아해서). 몇 초 뒤 알아서 사라진다."""
    frogs = []
    for _ in range(count):
        size = random.uniform(1.2, 2.8)
        frogs.append(
            f'<span style="left:{random.uniform(0, 97):.1f}vw;font-size:{size:.2f}rem;'
            f'animation-delay:{random.uniform(0, 1.8):.2f}s;animation-duration:{random.uniform(2.2, 3.8):.2f}s;'
            f'--spin:{random.choice([-1, 1]) * random.randint(90, 540)}deg;--drift:{random.uniform(-8, 8):.1f}vw">🐸</span>')
    where.html('<div class="frog-rain" aria-hidden="true">' + "".join(frogs) + "</div>")


def sidebar_title(sb, text):
    sb.html(f'<div class="sb-title">{text}</div>')


def notice(where, text, kind="info"):
    """디자인 색에 맞춘 안내 상자 (st.info / st.error 대신)."""
    icon = {"info": "⏳", "error": "⚠"}.get(kind, "")
    where.html(f'<div class="ffx-notice {kind}"><span>{icon}</span><span>{html_escape(text)}</span></div>')


def changelog_html(log):
    parts = []
    for entry in log:
        items = "".join(f"<li>{html_escape(x)}</li>" for x in entry["changes"])
        parts.append(f'<div class="cl-entry"><div class="cl-head"><b>v{html_escape(entry["version"])}</b>'
                     f'<span>{html_escape(entry["date"])}</span></div><ul>{items}</ul></div>')
    return '<div class="changelog">' + "".join(parts) + "</div>"


def sidebar_note(sb, html):
    sb.html(f'<div class="sb-note">{html}</div>')


_component = None


def dashboard(data):
    """메인 영역 전체를 그린다. 탭·정렬·행 선택은 브라우저에서 처리된다."""
    global _component
    if _component is None:
        _component = st.components.v2.component(
            "ffxiv_dashboard", css=_read("dashboard.css"), js=_read("dashboard.js"))
    _component(data=_clean(data), key="dashboard")


def _clean(v):
    """JSON 으로 못 보내는 값(무한대, NaN)을 None 으로. 소수는 둘째 자리까지만 (보내는 양 줄이기)."""
    if isinstance(v, float):
        return None if math.isinf(v) or math.isnan(v) else round(v, 2)
    if isinstance(v, dict):
        return {k: _clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_clean(x) for x in v]
    return v


def ago(ts, now):
    if not ts:
        return "기록 없음"
    sec = max(0, now - ts)
    if sec < 3600:
        return f"{int(sec // 60)}분 전"
    if sec < 86400:
        return f"{int(sec // 3600)}시간 전"
    return f"{int(sec // 86400)}일 전"


# 개구리가 집 고치는 그림 (직접 그린 SVG, 색은 tokens.css 변수)
FROG_FIXING_HOUSE = """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 260">
  <style>
    .moved-hammer{transform-origin:248px 196px;animation:hit 1.1s ease-in-out infinite}
    .moved-spark{transform-origin:176px 110px;animation:spark 1.1s ease-in-out infinite}
    @keyframes hit{0%,100%{transform:rotate(0)}45%{transform:rotate(18deg)}55%{transform:rotate(-6deg)}}
    @keyframes spark{0%,40%,100%{opacity:0;transform:scale(.4)}55%{opacity:1;transform:scale(1)}}
  </style>
  <ellipse cx="180" cy="238" rx="160" ry="12" fill="var(--surface-2)"/>
  <!-- 집 -->
  <rect x="34" y="112" width="150" height="122" rx="4" fill="var(--surface)" stroke="var(--border-strong)" stroke-width="3"/>
  <path d="M22 118 L109 46 L196 118 Z" fill="var(--warning-soft)" stroke="var(--warning)" stroke-width="4" stroke-linejoin="round"/>
  <rect x="92" y="170" width="36" height="64" rx="3" fill="var(--warning-soft)" stroke="var(--warning)" stroke-width="3"/>
  <circle cx="120" cy="204" r="3" fill="var(--warning)"/>
  <rect x="48" y="134" width="32" height="28" rx="2" fill="var(--info-soft)" stroke="var(--border-strong)" stroke-width="3"/>
  <path d="M64 134v28M48 148h32" stroke="var(--border-strong)" stroke-width="2"/>
  <!-- 덧댄 판자 + 못 -->
  <g transform="rotate(-12 150 140)">
    <rect x="128" y="130" width="62" height="16" rx="2" fill="var(--warning)" opacity=".85"/>
    <circle cx="136" cy="138" r="2.4" fill="var(--text-muted)"/><circle cx="182" cy="138" r="2.4" fill="var(--text-muted)"/>
  </g>
  <!-- 사다리 -->
  <g stroke="var(--text-faint)" stroke-width="4" stroke-linecap="round">
    <path d="M206 236 L226 104"/><path d="M246 236 L264 104"/>
    <path d="M211 206h39M216 176h38M220 146h38M224 118h38"/>
  </g>
  <!-- 개구리 -->
  <g class="moved-frog">
    <ellipse cx="282" cy="196" rx="38" ry="34" fill="var(--positive)"/>
    <ellipse cx="282" cy="206" rx="24" ry="20" fill="var(--positive-soft)"/>
    <circle cx="264" cy="160" r="15" fill="var(--positive)"/><circle cx="300" cy="160" r="15" fill="var(--positive)"/>
    <circle cx="264" cy="158" r="9" fill="var(--surface)"/><circle cx="300" cy="158" r="9" fill="var(--surface)"/>
    <circle cx="262" cy="158" r="4.5" fill="var(--text)"/><circle cx="298" cy="158" r="4.5" fill="var(--text)"/>
    <path d="M268 182 Q282 192 296 182" fill="none" stroke="var(--text)" stroke-width="3" stroke-linecap="round"/>
    <ellipse cx="256" cy="178" rx="5" ry="3" fill="var(--negative-soft)"/><ellipse cx="308" cy="178" rx="5" ry="3" fill="var(--negative-soft)"/>
    <!-- 안전모 -->
    <path d="M250 150 Q282 116 314 150 Z" fill="var(--warning)"/><rect x="246" y="147" width="72" height="7" rx="3.5" fill="var(--warning)"/>
    <ellipse cx="262" cy="230" rx="14" ry="6" fill="var(--positive)"/><ellipse cx="302" cy="230" rx="14" ry="6" fill="var(--positive)"/>
    <!-- 망치 든 팔 -->
    <g class="moved-hammer">
      <path d="M248 196 Q228 186 222 168" fill="none" stroke="var(--positive)" stroke-width="10" stroke-linecap="round"/>
      <rect x="216" y="128" width="7" height="44" rx="3" fill="var(--warning)" transform="rotate(-20 220 168)"/>
      <rect x="196" y="122" width="34" height="14" rx="3" fill="var(--text-muted)" transform="rotate(-20 220 168)"/>
    </g>
  </g>
  <g fill="var(--warning)" class="moved-spark"><path d="M176 96l4 10 10 4-10 4-4 10-4-10-10-4 10-4z"/></g>
</svg>"""


def _svg_img(svg, theme, palette, cls):
    """st.html 은 <svg> 를 지워 버려서 그림 파일(data URI)로 넣는다. 색 변수는 지금 테마 값으로 바꿔 끼운다."""
    tokens = dict(re.findall(r"(--[\w-]+):([^;]+)", theme_tokens(THEMES[theme], PALETTES[palette])))
    for _ in range(3):  # 변수 안에 변수가 있을 수 있다
        svg = re.sub(r"var\((--[\w-]+)\)", lambda m: tokens.get(m.group(1), "currentColor").strip(), svg)
    data = base64.b64encode(svg.encode()).decode()
    return f'<img class="{cls}" alt="개구리가 망치로 집을 고치는 그림" src="data:image/svg+xml;base64,{data}">'


def moved_page():
    """Streamlit 은 닫았다: 새 사이트로 이사 안내만 보여준다."""
    theme = st.query_params.get("theme", DEFAULT_THEME)
    palette = st.query_params.get("palette", DEFAULT_PALETTE)
    theme = theme if theme in THEMES else DEFAULT_THEME
    palette = palette if palette in PALETTES else DEFAULT_PALETTE
    apply_theme(theme, palette)
    st.html("""<style>
      [data-testid="stSidebar"],[data-testid="stSidebarCollapsedControl"],header[data-testid="stHeader"]{display:none}
      .moved{max-width:560px;margin:6vh auto 0;text-align:center;color:var(--text)}
      .moved-art{width:min(360px,90%);height:auto;display:block;margin:0 auto var(--space-6)}
      .moved h1{font-family:var(--font-display);font-size:var(--fs-2xl);margin:0 0 var(--space-4);color:var(--text)}
      .moved p{margin:0 0 var(--space-2);color:var(--text-muted);font-size:var(--fs-md);line-height:1.7}
      .moved b{color:var(--primary-strong)}
    </style>""")
    st.html('<div class="moved">' + _svg_img(FROG_FIXING_HOUSE, theme, palette, "moved-art") +
            '<h1>장사 접습니다 개구리 뿌려요</h1>'
            '<p>사이트 안정화를 위해 이사했어요.</p>'
            '<p><b>로살리아@초코보</b>에게 문의해 주세요.</p></div>')
    frog_rain()


def _app_password():
    """Streamlit Secrets 의 app_password. 설정이 없으면 None (비밀번호 없이 열림)."""
    try:
        return st.secrets.get("app_password") or None
    except Exception:  # secrets.toml 자체가 없을 때
        return None


def password_gate():
    """비밀번호를 맞게 입력해야 아래 화면이 보인다. 한 번 맞히면 창을 닫을 때까지 유지."""
    password = _app_password()
    if password is None or st.session_state.get("authed"):
        return
    theme = st.query_params.get("theme", DEFAULT_THEME)
    palette = st.query_params.get("palette", DEFAULT_PALETTE)
    apply_theme(theme if theme in THEMES else DEFAULT_THEME, palette if palette in PALETTES else DEFAULT_PALETTE)
    st.html("<style>" + _read("login.css") + "</style>")
    st.html('<div class="login-head"><div class="eyebrow">CRAFTING PROFIT REPORT</div>'
            '<h1>에오르제아에서 장사꾼으로 살아남기</h1><p>비밀번호를 쳐야 화면을 열어준다 개굴.</p></div>')
    frog_rain()
    with st.form("login", border=False):
        typed = st.text_input("비밀번호", type="password", placeholder="비밀번호")
        ok = st.form_submit_button("들어가기", type="primary", width="stretch")
    if ok:
        if hmac.compare_digest(typed.encode(), str(password).encode()):
            st.session_state["authed"] = True
            st.rerun()
        st.html('<div class="login-error">🐸 비밀번호가 틀렸다 개굴. 다시 쳐 봐라 개굴.</div>')
    st.html('<div class="login-contact">🐸 문의는 <b>로살리아@초코보</b> 한테 해라 개굴</div>')
    st.stop()

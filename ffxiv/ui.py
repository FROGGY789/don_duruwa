"""화면 디자인 (Claude Design 시안 이식).

- design/tokens.css     색상·폰트 변수. 다크/화이트 × 색감 5종
- design/streamlit.css  사이드바 등 Streamlit 기본 위젯을 디자인에 맞추는 스타일
- design/dashboard.*    메인 영역(헤더·카드·탭·순위 표·재료 상세)을 그리는 컴포넌트
"""
import hmac
from html import escape as html_escape
import math
import random
import re
from pathlib import Path

import streamlit as st

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
    sb.html('<div class="brand"><span class="brand-frog" title="개굴">🐸</span><span class="brand-name">제작·채집 수익 분석</span></div>')


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


def badge(text, tip=None):
    """기타 칸 뱃지. 비전서는 짧게 '비전서'만 보이고 누르면 팝오버, 나머지는 마우스 올리믄 설명(tip)."""
    if text.startswith("비전서"):
        return {"kind": "book", "text": "📖 비전서", "detail": text.split(":", 1)[-1].strip()}
    kind = ("odd" if text.startswith("❗") else "stale" if text.startswith(("⚠", "🔥", "📉", "🔻"))
            else "world" if text.startswith("🌐") else "nq")
    return {"kind": kind, "text": text, "tip": tip}


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
            '<h1>파판14 제작 수익 분석</h1><p>비밀번호를 쳐야 화면을 열어준다 개굴.</p></div>')
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

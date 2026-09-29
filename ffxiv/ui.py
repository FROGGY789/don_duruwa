"""화면 디자인 (Claude Design 시안 이식).

- design/tokens.css     색상·폰트 변수. 다크/화이트 × 색감 5종
- design/streamlit.css  사이드바 등 Streamlit 기본 위젯을 디자인에 맞추는 스타일
- design/dashboard.*    메인 영역(헤더·카드·탭·순위 표·재료 상세)을 그리는 컴포넌트
"""
import math
import re
from pathlib import Path

import streamlit as st

DESIGN = Path(__file__).resolve().parent / "design"
FONTS = ("@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600"
         "&family=Noto+Serif+KR:wght@600&display=swap');")
# 화면에 보이는 이름 → 디자인 내부 이름. 주소창(?theme=화이트)에도 이 이름이 들어간다.
THEMES = {"다크": "dark", "화이트": "light"}
PALETTES = {"골드": "gold", "크리스탈": "crystal", "에테르": "aether", "로즈": "rose", "실버": "silver"}


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
    tokens = theme_tokens(THEMES.get(theme, "dark"), PALETTES.get(palette, "gold"))
    st.html(f"<style>{FONTS}{tokens}{_read('streamlit.css')}</style>")


def sidebar_brand(sb):
    sb.html('<div class="brand"><span class="brand-mark"></span><span class="brand-name">제작 수익 분석</span></div>')


def sidebar_title(sb, text):
    sb.html(f'<div class="sb-title">{text}</div>')


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
    """JSON 으로 못 보내는 값(무한대, NaN)을 None 으로."""
    if isinstance(v, float) and (math.isinf(v) or math.isnan(v)):
        return None
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


def badge_kind(text):
    if text.startswith("비전서"):
        return "book"
    if text.startswith("⚠"):
        return "stale"
    return "nq"

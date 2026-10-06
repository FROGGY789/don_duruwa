"""기타 칸 뱃지 (Streamlit 화면과 정적 사이트가 같이 쓴다)."""


def badge(text, tip=None):
    """비전서는 짧게 '비전서'만 보이고 누르면 팝오버, 나머지는 마우스 올리면 설명(tip)."""
    if text.startswith("비전서"):
        return {"kind": "book", "text": "📖 비전서", "detail": text.split(":", 1)[-1].strip()}
    kind = ("odd" if text.startswith("❗") else "stale" if text.startswith(("⚠", "🔥", "📉", "🔻"))
            else "world" if text.startswith("🌐") else "nq")
    return {"kind": kind, "text": text, "tip": tip}

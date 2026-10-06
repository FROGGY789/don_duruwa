# 작업 규칙

- 사용자에게 보이는 기능을 바꾸면 `ffxiv/changelog.py` 의 `CHANGELOG` 맨 위에 항목을 추가한다.
  - 큰 기능 추가는 가운데 숫자 +1 (1.7.0 → 1.8.0), 작은 수정은 끝 숫자 +1 (1.7.0 → 1.7.1)
  - date 는 한국 시간 `YYYY-MM-DD HH:MM` (`TZ=Asia/Seoul date "+%Y-%m-%d %H:%M"`)
  - 내용은 짧게, 화면의 다른 멘트처럼 개굴체로
- 화면에 보이는 안내·오류 멘트는 개굴체로 쓴다: 표준어 반말 문장 끝에 " 개굴" 을 붙인다 (예: "판매 기록이 없다 개굴."). 메뉴 이름·컬럼 제목·뱃지 글자는 표준어 그대로.
- 디자인 색은 `ffxiv/design/tokens.css` 변수만 쓴다 (화이트/다크 × 색감 모두 확인).
- 화면은 두 벌이다: Streamlit(`app.py`)과 정적 사이트(`web/` + `python -m ffxiv.build`). 표·상세(`ffxiv/design/dashboard.*`)는 같이 쓰니 고치면 둘 다 확인한다.

"""config.yaml 읽기."""
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
CACHE_DIR = ROOT / "cache"

JOB_NAMES = ["목수", "대장", "갑주", "보석", "가죽", "재봉", "연금", "요리"]  # CraftType 0~7 순서

TAX_CITIES = {
    "Limsa Lominsa": "림사 로민사",
    "Gridania": "그리다니아",
    "Ul'dah": "울다하",
    "Ishgard": "이슈가르드",
    "Kugane": "쿠가네",
    "Crystarium": "크리스타리움",
    "Old Sharlayan": "올드 샬레이안",
    "Tuliyollal": "툴라이욜라",
}


def load_config(path=ROOT / "config.yaml"):
    with open(path, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    for job in JOB_NAMES:
        cfg["job_levels"].setdefault(job, 0)
    return cfg

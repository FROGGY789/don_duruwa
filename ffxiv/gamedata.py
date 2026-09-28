"""게임 데이터(레시피 / 아이템 / NPC 상점) 불러오기.

한국어 데이터마이닝 CSV 를 그대로 씁니다. 한국 서버는 글로벌보다 패치가 늦기 때문에
레시피 구조도 한국 클라이언트 데이터 기준으로 잡아야 한국에 없는 아이템이 섞이지 않습니다.

직접 실행하면 (python -m ffxiv.gamedata) 분석 대상 레시피 목록을 출력합니다.
"""
import csv
from dataclasses import dataclass, field

import requests

from .config import DATA_DIR, JOB_NAMES, load_config

SHEETS = ["Recipe", "Item", "RecipeLevelTable", "GilShopItem", "SecretRecipeBook", "ItemUICategory"]
CSV_DIR = DATA_DIR / "csv"


def download_csvs(base_url, force=False, progress=None):
    """CSV 를 data/csv/ 에 내려받는다. 이미 있으면 건너뜀 (force=True 면 다시 받음)."""
    CSV_DIR.mkdir(parents=True, exist_ok=True)
    for i, sheet in enumerate(SHEETS):
        path = CSV_DIR / f"{sheet}.csv"
        if progress:
            progress(i / len(SHEETS), f"{sheet}.csv 받는 중")
        if path.exists() and not force:
            continue
        resp = requests.get(f"{base_url}/{sheet}.csv", timeout=120)
        resp.raise_for_status()
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(resp.content)
        tmp.replace(path)


def iter_sheet(sheet, fields):
    """CSV 한 줄마다 (key, {필드명: 값}) 을 돌려준다.

    CSV 형식: 1행 = 칼럼 번호, 2행 = 칼럼 이름, 3행 = 자료형, 4행부터 데이터.
    """
    path = CSV_DIR / f"{sheet}.csv"
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        next(reader)
        names = next(reader)
        next(reader)
        idx = {}
        for name in fields:
            if name not in names:
                raise KeyError(f"{sheet}.csv 에 '{name}' 칼럼이 없습니다. 데이터 형식이 바뀌었을 수 있어요.")
            idx[name] = names.index(name)
        for row in reader:
            if row:
                yield row[0], {name: row[i] for name, i in idx.items()}


def _int(s):
    try:
        return int(float(s))
    except ValueError:
        return 0


def _bool(s):
    return s.strip().lower() == "true"


@dataclass
class Item:
    id: int
    name: str
    ui_category: int
    search_category: int
    untradable: bool
    can_hq: bool
    price_mid: int  # NPC 상점 구매가

    @property
    def marketable(self):
        return not self.untradable and self.search_category > 0


@dataclass
class Recipe:
    id: int
    job: int  # 0~7 = JOB_NAMES 순서
    job_level: int
    stars: int
    result_id: int
    result_amount: int
    ingredients: list = field(default_factory=list)  # [(item_id, amount), ...] 크리스탈 포함
    secret_book: str = ""
    quest_unlock: bool = False
    expert: bool = False
    specialist: bool = False

    @property
    def job_name(self):
        return JOB_NAMES[self.job]


class GameData:
    def __init__(self):
        self.items = {}
        self.recipes = []
        self.recipes_by_result = {}
        self.npc_prices = {}
        self.ui_category_names = {}
        self._load()

    def _load(self):
        for key, r in iter_sheet("ItemUICategory", ["Name"]):
            self.ui_category_names[_int(key)] = r["Name"]

        for key, r in iter_sheet("Item", ["Name", "ItemUICategory", "ItemSearchCategory",
                                          "IsUntradable", "CanBeHq", "Price{Mid}"]):
            iid = _int(key)
            if iid <= 0:
                continue
            self.items[iid] = Item(
                id=iid,
                name=r["Name"] or f"#{iid}",
                ui_category=_int(r["ItemUICategory"]),
                search_category=_int(r["ItemSearchCategory"]),
                untradable=_bool(r["IsUntradable"]),
                can_hq=_bool(r["CanBeHq"]),
                price_mid=_int(r["Price{Mid}"]),
            )

        levels = {}
        for key, r in iter_sheet("RecipeLevelTable", ["ClassJobLevel", "Stars"]):
            levels[_int(key)] = (_int(r["ClassJobLevel"]), _int(r["Stars"]))

        books = {}
        for key, r in iter_sheet("SecretRecipeBook", ["Name"]):
            books[_int(key)] = r["Name"]

        ing_fields = []
        for i in range(8):
            ing_fields += [f"Item{{Ingredient}}[{i}]", f"Amount{{Ingredient}}[{i}]"]
        fields = ["CraftType", "RecipeLevelTable", "Item{Result}", "Amount{Result}", "SecretRecipeBook",
                  "Quest", "IsExpert", "IsSpecializationRequired"] + ing_fields
        for key, r in iter_sheet("Recipe", fields):
            result_id = _int(r["Item{Result}"])
            job = _int(r["CraftType"])
            if result_id <= 0 or result_id not in self.items or not 0 <= job < len(JOB_NAMES):
                continue
            job_level, stars = levels.get(_int(r["RecipeLevelTable"]), (0, 0))
            ingredients = []
            for i in range(8):
                iid = _int(r[f"Item{{Ingredient}}[{i}]"])
                amt = _int(r[f"Amount{{Ingredient}}[{i}]"])
                if iid > 0 and amt > 0:
                    ingredients.append((iid, amt))
            recipe = Recipe(
                id=_int(key),
                job=job,
                job_level=job_level,
                stars=stars,
                result_id=result_id,
                result_amount=max(1, _int(r["Amount{Result}"])),
                ingredients=ingredients,
                secret_book=books.get(_int(r["SecretRecipeBook"]), ""),
                quest_unlock=_int(r["Quest"]) > 0,
                expert=_bool(r["IsExpert"]),
                specialist=_bool(r["IsSpecializationRequired"]),
            )
            self.recipes.append(recipe)
            self.recipes_by_result.setdefault(result_id, []).append(recipe)

        # NPC 길 상점: 퀘스트/업적 조건 없이 파는 아이템만
        for _, r in iter_sheet("GilShopItem", ["Item", "Quest{Required}[0]", "Quest{Required}[1]",
                                               "Achievement{Required}"]):
            iid = _int(r["Item"])
            if iid <= 0 or iid not in self.items:
                continue
            if _int(r["Quest{Required}[0]"]) or _int(r["Quest{Required}[1]"]) or _int(r["Achievement{Required}"]):
                continue
            price = self.items[iid].price_mid
            if price > 0:
                self.npc_prices[iid] = price

    def name(self, item_id):
        item = self.items.get(item_id)
        return item.name if item else f"#{item_id}"

    def display_name(self, recipe):
        """별 레시피는 이름 앞에 ★ 를 붙인다."""
        return "★" * recipe.stars + self.name(recipe.result_id)

    def ids_by_name(self, names):
        wanted = set(names or [])
        return {iid for iid, it in self.items.items() if it.name in wanted}


def scope_recipes(gd, cfg, include_all):
    """시세를 받아둘 전체 범위: 레벨과 상관없이, 거래소 판매 가능, (기본) 하우징 가구."""
    furniture = set(cfg["furniture_ui_categories"])
    for r in gd.recipes:
        if r.expert or r.specialist:
            continue
        item = gd.items[r.result_id]
        if not item.marketable:
            continue
        if not include_all and item.ui_category not in furniture:
            continue
        yield r


def target_recipes(gd, cfg, include_all, level_min, level_max, job_levels=None):
    """분석 대상 레시피: 전체 범위 중 레벨 범위 안이고 내 직업 레벨로 가능한 것."""
    job_levels = job_levels or cfg["job_levels"]
    for r in scope_recipes(gd, cfg, include_all):
        if level_min <= r.job_level <= level_max and r.job_level <= job_levels[r.job_name]:
            yield r


def can_craft_intermediate(recipe, cfg, job_levels=None):
    """중간재료를 직접 만들 수 있는지: 내 레벨 이하, 별 없음, 전문/고난도 아님."""
    if recipe.expert or recipe.specialist or recipe.stars > 0:
        return False
    if recipe.secret_book and not cfg.get("allow_secret_recipe_intermediates", False):
        return False
    job_levels = job_levels or cfg["job_levels"]
    return recipe.job_level <= job_levels[recipe.job_name]


if __name__ == "__main__":
    cfg = load_config()
    download_csvs(cfg["datamining_base_url"])
    gd = GameData()
    print(f"아이템 {len(gd.items):,}개, 레시피 {len(gd.recipes):,}개, NPC 판매 아이템 {len(gd.npc_prices):,}개")
    targets = sorted(target_recipes(gd, cfg, False, cfg["recipe_level_min"], cfg["recipe_level_max"]),
                     key=lambda r: (r.job, r.job_level, r.stars, r.id))
    print(f"\n레벨 {cfg['recipe_level_min']}~{cfg['recipe_level_max']} 하우징 레시피: {len(targets)}개\n")
    for r in targets:
        extra = []
        if r.secret_book:
            extra.append(f"비전서: {r.secret_book}")
        if r.quest_unlock:
            extra.append("퀘스트 해금")
        cat = gd.ui_category_names.get(gd.items[r.result_id].ui_category, "")
        print(f"  [{r.job_name}] Lv{r.job_level:<3} {gd.display_name(r):<24} ({cat}) {' / '.join(extra)}")

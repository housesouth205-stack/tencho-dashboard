#!/usr/bin/env python3
"""対象機種一覧の作成（一覧ページからの機械的な列挙）.

2つの一覧を突き合わせて data/targets.json を作る。

  DMMぱちタウン  /machines/slot?page=N
      一覧カードに導入開始日が載っているので、機種ページを開かずに年代で絞れる。
      6号機の施行日（2018-02-01）以降に導入された機種だけを候補にする。

  P-WORLD  t_machine.cgi?mode=slot_type / mode=s_spec
      機種ページの「タイプ」欄が規則区分（スマスロ／6.5号機／6号機）の一次情報。
      ここでは 機種名 → P-WORLD機種ID の対応表を作る。

導入開始日での絞り込みは「候補を集めるため」だけに使う。
規則区分そのものは日付から推定せず、P-WORLDのタイプ欄を読んで確定させる
（日付から号機を決めるのは推測にあたるため）。

    python3 scripts/enumerate_targets.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent))

import sources  # noqa: E402
from fetch_specs import Politeness, fetch  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "targets.json"

# 6号機の規則が施行された日。これ以降に導入された機種を候補にする
CUTOFF = "2018-02-01"

DMM_LIST = "https://p-town.dmm.com/machines/slot?page={page}"
DMM_MAX_PAGE = 80

PW = "https://www.p-world.co.jp/_machine/t_machine.cgi"
PW_LISTS = [
    ("slot_type", "over_6.5number", "6.5号機以降"),
    ("slot_type", "AT", "AT"),
    ("slot_type", "aRT", "ART"),
    ("slot_type", "NORMAL", "ノーマル"),
    ("slot_type", "RT", "RT"),
]


def collect_dmm(pol: Politeness) -> list[dict]:
    """導入開始日が CUTOFF を下回るまで一覧ページを遡る。"""
    found: dict[str, dict] = {}
    for page in range(1, DMM_MAX_PAGE + 1):
        html = fetch(DMM_LIST.format(page=page), pol)
        if html is None:
            print(f"  DMM page={page}: 取得失敗。ここで打ち切り", file=sys.stderr)
            break
        recs = sources.dmm_list_page(html)
        if not recs:
            print(f"  DMM page={page}: 0件。ここで打ち切り")
            break
        dated = [r for r in recs if r["導入開始日"]]
        for r in recs:
            if r["導入開始日"] and r["導入開始日"] >= CUTOFF:
                found[r["dmm_id"]] = r
        oldest = min((r["導入開始日"] for r in dated), default="")
        print(f"  DMM page={page:>2}: {len(recs)}件 最古 {oldest or '不明'} / 累計 {len(found)}")
        if oldest and oldest < CUTOFF:
            break
    return list(found.values())


def collect_pworld(pol: Politeness) -> dict[str, dict]:
    """P-WORLDの各カテゴリ一覧を全ページ巡回し、名寄せキー → 機種情報 を作る。"""
    index: dict[str, dict] = {}
    for mode, key, label in PW_LISTS:
        first = f"{PW}?mode={mode}&key={quote(key, safe='.')}"
        html = fetch(first, pol)
        if html is None:
            print(f"  P-WORLD {label}: 取得失敗。スキップ", file=sys.stderr)
            continue
        total = sources.pworld_count(html) or 0
        print(f"  P-WORLD {label}: 全{total}件")
        start = 0
        while True:
            url = first if start == 0 else f"{first}&start={start}&aflag="
            html = fetch(url, pol) if start else html
            if html is None:
                break
            recs = sources.pworld_list_page(html)
            if not recs:
                break
            for r in recs:
                k = sources.norm_name(r["機種名"])
                if k:
                    index.setdefault(k, {**r, "カテゴリ": label})
            start += 50
            if start >= total:
                break
        print(f"    → 名寄せ済み累計 {len(index)}")
    return index


P7_LIST = "https://pachiseven.jp/machines/list_machine/slot/page:{page}"
P7_MAX_PAGE = 120


def collect_pachi7(pol: Politeness) -> dict[str, dict]:
    """パチ7の機種一覧を最後のページまで巡回し、名寄せキー → 機種情報 を作る。

    出率の照合相手として使う。スロベースが載せていない機種でも、
    パチ7とDMMぱちタウンの2件で機械割の範囲を突き合わせられる。
    """
    index: dict[str, dict] = {}
    for page in range(1, P7_MAX_PAGE + 1):
        url = P7_LIST.format(page=page) if page > 1 else \
            "https://pachiseven.jp/machines/list_machine/slot.html"
        html = fetch(url, pol)
        if html is None:
            break
        recs = sources.pachi7_list_page(html)
        if not recs:
            print(f"  パチ7 page={page}: 0件。ここで打ち切り")
            break
        before = len(index)
        for r in recs:
            k = sources.norm_name(r["機種名"])
            if k:
                index.setdefault(k, r)
        if page % 10 == 0:
            print(f"  パチ7 page={page:>3}: 累計 {len(index)}")
        if len(index) == before and page > 2:
            print(f"  パチ7 page={page}: 新規なし。ここで打ち切り")
            break
    print(f"  パチ7 名寄せ索引: {len(index)}件")
    return index


def main() -> int:
    pol = Politeness()

    print("== DMMぱちタウン 一覧の巡回 ==")
    dmm = collect_dmm(pol)
    print(f"DMM候補（導入開始日 >= {CUTOFF}）: {len(dmm)}件\n")

    print("== P-WORLD 一覧の巡回 ==")
    pw = collect_pworld(pol)
    print(f"P-WORLD 名寄せ索引: {len(pw)}件\n")
    # 名寄せの失敗を後から追えるように索引を残す
    (ROOT / "data" / "pworld_index.json").write_text(
        json.dumps(pw, ensure_ascii=False, indent=2), encoding="utf-8")

    print("== パチ7 一覧の巡回 ==")
    p7 = collect_pachi7(pol)
    (ROOT / "data" / "pachi7_index.json").write_text(
        json.dumps(p7, ensure_ascii=False, indent=2), encoding="utf-8")
    print()

    targets, unmatched, p7_hit = [], [], 0
    for r in dmm:
        key = sources.norm_name(r["機種名"])
        hit = pw.get(key)
        h7 = p7.get(key)
        if h7:
            p7_hit += 1
        rec = {
            "機種名": r["機種名"],
            "名寄せキー": key,
            "dmm_id": r["dmm_id"],
            "dmm_url": f"https://p-town.dmm.com/machines/{r['dmm_id']}",
            "導入開始日": r["導入開始日"],
            "一覧機械割下限": r["機械割下限"],
            "一覧機械割上限": r["機械割上限"],
            "スマスロ表示": r["スマスロ表示"],
        }
        if hit:
            rec["pw_id"] = hit["pw_id"]
            rec["pw_url"] = f"https://www.p-world.co.jp/machine/database/{hit['pw_id']}"
            rec["pwメーカー"] = hit["メーカー"]
        else:
            unmatched.append(r["機種名"])
        if h7:
            rec["p7_id"] = h7["p7_id"]
            rec["p7_url"] = f"https://pachiseven.jp/machines/{h7['p7_id']}"
        targets.append(rec)

    targets.sort(key=lambda r: (r["導入開始日"], r["機種名"]), reverse=True)
    OUT.write_text(json.dumps({
        "_meta": {
            "説明": "全件取得フェーズの対象機種一覧。規則区分は未確定（P-WORLD機種ページで確定させる）",
            "候補抽出条件": f"DMMぱちタウンの一覧で導入開始日 >= {CUTOFF}",
            "DMM候補数": len(dmm),
            "P-WORLD照合済": len(targets) - len(unmatched),
            "P-WORLD未照合": len(unmatched),
            "パチ7照合済": p7_hit,
        },
        "targets": targets,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"対象候補: {len(targets)}件")
    print(f"  P-WORLD照合済: {len(targets) - len(unmatched)}")
    print(f"  パチ7照合済  : {p7_hit}")
    print(f"  P-WORLD未照合: {len(unmatched)}（規則区分は別途確認が必要）")
    for n in unmatched[:15]:
        print(f"    - {n}")
    print(f"\n出力: {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""照合ロジックの検証.

merge_candidates.merge_one が、取得ルールを破らないことを確認する。
とくに「範囲表記から設定2〜5を埋めない」「食い違いを黙って解決しない」の2点は
データの正しさに直結するので、フィクスチャで固定しておく。

    python3 scripts/test_merge.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from merge_candidates import merge_one  # noqa: E402

TODAY = "2026-08-13"

SLOBASE_FULL = {
    "url": "https://slobase.jp/machines/x",
    "設定別出率": {"1": 97.9, "2": 98.9, "3": 100.9, "4": 105.0, "5": 107.8, "6": 112.1},
    "出率条件": "",
}
DMM_RANGE = {
    "url": "https://p-town.dmm.com/machines/1",
    "設定別出率": {"1": 97.9, "6": 112.1},
    "メーカー": "サミー", "型式名": "Lテスト機A",
}
PW_BASE = {
    "url": "https://www.p-world.co.jp/machine/database/1",
    "規則区分": "スマスロ", "機種タイプ": "AT", "メーカー": "サミー",
    "型式名": "Lテスト機A", "検定番号": "6S0001", "設置店舗数": 1200,
    "店舗数区分": "設置店", "設置調査日": "2026-08-01", "タイプ原文": "スマスロ、6.5号機、AT",
}


def rec(**srcs):
    return {"機種名": "テスト機", "名寄せキー": "てすとき", "情報源": dict(srcs)}


def check(name: str, cond: bool, detail: str = "") -> bool:
    print(f"{'PASS' if cond else 'FAIL'}  {name}")
    if not cond and detail:
        print(f"      {detail}")
    return cond


def main() -> int:
    results = []

    # 1. 範囲表記しかない場合、設定2〜5は空欄のまま
    m = merge_one(rec(**{"DMMぱちタウン": DMM_RANGE, "P-WORLD": PW_BASE}), TODAY)
    blanks = [m[f"設定{s}出率"] for s in (2, 3, 4, 5)]
    results.append(check("範囲表記から設定2〜5を埋めない",
                         all(v == "" for v in blanks) and m["設定1出率"] == 97.9,
                         f"設定2〜5={blanks} 設定1={m['設定1出率']}"))

    # 2. 情報源が1つだけなら信頼度「高」にしない
    results.append(check("1情報源のみでは高にしない", m["信頼度"] == "低", f"信頼度={m['信頼度']}"))

    # 3. 2情報源で設定1・6が一致したら「高」
    m2 = merge_one(rec(**{"スロベース": SLOBASE_FULL, "DMMぱちタウン": DMM_RANGE,
                          "P-WORLD": PW_BASE}), TODAY)
    results.append(check("設定1・6が2情報源で一致 → 高",
                         m2["信頼度"] == "高" and m2["設定3出率"] == 100.9,
                         f"信頼度={m2['信頼度']}"))
    results.append(check("出典URLを情報源ぶん保持",
                         len(m2["出率出典URL"]) == 2, str(m2["出率出典URL"])))

    # 4. 食い違いは平均せず、両方の値を残して要確認にする
    conflict = dict(DMM_RANGE, 設定別出率={"1": 99.9, "6": 112.1})
    m3 = merge_one(rec(**{"スロベース": SLOBASE_FULL, "DMMぱちタウン": conflict,
                          "P-WORLD": PW_BASE}), TODAY)
    avg = (97.9 + 99.9) / 2
    results.append(check("不一致は要確認にする", m3["信頼度"] == "要確認", f"信頼度={m3['信頼度']}"))
    results.append(check("不一致でも平均を入れない", m3["設定1出率"] != avg,
                         f"設定1={m3['設定1出率']} (平均={avg})"))
    results.append(check("不一致の両方の値を備考に残す",
                         "97.9" in m3["備考"] and "99.9" in m3["備考"], m3["備考"][:120]))

    # 5. 設置店舗数があれば現行、無ければ現行判定要確認
    results.append(check("設置店舗数から現行と判定", m2["現行判定"] == "現行", m2["現行判定"]))
    m4 = merge_one(rec(**{"スロベース": SLOBASE_FULL,
                          "P-WORLD": dict(PW_BASE, 設置店舗数=None, 店舗数区分="")}), TODAY)
    results.append(check("設置店舗数不明なら現行判定要確認",
                         m4["現行判定"] == "現行判定要確認", m4["現行判定"]))

    # 導入予定はまだ設置されていないので現行と断定しない
    m4b = merge_one(rec(**{"スロベース": SLOBASE_FULL,
                           "P-WORLD": dict(PW_BASE, 設置店舗数=1, 店舗数区分="導入予定")}), TODAY)
    results.append(check("導入予定なら現行と断定しない",
                         m4b["現行判定"] == "現行判定要確認" and "導入予定" in m4b["備考"],
                         m4b["現行判定"]))

    # 6. 出率が1件も取れなければ未取得として理由を残す
    m5 = merge_one(rec(**{"P-WORLD": PW_BASE}), TODAY)
    results.append(check("出率ゼロなら未取得理由を残す",
                         bool(m5.get("未取得理由")) and m5.get("再調査要否") == "要"))

    # 7. コイン単価は推定せず空欄のまま
    results.append(check("コイン単価を推定しない",
                         m2["コイン単価"] == "" and "コイン単価未確認" in m2["備考"]))

    # 8. メーカー不一致を黙って片方に寄せない
    m6 = merge_one(rec(**{"スロベース": SLOBASE_FULL,
                          "DMMぱちタウン": dict(DMM_RANGE, メーカー="三洋"),
                          "P-WORLD": dict(PW_BASE, メーカー="三洋物産")}), TODAY)
    results.append(check("メーカー表記の不一致を備考に残す",
                         "メーカー表記が情報源間で不一致" in m6["備考"], m6["備考"][:100]))

    passed = sum(results)
    print(f"\n{passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())

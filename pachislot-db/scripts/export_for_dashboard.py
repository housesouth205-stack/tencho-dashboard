#!/usr/bin/env python3
"""機種データベースを店長ダッシュボードが読む形に書き出す.

data/machines.json（原本）から、出玉率管理画面が必要とする項目だけを抜いて
src/data/payout-db.json を作る。ダッシュボードは素のJSで動きビルド工程が無いので、
そのまま fetch できる1ファイルにまとめる。

出玉率の粒度を2つに分けて持たせる。ダッシュボード側の扱いが変わるため。

  設定別 … 設定ごとの機械割表から取れた値。null は「その機種にその設定が無い」。
           ダッシュボードはこの null を見て、存在しない設定を割り当てない。
  範囲   … 機械割の範囲表記から取れた設定1と設定6だけの値。
           ダッシュボード側でタイプ標準カーブに写像して設定2〜5を補間する。
           元データに設定2〜5は存在しないので、DB側では空のまま持つ。

    python3 scripts/export_for_dashboard.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "machines.json"
OUT = ROOT.parent / "src" / "data" / "payout-db.json"

# 機種DBの機種タイプ → ダッシュボードのタイプ既定カーブのキー
TYPE_MAP = {"Aタイプ": "Aタイプ", "AT": "AT機", "ART": "AT機", "BT": "Aタイプ"}

SETTINGS = [f"設定{i}出率" for i in range(1, 7)]


def main() -> int:
    raw = json.loads(SRC.read_text(encoding="utf-8"))
    out = []
    per_setting = range_only = 0

    for m in raw["machines"]:
        rates = [m.get(c) if isinstance(m.get(c), (int, float)) else None for c in SETTINGS]
        known = [v for v in rates if v is not None]
        if not known:
            continue  # 出率が1件も無い機種は画面に出しても埋められないので載せない

        # 設定1と6だけ＝範囲表記由来。それ以外は設定ごとの表から取れている
        only_ends = len(known) == 2 and rates[0] is not None and rates[5] is not None
        grain = "範囲" if only_ends else "設定別"
        if only_ends:
            range_only += 1
        else:
            per_setting += 1

        rec = {
            "機種名": m["機種名"],
            "出率": rates,
            "粒度": grain,
            # その機種に存在する設定。複数の情報源が一致したときだけ入る。
            # ダッシュボードはレンジ補間のあとこれで絞り込み、
            # 設定1・2・5・6しか無い機種の設定3・4に値を作らないようにする。
            "存在する設定": m.get("存在する設定") or [],
            "信頼度": m.get("信頼度", ""),
            "出率条件": m.get("出率条件", ""),
            "出典": m.get("出率出典URL", [])[:3],
        }
        if m.get("別表記"):
            rec["別表記"] = m["別表記"]
        if TYPE_MAP.get(m.get("機種タイプ", "")):
            rec["タイプ"] = TYPE_MAP[m["機種タイプ"]]
        if m.get("規則区分"):
            rec["規則区分"] = m["規則区分"]
        # コイン単価は参考値として持つだけ。ダッシュボードの「コイン単価」は
        # 売上÷アウトの実測値であり別物なので、上書きには使わない。
        if isinstance(m.get("コイン単価"), (int, float)):
            rec["参考コイン単価"] = m["コイン単価"]
            rec["参考コイン単価条件"] = m.get("コイン単価条件", "")
        out.append(rec)

    out.sort(key=lambda r: r["機種名"])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "_meta": {
            "説明": "パチスロ機種データベースの出玉率。pachislot-db/data/machines.json から生成",
            "生成元": "pachislot-db/scripts/export_for_dashboard.py",
            "取得日": raw["_meta"]["取得日"],
            "機種数": len(out),
            "設定別": per_setting,
            "範囲のみ": range_only,
            "注意": "出率のnullは『その機種にその設定が無い』。粒度が範囲の機種は設定1と6のみ実測。",
        },
        "machines": out,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    size = OUT.stat().st_size
    print(f"{len(out)}機種 → {OUT} ({size / 1024:.0f}KB)")
    print(f"  設定別の表から取得: {per_setting}")
    print(f"  範囲表記のみ（設定1・6）: {range_only}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""候補データの照合と data/machines.json への反映.

candidates/collected.json（情報源ごとの生データ）を突き合わせ、
ルールに沿って1機種1レコードに落とす。

照合の原則:

- 数値が食い違ったら平均も内挿もしない。両方の出典URLを残し、
  食い違いの内容を備考に書き出したうえで信頼度を「要確認」に落とす。
  セルには設定別の表を持つ情報源（スロベース）の値を入れる。
  範囲表記から割り出した両端値より、設定ごとに掲載された値のほうが情報として細かいため。
  どちらを採ったかは備考に明記し、他方の値もURLごと残す。
- 範囲表記からは設定1と設定6しか埋めない。設定2〜5は空欄のまま。
- 出典URLの無い数値は書かない。
- 規則区分・機種タイプ・メーカーは P-WORLD のタイプ欄を一次情報にする。
  導入年から号機を推定するようなことはしない。
- 現行判定は P-WORLD 掲載の設置店舗数で判断する。0店舗・記載なしは「現行判定要確認」。

    python3 scripts/merge_candidates.py
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import sources  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
COLLECTED = ROOT / "candidates" / "collected.json"
OUT = ROOT / "data" / "machines.json"

IN_SCOPE = {"スマスロ", "6.5号機", "6号機"}
SETTINGS = [1, 2, 3, 4, 5, 6]
# 出率の一致判定の許容差。サイトごとの丸め（97.85→97.8/97.9）を吸収する幅にとどめる
TOLERANCE = 0.1

# P-WORLDの機種タイプ表記 → 列定義の機種タイプ
TYPE_MAP = {"AT": "AT", "ART": "ART", "ノーマル": "Aタイプ", "RT": "ART", "BT": "BT"}


def _rates(src: dict) -> dict[int, float]:
    return {int(k): float(v) for k, v in (src.get("設定別出率") or {}).items()}


def merge_one(rec: dict, today: str) -> dict:
    name = rec["機種名"]
    srcs = rec["情報源"]
    dmm = srcs.get("DMMぱちタウン", {})
    pw = srcs.get("P-WORLD", {})
    slo = srcs.get("スロベース", {})
    nana = srcs.get("ななプレス", {})
    p7 = srcs.get("パチ7", {})

    notes: list[str] = []
    rate_urls: list[str] = []
    maker_urls: list[str] = []

    # ---------------- 出率の照合
    # 設定ごとの表を持つスロベースを主、範囲表記しか無いDMM・パチ7を従として扱う。
    # 主が無ければ従の値をそのまま入れる。どちらの場合も採用元を備考に残す。
    by_source = [(n, _rates(s), s.get("url", ""))
                 for n, s in (("スロベース", slo), ("ななプレス", nana),
                              ("DMMぱちタウン", dmm), ("パチ7", p7))
                 if s.get("url") and _rates(s)]

    rates: dict[int, float] = {}
    primary = ""
    filled_from: dict[int, str] = {}
    for sname, srates, url in by_source:
        rate_urls.append(url)
        if not primary:
            primary = sname
        # 先に読んだ情報源の値は上書きしない。空いている設定だけを別の情報源で補う。
        # 補った設定は採用元を控えて備考に残す（どのセルがどこ由来か辿れるように）。
        for s, v in srates.items():
            if s not in rates:
                rates[s] = v
                filled_from[s] = sname
    supplemented = sorted(s for s, n in filled_from.items() if n != primary)

    conflicts: list[str] = []
    agreed: list[int] = []
    for s in SETTINGS:
        vals = [(n, r[s]) for n, r, _ in by_source if s in r]
        if len(vals) < 2:
            continue
        lo = min(v for _, v in vals)
        hi = max(v for _, v in vals)
        if hi - lo <= TOLERANCE:
            agreed.append(s)
        else:
            conflicts.append(f"設定{s}: " + " / ".join(f"{n} {v}%" for n, v in vals))

    # ---------------- 規則区分・機種タイプ・メーカー
    kikaku = pw.get("規則区分", "")
    pw_type = pw.get("機種タイプ", "")
    machine_type = TYPE_MAP.get(pw_type, "") if pw_type else ""

    maker = pw.get("メーカー", "") or dmm.get("メーカー", "")
    if pw.get("メーカー") and dmm.get("メーカー"):
        if sources.norm_name(pw["メーカー"]) != sources.norm_name(dmm["メーカー"]):
            notes.append(f"メーカー表記が情報源間で不一致（P-WORLD『{pw['メーカー']}』/ "
                         f"DMMぱちタウン『{dmm['メーカー']}』）")
    if pw.get("url"):
        maker_urls.append(pw["url"])
    if dmm.get("url") and dmm.get("メーカー"):
        maker_urls.append(dmm["url"])

    katashiki = pw.get("型式名", "") or dmm.get("型式名", "")
    if pw.get("型式名") and dmm.get("型式名") and pw["型式名"] != dmm["型式名"]:
        notes.append(f"型式名が不一致（P-WORLD『{pw['型式名']}』/ DMMぱちタウン『{dmm['型式名']}』）")

    # ---------------- 現行判定（設置店舗数を根拠にする）
    shops = pw.get("設置店舗数")
    kubun = pw.get("店舗数区分", "")
    survey = f" 調査日{pw['設置調査日']}" if pw.get("設置調査日") else ""
    if kubun == "設置店" and shops:
        genko = "現行"
        notes.append(f"設置店舗数 {shops:,}店舗（P-WORLD調べ{survey}）")
    elif kubun == "導入予定":
        # 導入予定はまだ設置されていない。現行と断定できないので要確認に倒す
        genko = "現行判定要確認"
        notes.append(f"導入予定 {shops:,}店舗（P-WORLD調べ{survey}）。未設置のため現行と断定できない")
    else:
        genko = "現行判定要確認"
        notes.append("設置店舗数の記載を確認できず、現行稼働かを判断できない")

    # ---------------- 信頼度
    if conflicts:
        conf = "要確認"
        notes.append("出率が情報源間で不一致: " + " ／ ".join(conflicts)
                     + f"。平均・選択は行わず全情報源の出典を保存。セルには{primary}の値を採用"
                     + "（設定ごとの表を持つ情報源を優先。他の値は本欄に保持）")
    elif {1, 6} <= set(agreed):
        conf = "高"
        notes.append(f"設定{'・'.join(str(s) for s in agreed)}の出率が"
                     f"{len(by_source)}情報源で一致")
    elif agreed:
        conf = "中"
        notes.append(f"設定{'・'.join(str(s) for s in agreed)}のみ複数情報源で一致")
    elif len(rates) >= 6:
        conf = "中"
        notes.append(f"設定1〜6を{primary}のみで取得（他情報源との照合は未達）")
    elif rates:
        conf = "低"
        notes.append(f"{primary}の範囲表記からの設定1・6のみ。"
                     "設定2〜5は範囲表記のため取得できず空欄")
    else:
        conf = "要確認"

    if supplemented:
        notes.append("設定" + "・".join(str(s) for s in supplemented)
                     + "は" + "／".join(sorted({filled_from[s] for s in supplemented}))
                     + "から補完（採用元が異なるため出典URLを併記）")

    # ---------------- コイン単価
    coin = slo.get("コイン単価")
    coin_cond, coin_urls = "", []
    if coin is not None:
        coin_cond = slo.get("コイン単価条件", "") or "条件表記なし"
        coin_urls = [slo["url"]]
        notes.append(f"コイン単価はスロベース掲載値『{slo.get('コイン単価原文', '')}』"
                     + (f"／回転数50枚 {slo['回転数50枚']}" if slo.get("回転数50枚") else ""))

    # ---------------- 別表記
    aliases = []
    for s in (dmm, pw, slo, nana, p7):
        n = s.get("機種名")
        if n and n != name and n not in aliases:
            aliases.append(n)
    if pw.get("検定番号"):
        notes.append(f"検定番号 {pw['検定番号']}")
    if pw.get("タイプ原文"):
        notes.append(f"P-WORLD掲載タイプ『{pw['タイプ原文']}』")

    out = {
        "機種名": name,
        "メーカー": maker,
        "機種タイプ": machine_type or slo.get("機種タイプ", ""),
        "メディア区分": ("スマスロ" if kikaku == "スマスロ"
                        else ("メダル機" if kikaku else slo.get("メディア区分", ""))),
        "ATタイプ": slo.get("ATタイプ", ""),
        "ボーナスタイプ": "",
        "規則区分": kikaku,
        "型式名": katashiki,
        "コイン単価": coin if coin is not None else "",
        "コイン単価条件": coin_cond,
        "出率条件": slo.get("出率条件") or nana.get("出率条件") or "不明（条件表記未確認）",
        "出率出典URL": rate_urls,
        "コイン単価出典URL": coin_urls,
        "メーカー出典URL": maker_urls,
        "現行判定": genko,
        "信頼度": conf,
        "別表記": aliases,
        "備考": " ／ ".join(notes),
        "_導入開始日": pw.get("導入開始日") or dmm.get("導入開始日", ""),
    }
    for s in SETTINGS:
        out[f"設定{s}出率"] = rates.get(s, "")

    if not rates:
        tried = [k for k in ("スロベース", "ななプレス", "DMMぱちタウン", "パチ7", "P-WORLD")
                 if k in srcs]
        out["未取得理由"] = "設定別出率・機械割のいずれも掲載を確認できなかった"
        out["試した情報源"] = tried
        out["再調査要否"] = "要"
    if not out["コイン単価"]:
        out["備考"] = (out["備考"] + " ／ " if out["備考"] else "") + "コイン単価未確認"
    return out


def main() -> int:
    data = json.loads(COLLECTED.read_text(encoding="utf-8"))
    today = date.today().isoformat()

    machines, skipped, no_kikaku = [], [], []
    for rec in data["machines"]:
        m = merge_one(rec, today)
        k = m["規則区分"]
        if k and k not in IN_SCOPE:
            skipped.append((m["機種名"], k))
            continue
        if not k:
            no_kikaku.append(m["機種名"])
            m["現行判定"] = "現行判定要確認"
            m["備考"] += " ／ 規則区分をP-WORLDのタイプ欄で確認できず、対象範囲か判断できない"
        machines.append(m)

    machines.sort(key=lambda m: (m.pop("_導入開始日") or "", m["機種名"]), reverse=True)

    OUT.write_text(json.dumps({
        "_meta": {
            "取得日": today,
            "対象": "スマスロ／6.5号機／6号機（規則区分はP-WORLD掲載のタイプ欄による）",
            "候補抽出": data["_meta"],
            "対象外として除外": len(skipped),
            "規則区分不明": len(no_kikaku),
            "情報源": {
                "設定別出率": "スロベース（slobase.jp）",
                "機械割の範囲": "DMMぱちタウン（p-town.dmm.com）",
                "規則区分・機種タイプ・型式名・検定番号・設置店舗数": "P-WORLD（www.p-world.co.jp）",
            },
        },
        "machines": machines,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    conf = Counter(m["信頼度"] for m in machines)
    print(f"反映: {len(machines)}機種 → {OUT}")
    print(f"  対象外（5号機等）として除外: {len(skipped)}")
    print(f"  規則区分不明（残置・要確認）: {len(no_kikaku)}")
    print(f"  信頼度: {dict(conf)}")
    print(f"  規則区分: {dict(Counter(m['規則区分'] or '不明' for m in machines))}")
    if skipped:
        print("  除外例:", ", ".join(f"{n}({k})" for n, k in skipped[:8]))
    return 0


if __name__ == "__main__":
    sys.exit(main())

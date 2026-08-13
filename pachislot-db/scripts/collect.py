#!/usr/bin/env python3
"""対象機種の詳細取得（情報源ごとの生データを candidates/ に落とす）.

data/targets.json の各機種について、情報源ごとに「そのページに書いてあったこと」を
そのまま記録する。ここでは統合も照合もしない（merge_candidates.py の役割）。

  スロベース  /machines/{slug}      設定1〜6の機械割（点の値）
  DMMぱちタウン /machines/{id}       型式名・メーカー・機械割の範囲・導入開始日
  P-WORLD    /machine/database/{id} タイプ（規則区分・機種タイプ）・検定番号・型式名

範囲表記（「97.8% 〜 114.1%」）は設定1と設定6の値としてのみ記録し、
設定2〜5は空のままにする（README ルール2）。

    python3 scripts/collect.py            # 全件
    python3 scripts/collect.py --limit 20 # 先頭20機種で試す
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import sources  # noqa: E402
from fetch_specs import Politeness, extract_condition, extract_rates, fetch  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
TARGETS = ROOT / "data" / "targets.json"
CANDIDATES = ROOT / "candidates"

SLOBASE_SITEMAP = "https://slobase.jp/sitemap.xml"
SLOBASE_MACHINE_RE = re.compile(r"https://slobase\.jp/machines/[^/<]+$")


def collect_slobase(pol: Politeness) -> dict[str, dict]:
    """スロベースの全機種ページを巡回し、名寄せキー → 設定別出率 を作る。"""
    sm = fetch(SLOBASE_SITEMAP, pol)
    if sm is None:
        print("  スロベース: sitemap取得失敗", file=sys.stderr)
        return {}
    urls = [u for u in re.findall(r"<loc>(.*?)</loc>", sm) if SLOBASE_MACHINE_RE.match(u)]
    print(f"  スロベース: 機種ページ {len(urls)}件")

    index: dict[str, dict] = {}
    for i, u in enumerate(urls, 1):
        html = fetch(u, pol)
        if html is None:
            continue
        name = sources.slobase_machine_page(html)["機種名"]
        rates = extract_rates(html)
        key = sources.norm_name(name)
        if not key:
            continue
        index[key] = {
            "機種名": name,
            "url": u,
            "設定別出率": {str(k): v for k, v in sorted(rates.items())},
            "出率条件": extract_condition(html),
        }
        if i % 25 == 0 or i == len(urls):
            got = sum(1 for v in index.values() if v["設定別出率"])
            print(f"    {i}/{len(urls)} 完了 / 出率取得済 {got}")
    return index


def collect_machine(rec: dict, pol: Politeness, slobase: dict[str, dict]) -> dict:
    """1機種ぶんの生データを情報源ごとに集める。"""
    out: dict = {"機種名": rec["機種名"], "名寄せキー": rec["名寄せキー"], "情報源": {}}

    html = fetch(rec["dmm_url"], pol)
    if html is not None:
        d = sources.dmm_machine_page(html)
        d.pop("_d", None)
        d["url"] = rec["dmm_url"]
        d["設定別出率"] = {}
        if d["機械割下限"] is not None:
            # 範囲は設定1〜6の幅。両端だけを記録し、設定2〜5は埋めない
            d["設定別出率"] = {"1": d["機械割下限"], "6": d["機械割上限"]}
            d["出率の出所"] = "機械割の範囲表記（設定1・6のみ）"
        out["情報源"]["DMMぱちタウン"] = d
    else:
        out["情報源"]["DMMぱちタウン"] = {"url": rec["dmm_url"], "status": "取得失敗"}

    if rec.get("pw_url"):
        html = fetch(rec["pw_url"], pol)
        if html is not None:
            p = sources.pworld_machine_page(html)
            p["url"] = rec["pw_url"]
            out["情報源"]["P-WORLD"] = p
        else:
            out["情報源"]["P-WORLD"] = {"url": rec["pw_url"], "status": "取得失敗"}

    if rec.get("p7_url"):
        html = fetch(rec["p7_url"], pol)
        if html is not None:
            p7 = sources.pachi7_machine_page(html)
            p7["url"] = rec["p7_url"]
            p7["設定別出率"] = {}
            if p7["機械割下限"] is not None:
                p7["設定別出率"] = {"1": p7["機械割下限"], "6": p7["機械割上限"]}
                p7["出率の出所"] = "出玉率の範囲表記（設定1・6のみ）"
            out["情報源"]["パチ7"] = p7
        else:
            out["情報源"]["パチ7"] = {"url": rec["p7_url"], "status": "取得失敗"}

    hit = slobase.get(rec["名寄せキー"])
    if hit:
        out["情報源"]["スロベース"] = {
            "url": hit["url"],
            "設定別出率": hit["設定別出率"],
            "出率条件": hit["出率条件"],
            "出率の出所": "設定別の機械割表",
        }
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, help="先頭N機種だけ処理する（試走用）")
    ap.add_argument("--skip-slobase", action="store_true")
    args = ap.parse_args()

    data = json.loads(TARGETS.read_text(encoding="utf-8"))
    targets = data["targets"]
    if args.limit:
        targets = targets[: args.limit]

    CANDIDATES.mkdir(exist_ok=True)
    pol = Politeness()

    print("== スロベース（設定1〜6の一次情報） ==")
    slobase = {} if args.skip_slobase else collect_slobase(pol)
    if slobase:
        (CANDIDATES / "slobase.json").write_text(
            json.dumps(slobase, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n== 機種ページの取得（{len(targets)}件） ==")
    collected = []
    for i, rec in enumerate(targets, 1):
        collected.append(collect_machine(rec, pol, slobase))
        if i % 20 == 0 or i == len(targets):
            print(f"  {i}/{len(targets)} 完了")

    out = CANDIDATES / "collected.json"
    out.write_text(json.dumps({"_meta": data["_meta"], "machines": collected},
                              ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n出力: {out}")
    print("※ これは情報源ごとの生データ。data/machines.json への反映は merge_candidates.py で照合してから行う。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""抽出ロジックのオフライン検証.

解析サイトで実際に使われている表の形（横持ち／縦持ち／範囲表記のみ）を模した
フィクスチャで、extract_rates が正しく動くこと・推測で埋めないことを確認する。

    python3 scripts/test_extract.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_specs import extract_condition, extract_rates  # noqa: E402

# 横持ち: ヘッダが設定1〜6
HORIZONTAL = """
<table>
  <tr><th>項目</th><th>設定1</th><th>設定2</th><th>設定3</th>
      <th>設定4</th><th>設定5</th><th>設定6</th></tr>
  <tr><td>BIG確率</td><td>1/273.1</td><td>1/269.7</td><td>1/259.0</td>
      <td>1/254.0</td><td>1/240.9</td><td>1/229.1</td></tr>
  <tr><td>機械割</td><td>97.0%</td><td>98.0%</td><td>99.5%</td>
      <td>101.5%</td><td>104.0%</td><td>109.4%</td></tr>
</table>
<p>数値はメーカー発表値です。</p>
"""

# 縦持ち: 1列目が設定、ヘッダに機械割の列
VERTICAL = """
<table>
  <tr><th>設定</th><th>AT初当り</th><th>出玉率</th></tr>
  <tr><td>設定1</td><td>1/383.4</td><td>98.0%</td></tr>
  <tr><td>設定2</td><td>1/360.0</td><td>99.0%</td></tr>
  <tr><td>設定3</td><td>1/340.0</td><td>100.5%</td></tr>
  <tr><td>設定4</td><td>1/300.0</td><td>105.0%</td></tr>
  <tr><td>設定5</td><td>1/270.0</td><td>108.5%</td></tr>
  <tr><td>設定6</td><td>1/235.1</td><td>113.0%</td></tr>
</table>
"""

# 範囲表記のみ: 個別設定値ではないので1件も拾ってはいけない
RANGE_ONLY = """
<table>
  <tr><th>項目</th><th>スペック</th></tr>
  <tr><td>機械割</td><td>97.7〜114.9%</td></tr>
  <tr><td>AT初当り確率</td><td>1/581.8〜1/407.3</td></tr>
</table>
"""

# 全角の設定表記＋「約」付き
ZENKAKU = """
<table>
  <tr><th>設定</th><th>機械割</th></tr>
  <tr><td>設定１</td><td>約97.2%</td></tr>
  <tr><td>設定６</td><td>約106.5%</td></tr>
</table>
<p>完全攻略時の数値。</p>
"""

# 出率と無関係な数値だらけの表を誤検出しないこと
NOISE = """
<table>
  <tr><th>設定1</th><th>設定2</th><th>設定6</th></tr>
  <tr><td>ぶどう 1/6.35</td><td>1/6.30</td><td>1/5.78</td></tr>
</table>
"""

# 実サイトに多い閉じタグ欠落。</td> も </tr> も無い
UNCLOSED = """
<table>
  <tr><th>設定<th>機械割
  <tr><td>設定1<td>97.8%
  <tr><td>設定6<td>112.4%
</table>
"""

# thead/tbody で囲まれ、セル内に装飾タグが入る実サイト型
NESTED_MARKUP = """
<table class="spec">
  <thead><tr><th>設定</th><th>出玉率</th></tr></thead>
  <tbody>
    <tr><td><span class="s">設定&#49;</span></td><td><strong>98.<em>2</em></strong>%</td></tr>
    <tr><td>設定6</td><td>110.9&nbsp;%</td></tr>
  </tbody>
</table>
<div>数値は独自調査値です。</div>
"""

# スペック表の外側にレイアウト用テーブルがある（入れ子）。内側の表を選ぶこと
NESTED_TABLE = """
<table><tr><td>
  <table>
    <tr><th>項目</th><th>設定1</th><th>設定2</th><th>設定3</th>
        <th>設定4</th><th>設定5</th><th>設定6</th></tr>
    <tr><td>機械割</td><td>96.9%</td><td>97.8%</td><td>99.1%</td>
        <td>103.4%</td><td>107.6%</td><td>115.2%</td></tr>
  </table>
</td></tr></table>
"""

# 見出しが「設定」で、本文は素の数字だけの表
BARE_DIGITS = """
<table>
  <tr><th>設定</th><th>BIG</th><th>出玉率 (機械割)</th></tr>
  <tr><td>1</td><td>1/295.2</td><td>98.2%</td></tr>
  <tr><td>6</td><td>1/277.7</td><td>106.2%</td></tr>
</table>
"""

# 素の数字の表でも、値が範囲なら拾わない（設定ごとの機械割に幅を持たせるサイト）
BARE_DIGITS_RANGE = """
<table>
  <tr><th>設定</th><th>出玉率 (機械割)</th></tr>
  <tr><td>1</td><td>98.2% 〜100.3%</td></tr>
  <tr><td>6</td><td>106.2% 〜108.7%</td></tr>
</table>
"""

# 「設定」を含まない見出しの表では、素の数字を設定番号と解釈しないこと
BARE_DIGITS_NOT_SETTING = """
<table>
  <tr><th>段階</th><th>機械割</th></tr>
  <tr><td>1</td><td>98.2%</td></tr>
  <tr><td>6</td><td>106.2%</td></tr>
</table>
"""

# 設定1と設定6しか載せない表（実サイトに多い）。2列でも拾えること
TWO_SETTINGS_ONLY = """
<table>
  <tr><th>項目</th><th>設定1</th><th>設定6</th></tr>
  <tr><td>出玉率</td><td>96.9%</td><td>115.2%</td></tr>
</table>
"""

# script/style の中身を本文として拾わないこと
SCRIPT_NOISE = """
<script>var 機械割 = "設定1: 999.9%";</script>
<style>.x{content:"完全攻略時"}</style>
<table>
  <tr><th>設定</th><th>機械割</th></tr>
  <tr><td>設定1</td><td>97.0%</td></tr>
</table>
"""


def check(name: str, html: str, expect: dict[int, float], expect_cond: str = "") -> bool:
    got = extract_rates(html)
    cond = extract_condition(html)
    ok = got == expect and cond == expect_cond
    print(f"{'PASS' if ok else 'FAIL'}  {name}")
    if not ok:
        print(f"      期待 rates={expect} cond='{expect_cond}'")
        print(f"      実際 rates={got} cond='{cond}'")
    return ok


def main() -> int:
    results = [
        check("横持ちテーブル（6設定＋メーカー発表値）", HORIZONTAL,
              {1: 97.0, 2: 98.0, 3: 99.5, 4: 101.5, 5: 104.0, 6: 109.4}, "メーカー発表値"),
        check("縦持ちテーブル（6設定）", VERTICAL,
              {1: 98.0, 2: 99.0, 3: 100.5, 4: 105.0, 5: 108.5, 6: 113.0}),
        check("範囲表記のみ → 1件も拾わない", RANGE_ONLY, {}),
        check("全角設定＋約付き＋完全攻略時", ZENKAKU, {1: 97.2, 6: 106.5}, "完全攻略時"),
        check("小役確率の表を誤検出しない", NOISE, {}),
        check("閉じタグ欠落のHTML", UNCLOSED, {1: 97.8, 6: 112.4}),
        check("thead/tbody＋セル内装飾タグ＋実体参照", NESTED_MARKUP,
              {1: 98.2, 6: 110.9}, "独自調査値"),
        check("レイアウト用テーブルの入れ子", NESTED_TABLE,
              {1: 96.9, 2: 97.8, 3: 99.1, 4: 103.4, 5: 107.6, 6: 115.2}),
        check("設定1と設定6だけの表", TWO_SETTINGS_ONLY, {1: 96.9, 6: 115.2}),
        check("見出し『設定』＋素の数字", BARE_DIGITS, {1: 98.2, 6: 106.2}),
        check("素の数字でも範囲表記は拾わない", BARE_DIGITS_RANGE, {}),
        check("『設定』見出しでなければ数字を設定と解釈しない", BARE_DIGITS_NOT_SETTING, {}),
        check("script/style の中身を本文にしない", SCRIPT_NOISE, {1: 97.0}),
    ]
    passed = sum(results)
    print(f"\n{passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())

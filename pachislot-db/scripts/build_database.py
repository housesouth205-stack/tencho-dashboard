#!/usr/bin/env python3
"""パチスロ機種データベース ビルダー

data/machines.json を唯一の入力とし、以下を生成する。

  output/slot_machine_database.csv   機種マスター
  output/slot_machine_database.xlsx  4シート（機種マスター／出率ランキング／要確認／未取得機種）
  output/unacquired_machines.csv     未取得機種一覧
  output/needs_review.csv            要確認機種一覧
  output/quality_report.txt          データ品質チェック結果

方針：値の補完・推測は一切行わない。欠損は空欄のまま出力し、
異常値は自動修正せず「要確認」として列挙する。

依存パッケージは無い。この環境ではパッケージレジストリが egress で遮断されており
pandas も openpyxl も導入できないため、表の保持は下の Table クラス、
xlsx 生成は minixlsx（いずれも標準ライブラリのみ）で行う。
"""

from __future__ import annotations

import csv
import json
import re
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import minixlsx  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "machines.json"
OUT = ROOT / "output"

SETTING_COLS = [f"設定{i}出率" for i in range(1, 7)]

COLUMNS = [
    "機種名",
    "メーカー",
    "機種タイプ",
    "メディア区分",
    "ATタイプ",
    "ボーナスタイプ",
    "規則区分",
    "型式名",
    "コイン単価",
    "コイン単価条件",
    *SETTING_COLS,
    "出率条件",
    "出率出典URL",
    "コイン単価出典URL",
    "メーカー出典URL",
    "データ取得日",
    "現行判定",
    "信頼度",
    "備考",
    "別表記",
]


# ---------------------------------------------------------------- 表の保持


class Table:
    """列順を保った表。pandas.DataFrame のうち本スクリプトが使う分だけを持つ。"""

    def __init__(self, rows, columns=None):
        self.rows: list[dict] = [dict(r) for r in rows]
        if columns is None:
            seen: dict[str, None] = {}
            for r in self.rows:
                for k in r:
                    seen.setdefault(k, None)
            columns = list(seen)
        self.columns: list[str] = list(columns)
        for r in self.rows:  # 欠けている列は空欄で揃える（0で埋めない）
            for c in self.columns:
                r.setdefault(c, "")

    @property
    def empty(self) -> bool:
        return not self.rows

    def __len__(self) -> int:
        return len(self.rows)

    def __iter__(self):
        return iter(self.rows)

    def col(self, name: str) -> list:
        return [r[name] for r in self.rows]

    def sort_by(self, key: str, reverse: bool = False) -> "Table":
        return Table(sorted(self.rows, key=lambda r: r[key], reverse=reverse), self.columns)

    def matrix(self) -> list[list]:
        return [[r[c] for c in self.columns] for r in self.rows]

    def to_csv(self, path: Path) -> None:
        with open(path, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f, lineterminator="\n")
            w.writerow(self.columns)
            w.writerows(self.matrix())


# ---------------------------------------------------------------- 正規化辞書

# メーカー名の表記ゆれ統一（左＝ゆれ、右＝正式表記）。
# 正式表記はP-WORLDの掲載名に合わせ、他サイトの別表記を左辺に足していく。
MAKER_CANON = {
    # --- 表記ゆれのある社
    "SANKYO": "SANKYO", "三共": "SANKYO", "サンキョー": "SANKYO",
    "サミー": "サミー", "Sammy": "サミー", "SAMMY": "サミー",
    "北電子": "北電子", "KITA DENSHI": "北電子", "きたでんし": "北電子",
    "山佐": "山佐", "YAMASA": "山佐", "ヤマサ": "山佐",
    "大都技研": "大都技研", "DAITO": "大都技研", "だいと": "大都技研",
    "パイオニア": "パイオニア", "PIONEER": "パイオニア",
    "藤商事": "藤商事", "FUJISHOJI": "藤商事",
    "三洋物産": "三洋物産", "三洋": "三洋物産",
    "パオン・ディーピー": "パオン・ディーピー", "パオン･ディーピー": "パオン・ディーピー",
    "パオンディーピー": "パオン・ディーピー",
    "アクロス": "アクロス", "アクロス(ユニバーサル)": "アクロス",
    "オッケー.": "オッケー.", "オッケー": "オッケー.",
    "サンセイR&D": "サンセイR&D", "サンセイＲ＆Ｄ": "サンセイR&D",
    # DMMぱちタウンが英字・略称で載せる社。P-WORLDの掲載名に寄せる
    "エキサイト": "エキサイト", "EXCITE": "エキサイト",
    "清龍ゲームジャパン": "清龍ゲームジャパン", "清龍ジャパン": "清龍ゲームジャパン",
    # 共同開発名義。どちらか片方に寄せると出所が消えるのでそのまま残す
    "オーイズミ×ごらく": "オーイズミ×ごらく",
    "WORLD": "WORLD",
    # --- 以下は表記ゆれが確認されていない社（正規化辞書の登録済み判定用）
    "ビスティ": "ビスティ", "Bisty": "ビスティ",
    "ミズホ": "ミズホ", "メーシー": "メーシー", "オリンピア": "オリンピア",
    "オリンピアエステート": "オリンピアエステート", "エンターライズ": "エンターライズ",
    "コナミアミューズメント": "コナミアミューズメント", "ネット": "ネット",
    "オーイズミ": "オーイズミ", "JPS": "JPS", "京楽": "京楽", "ベルコ": "ベルコ",
    "スパイキー": "スパイキー", "セブンリーグ": "セブンリーグ", "アムテックス": "アムテックス",
    "ユニバーサルブロス": "ユニバーサルブロス", "サボハニ": "サボハニ",
    "山佐ネクスト": "山佐ネクスト", "エレコ": "エレコ", "サンスリー": "サンスリー",
    "平和": "平和", "エキサイト": "エキサイト", "カルミナ": "カルミナ",
    "バルテック": "バルテック", "アデリオン": "アデリオン", "JFJ": "JFJ",
    "DAXEL": "DAXEL", "ニューギン": "ニューギン", "清龍ゲームジャパン": "清龍ゲームジャパン",
    "ヤーマ": "ヤーマ", "七匠": "七匠", "岡崎産業": "岡崎産業", "D-light": "D-light",
    "ボーダー": "ボーダー", "KPE": "KPE", "オレンジ": "オレンジ", "Daiichi": "Daiichi",
    "新日テクノロジー": "新日テクノロジー", "レオスター": "レオスター",
    "タイヨーエレック": "タイヨーエレック", "西陣": "西陣", "銀座": "銀座",
    "アイドル": "アイドル", "LUX": "LUX", "オズ": "オズ", "エフ": "エフ",
    "クロスアルファ": "クロスアルファ", "ロデオ": "ロデオ", "タイヨー": "タイヨー",
    "エマ": "エマ", "ラスター": "ラスター", "アリストクラートテクノロジーズ": "アリストクラートテクノロジーズ",
    "SNKプレイモア": "SNKプレイモア", "トリビー": "トリビー", "IGTジャパン": "IGTジャパン",
    "不明": "不明",
}

# 機種タイプの表記ゆれ統一
TYPE_CANON = {
    "AT": "AT",
    "AT機": "AT",
    "ART": "ART",
    "ART機": "ART",
    "A+AT": "A+AT",
    "A＋AT": "A+AT",
    "AT+ART": "A+AT",
    "Aタイプ": "Aタイプ",
    "ノーマル": "Aタイプ",
    "ノーマルタイプ": "Aタイプ",
    "A": "Aタイプ",
    "BT": "BT",
    "ボーナスタイプ": "BT",
    "不明": "不明",
}

MEDIA_CANON = {
    "スマスロ": "スマスロ",
    "スマートパチスロ": "スマスロ",
    "メダル機": "メダル機",
    "メダル": "メダル機",
    "不明": "不明",
}

CONFIDENCE_ORDER = {"高": 0, "中": 1, "低": 2, "要確認": 3}

# 出率の常識的レンジ（これを外れたら異常値として要確認に回す）
RATE_MIN, RATE_MAX = 80.0, 130.0
# コイン単価の常識的レンジ（円）
COIN_MIN, COIN_MAX = 0.5, 10.0


def canon(value: str, table: dict[str, str], label: str, issues: list[str], machine: str) -> str:
    """表記ゆれを辞書で統一する。辞書に無い値はそのまま通し、品質チェックで報告。"""
    v = (value or "").strip()
    if not v:
        return ""
    if v in table:
        return table[v]
    issues.append(f"[表記ゆれ未登録] {machine}: {label}='{v}' は正規化辞書に未登録")
    return v


def join_urls(urls) -> str:
    if not urls:
        return ""
    return " | ".join(urls)


def valid_url(u: str) -> bool:
    try:
        p = urlparse(u)
        return p.scheme in ("http", "https") and bool(p.netloc)
    except ValueError:
        return False


def num_or_blank(v):
    """数値なら float、空文字/None/'不明' なら空文字を返す。推測補完はしない。"""
    if v is None or v == "" or v == "不明":
        return ""
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace("%", "")
    try:
        return float(s)
    except ValueError:
        return ""


def build_master(raw: dict, issues: list[str]) -> Table:
    acquired_at = raw["_meta"]["取得日"]
    rows = []
    for m in raw["machines"]:
        name = m["機種名"]
        row = {
            "機種名": name,
            "メーカー": canon(m.get("メーカー", ""), MAKER_CANON, "メーカー", issues, name),
            "機種タイプ": canon(m.get("機種タイプ", ""), TYPE_CANON, "機種タイプ", issues, name),
            "メディア区分": canon(m.get("メディア区分", ""), MEDIA_CANON, "メディア区分", issues, name),
            "ATタイプ": m.get("ATタイプ", ""),
            "ボーナスタイプ": m.get("ボーナスタイプ", ""),
            "規則区分": m.get("規則区分", ""),
            "型式名": m.get("型式名", ""),
            "コイン単価": num_or_blank(m.get("コイン単価")),
            "コイン単価条件": m.get("コイン単価条件", ""),
            "出率条件": m.get("出率条件", ""),
            "出率出典URL": join_urls(m.get("出率出典URL")),
            "コイン単価出典URL": join_urls(m.get("コイン単価出典URL")),
            "メーカー出典URL": join_urls(m.get("メーカー出典URL")),
            "データ取得日": acquired_at,
            "現行判定": m.get("現行判定", ""),
            "信頼度": m.get("信頼度", ""),
            "備考": m.get("備考", ""),
            "別表記": " / ".join(m.get("別表記", [])),
        }
        for c in SETTING_COLS:
            row[c] = num_or_blank(m.get(c))
        rows.append(row)

    return Table(rows, columns=COLUMNS)


# ---------------------------------------------------------------- 品質チェック


def quality_checks(df: Table, raw: dict) -> tuple[list[str], set[str]]:
    """品質チェックを実行。(問題行リスト, 要確認に回す機種名の集合) を返す。"""
    issues: list[str] = []
    flagged: set[str] = set()

    def flag(name: str, msg: str):
        issues.append(f"[{name}] {msg}")
        flagged.add(name)

    # 1. 機種名の重複（正規表記・別表記の両方で判定）
    seen_names: set[str] = set()
    for n in df.col("機種名"):
        if n in seen_names:
            flag(n, "機種名が2行以上存在する（重複排除もれ）")
        seen_names.add(n)

    alias_map: dict[str, str] = {}
    for r in df:
        keys = [r["機種名"]] + [a for a in str(r["別表記"]).split(" / ") if a]
        for k in keys:
            norm = re.sub(r"[\sＬL　]|スマスロ|パチスロ", "", k)
            if not norm:
                continue
            if norm in alias_map and alias_map[norm] != r["機種名"]:
                flag(r["機種名"], f"別表記『{k}』が既存機種『{alias_map[norm]}』と衝突（同一機種の可能性）")
            alias_map.setdefault(norm, r["機種名"])

    for r in df:
        name = r["機種名"]
        vals = {c: r[c] for c in SETTING_COLS}
        filled = {c: v for c, v in vals.items() if v != ""}

        # 2. 設定1〜6が全て入っているか
        if len(filled) == 0:
            flag(name, "設定1〜6の出率が1つも入っていない（データ欠損）")
        elif len(filled) < 6:
            missing = [c for c in SETTING_COLS if vals[c] == ""]
            flag(name, f"出率欠損: {', '.join(missing)}")

        # 3. 設定1より設定6が低い／単調性の破綻
        s1, s6 = vals["設定1出率"], vals["設定6出率"]
        if s1 != "" and s6 != "" and s6 < s1:
            flag(name, f"設定6({s6}%)が設定1({s1}%)より低い（異常）")
        ordered = [(c, v) for c, v in vals.items() if v != ""]
        for (ca, va), (cb, vb) in zip(ordered, ordered[1:]):
            if vb < va:
                flag(name, f"{ca}({va}%) > {cb}({vb}%) と逆転している（要確認）")

        # 4. 出率の異常値
        for c, v in filled.items():
            if not (RATE_MIN <= v <= RATE_MAX):
                flag(name, f"{c}={v}% が想定レンジ({RATE_MIN}〜{RATE_MAX}%)外")

        # 5. コイン単価の異常値／未取得
        coin = r["コイン単価"]
        if coin == "":
            flag(name, "コイン単価未確認")
        elif not (COIN_MIN <= coin <= COIN_MAX):
            flag(name, f"コイン単価={coin}円 が想定レンジ({COIN_MIN}〜{COIN_MAX}円)外")

        # 6. URLの存在と妥当性
        for col in ("出率出典URL", "コイン単価出典URL", "メーカー出典URL"):
            urls = [u for u in str(r[col]).split(" | ") if u]
            if col == "出率出典URL" and not urls and len(filled) > 0:
                flag(name, "出率の値があるのに出典URLが無い")
            if col == "メーカー出典URL" and not urls:
                flag(name, "メーカー出典URLが無い")
            for u in urls:
                if not valid_url(u):
                    flag(name, f"{col} に不正なURL: {u}")

        # 7. 出率の情報源が1つしかない
        rate_urls = [u for u in str(r["出率出典URL"]).split(" | ") if u]
        if len(filled) > 0 and len(rate_urls) < 2:
            flag(name, "出率の情報源が1つしかない（照合未達）")

        # 8. 出率条件・現行判定・メーカーの不明
        if len(filled) > 0 and (not r["出率条件"] or "不明" in str(r["出率条件"])):
            flag(name, "出率条件が不明")
        if "要確認" in str(r["現行判定"]):
            flag(name, "現行機かどうか不明（現行判定要確認）")
        if r["メーカー"] in ("", "不明"):
            flag(name, "メーカー不明")
        if r["機種タイプ"] in ("", "不明"):
            flag(name, "機種タイプ不明")

    return issues, flagged


# ---------------------------------------------------------------- シート生成

# 信頼度を並べておかないと、1情報源だけの値や不一致の値が
# 上位に来たときに読み手が気づけない
RANK_COLUMNS = ["ランキング", "順位", "機種名", "メーカー", "値", "信頼度", "出率条件"]


def build_rankings(df: Table) -> Table:
    """出率ランキングシート。値が無い機種はランキングから除外（推測補完しない）。"""
    out_rows: list[dict] = []

    def blank() -> dict:
        return {c: "" for c in RANK_COLUMNS}

    def add(title: str, key: str, rows: list[dict]):
        sub = [r for r in rows if r.get(key, "") != ""]
        if not sub:
            row = blank()
            row["ランキング"] = title
            row["順位"] = "該当データなし"
            out_rows.append(row)
            return
        sub.sort(key=lambda r: r[key], reverse=True)
        for rank, r in enumerate(sub, start=1):
            out_rows.append({
                "ランキング": title if rank == 1 else "",
                "順位": rank,
                "機種名": r["機種名"],
                "メーカー": r["メーカー"],
                "値": r[key],
                "信頼度": r["信頼度"],
                "出率条件": r["出率条件"],
            })
        out_rows.append(blank())

    for setting in ("設定1出率", "設定4出率", "設定5出率", "設定6出率"):
        add(f"{setting}ランキング", setting, list(df.rows))

    # 設定1→設定6の出率差
    diff_rows = []
    for r in df:
        d = dict(r)
        s1, s6 = r["設定1出率"], r["設定6出率"]
        d["設定1-6差"] = round(s6 - s1, 2) if (s1 != "" and s6 != "") else ""
        diff_rows.append(d)
    add("設定1→設定6 出率差ランキング", "設定1-6差", diff_rows)
    add("コイン単価ランキング", "コイン単価", list(df.rows))

    return Table(out_rows, columns=RANK_COLUMNS)


REVIEW_COLUMNS = ["機種名", "メーカー", "信頼度", "要確認項目数", "要確認内容",
                  "出率出典URL", "データ取得日"]


def build_needs_review(df: Table, issues: list[str], flagged: set[str]) -> Table:
    by_machine: dict[str, list[str]] = {}
    for msg in issues:
        m = re.match(r"\[(.+?)\]\s*(.*)", msg)
        if not m:
            continue
        by_machine.setdefault(m.group(1), []).append(m.group(2))

    rows = []
    for r in df:
        name = r["機種名"]
        if name not in by_machine:
            continue
        rows.append({
            "機種名": name,
            "メーカー": r["メーカー"],
            "信頼度": r["信頼度"],
            "要確認項目数": len(by_machine[name]),
            "要確認内容": " ／ ".join(by_machine[name]),
            "出率出典URL": r["出率出典URL"],
            "データ取得日": r["データ取得日"],
        })
    out = Table(rows, columns=REVIEW_COLUMNS)
    if not out.empty:
        out = out.sort_by("要確認項目数", reverse=True)
    return out


UNACQUIRED_COLUMNS = ["機種名", "メーカー", "取得できなかった理由", "試した情報源",
                      "URL", "再調査が必要か"]


def build_unacquired(raw: dict) -> Table:
    rows = []
    for m in raw["machines"]:
        if not m.get("未取得理由"):
            continue
        rows.append({
            "機種名": m["機種名"],
            "メーカー": m.get("メーカー", ""),
            "取得できなかった理由": m["未取得理由"],
            "試した情報源": " / ".join(m.get("試した情報源", [])),
            "URL": join_urls(m.get("メーカー出典URL")),
            "再調査が必要か": m.get("再調査要否", "要"),
        })
    return Table(rows, columns=UNACQUIRED_COLUMNS)


# ---------------------------------------------------------------- Excel 出力


def write_excel(path: Path, master: Table, rankings: Table, review: Table, unacquired: Table):
    def sheet(name: str, t: Table):
        if t.empty:
            return (name, ["機種名"], [["該当なし"]])
        return (name, t.columns, t.matrix())

    minixlsx.write_workbook(path, [
        sheet("機種マスター", master),
        sheet("出率ランキング", rankings),
        sheet("要確認", review),
        sheet("未取得機種", unacquired),
    ])


# ---------------------------------------------------------------- レポート


def summary(df: Table, review: Table, unacquired: Table) -> list[str]:
    total = len(df)
    complete = sum(1 for r in df if all(r[c] != "" for c in SETTING_COLS))
    partial = sum(1 for r in df
                  if any(r[c] != "" for c in SETTING_COLS) and any(r[c] == "" for c in SETTING_COLS))
    none_got = sum(1 for r in df if all(r[c] == "" for c in SETTING_COLS))
    coin_got = sum(1 for r in df if r["コイン単価"] != "")

    domains: Counter = Counter()
    for r in df:
        for col in ("出率出典URL", "コイン単価出典URL", "メーカー出典URL"):
            for u in str(r[col]).split(" | "):
                if u:
                    domains[urlparse(u).netloc] += 1

    cross = sum(1 for r in df
                if len([u for u in str(r["出率出典URL"]).split(" | ") if u]) >= 2)

    lines = [
        "===== 最終報告 =====",
        f"調査対象機種数        : {total}",
        f"完全取得（設定1〜6全）: {complete}",
        f"一部欠損機種数        : {partial}",
        f"未取得機種数（出率0件）: {none_got}",
        f"要確認機種数          : {len(review)}",
        f"コイン単価取得率      : {coin_got}/{total} ({coin_got / total * 100:.1f}%)" if total else "",
        f"出率の照合率(2URL以上): {cross}/{total} ({cross / total * 100:.1f}%)" if total else "",
        "",
        "--- 情報源別 取得件数（ドメイン単位） ---",
    ]
    for d, c in domains.most_common():
        lines.append(f"  {d}: {c}")
    if domains:
        lines.append(f"最も多く使用した情報源: {domains.most_common(1)[0][0]}")

    lines.append("")
    lines.append("--- 信頼度分布 ---")
    conf = Counter(df.col("信頼度"))
    for k, c in sorted(conf.items(), key=lambda kv: (CONFIDENCE_ORDER.get(kv[0], 9), kv[0])):
        lines.append(f"  {k}: {c}")
    return [line for line in lines if line != ""] + [""]


def main() -> int:
    raw = json.loads(DATA.read_text(encoding="utf-8"))
    OUT.mkdir(exist_ok=True)

    canon_issues: list[str] = []
    master = build_master(raw, canon_issues)

    issues, flagged = quality_checks(master, raw)
    rankings = build_rankings(master)
    review = build_needs_review(master, issues, flagged)
    unacquired = build_unacquired(raw)

    master.to_csv(OUT / "slot_machine_database.csv")
    review.to_csv(OUT / "needs_review.csv")
    unacquired.to_csv(OUT / "unacquired_machines.csv")
    write_excel(OUT / "slot_machine_database.xlsx", master, rankings, review, unacquired)

    report = []
    report.append("===== データ品質チェック =====")
    report.append(f"検出件数: {len(issues) + len(canon_issues)}")
    report.append("")
    report.append("--- 表記ゆれチェック ---")
    report.extend(canon_issues or ["  問題なし（全て正規化辞書に登録済み）"])
    report.append("")
    report.append("--- 機種別チェック ---")
    report.extend(f"  {i}" for i in issues)
    report.append("")
    report.append("※ 検出された異常値は自動修正せず、全て『要確認』シートに転記済み。")
    report.append("")
    report.extend(summary(master, review, unacquired))

    text = "\n".join(report)
    (OUT / "quality_report.txt").write_text(text, encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""情報源ごとのページ解析（一覧ページ・機種ページ）.

サイトごとにHTML構造が違うため、取得（fetch_specs）と切り離してここに集約する。
どの関数も「ページに書かれていることだけを返す」ことを守り、
書かれていない項目は None／空のままにする。推測で補わない。
"""

from __future__ import annotations

import html as html_mod
import re
import unicodedata

import minihtml

# ---------------------------------------------------------------- 名寄せ

# 括弧内の略称・別名（例:「(スマスロ 転天 てんてん)」）
_PAREN_RE = re.compile(r"[（(][^（()）]*[)）]")
# 媒体・区分の接頭辞。機種名の一部ではないので照合前に落とす
_PREFIX_RE = re.compile(r"(スマスロ|パチスロ|メダル機|新台)")
# 先頭に付く型式記号 L / S（「Ｌ転生王女…」「Ｌパチスロ 彼女、お借りします」）
_TYPE_MARK_RE = re.compile(r"^[LS]\s*")
# 記号・空白。長音符は残す（「ゴッドイーター」と「ゴッドイタ」を同一視しないため）
_PUNCT_RE = re.compile(r"[\s\-‐‑–—~〜･・,，.。、'\"’”“！!？?/\\|:：;；#＃&＆+＋*＝=＿_\[\]【】「」]")


def norm_name(s: str) -> str:
    """サイト間で機種名を照合するための正規化キー。

    表記ゆれ（全角半角・「L」「スマスロ」の有無・記号・括弧内の略称）を吸収する。
    照合専用であり、この値を機種名として出力してはいけない。
    """
    s = unicodedata.normalize("NFKC", s or "")
    s = _PAREN_RE.sub("", s)
    s = _PREFIX_RE.sub("", s)
    s = _TYPE_MARK_RE.sub("", s)
    s = _PUNCT_RE.sub("", s)
    return s.lower()


def _clean(s: str) -> str:
    # alt属性などを正規表現で拾うと実体参照が残るので、ここで必ず戻す
    s = html_mod.unescape(s or "")
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", s)).strip()


# ---------------------------------------------------------------- 出率レンジ

# 「97.8% 〜 114.1%」「98.2%〜106.2% (設定1〜設定6)」
_RANGE_RE = re.compile(
    r"(\d{2,3}(?:\.\d+)?)\s*%?\s*[〜～~ー−\-]\s*(\d{2,3}(?:\.\d+)?)\s*%"
)


def parse_rate_range(text: str) -> tuple[float, float] | None:
    """機械割の範囲表記から (下限, 上限) を取り出す。

    範囲は設定1〜設定6の幅として各サイトが掲載しているもの。
    README のルール2に従い、ここから埋めてよいのは設定1と設定6だけで、
    設定2〜5を内挿してはいけない（呼び出し側の責任）。
    """
    m = _RANGE_RE.search(text or "")
    if not m:
        return None
    lo, hi = float(m.group(1)), float(m.group(2))
    if not (80.0 <= lo <= 130.0 and 80.0 <= hi <= 130.0) or hi < lo:
        return None
    return lo, hi


# ---------------------------------------------------------------- DMMぱちタウン

_DMM_UNIT_RE = re.compile(r'<li class="unit">(.*?)</li>', re.S)
_DMM_ID_RE = re.compile(r'href="/machines/(\d+)"')
_DMM_ALT_RE = re.compile(r'alt="([^"]*)"')
_DMM_DATE_RE = re.compile(r"導入開始日[:：]\s*(\d{4})年(\d{2})月(\d{2})日")
_DMM_SLOT_RE = re.compile(r"text-icon -slot")
_DMM_SMART_RE = re.compile(r'alt="スマスロ"')


def dmm_list_page(html: str) -> list[dict]:
    """DMMぱちタウンの機種一覧ページから1件ずつ拾う。

    一覧カードに導入開始日が載っているため、機種ページを開かずに年代で絞り込める。
    """
    out = []
    for block in _DMM_UNIT_RE.findall(html):
        mid = _DMM_ID_RE.search(block)
        if not mid:
            continue
        if not _DMM_SLOT_RE.search(block):
            continue  # パチンコを除外
        d = _DMM_DATE_RE.search(block)
        rng = parse_rate_range(block)
        alt = _DMM_ALT_RE.search(block)
        out.append({
            "dmm_id": mid.group(1),
            "機種名": _clean(alt.group(1)) if alt else "",
            "導入開始日": f"{d.group(1)}-{d.group(2)}-{d.group(3)}" if d else "",
            "機械割下限": rng[0] if rng else None,
            "機械割上限": rng[1] if rng else None,
            "スマスロ表示": bool(_DMM_SMART_RE.search(block)),
        })
    return out


def dmm_machine_page(html: str) -> dict:
    """DMMぱちタウンの機種ページのスペック表を読む。"""
    spec: dict[str, str] = {}
    for grid in minihtml.tables(html):
        for row in grid:
            if len(row) >= 2 and row[0]:
                spec.setdefault(_clean(row[0]), _clean(row[1]))

    maker = spec.get("メーカー名", "")
    maker = re.sub(r"（メーカー公式サイト）.*$", "", maker).strip()
    maker = re.sub(r"の掲載機種一覧$", "", maker).strip()

    rng = parse_rate_range(spec.get("機械割", ""))
    d = _DMM_DATE_RE.search("導入開始日: " + spec.get("導入開始日", "").replace("（", " ("))
    date = spec.get("導入開始日", "")
    dm = re.search(r"(\d{4})年(\d{2})月(\d{2})日", date)

    return {
        "型式名": spec.get("型式名", ""),
        "メーカー": maker,
        "機械割下限": rng[0] if rng else None,
        "機械割上限": rng[1] if rng else None,
        "機械割原文": spec.get("機械割", ""),
        "導入開始日": f"{dm.group(1)}-{dm.group(2)}-{dm.group(3)}" if dm else "",
        "スマスロ表示": bool(_DMM_SMART_RE.search(html)),
        "_d": d,
    }


# ---------------------------------------------------------------- P-WORLD

_PW_ID_RE = re.compile(r"/machine/database/(\d+)")
_PW_COUNT_RE = re.compile(r"該当する機種は、.*?<strong>(\d+)</strong>", re.S)
# 一覧の行。機種名は <strong> に入っており、その直後に掲示板件数のリンクが続く。
# セルのテキストを繋いでから「N件」を削ろうとすると、
# 「ストリートファイター6」+「0件」のように機種名末尾の数字まで巻き込むため、
# ここは連結後の文字列ではなく元のHTMLから機種名だけを取り出す。
_PW_ROW_RE = re.compile(
    r'<td class="title">\s*<a href="/machine/database/(\d+)"[^>]*>\s*<strong>(.*?)</strong>',
    re.S,
)
_PW_MAKER_RE = re.compile(r'<td class="maker">(?:<a[^>]*>)?(.*?)(?:</a>)?\s*</td>', re.S)
_PW_TYPE_RE = re.compile(r'<td class="type">(.*?)</td>', re.S)
_TAG_RE = re.compile(r"<[^>]+>")


def pworld_count(html: str) -> int | None:
    m = _PW_COUNT_RE.search(html)
    return int(m.group(1)) if m else None


def pworld_list_page(html: str) -> list[dict]:
    """P-WORLDの機種一覧（50件/ページ）を読む。

    行は [連番, 別窓アイコン, 機種名+掲示板件数, 種別, メーカー] の並び。
    機種名・種別・メーカーは同じ順で並ぶので、行ごとに突き合わせる。
    """
    rows = _PW_ROW_RE.findall(html)
    types = _PW_TYPE_RE.findall(html)
    makers = _PW_MAKER_RE.findall(html)

    out = []
    for i, (mid, name) in enumerate(rows):
        name = _clean(_TAG_RE.sub("", name))
        if not name:
            continue
        out.append({
            "pw_id": mid,
            "機種名": name,
            "種別": _clean(_TAG_RE.sub("", types[i])) if i < len(types) else "",
            "メーカー": _clean(_TAG_RE.sub("", makers[i])) if i < len(makers) else "",
        })
    return out


_PW_FIELD_RE = re.compile(r"^(メーカー|タイプ|検定番号|型式名|導入開始)\s*[：:]\s*(.*)$")
# 「【設置店4,853店舗】…」。現行稼働の有無を推測でなく出典付きで判定するために使う
_PW_SHOPS_RE = re.compile(r"【設置店\s*([\d,]+)\s*店舗】")
_PW_SURVEY_RE = re.compile(r"調査日[：:]\s*(\d{4})/(\d{1,2})/(\d{1,2})")


def pworld_machine_page(html: str) -> dict:
    """P-WORLDの機種ページから タイプ／検定番号／型式名／導入開始 を読む。

    タイプ欄（例「スマスロ、6.5号機、AT、CZ、疑似ボーナス」）が
    規則区分と機種タイプの一次情報になる。ここから読めない項目は空のままにする。
    """
    fields: dict[str, str] = {}
    for grid in minihtml.tables(html):
        for row in grid:
            for cell in row:
                m = _PW_FIELD_RE.match(_clean(cell))
                if m:
                    fields.setdefault(m.group(1), _clean(m.group(2)))
            if len(row) >= 2:
                key = _clean(row[0]).rstrip("：:").strip()
                if key in ("メーカー", "タイプ", "検定番号", "型式名", "導入開始"):
                    fields.setdefault(key, _clean(row[1]))

    tags = [t.strip() for t in re.split(r"[、,／/]", fields.get("タイプ", "")) if t.strip()]
    kikaku = next((t for t in tags if re.match(r"^(スマスロ|[456](?:\.\d)?号機)$", t)), "")
    # 「スマスロ」と「6.5号機」が併記されるので、規則区分はスマスロを優先して1つに決める
    if "スマスロ" in tags:
        kikaku = "スマスロ"
    elif not kikaku:
        kikaku = next((t for t in tags if t.endswith("号機")), "")

    type_tag = next((t for t in tags if t in ("AT", "ART", "A+AT", "ノーマル", "RT", "BT")), "")

    d = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日", fields.get("導入開始", ""))
    shops = _PW_SHOPS_RE.search(html)
    survey = _PW_SURVEY_RE.search(html)
    return {
        "メーカー": fields.get("メーカー", ""),
        "タイプ原文": fields.get("タイプ", ""),
        "規則区分": kikaku,
        "機種タイプ": type_tag,
        "検定番号": fields.get("検定番号", ""),
        "型式名": fields.get("型式名", ""),
        "導入開始日": (f"{d.group(1)}-{int(d.group(2)):02d}-{int(d.group(3)):02d}" if d else ""),
        "タグ": tags,
        # 掲載されている設置店舗数。現行稼働の判断材料として、数値と調査日をそのまま持つ
        "設置店舗数": int(shops.group(1).replace(",", "")) if shops else None,
        "設置調査日": (f"{survey.group(1)}-{int(survey.group(2)):02d}-{int(survey.group(3)):02d}"
                       if survey else ""),
    }


# ---------------------------------------------------------------- スロベース

# ---------------------------------------------------------------- パチ7

_P7_ROW_RE = re.compile(r'href="/machines/(\d+)[^"]*"[^>]*>(.*?)</a>', re.S)


def pachi7_list_page(html: str) -> list[dict]:
    """パチ7の機種一覧（20件/ページ）。リンク文言に機種名とメーカー名が入る。"""
    out, seen = [], set()
    for mid, body in _P7_ROW_RE.findall(html):
        if mid in seen:
            continue
        text = _clean(_TAG_RE.sub(" ", body))
        if not text:
            continue
        name, _, maker = text.partition("メーカー名：")
        name = name.strip()
        if not name:
            continue
        seen.add(mid)
        out.append({"p7_id": mid, "機種名": name, "メーカー": maker.strip()})
    return out


def pachi7_machine_page(html: str) -> dict:
    """パチ7の機種ページ。スペック表の出玉率は設定1〜6の範囲で載る。"""
    spec: dict[str, str] = {}
    for grid in minihtml.tables(html):
        for row in grid:
            if len(row) >= 2 and row[0]:
                spec.setdefault(_clean(row[0]), _clean(row[1]))

    rng = parse_rate_range(spec.get("出玉率", "") or spec.get("機械割", ""))
    d = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日", spec.get("導入日", ""))
    return {
        "型式名": spec.get("型式名", ""),
        "メーカー": spec.get("メーカー名", ""),
        "機械割下限": rng[0] if rng else None,
        "機械割上限": rng[1] if rng else None,
        "機械割原文": spec.get("出玉率", "") or spec.get("機械割", ""),
        "導入開始日": (f"{d.group(1)}-{int(d.group(2)):02d}-{int(d.group(3)):02d}" if d else ""),
    }


# ---------------------------------------------------------------- スロベース

_SLOBASE_TITLE_RE = re.compile(r"<title>(.*?)</title>", re.S)


def slobase_machine_page(html: str) -> dict:
    """スロベースの機種ページ。設定1〜6の機械割を表で持っている。"""
    t = _SLOBASE_TITLE_RE.search(html)
    title = _clean(t.group(1)) if t else ""
    name = re.split(r"[|｜]", title)[0].strip()
    name = re.sub(r"(の)?(設定判別|解析|スペック|天井|closing).*$", "", name).strip()
    return {"機種名": name}

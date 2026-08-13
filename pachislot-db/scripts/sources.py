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

_TITLE_RE = re.compile(r"<title>(.*?)</title>", re.S)

# ---------------------------------------------------------------- 名寄せ

# 括弧内の略称・別名（例:「(スマスロ 転天 てんてん)」）
_PAREN_RE = re.compile(r"[（(][^（()）]*[)）]")
# 媒体・区分の接頭辞。機種名の一部ではないので照合前に落とす
_PREFIX_RE = re.compile(r"(スマスロ|パチスロ|メダル機|新台)")
# 先頭にだけ付く「スロット ○○」。名前の途中の「スロット」は残す
_LEAD_SLOT_RE = re.compile(r"^スロット\s+")
# 先頭に付く型式記号 L / S（「Ｌ転生王女…」「Ｌパチスロ 彼女、お借りします」）
_TYPE_MARK_RE = re.compile(r"^[LS]\s*")
# 記号・空白。長音符は残す（「ゴッドイーター」と「ゴッドイタ」を同一視しないため）。
# ハイフンはサイトによって使う文字が違う（「琉神-30」と「琉神−30」は同じ機種）ので、
# マイナス記号 U+2212 と全角ハイフンも同じものとして落とす。
_PUNCT_RE = re.compile(
    r"[\s\-‐‑–—−－~〜･・,，.。、'\"’”“！!？?/\\|:：;；#＃&＆+＋*＝=＿_\[\]【】「」]")


def norm_name(s: str) -> str:
    """サイト間で機種名を照合するための正規化キー。

    表記ゆれ（全角半角・「L」「スマスロ」の有無・記号・括弧内の略称）を吸収する。
    照合専用であり、この値を機種名として出力してはいけない。
    """
    s = unicodedata.normalize("NFKC", s or "")
    s = _PAREN_RE.sub("", s)
    s = _LEAD_SLOT_RE.sub("", s)
    s = _PREFIX_RE.sub("", s)
    s = _TYPE_MARK_RE.sub("", s)
    s = _PUNCT_RE.sub("", s)
    return s.lower()


def _clean(s: str) -> str:
    # alt属性などを正規表現で拾うと実体参照が残るので、ここで必ず戻す
    s = html_mod.unescape(s or "")
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", s)).strip()


# ---------------------------------------------------------------- 出率レンジ

# 「97.8% 〜 114.1%」「98.2%〜106.2% (設定1〜設定6)」「97.5%〜113.0 (設定1〜設定6)」。
# 片側にしか % が付かない書き方があるので、両側とも省略可にしたうえで
# 「% がどこかに1つはある」ことを parse 側で確かめる。
_RANGE_RE = re.compile(
    r"(\d{2,3}(?:\.\d+)?)\s*%?\s*[〜～~ー−\-]\s*(\d{2,3}(?:\.\d+)?)\s*%?"
)


def parse_rate_range(text: str) -> tuple[float, float] | None:
    """機械割の範囲表記から (下限, 上限) を取り出す。

    範囲は設定1〜設定6の幅として各サイトが掲載しているもの。
    README のルール2に従い、ここから埋めてよいのは設定1と設定6だけで、
    設定2〜5を内挿してはいけない（呼び出し側の責任）。

    「1/192.2〜1/148.9」のような確率表記を出率と取り違えないよう、
    % が含まれること・80〜130%に収まること・下限≦上限を条件にする。
    """
    m = _RANGE_RE.search(text or "")
    if not m or "%" not in m.group(0):
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

    # _clean が NFKC 正規化するので括弧は半角で来る。
    # 「北電子(メーカー公式サイト) 北電子の掲載機種一覧」から社名だけを残す。
    maker = spec.get("メーカー名", "")
    maker = re.sub(r"[(（]メーカー公式サイト[)）].*$", "", maker).strip()
    maker = re.sub(r"の掲載機種一覧$", "", maker).strip()
    # 公式サイトへのリンクが無い社では「EXCITE EXCITEの掲載機種一覧」の形になり、
    # 末尾を削ると社名が2回残る。同じ語の繰り返しなら1つに畳む。
    maker = re.sub(r"^(.+?)\s+\1$", r"\1", maker).strip()

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
# 「【設置店4,853店舗】」＝設置済み、「【導入予定1店舗】」＝これから導入。
# 現行稼働の有無を推測でなく出典付きで判定するために、どちらの表記かも持つ。
_PW_SHOPS_RE = re.compile(r"【(設置店|導入予定)\s*([\d,]+)\s*店舗】")
_PW_SURVEY_RE = re.compile(r"調査日[：:]\s*(\d{4})/(\d{1,2})/(\d{1,2})")


def pworld_machine_page(html: str) -> dict:
    """P-WORLDの機種ページから タイプ／検定番号／型式名／導入開始 を読む。

    タイプ欄（例「スマスロ、6.5号機、AT、CZ、疑似ボーナス」）が
    規則区分と機種タイプの一次情報になる。ここから読めない項目は空のままにする。
    """
    fields: dict[str, str] = {}

    def put(key: str, value: str) -> None:
        # ラベルと値が別セルに分かれている表では、ラベルだけのセルも
        # 「タイプ ：」の形で正規表現に一致してしまう。空値で埋めてしまうと
        # 後から来る本当の値を setdefault が受け付けなくなるので、値が空なら捨てる。
        value = _clean(value)
        if value:
            fields.setdefault(key, value)

    for grid in minihtml.tables(html):
        for row in grid:
            for cell in row:
                m = _PW_FIELD_RE.match(_clean(cell))
                if m:
                    put(m.group(1), m.group(2))
            if len(row) >= 2:
                key = _clean(row[0]).rstrip("：:").strip()
                if key in ("メーカー", "タイプ", "検定番号", "型式名", "導入開始"):
                    put(key, row[1])

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
        # 掲載されている店舗数。現行稼働の判断材料として、数値・区分・調査日をそのまま持つ
        "設置店舗数": int(shops.group(2).replace(",", "")) if shops else None,
        "店舗数区分": shops.group(1) if shops else "",
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
        # _clean が NFKC 正規化するので「メーカー名：」の全角コロンは半角になる。
        # どちらで来ても切れるよう、コロンは分割後に落とす。
        name, _, maker = text.partition("メーカー名")
        name = name.strip()
        maker = maker.lstrip(":： ").strip()
        if not name:
            continue
        seen.add(mid)
        out.append({"p7_id": mid, "機種名": name, "メーカー": maker.strip()})
    return out


def pachi7_machine_page(html: str) -> dict:
    """パチ7の機種ページ。スペック表の出玉率は設定1〜6の範囲で載る。

    見出しは「出玉率」だけでなく「出玉率 (完全攻略時)」の形を取ることが多く、
    完全一致で引くとほとんど取り逃がす。前方一致で拾い、括弧の中身は
    そのまま出率条件として持つ（条件表記を書いている数少ない情報源のため）。
    """
    spec: dict[str, str] = {}
    for grid in minihtml.tables(html):
        for row in grid:
            if len(row) >= 2 and row[0]:
                spec.setdefault(_clean(row[0]), _clean(row[1]))

    # 見出しの形が一定しない。「出玉率」「出玉率 (完全攻略時)」「完全攻略時の 出玉率」
    # 「出玉率 (機械割)」など前後に語が付くので、前方一致ではなく包含で候補を集め、
    # 値が出率の範囲として読めたものを採る。
    rate_key, raw, rng = "", "", None
    for k in spec:
        if not re.search(r"出玉率|機械割", k):
            continue
        parsed = parse_rate_range(spec[k])
        if parsed:
            rate_key, raw, rng = k, spec[k], parsed
            break

    # 見出しから「出玉率」「機械割」を除いた残りが条件表記になる
    cond = re.sub(r"出玉率|機械割", "", rate_key)
    cond = _clean(re.sub(r"[（()）※・]", " ", cond)).strip("の 　")
    if cond in ("", "の"):
        cond = ""

    d = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日", spec.get("導入日", ""))
    base_key = next((k for k in spec if k.startswith("ベース")), "")
    return {
        "型式名": spec.get("型式名", ""),
        "メーカー": spec.get("メーカー名", ""),
        "機械割下限": rng[0] if rng else None,
        "機械割上限": rng[1] if rng else None,
        "機械割原文": raw,
        "機械割見出し": rate_key,
        "出率条件": cond,
        "ベース": spec.get(base_key, ""),
        "導入開始日": (f"{d.group(1)}-{int(d.group(2)):02d}-{int(d.group(3)):02d}" if d else ""),
    }


# ---------------------------------------------------------------- ななプレス

_NANA_NAME_RE = re.compile(r"【(.+?)】")


def nanapress_spec_page(html: str) -> dict:
    """ななプレスの、設定別機械割を載せたページ。

    タイトルは「【機種名】…」の形で、機械割を載せるページの見出しは世代で異なる。

        【スマスロ 獣王】スペック情報（機械割や各種確率まとめ）
        【炎炎ノ消防隊2（スマスロ）】初当たり確率/機械割/小役確率
        【スマスロ鉄拳6】CZ・ボーナス・AT確率/機械割/小役確率

    「スペック情報」だけを見ると後者2つを取りこぼすので、
    見出しに「機械割」が入っているページも対象にする。
    設定別の機械割は「設定／機械割」の2列表（設定欄は素の数字）で載る。
    """
    t = _TITLE_RE.search(html)
    title = _clean(t.group(1)) if t else ""
    m = _NANA_NAME_RE.search(title)
    return {
        "機種名": _clean(m.group(1)) if m else "",
        "スペックページ": ("スペック情報" in title) or ("機械割" in title),
        "title": title,
    }


# ---------------------------------------------------------------- スロベース


_COIN_RE = re.compile(r"(?:約)?\s*(\d+(?:\.\d+)?)\s*円")
_COIN_COND_RE = re.compile(r"[（(]([^)）]*)[)）]")


def parse_coin(text: str) -> tuple[float | None, str]:
    """「約3.7円(設定1)」から (単価, 条件) を取り出す。

    条件の記載が無ければ条件は空にする。単価だけ拾って条件を作文しない。
    """
    m = _COIN_RE.search(text or "")
    if not m:
        return None, ""
    v = float(m.group(1))
    if not (0.5 <= v <= 10.0):  # 想定レンジ外は誤検出とみなして採らない
        return None, ""
    c = _COIN_COND_RE.search(text or "")
    return v, _clean(c.group(1)) if c else ""


def slobase_machine_page(html: str) -> dict:
    """スロベースの機種ページ。

    設定1〜6の機械割の表に加えて、項目／内容の2列表に
    メーカー・仕様・AT純増・コイン単価などが載っている。
    """
    t = _TITLE_RE.search(html)
    title = _clean(t.group(1)) if t else ""
    name = re.split(r"[|｜]", title)[0].strip()
    name = re.sub(r"(の)?(設定判別|解析|スペック|天井|closing).*$", "", name).strip()

    spec: dict[str, str] = {}
    for grid in minihtml.tables(html):
        for row in grid:
            if len(row) >= 2 and row[0]:
                spec.setdefault(_clean(row[0]), _clean(row[1]))

    coin, coin_cond = parse_coin(spec.get("コイン単価", ""))
    shiyou = spec.get("仕様", "")
    media = "スマスロ" if "スマスロ" in shiyou else ("メダル機" if shiyou else "")
    mtype = ""
    for tag, canon in (("AT機", "AT"), ("ART機", "ART"), ("ノーマル", "Aタイプ"),
                       ("Aタイプ", "Aタイプ"), ("ボーナスタイプ", "BT")):
        if tag in shiyou:
            mtype = canon
            break

    return {
        "機種名": spec.get("機種名", "") or name,
        "メーカー": spec.get("メーカー", ""),
        "仕様": shiyou,
        "メディア区分": media,
        "機種タイプ": mtype,
        "ATタイプ": spec.get("AT純増", ""),
        "コイン単価": coin,
        "コイン単価条件": coin_cond,
        "コイン単価原文": spec.get("コイン単価", ""),
        "回転数50枚": spec.get("回転数/50枚", ""),
    }

#!/usr/bin/env python3
"""標準ライブラリだけの最小xlsxライター（openpyxl の代替）.

この環境ではパッケージレジストリが egress で遮断されており openpyxl を導入できない。
xlsx は ZIP に XML を詰めた形式なので、zipfile と文字列組み立てだけで生成できる。

対応するのは build_database.py が必要とする範囲に限る。

- 複数シート
- ヘッダ行の塗り／白太字／中央揃え・折り返し
- ウィンドウ枠の固定（1行目）
- オートフィルタ
- 列幅の自動調整
- 数値セルと文字列セルの区別（数値は数値として書き込む）

数式・書式・グラフ・共有文字列テーブルには対応しない（必要がないため）。
"""

from __future__ import annotations

import re
import zipfile
from pathlib import Path

__all__ = ["write_workbook", "column_letter"]

# XMLに入れられない制御文字（タブ・改行を除く）
_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
_INVALID_SHEET_CHARS = re.compile(r"[\[\]:*?/\\]")

_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"

HEADER_STYLE = 1  # cellXfs のインデックス（下の styles.xml と対応）


def column_letter(idx: int) -> str:
    """1 → A, 27 → AA。"""
    if idx < 1:
        raise ValueError("列番号は1以上")
    out = ""
    while idx:
        idx, rem = divmod(idx - 1, 26)
        out = chr(65 + rem) + out
    return out


def _esc(value: str) -> str:
    value = _CTRL_RE.sub("", value)
    return (value.replace("&", "&amp;").replace("<", "&lt;")
                 .replace(">", "&gt;").replace('"', "&quot;"))


def _safe_sheet_name(name: str, used: set[str]) -> str:
    """Excelのシート名制約（31文字・禁止文字・重複不可）に収める。"""
    clean = _INVALID_SHEET_CHARS.sub("_", name).strip("'")[:31] or "Sheet"
    candidate, n = clean, 1
    while candidate.lower() in used:
        n += 1
        suffix = f"_{n}"
        candidate = clean[: 31 - len(suffix)] + suffix
    used.add(candidate.lower())
    return candidate


def _is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _display_width(v) -> int:
    """列幅の目安。全角は2文字ぶんとして数える。"""
    s = f"{v}"
    return sum(2 if ord(ch) > 0x2000 else 1 for ch in s)


def _cell_xml(ref: str, value, style: int | None) -> str:
    attrs = f'r="{ref}"'
    if style:
        attrs += f' s="{style}"'
    if value is None or value == "":
        return f"<c {attrs}/>" if style else ""
    if _is_number(value):
        return f"<c {attrs}><v>{value}</v></c>"
    return f'<c {attrs} t="inlineStr"><is><t xml:space="preserve">{_esc(str(value))}</t></is></c>'


def _sheet_xml(columns: list[str], rows: list[list], widths: list[int]) -> str:
    ncols = len(columns)
    nrows = len(rows) + 1
    last = f"{column_letter(ncols)}{nrows}" if ncols else "A1"

    parts = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        f'<worksheet xmlns="{_NS}" xmlns:r="{_NS_R}">',
        f'<dimension ref="A1:{last}"/>',
        '<sheetViews><sheetView workbookViewId="0">',
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
        '</sheetView></sheetViews>',
        '<sheetFormatPr defaultRowHeight="15"/>',
    ]

    if ncols:
        cols = "".join(
            f'<col min="{i}" max="{i}" width="{w}" customWidth="1"/>'
            for i, w in enumerate(widths, start=1)
        )
        parts.append(f"<cols>{cols}</cols>")

    parts.append("<sheetData>")
    header = "".join(
        _cell_xml(f"{column_letter(i)}1", c, HEADER_STYLE) for i, c in enumerate(columns, start=1)
    )
    parts.append(f'<row r="1">{header}</row>')
    for rnum, row in enumerate(rows, start=2):
        cells = "".join(
            _cell_xml(f"{column_letter(i)}{rnum}", v, None) for i, v in enumerate(row, start=1)
        )
        parts.append(f'<row r="{rnum}">{cells}</row>')
    parts.append("</sheetData>")

    if ncols:  # autoFilter は sheetData の後ろに置く必要がある
        parts.append(f'<autoFilter ref="A1:{last}"/>')
    parts.append("</worksheet>")
    return "".join(parts)


_STYLES_XML = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="{_NS}">
<fonts count="2">
<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>"""

_ROOT_RELS = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="{_NS_PKG_REL}">
<Relationship Id="rId1" Type="{_NS_R}/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"""


def write_workbook(path: str | Path, sheets, max_width: int = 60, min_width: int = 10) -> None:
    """sheets = [(シート名, 列名リスト, 行リスト), ...] を xlsx として書き出す。

    行は列名リストと同じ長さのリスト。値が int/float なら数値セル、
    それ以外は文字列セルになる。空文字・None は空セルのまま出力する
    （欠損を0や平均で埋めないため、空は空のまま保つ）。
    """
    path = Path(path)
    prepared = []
    used: set[str] = set()
    for name, columns, rows in sheets:
        columns = list(columns)
        rows = [list(r) for r in rows]
        widths = []
        for i, col in enumerate(columns):
            longest = max(
                [_display_width(col)] + [_display_width(r[i]) for r in rows[:200] if i < len(r)]
            )
            widths.append(min(max(longest + 2, min_width), max_width))
        prepared.append((_safe_sheet_name(name, used), columns, rows, widths))

    content_types = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '<Default Extension="rels" '
        'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '<Default Extension="xml" ContentType="application/xml"/>',
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-'
        'officedocument.spreadsheetml.sheet.main+xml"/>',
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-'
        'officedocument.spreadsheetml.styles+xml"/>',
    ]
    sheet_tags, rel_tags = [], []
    for n, (name, _c, _r, _w) in enumerate(prepared, start=1):
        content_types.append(
            f'<Override PartName="/xl/worksheets/sheet{n}.xml" '
            'ContentType="application/vnd.openxmlformats-'
            'officedocument.spreadsheetml.worksheet+xml"/>'
        )
        sheet_tags.append(f'<sheet name="{_esc(name)}" sheetId="{n}" r:id="rId{n}"/>')
        rel_tags.append(
            f'<Relationship Id="rId{n}" Type="{_NS_R}/worksheet" '
            f'Target="worksheets/sheet{n}.xml"/>'
        )
    content_types.append("</Types>")

    style_rid = len(prepared) + 1
    rel_tags.append(
        f'<Relationship Id="rId{style_rid}" Type="{_NS_R}/styles" Target="styles.xml"/>'
    )

    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<workbook xmlns="{_NS}" xmlns:r="{_NS_R}">'
        f'<sheets>{"".join(sheet_tags)}</sheets></workbook>'
    )
    workbook_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<Relationships xmlns="{_NS_PKG_REL}">{"".join(rel_tags)}</Relationships>'
    )

    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "".join(content_types))
        z.writestr("_rels/.rels", _ROOT_RELS)
        z.writestr("xl/workbook.xml", workbook)
        z.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        z.writestr("xl/styles.xml", _STYLES_XML)
        for n, (_name, columns, rows, widths) in enumerate(prepared, start=1):
            z.writestr(f"xl/worksheets/sheet{n}.xml", _sheet_xml(columns, rows, widths))

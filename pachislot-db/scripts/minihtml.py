#!/usr/bin/env python3
"""標準ライブラリだけの最小HTML抽出器（BeautifulSoup + lxml の代替）.

この環境ではパッケージレジストリ（pypi.org / archive.ubuntu.com）が egress で
遮断されており、beautifulsoup4 も lxml も導入できない。
一方で fetch_specs.py が bs4 に求めていた機能は

  1. 文書内の <table> をセルの二次元配列として取り出す
  2. 文書全体のテキストを取り出す

の2つだけなので、html.parser で同等のものを用意して依存を切る。

bs4 との差異として意識している点:

- ``get_text(" ", strip=True)`` に合わせ、テキスト片は個別に strip してから
  半角スペースで連結し、連続空白を1つに畳む。
- 入れ子テーブルのテキストは外側のセルにも含める（bs4 と同じ挙動）。
  入れ子テーブル自身も独立した表として tables() に現れる。
- </td> や </tr> を閉じ忘れている実サイトのHTMLに耐えるよう、
  次の <td>/<tr>/<\\table> が来た時点で暗黙的に閉じる。
"""

from __future__ import annotations

import re
from html.parser import HTMLParser

__all__ = ["tables", "text"]

_WS_RE = re.compile(r"\s+")

# テキストを持たない、あるいは持っていても本文ではない要素
_SKIP_TAGS = {"script", "style", "noscript", "template"}
# 開いたまま閉じないことが多く、スタック管理の対象外にする要素
_VOID_TAGS = {"br", "hr", "img", "input", "meta", "link", "source", "area", "col"}
# 前後がくっつくと別語になるため、境界に空白を差し込む要素
_BLOCK_TAGS = {"p", "div", "li", "ul", "ol", "dl", "dt", "dd", "section", "article",
               "h1", "h2", "h3", "h4", "h5", "h6", "tr", "td", "th", "table"}


def _norm(s: str) -> str:
    """連続空白を1つに畳んで前後を削る。全角スペースも空白として扱う。"""
    return _WS_RE.sub(" ", s).strip()


class _Extractor(HTMLParser):
    def __init__(self) -> None:
        # convert_charrefs=True で &amp; などは自動的に復元される
        super().__init__(convert_charrefs=True)
        self.tables: list[list[list[str]]] = []
        self._open: list[dict] = []  # 開いている <table> のスタック
        self._skip = 0
        self._text: list[str] = []

    # -------------------------------------------------- セル／行の確定
    @staticmethod
    def _close_cell(t: dict) -> None:
        if t["cell"] is None:
            return
        # テキスト片はそのまま連結する。<strong>98.<em>2</em></strong> のように
        # インライン要素で数値が分断されていても "98.2" として復元するため、
        # ここで区切り文字を挟んではいけない。段落・<br> 等の区切りは
        # _feed_text 側で明示的に空白を流し込んでいる。
        if t["row"] is None:
            t["row"] = []
        t["row"].append(_norm("".join(t["cell"])))
        t["cell"] = None

    @staticmethod
    def _flush_row(t: dict) -> None:
        if t["row"]:
            t["rows"].append(t["row"])
        t["row"] = None

    def _close_table(self) -> None:
        t = self._open.pop()
        self._close_cell(t)
        self._flush_row(t)
        self.tables.append(t["rows"])

    # -------------------------------------------------- HTMLParser フック
    def handle_starttag(self, tag: str, attrs) -> None:
        tag = tag.lower()
        if tag in _SKIP_TAGS:
            self._skip += 1
            return
        if tag in _VOID_TAGS:
            # レイアウト上の改行はテキストの区切りとして扱う
            if not self._skip:
                self._feed_text(" ")
            return

        if tag in _BLOCK_TAGS:
            self._feed_text(" ")

        if tag == "table":
            self._open.append({"rows": [], "row": None, "cell": None})
        elif tag == "tr":
            if self._open:
                t = self._open[-1]
                self._close_cell(t)
                self._flush_row(t)
                t["row"] = []
        elif tag in ("td", "th"):
            if self._open:
                t = self._open[-1]
                self._close_cell(t)  # </td> 閉じ忘れへの対応
                if t["row"] is None:
                    t["row"] = []
                t["cell"] = []

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in _SKIP_TAGS:
            self._skip = max(0, self._skip - 1)
            return
        if tag in _VOID_TAGS:
            return

        if tag in ("td", "th"):
            if self._open:
                self._close_cell(self._open[-1])
        elif tag == "tr":
            if self._open:
                t = self._open[-1]
                self._close_cell(t)
                self._flush_row(t)
        elif tag == "table":
            if self._open:
                self._close_table()

        if tag in _BLOCK_TAGS and not self._skip:
            self._feed_text(" ")

    def _feed_text(self, data: str) -> None:
        self._text.append(data)
        # 入れ子テーブルでは外側のセルにもテキストを含める（bs4 と同じ）
        for t in self._open:
            if t["cell"] is not None:
                t["cell"].append(data)

    def handle_data(self, data: str) -> None:
        if self._skip:
            return
        self._feed_text(data)

    def close(self) -> None:  # noqa: D102
        super().close()
        while self._open:  # </table> の閉じ忘れを回収する
            self._close_table()

    @property
    def document_text(self) -> str:
        # セルと同様、連結してから空白を畳む。ブロック要素の境界には
        # _feed_text 経由で空白が入っているので単語が繋がることはない。
        return _norm("".join(self._text))


def _parse(html: str) -> _Extractor:
    p = _Extractor()
    p.feed(html)
    p.close()
    return p


def tables(html: str) -> list[list[list[str]]]:
    """文書内の表を [表][行][セル] の三重リストで返す。空の表は含めない。"""
    return [g for g in _parse(html).tables if g]


def text(html: str) -> str:
    """文書全体のテキスト。bs4 の get_text(" ", strip=True) 相当。"""
    return _parse(html).document_text

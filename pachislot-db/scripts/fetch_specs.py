#!/usr/bin/env python3
"""機種スペックの取得・抽出（egress解放後に使用）.

責務を2層に分ける。

  fetch層 : robots.txt を尊重し、レート制限付きで1ページずつ取得してディスクにキャッシュ。
            サイト構造に依存しないため、そのまま使える。
  parse層 : キャッシュ済みHTMLから「設定1〜6 × 機械割/出玉率」の表を汎用的に抽出。
            多くの解析サイトがHTMLテーブルで掲載しているため、縦横どちらの並びにも対応する。

抽出結果は candidates/*.json に出力するだけで、data/machines.json には自動マージしない。
機械抽出をそのまま正とせず、必ず人間／エージェントの照合を挟むための設計。

使い方:
    python3 scripts/fetch_specs.py --check                    # robots確認のみ
    python3 scripts/fetch_specs.py --url <machine_page_url>   # 単ページ取得＋抽出
    python3 scripts/fetch_specs.py --urls urls.txt            # 一括（1行1URL）
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

import requests

import minihtml

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "cache"
CANDIDATES = ROOT / "candidates"

UA = "pachislot-db-research/1.0"
TIMEOUT = 30
MIN_DELAY = 2.5  # サイトへの最低アクセス間隔（秒）。robots の Crawl-delay が長ければそちらを優先

SETTING_RE = re.compile(r"設定\s*([1-6１-６])")
RATE_LABEL_RE = re.compile(r"(機械割|出玉率|payout)")
# 「97.0%」「97.0」「約97.0%」を拾う。範囲表記「97.0〜113.0」は個別設定値ではないので除外する
RATE_VALUE_RE = re.compile(r"(?<![\d.])(\d{2,3}\.\d|\d{2,3})\s*%?")
# 「97.7〜114.9%」だけでなく「98.2% 〜100.3%」のように
# 前側の数値にも % が付く書き方があるので、区切りの前の % を許容する
RANGE_RE = re.compile(r"\d{2,3}(?:\.\d)?\s*%?\s*[〜～~ー−\-]\s*\d{2,3}(?:\.\d)?")

ZEN2HAN = str.maketrans("１２３４５６", "123456")


class Politeness:
    """ホストごとに robots.txt とアクセス間隔を管理する。"""

    def __init__(self) -> None:
        self._robots: dict[str, RobotFileParser | None] = {}
        self._delay: dict[str, float] = {}
        self._last: dict[str, float] = {}

    def _robots_for(self, host: str) -> RobotFileParser | None:
        if host in self._robots:
            return self._robots[host]
        rp = RobotFileParser()
        try:
            r = requests.get(f"https://{host}/robots.txt",
                             headers={"User-Agent": UA}, timeout=TIMEOUT)
            if r.status_code == 200:
                rp.parse(r.text.splitlines())
            else:
                rp = None  # robots.txt が無い＝制限なしとみなす
        except requests.exceptions.RequestException:
            rp = None
        self._robots[host] = rp
        if rp is not None:
            cd = rp.crawl_delay(UA)
            self._delay[host] = max(float(cd), MIN_DELAY) if cd else MIN_DELAY
        else:
            self._delay[host] = MIN_DELAY
        return rp

    def allowed(self, url: str) -> tuple[bool, str]:
        host = urlparse(url).netloc
        rp = self._robots_for(host)
        if rp is None:
            return True, "robots.txt なし"
        if rp.can_fetch(UA, url):
            return True, f"robots許可 (間隔 {self._delay[host]}s)"
        return False, "robots.txt で Disallow"

    def wait(self, url: str) -> None:
        host = urlparse(url).netloc
        delay = self._delay.get(host, MIN_DELAY)
        elapsed = time.monotonic() - self._last.get(host, 0.0)
        if elapsed < delay:
            time.sleep(delay - elapsed)
        self._last[host] = time.monotonic()


def cache_path(url: str) -> Path:
    host = urlparse(url).netloc
    digest = hashlib.sha256(url.encode()).hexdigest()[:16]
    return CACHE / host / f"{digest}.html"


def fetch(url: str, pol: Politeness, force: bool = False) -> str | None:
    """1ページ取得。キャッシュがあれば再取得しない（サイトへの負荷を最小化）。"""
    path = cache_path(url)
    if path.exists() and not force:
        return path.read_text(encoding="utf-8", errors="replace")

    ok, reason = pol.allowed(url)
    if not ok:
        print(f"  スキップ: {url} — {reason}", file=sys.stderr)
        return None

    pol.wait(url)
    try:
        r = requests.get(url, headers={"User-Agent": UA}, timeout=TIMEOUT)
    except requests.exceptions.RequestException as e:
        print(f"  取得失敗: {url} — {type(e).__name__}: {e}", file=sys.stderr)
        return None
    if r.status_code != 200:
        print(f"  取得失敗: {url} — HTTP {r.status_code}", file=sys.stderr)
        return None

    r.encoding = r.apparent_encoding or r.encoding
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(r.text, encoding="utf-8")
    return r.text


def _setting_index(text: str, bare: bool = False) -> int | None:
    """セルから設定番号を読む。

    bare=True のときは「1」「６」のような素の数字も設定番号として認める。
    見出しが「設定」で、各行には数字だけを置くサイトがあるため。
    行が本当に設定行かどうかは呼び出し側が見出しで確認すること。
    """
    t = text.translate(ZEN2HAN).strip()
    m = SETTING_RE.search(t)
    if m:
        return int(m.group(1))
    if bare and len(t) == 1 and t in "123456":
        return int(t)
    return None


def _rate(text: str) -> float | None:
    """セルから出率を1つだけ取り出す。範囲表記は個別設定値ではないため捨てる。"""
    if RANGE_RE.search(text):
        return None
    m = RATE_VALUE_RE.search(text.replace(",", ""))
    if not m:
        return None
    v = float(m.group(1))
    return v if 80.0 <= v <= 130.0 else None


def extract_rates(html: str) -> dict[int, float]:
    """HTML内の表から {設定番号: 出率} を抽出。縦持ち・横持ちの両方に対応。"""
    best: dict[int, float] = {}

    for grid in minihtml.tables(html):
        found: dict[int, float] = {}

        # 横持ち: ヘッダ行が 設定1..6、どこかの行が「機械割/出玉率」
        # 設定1と設定6だけを載せる表も多いため2列から受け付ける。
        # 行ラベルの「機械割/出玉率」一致を必須にしているので、
        # 小役確率などの表を誤って拾うことはない。
        header = grid[0]
        cols = {i: s for i, c in enumerate(header) if (s := _setting_index(c))}
        if len(cols) >= 2:
            for row in grid[1:]:
                if not row or not RATE_LABEL_RE.search(row[0]):
                    continue
                for i, s in cols.items():
                    if i < len(row) and (v := _rate(row[i])) is not None:
                        found[s] = v

        # 縦持ち: 1列目が 設定1..6、ヘッダに「機械割/出玉率」の列がある。
        # 見出しが「設定」で本文が素の数字だけの表もあるため、その場合に限り
        # 数字1文字を設定番号として認める（見出しの確認を条件にして誤検出を防ぐ）。
        if not found:
            rate_col = next((i for i, c in enumerate(header) if RATE_LABEL_RE.search(c)), None)
            bare = bool(header) and SETTING_RE.search(header[0].translate(ZEN2HAN)) is None \
                and "設定" in header[0]
            if rate_col is not None:
                for row in grid[1:]:
                    if not row:
                        continue
                    s = _setting_index(row[0], bare=bare)
                    if s and rate_col < len(row) and (v := _rate(row[rate_col])) is not None:
                        found[s] = v

        if len(found) > len(best):
            best = found

    return best


def extract_condition(html: str) -> str:
    """出率条件（メーカー発表値／完全攻略時 等）の表記を探す。"""
    text = minihtml.text(html)
    for kw in ("メーカー発表値", "メーカー公表値", "完全攻略時", "フル攻略時",
               "独自調査値", "シミュレーション値", "自社調査"):
        if kw in text:
            return kw
    return ""


def process(url: str, pol: Politeness) -> dict:
    html = fetch(url, pol)
    if html is None:
        return {"url": url, "status": "取得失敗", "設定別出率": {}, "出率条件": ""}
    rates = extract_rates(html)
    return {
        "url": url,
        "status": "取得成功",
        "設定別出率": {f"設定{k}出率": v for k, v in sorted(rates.items())},
        "取得できた設定数": len(rates),
        "出率条件": extract_condition(html),
        "cache": str(cache_path(url).relative_to(ROOT)),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", help="単一ページのURL")
    ap.add_argument("--urls", type=Path, help="1行1URLのファイル")
    ap.add_argument("--check", action="store_true", help="robots確認のみ")
    ap.add_argument("--out", type=Path, default=CANDIDATES / "extracted.json")
    args = ap.parse_args()

    urls: list[str] = []
    if args.url:
        urls.append(args.url)
    if args.urls:
        urls += [ln.strip() for ln in args.urls.read_text(encoding="utf-8").splitlines()
                 if ln.strip() and not ln.startswith("#")]
    if not urls:
        ap.error("--url か --urls を指定してください")

    pol = Politeness()

    if args.check:
        for u in urls:
            ok, reason = pol.allowed(u)
            print(f"{'✓' if ok else '×'} {u} — {reason}")
        return 0

    CACHE.mkdir(exist_ok=True)
    CANDIDATES.mkdir(exist_ok=True)

    results = []
    for i, u in enumerate(urls, 1):
        print(f"[{i}/{len(urls)}] {u}")
        res = process(u, pol)
        n = res.get("取得できた設定数", 0)
        print(f"  → {res['status']} / 設定 {n}/6 件"
              + (f" / 条件: {res['出率条件']}" if res["出率条件"] else ""))
        results.append(res)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n抽出結果: {args.out}")
    print("※ この結果は自動マージしない。data/machines.json への反映前に必ず値を照合すること。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

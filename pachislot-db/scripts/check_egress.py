#!/usr/bin/env python3
"""egress許可状況の確認スクリプト.

環境のネットワークポリシーに情報源ドメインが追加されたかを一括で確認する。
robots.txt を1本だけ取りに行き、到達可否と robots の許可状況を同時に判定する。

    python3 scripts/check_egress.py

全ドメインが OK になれば全件取得フェーズに進める。
"""

from __future__ import annotations

import sys
import time
from urllib.robotparser import RobotFileParser

import requests

UA = "pachislot-db-research/1.0"
TIMEOUT = 20
DELAY = 2.0

DOMAINS = {
    "解析サイト": [
        "p-town.dmm.com",
        "cs62.cs-plaza.com",
        "pachi7.jp",
        "pachiseven.jp",
        "www.p-world.co.jp",
        "slobase.jp",
        "nana-press.com",
        "chonborista.com",
        "1geki.jp",
        "p-gabu.jp",
        "hazuse.com",
    ],
    "メーカー公式": [
        "www.sammy.co.jp",
        "www.kitadenshi.co.jp",
        "www.yamasa.co.jp",
        "www.daito.co.jp",
        "www.daitogiken.com",
        "www.sankyo-fever.co.jp",
        "www.fujishoji.co.jp",
        "www.olympia-tokyo.co.jp",
        "www.bisty.co.jp",
        "www.pioneer-net.jp",
    ],
}


def probe(host: str) -> tuple[str, str]:
    """(状態, 詳細) を返す。"""
    url = f"https://{host}/robots.txt"
    try:
        r = requests.get(url, headers={"User-Agent": UA}, timeout=TIMEOUT)
    except requests.exceptions.ProxyError as e:
        return "BLOCKED", f"egressプロキシが拒否 ({type(e).__name__})"
    except requests.exceptions.SSLError as e:
        return "TLS_ERROR", str(e)[:80]
    except requests.exceptions.RequestException as e:
        return "ERROR", f"{type(e).__name__}: {str(e)[:60]}"

    if r.status_code == 404:
        return "OK", "robots.txt なし（制限なしとみなす）"
    if r.status_code != 200:
        return "OK?", f"robots.txt HTTP {r.status_code}"

    rp = RobotFileParser()
    rp.parse(r.text.splitlines())
    allowed = rp.can_fetch(UA, f"https://{host}/")
    delay = rp.crawl_delay(UA)
    detail = "robots: 許可" if allowed else "robots: ルート配下を Disallow"
    if delay:
        detail += f" / Crawl-delay {delay}s"
    return ("OK" if allowed else "ROBOTS_DENY"), detail


def check_packages() -> int:
    """取得・ビルドに必要なモジュールが揃っているかを確認する。

    この環境ではパッケージレジストリ（pypi.org / archive.ubuntu.com）が egress で
    遮断されており pip も apt も使えない。そのため pandas / openpyxl /
    beautifulsoup4 / lxml への依存は標準ライブラリ実装に置き換えてある。
    外部依存は requests ひとつだけで、それも導入済み。
    """
    import importlib

    need = {
        "requests": "fetch_specs.py（HTTP取得）※唯一の外部依存",
        "minihtml": "fetch_specs.py（HTML解析・bs4/lxmlの代替。標準ライブラリのみ）",
        "minixlsx": "build_database.py（xlsx生成・openpyxlの代替。標準ライブラリのみ）",
    }
    print("\n=== 必要モジュール ===")
    missing = 0
    for mod, used_by in need.items():
        try:
            importlib.import_module(mod)
        except ImportError:
            print(f"  × MISSING      {mod:<28} {used_by}")
            missing += 1
        else:
            print(f"  ✓ OK           {mod:<28} {used_by}")

    if missing:
        print(f"\n{missing} 件のモジュールが読み込めません。")
        print("minihtml / minixlsx は scripts/ 配下にあり pip 導入は不要です。")
        print("requests が無い場合のみ環境側の対応が要ります。")
    return missing


def main() -> int:
    ok = blocked = 0
    for group, hosts in DOMAINS.items():
        print(f"\n=== {group} ===")
        for host in hosts:
            state, detail = probe(host)
            mark = {"OK": "✓", "OK?": "△", "ROBOTS_DENY": "×", "BLOCKED": "×"}.get(state, "×")
            print(f"  {mark} {state:<12} {host:<28} {detail}")
            if state.startswith("OK"):
                ok += 1
            else:
                blocked += 1
            time.sleep(DELAY)

    total = ok + blocked
    print(f"\n到達可能: {ok}/{total} / 不可: {blocked}/{total}")

    missing = check_packages()

    print()
    if blocked:
        print("未解放のドメインがあります。README の許可リストを環境設定に追加してください。")
        print("robots.txt で Disallow のサイトは自動取得の対象外とし、代替情報源を使います。")
    if missing:
        print("必要パッケージが未導入です。上記の対処を行ってください。")
    if blocked or missing:
        print("\n開始条件を満たしていないため、全件取得フェーズには進みません。")
        return 1

    print("全ドメイン到達可能・必要パッケージ導入済み。全件取得フェーズに進めます。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

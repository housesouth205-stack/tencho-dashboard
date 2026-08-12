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
    if blocked:
        print("\n未解放のドメインがあります。README の許可リストを環境設定に追加してください。")
        print("robots.txt で Disallow のサイトは自動取得の対象外とし、代替情報源を使います。")
        return 1
    print("\n全ドメイン到達可能。全件取得フェーズに進めます。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""本番Supabaseの中身を読んで、引き継ぎで宙に浮いている確認事項に答える道具.

画面を開かないと分からないこと（経費の地代家賃が直っているか、増台計画の台番が
島図と合っているか）を毎回人に聞いていると、確認だけで1往復かかる。
繋がる環境からこれを流せば、その場で全部答えが出る。

**読むだけ。1バイトも書かない。**（書き込みはアプリの画面からやること。
道具から書くと、検算も確認画面も通らないまま本番のデータが変わる）

    export DASH_PASSWORD='共有アカウントのパスワード'
    python3 tools/dbcheck/check.py

接続先とメールは src/core/config.js から読む。ここに書き写すと、
config.js を直したときに片方だけ古くなる（実際にキーの二重管理で事故っている）。

パスワードは環境変数からしか受け取らない（引数にすると ps や履歴に残る）。
出力にも出さない。

外部ライブラリは使わない。この環境はパッケージレジストリに出られないので、
requests も supabase-py も入れられない（pachislot-db と同じ事情）。
"""

from __future__ import annotations

import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
CONFIG = ROOT / "src" / "core" / "config.js"
STORE_ID = "toho-ikebukuro"

# 会議資料の千円表記に合わせる。円のまま出すと紙と突き合わせられない。
def k(v):
    return "—" if v is None else f"{round(v / 1000):,}"


def ctx():
    # プロキシがTLSを張り直す環境があるので、CA束の指定を環境変数から拾えるようにする。
    ca = os.environ.get("SSL_CERT_FILE") or os.environ.get("REQUESTS_CA_BUNDLE")
    return ssl.create_default_context(cafile=ca) if ca else ssl.create_default_context()


def read_config():
    """config.js から接続先・キー・ログイン用メールを取る。"""
    src = CONFIG.read_text(encoding="utf-8")

    def const(name):
        m = re.search(rf'export const {name}\s*=\s*"([^"]*)"', src)
        return m.group(1) if m else None

    url, key = const("SUPABASE_URL"), const("SUPABASE_ANON_KEY")
    # AUTH_EMAIL は公開ソースに素で残さないため配列を join して持っている。
    m = re.search(r'export const AUTH_EMAIL\s*=\s*\[([^\]]*)\]\.join\("@"\)', src)
    email = "@".join(re.findall(r'"([^"]*)"', m.group(1))) if m else None
    if not url or not key:
        sys.exit(f"config.js から接続先を読めませんでした: {CONFIG}")
    return url.rstrip("/"), key, email


def call(url, key, path, token=None, data=None):
    """PostgREST / GoTrue を叩く。失敗の理由は呼び出し側で出し分けたいので例外は包まない。"""
    req = urllib.request.Request(url + path, method="POST" if data is not None else "GET")
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {token or key}")
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, body, timeout=30, context=ctx()) as res:
        return json.loads(res.read().decode() or "null")


def explain(e, host):
    """繋がらないときは、どこで止まったのかまで書く（『失敗しました』だけだと次の手が決まらない）。"""
    if isinstance(e, urllib.error.HTTPError):
        return f"HTTP {e.code}: {e.read().decode(errors='replace')[:300]}"
    reason = str(getattr(e, "reason", e))
    if "403" in reason or "CONNECT" in reason.upper():
        return (f"プロキシが {host} を拒否しました（組織のネットワークポリシー）。\n"
                "  → 環境設定のネットワークアクセスに このホストを足して、新しいセッションを開いてください。")
    return reason


# ───────── 確認 ─────────

def check_rls_hole(url, key):
    """未ログインで読めてしまわないか。

    anonキーは GitHub Pages のソースに露出しているので、読めたら誰でも読める。
    pl_month は 0002_auth_rls.sql のテーブル一覧に入っていない（後から足したテーブル）
    ので、ここが穴になっていないかを毎回確かめる。
    """
    print("■ 未ログインで読めるテーブルがないか（RLSの穴）")
    for t in ("pl_month", "actual_day", "app_setting"):
        try:
            rows = call(url, key, f"/rest/v1/{t}?select=*&limit=1")
            state = (f"⚠ 未ログインで読めます（{len(rows)}件返った）。RLSが無効か anon 許可のポリシーが残っています"
                     if rows else "△ 未ログインで通りましたが0件（RLSは有効で、ポリシーが無いだけの可能性）")
        except urllib.error.HTTPError as e:
            state = f"OK 拒否されました（HTTP {e.code}）" if e.code in (401, 403) else f"? HTTP {e.code}"
        print(f"  {t:12} {state}")
    print()


def check_pl(url, key, token):
    """経費（pl_month）。地代家賃が直っているか＝ここがいちばん見たい。"""
    print("■ 月次の損益・経費（千円）")
    cols = "ym,label,src,sales,cogs,gross,sga,op,jinken,hanbai,tatemono,koukyou,shokeihi,genka,yachin,kigu"
    rows = call(url, key, f"/rest/v1/pl_month?select={cols}&store_id=eq.{STORE_ID}&kind=eq.actual&order=ym", token)
    if not rows:
        print("  1件もありません（＝CSVはまだ取り込まれていない）\n")
        return
    print(f"  {'月度':<9}{'総売上高':>10}{'一般管理費':>11}{'営業利益':>10}{'地代家賃':>10}{'入替代':>10}  出典")
    for r in rows:
        print(f"  {str(r['ym'])[:7]:<9}{k(r['sales']):>10}{k(r['sga']):>11}{k(r['op']):>10}"
              f"{k(r['yachin']):>10}{k(r['kigu']):>10}  {r.get('src') or '—'}")

    # 資料と同じ検算。合わない月は読み違いが残っている。
    print("\n  検算（合わない月は資料の読み違いが残っています）")
    parts = ["jinken", "hanbai", "tatemono", "koukyou", "shokeihi", "genka"]
    bad = 0
    for r in rows:
        ng = []
        if r["sga"] is not None and all(r[p] is not None for p in parts):
            s = sum(r[p] for p in parts)
            if s != r["sga"]:
                ng.append(f"内訳合計{k(s)}≠一般管理費{k(r['sga'])}")
        if None not in (r["sales"], r["cogs"], r["gross"]) and r["sales"] - r["cogs"] != r["gross"]:
            ng.append("総売上高−売上原価≠売上総利益")
        if None not in (r["gross"], r["sga"], r["op"]) and r["gross"] - r["sga"] != r["op"]:
            ng.append("売上総利益−一般管理費≠営業利益")
        if ng:
            bad += 1
            print(f"    ⚠ {str(r['ym'])[:7]}  " + " / ".join(ng))
    print(f"    {'すべて一致' if not bad else f'{bad}か月ずれています'}")

    # 地代家賃は毎月4,000千円で固定のはず。ばらついていたら資料の1行ずれを疑う。
    ya = [r["yachin"] for r in rows if r["yachin"] is not None]
    if ya:
        lo, hi = min(ya), max(ya)
        print(f"\n  地代家賃: {k(lo)}〜{k(hi)}千円"
              + ("（毎月同額。直っています）" if lo == hi else "  ⚠ 月によって違います。読み違い（行ずれ）が残っている可能性"))
    print()


def check_capex(url, key, token, layout):
    """増台計画。工事回の台番が実在するか・区分が合っているかまで見る。"""
    print("■ 増台計画（app_setting）")
    rows = call(url, key, f"/rest/v1/app_setting?select=key,value&store_id=eq.{STORE_ID}", token)
    by = {r["key"]: r["value"] for r in rows}
    for k2 in ("capex_items", "capex_rounds", "capex_growth", "dai_ranges"):
        v = by.get(k2)
        n = len(v.get("list", [])) if isinstance(v, dict) and isinstance(v.get("list"), list) else None
        print(f"  {k2:14} " + ("未保存（画面の初期値のまま）" if v is None
                               else f"保存済み{f'（{n}件）' if n is not None else ''}"
                                    f" 最終更新 {str(v.get('updated_at') or '—')[:10]}"))

    for it in (by.get("capex_items") or {}).get("list", []):
        qty, amt = it.get("qty") or 0, it.get("amount") or 0
        unit = f"{round(amt / qty):,}" if qty else "—"
        print(f"    ・{it.get('name','')}  総額 {amt:,}円 ÷ {qty}{it.get('unit','')} = 単価 {unit}円"
              f"  見積日 {it.get('quoteDate','—')}")

    known = {c["dai_no"] for c in layout}
    for r in (by.get("capex_rounds") or {}).get("list", []):
        for a in r.get("adds", []):
            dai = parse_ranges(a.get("daiText", ""))
            miss = sorted(d for d in dai if known and d not in known)
            # 連番はまとめる。1台ずつ並べると1行に収まらず、どこが抜けたのか読めない。
            note = f"  ⚠ 島図に無い台番 {format_ranges(miss)}" if miss else ""
            count = a.get("count")
            if dai and count and len(dai) != count:
                note += f"  ⚠ 台数{count}と台番の数{len(dai)}が合いません"
            print(f"    ・{r.get('label','')} {r.get('workDate','')} {a.get('rate')} "
                  f"{count}台 [{a.get('daiText') or '台番未入力'}]{note}")
    print()


def parse_ranges(text):
    """"82-94, 100" → [82..94, 100]。画面の daiRange.js と同じ書式。"""
    out = []
    for part in str(text or "").replace("　", " ").split(","):
        part = part.strip()
        if not part:
            continue
        m = re.match(r"^(\d+)\s*[-−〜~]\s*(\d+)$", part)
        if m:
            out += list(range(int(m.group(1)), int(m.group(2)) + 1))
        elif part.isdigit():
            out.append(int(part))
    return out


def format_ranges(nums):
    """[82,83,84,100] → "82-84, 100"。画面（daiRange.js の formatRanges）と同じ見せ方。"""
    out, start, prev = [], None, None
    for n in sorted(nums):
        if start is None:
            start = prev = n
            continue
        if n == prev + 1:
            prev = n
            continue
        out.append(f"{start}-{prev}" if start != prev else f"{start}")
        start = prev = n
    if start is not None:
        out.append(f"{start}-{prev}" if start != prev else f"{start}")
    return ", ".join(out)


def check_layout(url, key, token):
    print("■ 島図（layout_cell）")
    cells = call(url, key, f"/rest/v1/layout_cell?select=dai_no,floor&store_id=eq.{STORE_ID}&order=dai_no", token)
    if not cells:
        print("  1件もありません（島図が未取込）\n")
        return []
    by = {}
    for c in cells:
        by.setdefault(c["floor"], []).append(c["dai_no"])
    for fl, dai in by.items():
        print(f"  {fl:4} {len(dai):>4}台  台番 {min(dai)}〜{max(dai)}")
    print()
    return cells


def main():
    url, key, email = read_config()
    host = url.split("//")[-1]
    print(f"接続先 {url}\n")

    try:
        check_rls_hole(url, key)
    except Exception as e:  # noqa: BLE001 - 理由をそのまま出したい
        sys.exit("繋がりません: " + explain(e, host))

    pw = os.environ.get("DASH_PASSWORD")
    if not pw:
        sys.exit("DASH_PASSWORD が設定されていません（ログインしないと中身は読めません）。\n"
                 "  環境変数に入れてください。引数やチャットに書くと履歴に残ります。")
    try:
        auth = call(url, key, "/auth/v1/token?grant_type=password", data={"email": email, "password": pw})
        token = auth["access_token"]
    except Exception as e:  # noqa: BLE001
        sys.exit(f"ログインできませんでした（{email}）: " + explain(e, host))
    print(f"ログイン成功: {email}\n")

    check_pl(url, key, token)
    layout = check_layout(url, key, token)
    check_capex(url, key, token, layout)
    print("（このスクリプトは読むだけです。何も書き換えていません）")


if __name__ == "__main__":
    main()

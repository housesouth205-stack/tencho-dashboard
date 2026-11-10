#!/bin/sh
# コミット前の確認をまとめて通す。CIが無いので、これが唯一の関門。
#   sh tools/check/run.sh
# 1つでも失敗したら終了コード1。
cd "$(dirname "$0")/../.." || exit 1
fail=0
echo "== 1/4 構文（node --check）"
for f in $(find src -name '*.js' -not -path 'src/lib/*') tools/check/*.mjs sw.js; do
  node --check "$f" || fail=1
done
echo "== 2/4 import と export の照合"
out=$(node tools/check/imports.mjs); st=$?   # パイプに通すと終了コードが grep のものになる
echo "$out" | grep -v '^注意'
[ "$st" = 0 ] || fail=1
echo "== 3/4 機種DBのテスト"
(cd pachislot-db/scripts && python3 test_extract.py | tail -1 && python3 test_merge.py | tail -1) || fail=1
echo "== 4/4 全タブをブラウザで描画"
node tools/check/smoke.mjs || fail=1
[ "$fail" = 0 ] && echo "すべて通りました" || echo "失敗があります（上を確認）"
exit $fail

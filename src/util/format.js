export const yen = (n) => (n == null || isNaN(n) ? "—" : "¥" + Math.round(n).toLocaleString("ja-JP"));
export const num = (n, d = 0) => (n == null || isNaN(n) ? "—" : Number(n).toLocaleString("ja-JP", { maximumFractionDigits: d, minimumFractionDigits: d }));
export const pct = (r, d = 1) => (r == null || isNaN(r) ? "—" : (r * 100).toFixed(d) + "%");
export const yaku = (r, d = 1) => (r == null || isNaN(r) ? "—" : Number(r).toFixed(d)); // 単価等

// 機種名の表記ゆれを吸収した比較キー（半角カナ・記号・接頭辞・末尾の型式コードを無視）。
// 例「Lｽﾏｽﾛ北斗の拳 転生の章2 MW」と「L スマスロ北斗の拳転生の章2」を同一とみなす。
export function modelKey(name) {
  let t = String(name || "").replace(/^[①-⑳]+/, "").normalize("NFKC").toUpperCase();
  t = t.replace(/[Ⅰ-Ⅻ]/g, (c) => String("ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ".indexOf(c) + 1));
  t = t.replace(/(スマスロ|パチスロ|スロット|SLOT)/g, "");
  t = t.replace(/[\s　・･,.。、（）()【】\[\]「」"'~〜～\-_/]/g, "");
  t = t.replace(/^[LSP]/, "");        // 先頭の機種種別
  t = t.replace(/[A-Z0-9]{1,4}$/, ""); // 末尾の店内コード/型式コード
  return t;
}
// 表記ゆれを許容した同一機種判定。どちらか空なら false。
export function sameModel(a, b) {
  const ka = modelKey(a), kb = modelKey(b);
  if (!ka || !kb) return false;
  return ka === kb || ka.includes(kb) || kb.includes(ka);
}

// 島図・ヒートマップの狭いセル用に機種名を短縮。
// 先頭の機種種別（L / S / LB / Ｌ / Ｓ）と、その後ろの「/」や空白、
// 続く「スマスロ」「パチスロ」を除去する。例「LB/ クレアの秘宝伝」→「クレアの秘宝伝」。
// 後ろ側の「/」は型式コードの区切りなので残す（「ハナビ /KM」はそのまま）。
// 英字が続くとき（Lupin など）は機種種別ではないので消さない。
export function shortModel(name) {
  let s = String(name || "");
  let prev;
  do {
    prev = s;
    s = s.replace(/^[\s　]*[LSＬＳ][BＢ]?(?=[\s　/／]|$|[^0-9A-Za-z])[\s　]*[/／]?[\s　]*/, "");
    s = s.replace(/^[\s　]*(?:スマスロ|ｽﾏｽﾛ)[\s　]*/, "");
    s = s.replace(/^[\s　]*(?:パチスロ|ﾊﾟﾁｽﾛ)[\s　]*/, "");
  } while (s !== prev);
  return s.trim() || String(name || "");
}

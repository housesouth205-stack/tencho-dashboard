export const yen = (n) => (n == null || isNaN(n) ? "—" : "¥" + Math.round(n).toLocaleString("ja-JP"));
export const num = (n, d = 0) => (n == null || isNaN(n) ? "—" : Number(n).toLocaleString("ja-JP", { maximumFractionDigits: d, minimumFractionDigits: d }));
export const pct = (r, d = 1) => (r == null || isNaN(r) ? "—" : (r * 100).toFixed(d) + "%");
export const yaku = (r, d = 1) => (r == null || isNaN(r) ? "—" : Number(r).toFixed(d)); // 単価等

// 島図・ヒートマップの狭いセル用に機種名を短縮。先頭の「L」「スマスロ」等を除去。
export function shortModel(name) {
  let s = String(name || "");
  let prev;
  do {
    prev = s;
    s = s.replace(/^\s*[LＬ]\s*/, "").replace(/^\s*(?:スマスロ|ｽﾏｽﾛ)\s*/, "").replace(/^\s*(?:パチスロ|ﾊﾟﾁｽﾛ)\s*/, "");
  } while (s !== prev);
  return s.trim() || String(name || "");
}

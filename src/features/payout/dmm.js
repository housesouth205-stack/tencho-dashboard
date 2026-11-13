// 機種名の照合に使う、名前の正規化と似ている度合い。機種DB（localdb.js）と出玉率表の照合が使う。
// もとはDMMぱちタウンから出玉率を取るクライアントだったが、Webからの取得はやめた
// （出玉率は店長の出玉率表だけを使う）。照合の部品だけが残っている。
// 機種名を検索・照合用に正規化。全半角統一→末尾の店内コード/バージョン記号を除去。
export function normName(s) {
  let t = String(s || "").normalize("NFKC").toUpperCase();
  t = t.replace(/[Ⅰ-Ⅻ]/g, (c) => "ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ".indexOf(c) + 1); // ローマ数字→算用
  t = t.replace(/[\s　・･,.。、（）()【】\[\]「」"'~〜\-_/]/g, "");
  t = t.replace(/(スマスロ|パチスロ|SLOT)/g, "");
  return t;
}

// 2-gram Dice係数で名前類似度(0..1)。
export function similarity(a, b) {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const grams = (s) => { const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; };
  const ga = grams(na), gb = grams(nb);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return (2 * inter) / (ga.size + gb.size);
}

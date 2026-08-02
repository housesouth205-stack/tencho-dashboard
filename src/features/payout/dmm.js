// DMMぱちタウン出玉率取得クライアント。Supabase Edge Function(payout-fetch)を叩く。
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../../core/config.js";

const ENDPOINT = `${SUPABASE_URL}/functions/v1/payout-fetch`;

async function call(body) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_ANON_KEY}`, apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `取得失敗(HTTP ${res.status})`);
  return json;
}

export const dmmSearch = (keyword, limit = 3) => call({ action: "search", keyword, limit });
export const dmmFetch = (id, source) => call({ action: "fetch", id, source });

// 機種名を検索・照合用に正規化。全半角統一→末尾の店内コード/バージョン記号を除去。
export function normName(s) {
  let t = String(s || "").normalize("NFKC").toUpperCase();
  t = t.replace(/[Ⅰ-Ⅻ]/g, (c) => "ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ".indexOf(c) + 1); // ローマ数字→算用
  t = t.replace(/[\s　・･,.。、（）()【】\[\]「」"'~〜\-_/]/g, "");
  t = t.replace(/(スマスロ|パチスロ|SLOT)/g, "");
  return t;
}

// 検索キーワード用: 当店の命名(⑤区分マーカー / 先頭S,L,P機種種別 / 末尾の店内コード)を落として
// DMMがヒットする主要語(日本語＋作品番号)だけを残す。
export function searchKeyword(model) {
  let t = String(model || "").replace(/^[①-⑳①-⑳]+/, ""); // 丸数字はNFKCで数字化する前に除去
  t = t.normalize("NFKC");
  t = t.replace(/[（(].*?[)）]/g, "");        // 括弧内
  t = t.replace(/^[\s/]*[SLP]\s*/i, "");      // 先頭の機種種別 S/L/P
  t = t.replace(/^[\s/]+/, "");
  t = t.replace(/[A-Za-z].*$/, "");           // 最初のラテン文字(=店内コード/型番)以降を除去
  return t.replace(/[\s/・･\-]+$/, "").trim();
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

// 検索結果から最良候補を選ぶ。score付き降順。設定別実測(per6)持ちを同点なら優先。
export function rankCandidates(model, candidates) {
  const bonus = (c) => ((c.per6 || []).filter((v) => v != null).length >= 3 ? 0.08 : 0);
  return candidates
    .map((c) => ({ ...c, score: similarity(model, c.name) }))
    .sort((a, b) => (b.score + bonus(b)) - (a.score + bonus(a)));
}

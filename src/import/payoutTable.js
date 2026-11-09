// 出玉率表（機種名 × 設定1〜6 の機械割）の読み取り。
//
// 店長が手元で作っている表（デスクトップの出玉率表など）を、そのまま出玉率タブに入れるため。
// 列は名前で探すので、台数や備考の列があっても、設定の列の並びが違っても読める。
// 空欄は「その機種にその設定の数値が無い」という意味なので埋めない
// （シミュレーターは空欄の設定を割り当てない）。
import { findHeader } from "./anyTable.js";

export const PAYOUT_FIELDS = [
  { key: "name", label: "機種名", required: true, names: ["機種名", "機種", "機種名称", "=名前"] },
  { key: "count", label: "台数", names: ["台数", "設置台数"] },
  ...[1, 2, 3, 4, 5, 6].map((s) => ({
    key: "s" + s, label: "設定" + s, required: s === 1 || s === 6,
    names: ["設定" + s, "設定" + "０１２３４５６"[s], "=S" + s, "=" + s, "設" + s],
  })),
];

const num = (v) => {
  const t = String(v ?? "").normalize("NFKC").replace(/[,\s%％]/g, "");
  if (t === "" || t === "-" || t === "—") return null;
  const n = Number(t);
  // 機械割は90〜130%に収まる。0.975 のように割合で書かれていれば100倍してそろえる
  if (!isFinite(n) || n <= 0) return null;
  return Math.round((n < 2 ? n * 100 : n) * 10) / 10;
};

/**
 * @returns {{entries: {name: string, count: number|null, per6: (number|null)[]}[], warnings: string[]}}
 */
export function parsePayoutTable(rows, filename = "") {
  const h = findHeader(rows, PAYOUT_FIELDS);
  const warnings = [];
  const settingCols = [1, 2, 3, 4, 5, 6].filter((s) => h.map["s" + s] != null).length;
  if (h.index < 0 || h.map.name == null || settingCols < 2) {
    return { entries: [], warnings: [`${filename}: 「機種名」と「設定1〜6」の見出しが見つかりません`] };
  }
  const entries = [];
  const seen = new Set();
  for (const r of rows.slice(h.index + 1)) {
    const name = String(r[h.map.name] ?? "").trim();
    if (!name) continue;
    const per6 = [1, 2, 3, 4, 5, 6].map((s) => (h.map["s" + s] == null ? null : num(r[h.map["s" + s]])));
    if (!per6.some((v) => v != null)) continue; // 数値の無い行（注記・小見出し）は飛ばす
    if (seen.has(name)) { warnings.push(`「${name}」が2回出てきます。先の行を使いました`); continue; }
    seen.add(name);
    const count = h.map.count == null ? null : Number(String(r[h.map.count]).replace(/[^\d.]/g, "")) || null;
    entries.push({ name, count, per6 });
  }
  if (!entries.length) warnings.push(`${filename}: 数値の入った機種が1つもありません`);
  return { entries, warnings };
}

// 見出しだけで出玉率表らしいかを見る（種類の判定用）
export function looksLikePayoutTable(rows) {
  const h = findHeader(rows, PAYOUT_FIELDS);
  const settingCols = [1, 2, 3, 4, 5, 6].filter((s) => h.map["s" + s] != null).length;
  return h.map.name != null && settingCols >= 3 ? settingCols : 0;
}

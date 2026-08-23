// 月次の損益・経費CSVのパーサ。
// 会議資料（店舗別営業実績表）を読み取ってこちらで作るCSVを取り込む。
// 1行＝1か月。列は名前で探すので、順番が変わっても増減しても壊れない。
import { decodeText, parseCsv, findCol } from "../util/csv.js";

// 列名 → DBの列。別名も許す（元資料の言い方とこちらの言い方が揺れるため）。
// PDF側（plPdf.js）も同じ対応表を見る。増やすときはここだけ直せばよい。
export const COLS = [
  ["sales", ["総売上高", "実績_総売上高", "売上高"]],
  ["cogs", ["売上原価"]],
  ["gross", ["売上総利益", "粗利"]],
  ["sga", ["一般管理費", "一般管理費合計", "一般経費"]],
  ["op", ["営業利益"]],
  ["ordinary", ["経常利益"]],
  ["jinken", ["人件費"]],
  ["hanbai", ["販売費"]],
  ["tatemono", ["建物管理費"]],
  ["koukyou", ["公共料金"]],
  ["shokeihi", ["一般諸経費"]],
  ["genka", ["減価償却費"]],
  ["kyuyo", ["給与計", "給与", "従業員給料"]],
  ["kigu", ["消耗器具費", "入替代"]],
  ["suidou", ["水道光熱費"]],
  ["yachin", ["地代家賃"]],
  ["hoshu", ["保守料"]],
  ["shuzen", ["修繕費"]],
];

const num = (v) => {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/[,\s￥¥]/g, ""));
  return isFinite(n) ? n : null;
};

// 月度の表記を月初の日付にする。
// 「R7.01」「令和7年1月」「2025-01」「2025/1」のどれでも受ける。
// 令和は1年＝2019年。
export function parseMonthLabel(s) {
  const t = String(s || "").trim().normalize("NFKC");
  if (!t) return null;
  let m = t.match(/^[RrＲｒ令和]*\s*(\d{1,2})\s*[年.\-\/]\s*(\d{1,2})/);
  // 「和7年5月」のように令が落ちた断片で渡ってくることがある（PDFは文字が分かれて出る）
  if (m && /^[RrＲｒ令和]/.test(t)) {
    const y = 2018 + Number(m[1]), mo = Number(m[2]);
    if (mo >= 1 && mo <= 12) return `${y}-${String(mo).padStart(2, "0")}-01`;
    return null;
  }
  m = t.match(/^(\d{4})\s*[年.\-\/]\s*(\d{1,2})/);
  if (m) {
    const mo = Number(m[2]);
    if (mo >= 1 && mo <= 12) return `${m[1]}-${String(mo).padStart(2, "0")}-01`;
  }
  return null;
}

/**
 * @returns {{rows: object[], warnings: string[]}} rows は pl_month にそのまま入れられる形（金額は円）。
 */
export function parsePlCsv(arrayBuffer, filename = "") {
  const table = parseCsv(decodeText(arrayBuffer)).filter((r) => r.some((c) => String(c).trim() !== ""));
  const warnings = [];
  if (!table.length) return { rows: [], warnings: [`${filename}: 中身が空です`] };

  const header = table[0].map((h) => String(h).replace(/^﻿/, "").trim());
  const iMonth = findCol(header, ["月度", "年月", "西暦年月"]);
  if (iMonth < 0) return { rows: [], warnings: [`${filename}: 「月度」の列が見つかりません`] };
  const iSrc = findCol(header, ["出典ファイル"]);

  const idx = {};
  for (const [key, names] of COLS) { const i = findCol(header, names); if (i >= 0) idx[key] = i; }
  if (idx.sga == null) warnings.push(`${filename}: 「一般管理費」の列がありません（グラフが出せません）`);

  const rows = [];
  for (let r = 1; r < table.length; r++) {
    const line = table[r];
    const ym = parseMonthLabel(line[iMonth]);
    if (!ym) { warnings.push(`${r + 1}行目: 月度「${line[iMonth]}」が読めないので飛ばしました`); continue; }

    // 元資料は千円単位。アプリ内の金額は円に揃えているので1000倍する。
    const rec = { ym, kind: "actual", label: String(line[iMonth]).trim(), src: iSrc >= 0 ? line[iSrc] : null };
    let any = false;
    for (const [key] of COLS) {
      if (idx[key] == null) continue;
      const v = num(line[idx[key]]);
      // 空欄は書かない。列が丸ごと無いときと同じ扱いにする。
      // nullで上書きすると、前に入れた値が消える（1か月ぶんだけ費目が空のCSVを
      // 入れ直しただけで、入っていた地代家賃が消えてしまう）。
      if (v == null) continue;
      rec[key] = Math.round(v * 1000);
      any = true;
    }
    if (!any) { warnings.push(`${r + 1}行目: 金額が1つも入っていないので飛ばしました`); continue; }

    // 内訳の合計が一般管理費と合うか確かめる（読み取り違いをここで捕まえる）。
    const parts = ["jinken", "hanbai", "tatemono", "koukyou", "shokeihi", "genka"];
    if (rec.sga != null && parts.every((k) => rec[k] != null)) {
      const sum = parts.reduce((a, k) => a + rec[k], 0);
      if (sum !== rec.sga) {
        warnings.push(`${rec.label}: 内訳の合計 ${Math.round(sum / 1000).toLocaleString()}千円 が一般管理費 ${Math.round(rec.sga / 1000).toLocaleString()}千円 と合いません`);
      }
    }
    rows.push(rec);
  }
  return { rows, warnings };
}

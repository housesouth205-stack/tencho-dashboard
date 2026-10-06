// 月次の損益・経費CSVのパーサ。
// 会議資料（店舗別営業実績表）を読み取ってこちらで作るCSVを取り込む。
// 1行＝1か月。列は名前で探すので、順番が変わっても増減しても壊れない。
import { decodeText, parseCsv, findCol, sniffDelimiter } from "../util/csv.js";

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

// 金額のセル。△▲・(1,234) のマイナス表記と、¥・円の飾りを受ける
const num = (v) => {
  const t = String(v ?? "").normalize("NFKC").replace(/[,\s¥円]/g, "");
  if (t === "" || t === "-") return null;
  const neg = /^[△▲\-(]/.test(t);
  const n = Number(t.replace(/[△▲\-()]/g, ""));
  return isFinite(n) ? (neg ? -n : n) : null;
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
  const text = decodeText(arrayBuffer);
  return parsePlTable(parseCsv(text, sniffDelimiter(text)), filename);
}

const blank = (r) => !r.some((c) => String(c ?? "").trim() !== "");

/**
 * 表（文字の2次元配列）から月次の損益を読む。CSV・Excel・貼り付けのどれもここを通す。
 * 向きは2通り受ける:
 *   縦持ち … 1行＝1か月（「月度,総売上高,…」の見出し）。こちらで作るCSVの形
 *   横持ち … 1行＝1費目、月が列に並ぶ（会議資料・本部のExcelはこちらが多い）
 * @param unit 資料の単位。既定は千円（会議資料に合わせる）。円の資料は 1 を渡す
 */
export function parsePlTable(table, filename = "", { unit = 1000 } = {}) {
  table = table.filter((r) => !blank(r)).map((r) => r.map((c) => String(c ?? "").replace(/^\uFEFF/, "").trim()));
  if (!table.length) return { rows: [], warnings: [`${filename}: 中身が空です`] };

  // 見出しに「月度」が無ければ横持ちとみなして縦に組み直す
  let hi = table.findIndex((r, i) => i < 20 && findCol(r, MONTH_NAMES) >= 0);
  const pre = [];
  if (hi < 0) {
    const t = transposeByMonth(table, pre);
    if (!t) return { rows: [], warnings: [`${filename}: 「月度」の列も、月が横に並んだ見出しも見つかりません`] };
    table = t; hi = 0;
  }
  const res = readVertical(table.slice(hi), filename, unit);
  return { ...res, warnings: [...pre, ...res.warnings] };
}

const MONTH_NAMES = ["月度", "年月", "西暦年月", "対象月"];
const fieldKey = (s) => String(s || "").normalize("NFKC").replace(/[\s　・（）()［］\[\]「」【】:：]/g, "");

// 横持ちの表を縦持ちにする。月の見出しがいちばん多く並ぶ行を見出しとし、
// 費目名はその左側の列から拾う。
// 1か月に「予算・実績・前年」の小見出しが並ぶ資料では、月の見出しは先頭（ふつう予算）の
// 上にしか無い。そのまま月の列を取ると予算が実績として静かに入るので、すぐ下の行から
// 「実績」の列を探す。見つからず1か月に複数列あるときは、注意を出す。
function transposeByMonth(table, warnings) {
  let head = -1, cols = [];
  for (let i = 0; i < Math.min(30, table.length); i++) {
    const hit = table[i].map((c, j) => (parseMonthLabel(c) ? j : -1)).filter((j) => j >= 0);
    if (hit.length > cols.length) { head = i; cols = hit; }
  }
  if (head < 0) return null;
  const width = Math.max(...table.map((r) => r.length));
  let ambiguous = 0;
  const pick = cols.map((j, k) => {
    const end = k + 1 < cols.length ? cols[k + 1] : width;
    for (const sub of table.slice(head + 1, head + 3)) {
      for (let c = j; c < end; c++) if (/^(当月)?実績$/.test(fieldKey(sub[c]))) return c;
    }
    // 次の月までの間に数字の入る列が複数あれば、どれが実績か分からない
    if (end - j > 1 && table.slice(head + 1).some((r) => r.slice(j + 1, end).some((c) => num(c) != null))) ambiguous++;
    return j;
  });
  if (ambiguous) warnings.push(`月ごとに数字の列が複数あり、「実績」の見出しが見つかりませんでした（${ambiguous}か月）。各月の先頭の列を使っています。予算が入っていないか確かめてください`);
  const known = COLS.flatMap(([, names]) => names.map(fieldKey));
  const names = [];
  const values = cols.map(() => []);
  for (let i = head + 1; i < table.length; i++) {
    const r = table[i];
    // 月の列より左で、知っている費目名に当たるセルを費目名とする（左端に「科目コード」等があっても読める）
    const label = r.slice(0, cols[0]).find((c) => known.includes(fieldKey(c)) || known.includes(fieldKey(c).replace(/合計$/, "")));
    if (!label) continue;
    names.push(label);
    pick.forEach((c, k) => values[k].push(r[c] ?? ""));
  }
  if (!names.length) return null;
  return [["月度", ...names], ...cols.map((j, k) => [table[head][j], ...values[k]])];
}

function readVertical(table, filename, unit) {
  const warnings = [];
  const header = table[0];
  const iMonth = findCol(header, MONTH_NAMES);
  if (iMonth < 0) return { rows: [], warnings: [`${filename}: 「月度」の列が見つかりません`] };
  const iSrc = findCol(header, ["出典ファイル"]);
  const hk = header.map(fieldKey);

  const idx = {};
  for (const [key, names] of COLS) {
    const i = hk.findIndex((h) => names.some((n) => h === fieldKey(n)));
    if (i >= 0) idx[key] = i;
  }
  if (idx.sga == null) warnings.push(`${filename}: 「一般管理費」の列がありません（グラフが出せません）`);

  const rows = [];
  for (let r = 1; r < table.length; r++) {
    const line = table[r];
    const ym = parseMonthLabel(line[iMonth]);
    if (!ym) { warnings.push(`${r + 1}行目: 月度「${line[iMonth]}」が読めないので飛ばしました`); continue; }

    // アプリ内の金額は円に揃えている。資料の単位（ふつう千円）を掛ける。
    const rec = { ym, kind: "actual", label: String(line[iMonth]).trim(), src: iSrc >= 0 ? line[iSrc] : null };
    let any = false;
    for (const [key] of COLS) {
      if (idx[key] == null) continue;
      const v = num(line[idx[key]]);
      rec[key] = v == null ? null : Math.round(v * unit);
      if (v != null) any = true;
    }
    if (!any) { warnings.push(`${r + 1}行目: 金額が1つも入っていないので飛ばしました`); continue; }

    // 内訳の合計が一般管理費と合うか確かめる（読み取り違いをここで捕まえる）。
    const parts = ["jinken", "hanbai", "tatemono", "koukyou", "shokeihi", "genka"];
    if (rec.sga != null && parts.every((k) => rec[k] != null)) {
      const sum = parts.reduce((a, k) => a + rec[k], 0);
      if (sum !== rec.sga) {
        warnings.push(`${rec.label}: 内訳の合計 ${Math.round(sum / unit).toLocaleString()} が一般管理費 ${Math.round(rec.sga / unit).toLocaleString()} と合いません（資料の単位）`);
      }
    }
    rows.push(rec);
  }
  return { rows, warnings };
}

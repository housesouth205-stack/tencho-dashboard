// どんな形式のファイルでも、いったん「シートごとの表（文字の2次元配列）」にそろえる。
//
// 資料は同じ中身でも、CSV（cp932/UTF-8）・タブ区切り・Excel（xlsx/xls）・PDF と
// 届く形がばらばら。読み方を資料の種類ごとに形式の数だけ書くと、どれか1つだけ直し忘れる。
// ここで表にそろえてしまえば、後ろの読み取り（台別・損益など）は形式を気にしなくてよい。
import { decodeText, parseCsv, sniffDelimiter } from "../util/csv.js";
import { getXLSX } from "../util/sheetjs.js";

export const FORMAT_LABEL = { csv: "CSV", excel: "Excel", pdf: "PDF", unknown: "不明な形式" };

const pad = (n) => String(n).padStart(2, "0");

// 拡張子だけでなく先頭のバイトも見る。名前を付け替えたファイルや、
// 拡張子の無い添付（メールから保存したもの）でも読めるようにするため。
export function sniffFormat(name, bytes) {
  const head = String.fromCharCode(...bytes.subarray(0, 8));
  if (head.startsWith("%PDF-")) return "pdf";
  if (head.startsWith("PK\x03\x04")) return "excel"; // xlsx/ods（中身はzip）
  if (bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0) return "excel"; // 旧xls
  if (/\.(xlsx|xlsm|xls|ods)$/i.test(name)) return "excel";
  if (/\.pdf$/i.test(name)) return "pdf";
  if (/\.(csv|tsv|txt)$/i.test(name) || !/\./.test(name)) return "csv";
  return "unknown";
}

// Excelのセルを文字にする。日付はK-TACsのCSVと同じ「YYYY/MM/DD」にそろえる
// （そろえないと、Excelに保存し直した台別データだけ期間が読めなくなる）。
function cellText(v) {
  if (v == null) return "";
  if (v instanceof Date) {
    if (isNaN(v)) return "";
    return `${v.getFullYear()}/${pad(v.getMonth() + 1)}/${pad(v.getDate())}`;
  }
  return String(v).trim();
}

async function readExcel(buffer) {
  const XLSX = await getXLSX();
  const wb = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheets = wb.SheetNames.map((name) => {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, blankrows: false, defval: "" });
    return { name, rows: aoa.map((r) => r.map(cellText)) };
  });
  return { sheets, workbook: wb };
}

function readText(buffer) {
  const text = decodeText(buffer).replace(/^﻿/, "");
  const rows = parseCsv(text, sniffDelimiter(text)).map((r) => r.map((c) => String(c).trim()));
  return { sheets: [{ name: "", rows }] };
}

// PDFは文字と座標しか無いので、近い高さの文字を1行、離れた文字を別のセルにして表に戻す。
async function readPdf(buffer) {
  const [{ extractPdfText, toRows }, { words }] = await Promise.all([import("./pdfText.js"), import("./plPdf.js")]);
  const { pages, warnings } = await extractPdfText(buffer);
  const sheets = pages.map((p, i) => ({
    name: `${i + 1}ページ`,
    rows: toRows(p.items).map((r) => words(r.cells).map((w) => w.str.trim())).filter((r) => r.some(Boolean)),
  }));
  return { sheets, warnings };
}

/**
 * @returns {Promise<{format: string, sheets: {name: string, rows: string[][]}[], warnings: string[], buffer: ArrayBuffer, workbook?: object}>}
 */
export async function readAnyFile(file) {
  const buffer = await file.arrayBuffer();
  const format = sniffFormat(file.name, new Uint8Array(buffer));
  let res = { sheets: [] };
  if (format === "excel") res = await readExcel(buffer);
  else if (format === "pdf") res = await readPdf(buffer);
  else if (format === "csv") res = readText(buffer);
  const sheets = (res.sheets || []).map((s) => ({ ...s, rows: s.rows.filter((r) => r.some((c) => c !== "")) }));
  return { format, sheets, warnings: res.warnings || [], buffer, workbook: res.workbook };
}

// 照合用に表記ゆれをつぶす。全角半角・空白・括弧などの記号を落とす。
// 「ＢＢ回数」「BB 回数」「BB回数(回)」を同じものとして扱いたいため。
export const normKey = (s) => String(s ?? "").normalize("NFKC").toUpperCase()
  .replace(/[\s　・･:：/／\\()（）［］\[\]「」【】<>＜＞"'`]/g, "");

// ヘッダー行を探す。必須の項目（どれか1つの呼び方に一致すればよい）が最も多くそろう行を選ぶ。
// fields: [{ key, names: [...], required? }]
export function findHeader(rows, fields, { scan = 30 } = {}) {
  let best = { index: -1, map: {}, hits: 0, requiredHits: 0 };
  for (let i = 0; i < Math.min(scan, rows.length); i++) {
    const map = matchColumns(rows[i], fields);
    const hits = Object.keys(map).length;
    const requiredHits = fields.filter((f) => f.required && map[f.key] != null).length;
    if (requiredHits > best.requiredHits || (requiredHits === best.requiredHits && hits > best.hits)) {
      best = { index: i, map, hits, requiredHits };
    }
  }
  return best;
}

// 見出しの並びから、項目ごとの列番号を決める。完全一致を優先し、無ければ前方一致。
// 前方一致まで広げるのは「台売上(円)」「投入枚数」のような単位・補足付きの見出しのため。
export function matchColumns(header, fields) {
  const keys = header.map(normKey);
  const used = new Set();
  const map = {};
  for (const pass of ["exact", "prefix"]) {
    for (const f of fields) {
      if (map[f.key] != null) continue;
      for (const n of f.names) {
        // 「=」付きは完全一致だけ。短い呼び方（IN・売上など）が別の列の頭に当たるのを防ぐ
        const exactOnly = n.startsWith("=");
        if (exactOnly && pass === "prefix") continue;
        const nk = normKey(exactOnly ? n.slice(1) : n);
        const i = keys.findIndex((k, j) => !used.has(j) && k && (pass === "exact" ? k === nk : k.startsWith(nk)));
        if (i >= 0) { map[f.key] = i; used.add(i); break; }
      }
    }
  }
  return map;
}

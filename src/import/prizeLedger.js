// 景品管理表（1日1シート、1か月で31シート）を読む。
//
// 各シートは「景品管理表」の表題・日付・記入者と、品目ごとの 前日残／入庫／拾い入庫／計／出庫／本日残／
// ＰＯＳ残／誤差 の表。品目は2種類ある:
//  - 金景品: コードの無い「大」「中」「小」の行
//  - タバコ: コードの付いた銘柄の行
// 列は見出しの言葉で探す（並びや列の数が変わっても読めるように）。
//
// まだ記入していない日のシートも、月初に31枚作ってあることが多い。本日残が1つも入っていない
// シートは「未入力」として飛ばす。出庫の欄が「計−本日残」の式になっていて、本日残が空だと
// 出庫が在庫そのものに見える（実物で合計2,719になっていた）ので、出庫の数字では判断しない。

const n = (s) => String(s ?? "").normalize("NFKC").replace(/\s+/g, "");
const num = (s) => {
  const t = n(s).replace(/,/g, "");
  if (t === "" || t === "-" || t === "—") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};

// 見出しの言葉（NFKCにして空白を落とした形）
const COLS = {
  code: ["コード", "ｺｰﾄﾞ", "CD"],
  name: ["品名", "銘柄", "品目"],
  prev: ["前日残"],
  in: ["入庫"],
  pick: ["拾い入庫", "拾入庫"],
  out: ["出庫"],
  zan: ["本日残", "当日残"],
  pos: ["POS残"],
  err: ["誤差"],
};
const GOLD = ["大", "中", "小"];

export const looksLikePrizeLedger = (sheets) =>
  sheets.some((s) => s.rows.slice(0, 6).flat().some((c) => n(c).includes("景品管理表")))
  && sheets.some((s) => s.rows.slice(0, 12).some((r) => r.map(n).includes("前日残") && r.map(n).includes("本日残")));

const DATE_RE = /^(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})日?$/;
const ymdOf = (c) => { const m = n(c).match(DATE_RE); return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null; };

function parseSheet(sheet) {
  const rows = sheet.rows;
  // 表題の近く（上5行）にある日付と記入者
  let ymd = null, writer = "";
  for (const r of rows.slice(0, 5)) {
    for (let i = 0; i < r.length; i++) {
      if (!ymd) ymd = ymdOf(r[i]);
      if (n(r[i]) === "記入者") writer = r.slice(i + 1).map((c) => String(c).trim()).find((c) => c && c !== "　") || "";
    }
  }
  const hIdx = rows.findIndex((r) => r.map(n).includes("前日残") && r.map(n).includes("本日残"));
  if (hIdx < 0) return null;
  const head = rows[hIdx].map(n);
  const col = {};
  for (const [k, names] of Object.entries(COLS)) {
    // 「入庫」は「拾い入庫」にも含まれるので、完全一致で探す
    const i = head.findIndex((h) => names.map(n).includes(h));
    if (i >= 0) col[k] = i;
  }
  if (col.name == null || col.out == null || col.zan == null) return null;

  const items = [];
  for (const r of rows.slice(hIdx + 1)) {
    const name = String(r[col.name] ?? "").trim();
    const code = col.code == null ? null : num(r[col.code]);
    const key = code != null ? String(code) : GOLD.includes(n(name)) ? n(name) : null;
    if (!key) continue; // 空の行・記入者の一覧など
    const v = (k) => (col[k] == null ? null : num(r[col[k]]));
    items.push({
      key, kind: code != null ? "tobacco" : "gold", name: name.replace(/　/g, " "),
      prev: v("prev"), in: v("in"), pick: v("pick"), out: v("out"), zan: v("zan"), pos: v("pos"), err: v("err"),
    });
  }
  const entered = items.some((it) => it.zan != null);
  return { ymd, writer, items, entered };
}

/**
 * @returns {{days: {ymd, writer, items}[], skipped: string[], warnings: string[]}}
 */
export function parsePrizeLedger(sheets) {
  const days = [], skipped = [], warnings = [];
  for (const s of sheets) {
    const d = parseSheet(s);
    if (!d) continue;
    if (!d.ymd) { warnings.push(`「${s.name}」シートに日付が見つかりません（飛ばしました）`); continue; }
    if (!d.entered) { skipped.push(d.ymd); continue; }
    days.push({ ymd: d.ymd, writer: d.writer, items: d.items });
  }
  const seen = new Set();
  for (const d of days) { if (seen.has(d.ymd)) warnings.push(`${d.ymd} のシートが2枚あります（後のほうを使います）`); seen.add(d.ymd); }
  days.sort((a, b) => (a.ymd < b.ymd ? -1 : 1));
  return { days, skipped: skipped.sort(), warnings };
}

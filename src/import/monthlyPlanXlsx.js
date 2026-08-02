// 自店「月計画表」xlsx パーサ。各月シート下部のレート別・日別テーブルを読む。
// 列: A=日付 / B=台数 / H=実績アウト / I=売上 / J=粗利。レート見出し行で区分切替。
import { getXLSX } from "../util/sheetjs.js";
import { calendarYear, ymd } from "../util/dates.js";

const numOrNull = (v) => {
  if (v == null || v === "") return null;
  const n = typeof v === "string" ? Number(v.replace(/[,\s]/g, "")) : Number(v);
  return isFinite(n) ? n : null;
};
const zen2han = (s) => String(s).replace(/[０-９．]/g, (c) => "0123456789.".charAt("０１２３４５６７８９．".indexOf(c)));

function extractMonth(sheetName) {
  const m = zen2han(sheetName).match(/(\d{1,2})\s*月/) || zen2han(sheetName).match(/(?:^|\D)(\d{1,2})(?:\D|$)/);
  const v = m ? Number(m[1]) : NaN;
  return v >= 1 && v <= 12 ? v : null;
}

function matchSection(text, sections) {
  if (typeof text !== "string") return null;
  const t = zen2han(text).replace(/\s/g, "");
  if (!/スロ|ｽﾛ|パチ|円|P\d/i.test(t)) return null;
  const num = t.match(/(\d+(?:\.\d+)?)/);
  if (num) {
    const v = Number(num[1]);
    const near = sections.find((s) => Math.abs(Number(s.rate) - v) < 0.6);
    if (near) return near;
  }
  return sections.find((s) => t.includes(zen2han(s.label).replace(/\s/g, ""))) || null;
}

function parseDate(a, fy, month) {
  if (a instanceof Date && a.getFullYear() > 2000) return { cy: a.getFullYear(), mm: a.getMonth() + 1, dd: a.getDate() };
  const n = numOrNull(a);
  if (n != null && Number.isInteger(n) && n >= 1 && n <= 31 && month) return { cy: calendarYear(fy, month), mm: month, dd: n };
  return null;
}

export async function parseMonthlyPlan(arrayBuffer, { fy, sections }) {
  const XLSX = await getXLSX();
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: true });
  const rows = [];
  const warnings = [];
  for (const sheetName of wb.SheetNames) {
    const month = extractMonth(sheetName);
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, blankrows: false });
    let cur = null, matchedAny = false;
    for (const r of aoa) {
      let heading = null;
      for (const cell of r) { heading = matchSection(cell, sections); if (heading) break; }
      if (heading) { cur = heading; matchedAny = true; continue; }
      if (!cur) continue;
      const dt = parseDate(r[0], fy, month);
      if (!dt) continue;
      if (month && dt.mm !== month) continue; // 他月シートへのはみ出し行を除外
      // 日別テーブル: B=台数 / 計画 C=アウト,F=玉単,G=粗利率 / 実績 H=アウト,I=売上,J=粗利
      const count = numOrNull(r[1]);
      const planOut = numOrNull(r[2]), planPrice = numOrNull(r[5]), planRate = numOrNull(r[6]);
      const actOut = numOrNull(r[7]), actSales = numOrNull(r[8]), actGross = numOrNull(r[9]);
      const hasPlan = planOut != null || planPrice != null || planRate != null;
      const hasActual = actOut != null || actSales != null || actGross != null;
      if (count == null && !hasPlan && !hasActual) continue;
      rows.push({
        ymd: ymd(dt.cy, dt.mm, dt.dd), sectionKey: cur.key, sectionLabel: cur.label, sectionId: cur.id, sheet: sheetName,
        count, planOut, planPrice, planRate, actOut, actSales, actGross, hasPlan, hasActual,
      });
    }
    if (month && !matchedAny) warnings.push(`「${sheetName}」でレート見出しを検出できませんでした`);
  }
  if (rows.length === 0) warnings.push("取込対象の行が見つかりませんでした（列位置A=日付/B=台数/H=アウト/I=売上/J=粗利をご確認ください）");
  return { rows, warnings };
}

// K-TACs「遊技台個別」CSV(cp932)パーサ。列名でマッピング（ファイル毎に列構成が違う）。
import { decodeCsv, findCol } from "../util/csv.js";

const num = (v) => {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/[,\s]/g, ""));
  return isFinite(n) ? n : null;
};

export function parseKtacsKoben(arrayBuffer, filename = "") {
  const rows = decodeCsv(arrayBuffer);
  const warnings = [];

  // 期間（先頭付近の2つの日付セル）
  let period = { start: null, end: null };
  for (let i = 0; i < Math.min(4, rows.length); i++) {
    const ds = (rows[i] || []).filter((c) => /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(String(c).trim()));
    if (ds.length >= 2) { period = { start: ds[0], end: ds[1] }; break; }
  }

  // レート（20円/5円/2円）
  let denom = null;
  for (let i = 0; i < Math.min(7, rows.length); i++) {
    for (const c of rows[i] || []) { const m = String(c).match(/(\d+)\s*円/); if (m) { denom = Number(m[1]); break; } }
    if (denom) break;
  }

  // ヘッダ行（「台番号」を含む行）
  const headerIdx = rows.findIndex((r) => r && r.some((c) => String(c).trim() === "台番号"));
  if (headerIdx < 0) { warnings.push(`${filename}: ヘッダ(台番号)が見つかりません`); return { denom, period, rows: [], warnings }; }
  const H = rows[headerIdx];
  const col = {
    dai: findCol(H, ["台番号"]), model: findCol(H, ["機種名"]),
    out: findCol(H, ["投入"]), sa: findCol(H, ["差引"]), payout: findCol(H, ["出率"]), big: findCol(H, ["ＢＢ回数", "ＢＢ回数 "]),
    // 項目パターンによって列名が違う。「合計売上/日」「台粗利」は1台1日あたりで、
    // 台売上・機械粗利と同じ意味。コイン単価×投入で出すより誤差が出ない
    // （ｺｲﾝ利益は小数2桁しかなく、粗利が数%ずれる）。「粗利合計」は期間合計なので使わない。
    sales: findCol(H, ["台売上", "合計売上/日", "合計売上"]), gross: findCol(H, ["機械粗利", "台粗利"]),
    coinPrice: findCol(H, ["ｺｲﾝ単"]), coinProfit: findCol(H, ["ｺｲﾝ利益"]),
  };
  if (col.out < 0) { warnings.push(`${filename}: 「投入」列がありません`); return { denom, period, rows: [], warnings }; }

  const out = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const daiRaw = r?.[col.dai];
    if (!/^\d+$/.test(String(daiRaw).trim())) continue; // 集計/総平均/累計 等で終端
    // 停止台・撤去台(投入0)も全台保持（総台数=物理台数に一致させる）
    const outVal = num(r[col.out]);
    const sales = col.sales >= 0 && r[col.sales] !== "" ? num(r[col.sales])
      : col.coinPrice >= 0 ? Math.round((num(r[col.coinPrice]) || 0) * (outVal || 0)) : null;
    const gross = col.gross >= 0 && r[col.gross] !== "" ? num(r[col.gross])
      : col.coinProfit >= 0 ? Math.round((num(r[col.coinProfit]) || 0) * (outVal || 0)) : null;
    out.push({
      dai_no: Number(daiRaw), model: String(r[col.model] ?? "").trim(),
      out: outVal, sa: num(r[col.sa]), payout: num(r[col.payout]), big: num(r[col.big]),
      sales, gross,
    });
  }
  return { denom, sectionKey: denom ? "S" + denom : null, period, rows: out, warnings };
}

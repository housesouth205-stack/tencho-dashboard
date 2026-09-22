// K-TACs「遊技台個別」CSV(cp932)パーサ。列名でマッピング（ファイル毎に列構成が違う）。
import { decodeCsv, findCol } from "../util/csv.js";
import { compressToRanges, formatRanges } from "../util/daiRange.js";

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
    // 「撤去台」は投入0で今も居る停止台の意味ではなく、期間中に入替でその番台から
    // 抜けた機種があったという印。ホールコンの出力設定「撤去台表示」を「する」に
    // すると、入替のあった番台だけ「現在の機種」と「抜けた機種」の2行が出る
    // （実物のCSVで確認：撤去台列が空/◯の2行、機種名以外はほぼ全部違う値）。
    removed: findCol(H, ["撤去台"]),
    out: findCol(H, ["投入"]), sa: findCol(H, ["差引"]), payout: findCol(H, ["出率"]), big: findCol(H, ["ＢＢ回数", "ＢＢ回数 "]),
    // 項目パターンによって列名が違う。「合計売上/日」「台粗利」は1台1日あたりで、
    // 台売上・機械粗利と同じ意味。コイン単価×投入で出すより誤差が出ない
    // （ｺｲﾝ利益は小数2桁しかなく、粗利が数%ずれる）。「粗利合計」は期間合計なので使わない。
    sales: findCol(H, ["台売上", "合計売上/日", "合計売上"]), gross: findCol(H, ["機械粗利", "台粗利"]),
    coinPrice: findCol(H, ["ｺｲﾝ単"]), coinProfit: findCol(H, ["ｺｲﾝ利益"]),
  };
  if (col.out < 0) { warnings.push(`${filename}: 「投入」列がありません`); return { denom, period, rows: [], warnings }; }

  // 台番ごとに1行に絞る。「撤去台」の入替で同じ台番が2行(現在の機種／抜けた機種)に
  // なっていても、書き込み先(machine_snapshot)は period_id+dai_no で1行しか持てない。
  // 2行のまま流すと、片方が同じ取込バッチに乗った瞬間に
  // 「ON CONFLICT DO UPDATE command cannot affect row a second time」でDBが弾く
  // （PostgreSQLの仕様：1回のupsertで同じ競合キーを2度更新できない）。
  // エラーは技術的すぎて店長には伝わらず、しかも弾かれたバッチぶんが丸ごと
  // 入らずに「取り込めない」と見える。ここで先に1台番=1行に絞っておく。
  const out = [];
  const idxOf = new Map(); // dai_no → out配列でのindex
  const removedAt = new Map(); // dai_no → その行が「撤去台」だったか
  const swapped = []; // 入替があった台番（数値のまま持ち、最後に範囲表記にする）
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const daiRaw = r?.[col.dai];
    if (!/^\d+$/.test(String(daiRaw).trim())) continue; // 集計/総平均/累計 等で終端
    const daiNo = Number(daiRaw);
    const isRemoved = col.removed >= 0 && String(r[col.removed] ?? "").trim() !== "";
    // 停止台・撤去台(投入0)も全台保持（総台数=物理台数に一致させる）
    const outVal = num(r[col.out]);
    const sales = col.sales >= 0 && r[col.sales] !== "" ? num(r[col.sales])
      : col.coinPrice >= 0 ? Math.round((num(r[col.coinPrice]) || 0) * (outVal || 0)) : null;
    const gross = col.gross >= 0 && r[col.gross] !== "" ? num(r[col.gross])
      : col.coinProfit >= 0 ? Math.round((num(r[col.coinProfit]) || 0) * (outVal || 0)) : null;
    const entry = {
      dai_no: daiNo, model: String(r[col.model] ?? "").trim(),
      out: outVal, sa: num(r[col.sa]), payout: num(r[col.payout]), big: num(r[col.big]),
      sales, gross,
    };

    if (!idxOf.has(daiNo)) {
      idxOf.set(daiNo, out.length);
      removedAt.set(daiNo, isRemoved);
      out.push(entry);
      continue;
    }
    // 2回目以降＝この番台で入替があった行。「撤去台」でない方（今その番台にある機種）を残す。
    // どちらも同じ印（両方◯・両方空）のときは元の並び順どおり後の行を残す。
    const pi = idxOf.get(daiNo);
    const prevRemoved = removedAt.get(daiNo);
    const keepNew = prevRemoved === isRemoved ? true : !isRemoved;
    const kept = keepNew ? entry : out[pi];
    out[pi] = kept;
    removedAt.set(daiNo, false);
    swapped.push(daiNo);
  }
  if (swapped.length) {
    // 何番の入替か（範囲表記）だけ出す。機種名まで並べると入替が多い日に
    // 警告欄が縦に伸びて読みにくくなる（コーナー入替は一度に十数台起きる）。
    // どちらの機種を使ったかは機種分析・島図タブで見れば分かる。
    warnings.push(`期間中に入替があった台が${swapped.length}台あります（${formatRanges(compressToRanges(swapped))}）。現在設置されている機種のぶんを使いました`);
  }
  return { denom, sectionKey: denom ? "S" + denom : null, period, rows: out, warnings };
}

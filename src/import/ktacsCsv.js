// K-TACs「遊技台個別」CSV(cp932)パーサ。列名でマッピング（ファイル毎に列構成が違う）。
import { decodeCsv } from "../util/csv.js";
import { findHeader } from "./anyTable.js";
import { compressToRanges, formatRanges } from "../util/daiRange.js";

// 数字のセル。Excelで作り直した表は「97.5%」「¥12,000」「△300」のように飾りが付くことがある
const num = (v) => {
  const t = String(v ?? "").normalize("NFKC").replace(/[,\s¥円%枚]/g, "");
  if (t === "") return null;
  const neg = /^[△▲]/.test(t);
  const n = Number(t.replace(/^[△▲]/, ""));
  return isFinite(n) ? (neg ? -n : n) : null;
};

// 台別データの項目と、その呼び方。K-TACsの見出しが基本で、ほかのホールコンや
// Excelで作り直した表の言い方も足してある（例：投入→アウト・IN、差引→差枚）。
// 列は名前で探すので、並びが違っても列が増えていても読める。
// 見つからないときは取込画面で列を選んでもらう（features/import/columnMap.js）。
// 先頭が「=」の呼び方は完全一致のときだけ使う（「粗利」が「粗利合計」に当たらないように）。
export const KTACS_FIELDS = [
  { key: "dai", label: "台番号", required: true, names: ["台番号", "台番", "台No", "台ナンバー", "=No"] },
  { key: "model", label: "機種名", names: ["機種名", "機種", "機種名称"] },
  { key: "out", label: "投入（アウト）", required: true, names: ["投入", "アウト", "=OUT", "=IN", "総投入", "累計投入"] },
  { key: "sa", label: "差引（差枚）", names: ["差引", "差枚", "差玉", "差枚数", "出玉差"] },
  { key: "payout", label: "出率", names: ["出率", "出玉率", "機械割", "払出率"] },
  { key: "big", label: "BB回数", names: ["ＢＢ回数", "BB回数", "BIG回数", "=BB", "=BIG", "大当り回数", "大当たり回数"] },
  // 項目パターンによって列名が違う。「合計売上/日」「台粗利」は1台1日あたりで、
  // 台売上・機械粗利と同じ意味。コイン単価×投入で出すより誤差が出ない
  // （ｺｲﾝ利益は小数2桁しかなく、粗利が数%ずれる）。「粗利合計」は期間合計なので使わない。
  { key: "sales", label: "台売上", names: ["台売上", "合計売上/日", "合計売上", "=売上"] },
  { key: "gross", label: "台粗利", names: ["機械粗利", "台粗利", "=粗利"] },
  { key: "coinPrice", label: "コイン単価", names: ["ｺｲﾝ単", "コイン単価", "ｺｲﾝ単価"] },
  { key: "coinProfit", label: "コイン利益", names: ["ｺｲﾝ利益", "コイン利益"] },
  // 「撤去台」は投入0で今も居る停止台の意味ではなく、期間中に入替でその番台から
  // 抜けた機種があったという印。ホールコンの出力設定「撤去台表示」を「する」に
  // すると、入替のあった番台だけ「現在の機種」と「抜けた機種」の2行が出る
  // （実物のCSVで確認：撤去台列が空/◯の2行、機種名以外はほぼ全部違う値）。
  { key: "removed", label: "撤去台", names: ["撤去台"] },
];

// 期間の日付。K-TACsは「2026/09/01」。Excelで保存し直すと「2026-09-01」や
// 「2026年9月1日」になることがあるので、どれも「YYYY/MM/DD」にそろえて返す。
const DATE_RE = /^(\d{4})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})\s*日?$/;
const asDate = (c) => {
  const m = String(c ?? "").normalize("NFKC").trim().match(DATE_RE);
  // 0詰めにする。期間は保存後に文字列のまま大小比較されるので、「2026/9/1」だと10月より後に並ぶ
  return m ? `${m[1]}/${m[2].padStart(2, "0")}/${m[3].padStart(2, "0")}` : null;
};

export function parseKtacsKoben(arrayBuffer, filename = "") {
  return parseKtacsRows(decodeCsv(arrayBuffer), filename);
}

/**
 * 表（文字の2次元配列）から台別データを読む。CSVでもExcelでも、ここは同じ。
 * @param colMap 画面で列を選んでもらったとき { headerRow, map: {key: 列番号} }
 */
export function parseKtacsRows(rows, filename = "", { colMap } = {}) {
  const warnings = [];

  // 期間（先頭付近の2つの日付セル）。1行に並ばず縦に分かれている表もあるので、先頭10行まとめて見る
  let period = { start: null, end: null };
  const dates = [];
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    for (const c of rows[i] || []) { const d = asDate(c); if (d) dates.push(d); }
    if (dates.length >= 2) break;
  }
  if (dates.length >= 2) period = { start: dates[0], end: dates[1] };
  else if (dates.length === 1) period = { start: dates[0], end: dates[0] };

  // レート（20円/5円/2円）
  let denom = null;
  for (let i = 0; i < Math.min(7, rows.length); i++) {
    for (const c of rows[i] || []) { const m = String(c).match(/(\d+)\s*円/); if (m) { denom = Number(m[1]); break; } }
    if (denom) break;
  }

  // ヘッダ行（台番号と投入の両方がそろう行）
  const head = colMap ? { index: colMap.headerRow, map: colMap.map } : findHeader(rows, KTACS_FIELDS);
  const col = Object.fromEntries(KTACS_FIELDS.map((f) => [f.key, head.map[f.key] ?? -1]));
  const headerIdx = head.index;
  const missing = KTACS_FIELDS.filter((f) => f.required && col[f.key] < 0).map((f) => f.label);
  if (headerIdx < 0 || missing.length) {
    warnings.push(`${filename}: ${missing.length ? `「${missing.join("」「")}」の列` : "見出しの行"}が見つかりません`);
    return { denom, period, rows: [], warnings, needsMap: true };
  }

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
    // 集計/総平均/累計 等は飛ばす。Excel由来だと「12.0」のように小数で来ることがある
    const daiTxt = String(daiRaw ?? "").normalize("NFKC").trim().replace(/\.0+$/, "");
    if (!/^\d+$/.test(daiTxt)) continue;
    const daiNo = Number(daiTxt);
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
    // 残したほうの印を覚えておく（3行目が来たときに正しく比べるため）
    removedAt.set(daiNo, keepNew ? isRemoved : prevRemoved);
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

// 読み込んだ表が「何の資料か」を中身から当てる。
//
// 拡張子やファイル名で決めると、同じExcelでも島図・月計画表・会議サマリーと中身が
// まったく違うので当たらない。見出しの言葉で点数を付け、いちばん高いものを候補にする。
// 決め打ちはしない。点数の近いものが並んだときや、どれにも当たらないときは画面で選んでもらう。
import { findHeader, normKey } from "./anyTable.js";
import { KTACS_FIELDS } from "./ktacsCsv.js";
import { COLS as PL_COLS, parseMonthLabel } from "./plCsv.js";

// 資料の種類。formats は読める形式（ここに無い形式で選ばれたら理由を出して止める）
export const KINDS = {
  ktacs: { label: "台別データ（遊技台個別）", formats: ["csv", "excel"], hint: "台番ごとのアウト・差枚・売上・粗利。機種分析・島図・出玉率に使います" },
  plan: { label: "月計画表", formats: ["excel"], hint: "日別の計画と実績（レート別）。予実タブに使います" },
  island: { label: "島図（配置図）", formats: ["excel"], hint: "島図＋設定表シート。配置が変わったときに入れます" },
  meeting: { label: "月次会議サマリー", formats: ["excel"], hint: "会議で配るサマリー表。経費タブに出ます" },
  pl: { label: "月次の損益・経費", formats: ["csv", "excel", "pdf"], hint: "会議資料（店舗別営業実績表）など。経費タブの推移に使います" },
};

const allText = (sheets, maxRows = 60) => sheets.flatMap((s) => s.rows.slice(0, maxRows).flat()).map((c) => String(c).normalize("NFKC"));

/**
 * @returns {{kind: string, score: number, reason: string}[]} 点数の高い順。0点のものは入れない
 */
export function detectKinds({ format, sheets }) {
  const out = [];
  const names = sheets.map((s) => s.name.normalize("NFKC"));
  const text = allText(sheets);
  const has = (re) => text.some((c) => re.test(c));

  // 島図: シート名「島図」「設定表」、またはフロアの見出し
  if (format === "excel") {
    let sc = 0; const why = [];
    if (names.includes("島図")) { sc += 5; why.push("「島図」シート"); }
    if (names.includes("設定表")) { sc += 3; why.push("「設定表」シート"); }
    if (has(/(1F|BF).?フロア/)) { sc += 3; why.push("フロアの見出し"); }
    if (sc) out.push({ kind: "island", score: sc, reason: why.join("・") });
  }

  // 会議サマリー: 表題の言葉
  if (format === "excel" && has(/月次会議サマリー/)) {
    // 中に損益の費目も月も入っているので、損益の点数より必ず上にする
    out.push({ kind: "meeting", score: 20 + (names.includes("サマリー") ? 2 : 0), reason: "表題「月次会議サマリー」" });
  }

  // 月計画表: 「◯月」のシートが並び、レートの見出し（20スロ等）がある
  if (format === "excel") {
    const monthSheets = names.filter((n) => /^\s*\d{1,2}\s*月/.test(n)).length;
    const rate = has(/\d+(\.\d+)?\s*(スロ|ｽﾛ|円スロ|パチ)/);
    if (monthSheets >= 2 && rate) out.push({ kind: "plan", score: 4 + Math.min(monthSheets, 6), reason: `月ごとのシート ${monthSheets}枚・レートの見出し` });
    else if (monthSheets && rate && has(/計画/)) out.push({ kind: "plan", score: 4, reason: "月のシート・レートの見出し・「計画」" });
  }

  // 台別データ: 台番号と投入（アウト）の列がそろう
  for (const s of sheets) {
    const h = findHeader(s.rows, KTACS_FIELDS);
    if (h.requiredHits === 2) {
      const dataRows = s.rows.slice(h.index + 1).filter((r) => /^\d+(\.0+)?$/.test(String(r[h.map.dai] ?? "").trim())).length;
      out.push({ kind: "ktacs", score: 4 + Math.min(h.hits, 6) + (dataRows >= 10 ? 2 : 0), reason: `「台番号」「投入」など ${h.hits}列・台 ${dataRows}行`, sheet: s.name });
      break;
    }
    if (h.requiredHits === 1 && h.hits >= 3) {
      out.push({ kind: "ktacs", score: 2, reason: `台別らしい列が ${h.hits}列（足りない列は選び直せます）`, sheet: s.name });
      break;
    }
  }

  // 月次の損益: 費目の名前と月の表記が両方ある
  const plNames = new Set(PL_COLS.flatMap(([, ns]) => ns.map(normKey)));
  const plHits = new Set(text.map(normKey).filter((k) => plNames.has(k) || plNames.has(k.replace(/合計$/, ""))));
  const months = text.filter((c) => parseMonthLabel(c)).length;
  if (plHits.size >= 2 && months) {
    out.push({ kind: "pl", score: 3 + Math.min(plHits.size, 8), reason: `費目 ${plHits.size}種類・月の表記` });
  }

  return out.sort((a, b) => b.score - a.score);
}

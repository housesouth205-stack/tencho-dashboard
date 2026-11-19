// 景品管理表の保存と読み出し。
//
// 新しいテーブルを作らず app_setting に月ごとの塊で置く（prize_YYYY-MM）。テーブルを足すと
// 本番のSupabaseでSQLを流すまで保存できず、開発環境からは本番に繋がらないので確かめようがない。
// 1か月ぶんでも品目40×31日ほどで小さい。どの月があるかは prize_months に並べておく
// （app_setting はキーの前方一致で探せないため）。
import { repo } from "../../core/repo.js";
import { state } from "../../core/state.js";
import { el } from "../../util/dom.js";
import { toast, setSaveState } from "../../core/errors.js";
import { readAnyFile } from "../../import/anyTable.js";
import { parsePrizeLedger } from "../../import/prizeLedger.js";

const get = async (key) => (await repo.select("app_setting", { eq: { store_id: state.storeId, key } }))[0]?.value;
const put = (key, value) => repo.upsert("app_setting", { store_id: state.storeId, key, value }, { onConflict: ["store_id", "key"] });

export const loadMonths = async () => ((await get("prize_months")) || []).slice().sort();
export const loadMonth = async (ym) => (await get(`prize_${ym}`)) || { days: {} };

const md = (ymd) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;

/**
 * 取り込む。同じ日がすでにあれば、その日だけ書き換える（月の途中で何度入れても重ならない）。
 * 未入力の日は書かない（前に入れた日を空で消さないため）。
 */
export async function importPrizeFile(file, msgHost, onDone) {
  const { sheets } = await readAnyFile(file);
  const { days, skipped, warnings } = parsePrizeLedger(sheets);
  const note = (text, bad) => msgHost?.appendChild(el("div", { class: "hint", style: bad ? "color:var(--bad-fg)" : "", "data-keep-open": bad ? "1" : null, text: (bad ? "⚠ " : "") + text }));
  for (const w of warnings) note(`${file.name}: ${w}`, true);
  if (!days.length) {
    note(`${file.name}: 記入済みの日が見つかりませんでした（本日残の入ったシートがありません）`, true);
    return;
  }
  setSaveState("saving");
  const byMonth = new Map();
  for (const d of days) { const ym = d.ymd.slice(0, 7); if (!byMonth.has(ym)) byMonth.set(ym, []); byMonth.get(ym).push(d); }
  const months = new Set(await loadMonths());
  for (const [ym, list] of byMonth) {
    const cur = await loadMonth(ym);
    for (const d of list) cur.days[d.ymd] = { writer: d.writer, items: d.items };
    cur.file = file.name; cur.importedAt = new Date().toISOString();
    await put(`prize_${ym}`, cur);
    months.add(ym);
  }
  await put("prize_months", [...months].sort());
  setSaveState("saved");
  const first = days[0].ymd, last = days[days.length - 1].ymd;
  const msg = `景品管理表 ${days.length}日分（${md(first)}〜${md(last)}）を取り込みました` + (skipped.length ? `。未記入の${skipped.length}日は飛ばしました` : "");
  note(`${file.name}: ${msg}`);
  toast(msg, "ok");
  onDone?.();
}

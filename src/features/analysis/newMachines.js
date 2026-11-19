// 当店の新台（いつからその台番にその機種が入っているか）。
//
// 導入日はどの資料にも書かれていないので、島図の入替履歴から割り出す。島図は入替のたびに
// 取り込み、そのとき「取り込む前の島図」を適用開始日つきで控えている（app_setting.island_backups、
// 最大5件）。今の島図と控えを新しい順にたどり、台番の機種が同じあいだは導入日を前へずらす。
// 控えが尽きるまで同じ機種なら、いつからかは分からない（＝少なくとも控えより前からある台）。
import { repo } from "../../core/repo.js";
import { state } from "../../core/state.js";

export const NEW_DAYS = 30; // 「直近1カ月の新台」の範囲（導入日を1日目として30日目まで）

/**
 * @param current {effectiveFrom, models: {台番: 機種名}} 今の島図
 * @param backups [{effectiveFrom, models}] 取り込む前の島図（順不同）
 * @returns Map<台番(number), 導入日 "YYYY-MM-DD">  導入日が分かった台だけ
 */
export function introDates(current, backups) {
  const out = new Map();
  if (!current?.effectiveFrom || !current.models) return out;
  // 適用日の新しい順。日付の無い控えは並べようがないので使わない
  const older = backups.filter((b) => b?.effectiveFrom && b.models && b.effectiveFrom <= current.effectiveFrom)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  for (const [dai, model] of Object.entries(current.models)) {
    if (!model) continue;
    let since = current.effectiveFrom, known = false;
    for (const b of older) {
      if (b.models[dai] === model) { since = b.effectiveFrom; continue; }
      // 同じ適用日で取り直した島図は、入替ではなく取込の直し。違っていても導入とは見ない
      if (b.effectiveFrom === since) continue;
      known = true; // この控えでは別の機種（または台が無かった）＝ since から入った
      break;
    }
    if (known) out.set(Number(dai), since);
  }
  return out;
}

export async function loadIntroDates() {
  const get = async (key) => (await repo.select("app_setting", { eq: { store_id: state.storeId, key } }))[0]?.value;
  const [models, meta, backups] = await Promise.all([get("island_models"), get("island_meta"), get("island_backups")]);
  return introDates({ effectiveFrom: meta?.effectiveFrom, models: models || {} }, backups || []);
}

// 導入日を1日目として、今日が何日目か
export function dayCount(introYmd, today = new Date()) {
  const [y, m, d] = introYmd.split("-").map(Number);
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((t - new Date(y, m - 1, d)) / 86400000) + 1;
}

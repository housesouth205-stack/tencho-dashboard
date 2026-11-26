// 月計画表の行（parseMonthlyPlan の結果）を、保存する3つの表の行に分ける。
// 画面の取込（yojitsu/importPlan.js）と、PCで毎朝動く自動取込（tools/plan-auto/run.mjs）の両方がこれを通す。
// 分け方を2か所に書くと、片方だけ直したときに画面と自動取込で入る数字が食い違うため。
export const PLAN_CONFLICT = ["store_id", "ymd", "section_id"];

export function planRecords(rows, storeId) {
  // 念のため (ymd, section) で重複排除（後勝ち）＝ upsertのバッチ内二重更新を防ぐ
  const uniq = new Map();
  for (const r of rows) uniq.set(r.ymd + "|" + r.sectionId, r);
  const machines = [], plans = [], actuals = [];
  for (const r of uniq.values()) {
    const base = { store_id: storeId, ymd: r.ymd, section_id: r.sectionId };
    if (r.count != null) machines.push({ ...base, count: r.count });
    if (r.hasPlan) plans.push({ ...base, out_per_unit: r.planOut, unit_price: r.planPrice, gross_rate: r.planRate });
    if (r.hasActual) actuals.push({ ...base, sales: r.actSales, gross: r.actGross, out_per_unit: r.actOut, source: "excel" });
  }
  return { machines, plans, actuals };
}

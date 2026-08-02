import { repo } from "../../core/repo.js";
import { state } from "../../core/state.js";
import { calendarYear } from "../../util/dates.js";

const bucket = (rows, prefix) =>
  new Map(rows.filter((r) => String(r.ymd).startsWith(prefix)).map((r) => [`${r.ymd}|${r.section_id}`, r]));

// 指定fy/monthの machines_day/plan_day/actual_day を (ymd|section_id) マップで返す。
export async function loadMonthMaps(fy, month) {
  const cy = calendarYear(fy, month);
  const prefix = `${cy}-${String(month).padStart(2, "0")}`;
  const load = async (table) => bucket(await repo.select(table, { eq: { store_id: state.storeId } }), prefix);
  return { cy, machines: await load("machines_day"), plan: await load("plan_day"), actual: await load("actual_day") };
}

// 年度分を1回ずつ取得し、monthMaps(month)->maps を返すファクトリ（年度サマリー用）。
export async function loadFiscalMonthMaps(fy) {
  const [machines, plan, actual] = await Promise.all([
    repo.select("machines_day", { eq: { store_id: state.storeId } }),
    repo.select("plan_day", { eq: { store_id: state.storeId } }),
    repo.select("actual_day", { eq: { store_id: state.storeId } }),
  ]);
  return (month) => {
    const cy = calendarYear(fy, month);
    const prefix = `${cy}-${String(month).padStart(2, "0")}`;
    return { cy, machines: bucket(machines, prefix), plan: bucket(plan, prefix), actual: bucket(actual, prefix) };
  };
}

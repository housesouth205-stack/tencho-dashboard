import { STORE_ID } from "./config.js";
import { todayFiscalYear } from "../util/dates.js";
import { repo } from "./repo.js";

// 画面横断の状態。区分(section_def)はここにキャッシュする。
export const state = {
  storeId: STORE_ID,
  fy: todayFiscalYear(),
  sections: [],
};

const DEFAULT_SECTIONS = [
  { key: "S20", label: "20スロ", ptype: "S", rate: 21.75, sort_order: 1 },
  { key: "S5", label: "5スロ", ptype: "S", rate: 5.56, sort_order: 2 },
  { key: "S2", label: "2スロ", ptype: "S", rate: 2.22, sort_order: 3 },
];

export async function loadSections() {
  let rows = await repo.select("section_def", { eq: { store_id: state.storeId }, order: "sort_order" });
  if (rows.length === 0) {
    const seed = DEFAULT_SECTIONS.map((s) => ({ ...s, store_id: state.storeId, is_active: true }));
    rows = await repo.upsert("section_def", seed, { onConflict: ["store_id", "key"] });
    rows = await repo.select("section_def", { eq: { store_id: state.storeId }, order: "sort_order" });
  }
  state.sections = rows.filter((r) => r.is_active !== false);
  return state.sections;
}

const listeners = new Set();
export const onStateChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));
export const emitStateChange = () => listeners.forEach((fn) => fn(state));

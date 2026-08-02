import { repo } from "../core/repo.js";
import { state } from "../core/state.js";

// 最新（is_current）スナップショット期間。無ければ最新作成分。
export async function loadCurrentPeriod() {
  const periods = await repo.select("snapshot_period", { eq: { store_id: state.storeId } });
  if (!periods.length) return null;
  return periods.find((p) => p.is_current) || periods.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
}

export async function loadSnapshotRows(periodId) {
  return repo.select("machine_snapshot", { eq: { period_id: periodId } });
}

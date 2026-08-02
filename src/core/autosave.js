import { repo } from "./repo.js";
import { setSaveState, errorToast } from "./errors.js";

// (table,onConflict)ごとにdebounceして行をまとめてupsert。キーは行のonConflict値。
const queues = new Map();

export function queueUpsert(table, row, onConflict) {
  const qk = table + "|" + onConflict.join(",");
  let q = queues.get(qk);
  if (!q) { q = { table, onConflict, rows: new Map(), timer: null }; queues.set(qk, q); }
  q.rows.set(onConflict.map((k) => row[k]).join("|"), row);
  setSaveState("saving");
  clearTimeout(q.timer);
  q.timer = setTimeout(() => flush(qk), 700);
}

async function flush(qk) {
  const q = queues.get(qk);
  if (!q || q.rows.size === 0) return;
  const rows = [...q.rows.values()];
  q.rows.clear();
  try {
    await repo.upsert(q.table, rows, { onConflict: q.onConflict });
    setSaveState("saved");
  } catch (e) { errorToast(e); }
}

export async function flushAll() {
  for (const qk of queues.keys()) { clearTimeout(queues.get(qk).timer); await flush(qk); }
}

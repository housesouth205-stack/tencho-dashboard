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
  } catch (e) {
    // 失敗した行は待ち行列に戻す。捨てると、画面には入力した数字が出ているのに保存されておらず、
    // 開き直したときに消える（電波の切れ目で起きる）。その間に同じ行を打ち直していれば新しいほうを残す。
    const keyOf = (r) => q.onConflict.map((k) => r[k]).join("|");
    for (const r of rows) if (!q.rows.has(keyOf(r))) q.rows.set(keyOf(r), r);
    setSaveState("error");
    errorToast(new Error("保存できませんでした。通信を確認してください（入力は残っています。次の入力か画面の移動のときにもう一度保存します）: " + (e?.message || e)));
  }
}

// 保存待ちが残っているか（画面を閉じる前の確認用）
export const hasPending = () => [...queues.values()].some((q) => q.rows.size > 0);

export async function flushAll() {
  for (const qk of queues.keys()) { clearTimeout(queues.get(qk).timer); await flush(qk); }
}

// PCアプリ（新台入替トラッカー）の記録フォルダ（%LOCALAPPDATA%\ShindaiTracker）を取り込む。
//   app/data/{pref}_{id}/snapshots/YYYY-MM-DD.json → shindai_snapshot
//   stores.json        → shindai_shop（未登録の店舗だけ追加）
//   latest_machines.json → 新台カレンダーのアーカイブにマージ
// クラウド側に同じ店舗・同じ日の記録が既にあれば上書きしない（自動取得のほうが新しいため）。
import { loadShops, saveShops, loadSnapshots, loadCalendar, saveCalendar, saveSnapshots } from "./data.js";

const readJson = async (f) => JSON.parse((await f.text()).replace(/^﻿/, ""));

export async function importLocalFolder(files, progress = () => {}) {
  const snapFiles = [], misc = {};
  for (const f of files) {
    const p = (f.webkitRelativePath || f.name).replace(/\\/g, "/");
    const m = p.match(/app\/data\/([a-z]+)_(\d+)\/snapshots\/(\d{4}-\d{2}-\d{2})\.json$/);
    if (m) snapFiles.push({ f, key: `${m[1]}/${m[2]}`, day: m[3] });
    else if (/(^|\/)stores\.json$/.test(p) && !p.includes("/app/")) misc.stores = f;
    else if (/(^|\/)latest_machines\.json$/.test(p)) misc.calendar = f;
  }
  if (!snapFiles.length && !misc.stores) throw new Error("記録が見つかりません。ShindaiTracker フォルダを選んでください。");

  // 店舗（未登録だけ末尾に追加）
  if (misc.stores) {
    const local = (await readJson(misc.stores)).shops || [];
    const shops = await loadShops();
    const have = new Set(shops.map((s) => s.key));
    const add = local.filter((s) => s.key && !have.has(s.key))
      .map((s) => ({ key: s.key, name: s.name, url: s.url || `https://p-town.dmm.com/shops/${s.key}`, enabled: s.enabled !== false }));
    if (add.length) await saveShops([...shops, ...add]);
  }

  // スナップショット
  const existing = await loadSnapshots();
  const have = new Set();
  for (const [k, arr] of existing) for (const s of arr) have.add(`${k}|${s.day}`);
  const rows = [];
  let skipped = 0;
  for (const { f, key, day } of snapFiles) {
    if (have.has(`${key}|${day}`)) { skipped++; continue; }
    const j = await readJson(f);
    if (!j.machines || !Object.keys(j.machines).length) continue;
    rows.push({
      shop_key: key, day, fetched_at: j.fetched_at ? new Date(j.fetched_at).toISOString() : null,
      // 旧記録で source が無いものは週次の定期取得だったので auto 扱い（比較の基準日に使う）
      source: j.source || "auto", dmm_updated: j.dmm_updated || null,
      name: j.name || key, total: j.total || 0, unique_count: j.unique || 0, machines: j.machines,
    });
  }
  for (let i = 0; i < rows.length; i += 20) {
    progress(`記録を送信中… ${Math.min(i + 20, rows.length)}/${rows.length}`);
    await saveSnapshots(rows.slice(i, i + 20));
  }

  // 新台カレンダー（過去分のアーカイブをマージ）
  let calCount = 0;
  if (misc.calendar) {
    const local = (await readJson(misc.calendar)).machines || [];
    const cur = await loadCalendar();
    const merged = new Map();
    for (const m of [...local, ...(cur.machines || [])]) if (/^\d{4}-\d{2}-\d{2}$/.test(m.date || "")) merged.set(`${m.name}|${m.date}`, m);
    const machines = [...merged.values()].sort((a, b) => (a.date === b.date ? a.name.localeCompare(b.name) : a.date < b.date ? 1 : -1));
    calCount = local.length;
    await saveCalendar({ ...cur, source: cur.source || "P-WORLD 新台スケジュール", machines });
  }
  return { snapshots: rows.length, skipped, calendar: calCount };
}

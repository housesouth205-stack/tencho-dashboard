// DBアクセスの唯一の窓口。Supabase未設定時はlocalStorageで同一APIを提供する。
// 認証・Supabase移行はこの層の差替えのみで完了する（設計方針）。
import { hasSupabase } from "./config.js";
import { getClient } from "./supabaseClient.js";

const LKEY = (table) => `dash:${table}`;

/* ---------- localStorage アダプタ ---------- */
const local = {
  _load(table) {
    try { return JSON.parse(localStorage.getItem(LKEY(table)) || "[]"); }
    catch { return []; }
  },
  _save(table, rows) { localStorage.setItem(LKEY(table), JSON.stringify(rows)); },

  async select(table, { eq = {}, order } = {}) {
    let rows = this._load(table).filter((r) =>
      Object.entries(eq).every(([k, v]) => r[k] === v));
    if (order) {
      const [col, dir] = Array.isArray(order) ? order : [order, "asc"];
      rows.sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === "desc" ? -1 : 1));
    }
    return rows;
  },

  async upsert(table, input, { onConflict = ["id"] } = {}) {
    const rows = Array.isArray(input) ? input : [input];
    const store = this._load(table);
    const keyOf = (r) => onConflict.map((k) => r[k]).join("");
    const index = new Map(store.map((r, i) => [keyOf(r), i]));
    for (const r of rows) {
      const rec = { ...r };
      if (onConflict.includes("id") && rec.id == null) rec.id = crypto.randomUUID();
      const k = keyOf(rec);
      if (index.has(k)) store[index.get(k)] = { ...store[index.get(k)], ...rec };
      else { index.set(k, store.length); store.push(rec); }
    }
    this._save(table, store);
    return rows;
  },

  async remove(table, match) {
    const rows = this._load(table).filter((r) =>
      !Object.entries(match).every(([k, v]) => r[k] === v));
    this._save(table, rows);
  },
};

/* ---------- Supabase アダプタ ---------- */
const remote = {
  // PostgRESTは1リクエスト最大1000行で打ち切るため、rangeで全ページ取得する。
  // （plan_dayは年度分で1000行を超え、8月以降の計画が欠落する実害があった）
  async select(table, { eq = {}, order } = {}) {
    const sb = await getClient();
    const PAGE = 1000;
    const all = [];
    for (let from = 0; ; from += PAGE) {
      let q = sb.from(table).select("*").range(from, from + PAGE - 1);
      for (const [k, v] of Object.entries(eq)) q = q.eq(k, v);
      if (order) {
        const [col, dir] = Array.isArray(order) ? order : [order, "asc"];
        q = q.order(col, { ascending: dir !== "desc" });
      }
      const { data, error } = await q;
      if (error) throw error;
      all.push(...data);
      if (data.length < PAGE) break;
    }
    return all;
  },
  async upsert(table, input, { onConflict = ["id"] } = {}) {
    const sb = await getClient();
    const { data, error } = await sb.from(table)
      .upsert(input, { onConflict: onConflict.join(",") }).select();
    if (error) throw error;
    return data;
  },
  async remove(table, match) {
    const sb = await getClient();
    let q = sb.from(table).delete();
    for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
    const { error } = await q;
    if (error) throw error;
  },
};

const backend = () => (hasSupabase() ? remote : local);

export const repo = {
  select: (t, o) => backend().select(t, o),
  upsert: (t, r, o) => backend().upsert(t, r, o),
  remove: (t, m) => backend().remove(t, m),
  isLocal: () => !hasSupabase(),
};

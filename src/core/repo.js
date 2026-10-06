// DBアクセスの唯一の窓口。Supabase未設定時はlocalStorageで同一APIを提供する。
// 認証・Supabase移行はこの層の差替えのみで完了する（設計方針）。
import { hasSupabase } from "./config.js";
import { getClient } from "./supabaseClient.js";

const LKEY = (table) => `dash:${table}`;
// id を既定値で採番する表（supabase/migrations の "id uuid primary key default gen_random_uuid()"）
const ID_TABLES = new Set(["section_def", "snapshot_period", "fixture", "model_spec", "sim_session", "sim_comment", "poster", "import_log"]);

/* ---------- localStorage アダプタ ---------- */
const local = {
  _load(table) {
    try { return JSON.parse(localStorage.getItem(LKEY(table)) || "[]"); }
    catch { return []; }
  },
  _save(table, rows) { localStorage.setItem(LKEY(table), JSON.stringify(rows)); },

  async select(table, { eq = {}, order, limit } = {}) {
    let rows = this._load(table).filter((r) =>
      Object.entries(eq).every(([k, v]) => r[k] === v));
    if (order) {
      const [col, dir] = Array.isArray(order) ? order : [order, "asc"];
      rows.sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === "desc" ? -1 : 1));
    }
    return limit ? rows.slice(0, limit) : rows;
  },

  async upsert(table, input, { onConflict = ["id"] } = {}) {
    const rows = Array.isArray(input) ? input : [input];
    const store = this._load(table);
    const keyOf = (r) => onConflict.map((k) => r[k]).join("");
    const index = new Map(store.map((r, i) => [keyOf(r), i]));
    const saved = [];
    for (const r of rows) {
      const rec = { ...r };
      const k = keyOf(rec);
      // DB側で id を既定値（gen_random_uuid）で採番する表は、こちらも新規行に振る。
      // onConflict が id 以外のとき（区分の種まき等）に振らないと、全区分が id 無しになり
      // 台がすべて同じ区分に寄って見えた。id 列の無い表には足さない（バックアップを
      // Supabaseへ戻すとき、無い列があると弾かれる）。
      if (rec.id == null && (ID_TABLES.has(table) || onConflict.includes("id")) && !(index.has(k) && store[index.get(k)].id != null)) rec.id = crypto.randomUUID();
      if (index.has(k)) store[index.get(k)] = { ...store[index.get(k)], ...rec };
      else { index.set(k, store.length); store.push({ created_at: new Date().toISOString(), ...rec }); }
      saved.push(store[index.get(k)]);
    }
    this._save(table, store);
    // Supabase側（.select()）と同じく「保存後の行」を返す。入力をそのまま返すと
    // 採番したidが呼び出し側に渡らず、スナップショットの行が期間に紐づかなかった。
    return saved;
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
  async select(table, { eq = {}, order, limit } = {}) {
    const sb = await getClient();
    // limit指定時は先頭n件だけでよいのでページングしない（鮮度チェックの1件取得など）。
    if (limit) {
      let q = sb.from(table).select("*").limit(limit);
      for (const [k, v] of Object.entries(eq)) q = q.eq(k, v);
      if (order) {
        const [col, dir] = Array.isArray(order) ? order : [order, "asc"];
        q = q.order(col, { ascending: dir !== "desc" });
      }
      const { data, error } = await q;
      if (error) throw error;
      return data;
    }
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

// 鮮度表示（タブ直下）が見ている表。書き込んだら知らせて読み直してもらう。
// 取込や日別入力のたびに各画面から呼ぶのでは、足し忘れた画面だけ表示が古いまま残る。
const WATCHED = new Set(["actual_day", "snapshot_period", "pl_month"]);
const notify = (t) => { if (WATCHED.has(t)) window.dispatchEvent(new Event("dash:datachange")); };

export const repo = {
  select: (t, o) => backend().select(t, o),
  upsert: async (t, r, o) => { const res = await backend().upsert(t, r, o); notify(t); return res; },
  remove: (t, m) => backend().remove(t, m),
  isLocal: () => !hasSupabase(),
};

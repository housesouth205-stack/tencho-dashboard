// 新台タブのデータ窓口。読み書きは repo 経由、取得（スクレイプ）は Edge Function「shindai-fetch」。
import { repo } from "../../core/repo.js";
import { state } from "../../core/state.js";
import { getClient } from "../../core/supabaseClient.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../../core/config.js";

const ENDPOINT = `${SUPABASE_URL}/functions/v1/shindai-fetch`;

// ログイン中のユーザーのトークンで呼ぶ（refresh/shop_info はログイン必須）
export async function callFetch(body) {
  const sb = await getClient();
  const token = sb ? (await sb.auth.getSession()).data.session?.access_token : null;
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token || SUPABASE_ANON_KEY}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 404) throw new Error("取得用の仕組み（shindai-fetch）がまだ設定されていません");
  if (!res.ok) throw new Error(json.error || `取得失敗(HTTP ${res.status})`);
  return json;
}

export async function loadShops() {
  const rows = await repo.select("shindai_shop", { eq: { store_id: state.storeId }, order: "sort_order" });
  return rows;
}

export async function saveShops(rows) {
  return repo.upsert("shindai_shop", rows.map((r, i) => ({ ...r, store_id: state.storeId, sort_order: i + 1 })), { onConflict: ["store_id", "key"] });
}

export const removeShop = (key) => repo.remove("shindai_shop", { store_id: state.storeId, key });

// 全スナップショット → Map(shop_key -> day昇順の配列)
export async function loadSnapshots() {
  const rows = await repo.select("shindai_snapshot", { eq: { store_id: state.storeId }, order: "day" });
  const by = new Map();
  for (const r of rows) {
    const a = by.get(r.shop_key) || [];
    a.push(r);
    by.set(r.shop_key, a);
  }
  return by;
}

export async function loadCalendar() {
  const rows = await repo.select("app_setting", { eq: { store_id: state.storeId, key: "shindai_calendar" } });
  return rows[0]?.value || { machines: [] };
}

export const saveCalendar = (value) =>
  repo.upsert("app_setting", { store_id: state.storeId, key: "shindai_calendar", value }, { onConflict: ["store_id", "key"] });

export const saveSnapshots = (rows) =>
  repo.upsert("shindai_snapshot", rows.map((r) => ({ ...r, store_id: state.storeId })), { onConflict: ["store_id", "shop_key", "day"] });

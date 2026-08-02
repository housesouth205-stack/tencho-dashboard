// supabase-js は Supabase 設定時のみ読込。UMDビルド(src/lib)を同梱しCDN非依存。
import { SUPABASE_URL, SUPABASE_ANON_KEY, hasSupabase } from "./config.js";

let _client = null;
let _libPromise = null;

// 同梱UMDをscriptタグで読み込み window.supabase を得る（1回だけ）。
function loadLib() {
  if (window.supabase?.createClient) return Promise.resolve(window.supabase);
  if (_libPromise) return _libPromise;
  _libPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = new URL("../lib/supabase.umd.js", import.meta.url).href;
    s.onload = () => window.supabase?.createClient ? resolve(window.supabase) : reject(new Error("supabase-js 読込失敗"));
    s.onerror = () => reject(new Error("supabase-js 読込失敗"));
    document.head.appendChild(s);
  });
  return _libPromise;
}

export async function getClient() {
  if (!hasSupabase()) return null;
  if (_client) return _client;
  const lib = await loadLib();
  _client = lib.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "toho-dash-auth" },
  });
  return _client;
}

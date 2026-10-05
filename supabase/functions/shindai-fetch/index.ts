// Supabase Edge Function: shindai-fetch
// 周辺店の新台入替を DMMぱちタウン（店舗の機種・台数）と P-WORLD（新台カレンダー）から取得し、
// shindai_snapshot / app_setting(shindai_calendar) に保存する。旧PCアプリ「新台入替トラッカー」の移植。
//
// リクエスト(POST JSON):
//   { "action": "auto" }      … 自動実行用（pg_cron が毎週月曜に30分おきに呼ぶ。認証不要）。
//                              今日分が未取得、またはDMMの機種情報がまだ今日付けでない店舗だけ取得する。
//                              直近25分以内に取得済みの店舗は取り直さない（連打されても負荷をかけない）。
//   { "action": "refresh" }   … ダッシュボードの「今すぐ更新」。ログイン必須。全店舗を取得。
//   { "action": "shop_info", "key": "tokyo/467" } … 店舗追加時の店名確認。ログイン必須。
//
// デプロイ: supabase functions deploy shindai-fetch --no-verify-jwt
//   （またはSupabaseの管理画面 Edge Functions → Deploy a new function にこのファイルを貼る。
//     名前は shindai-fetch、「Verify JWT」はオフ）

import { createClient } from "jsr:@supabase/supabase-js@2";

const STORE_ID = "toho-ikebukuro";
const DMM = "https://p-town.dmm.com";
const PWORLD_CAL = "https://www.p-world.co.jp/database/machine/introduce_calendar.cgi";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const RECHECK_MIN = 25;     // autoでこの分数以内に取得済みの店舗は取り直さない
const PRUNE_DAYS = 400;     // 新台カレンダーのアーカイブ保持日数

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "ja" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

// 日本時間の今日 YYYY-MM-DD
const jstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

// ---- parse start（HTML解析。node でも単体テストできるよう型注釈なし） ----
function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;/g, "'");
}
const stripTags = (s) => decodeEntities(String(s).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function normRate(raw) {
  const r = String(raw).trim();
  return /^\d+$/.test(r) ? `${r}円` : r;
}

// 「10/05」→ YYYY-MM-DD（年またぎ: 1月に12/xxなら前年）
function mdToDate(mo, d, today) {
  const [ty, tm] = today.split("-").map(Number);
  const y = mo > tm + 1 ? ty - 1 : ty;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// DMM店舗の機種ページ → {name, dmm_updated, machines:{"ID|レート":{name,type,rate,count}}, total, unique}
function parseShop(html, today) {
  const nm = html.match(/class="shop-name[^"]*">([^<]+)</);
  const name = nm ? decodeEntities(nm[1]).trim() : "";
  const um = html.match(/機種情報<\/h2>[\s\S]{0,300}?更新日[:：]\s*(\d{1,2})\/(\d{1,2})/);
  const dmm_updated = um ? mdToDate(+um[1], +um[2], today) : null;

  const machines = {};
  const parts = html.split(/<li class="unit">/).slice(1);
  for (const part of parts) {
    const hm = part.match(/<h4 class="title"[^>]*>([\s\S]*?)<\/h4>/);
    if (!hm) continue;
    const label = stripTags(hm[1]);
    const lm = label.match(/\[([^\]]+)\]/);
    if (!lm) continue;
    const rate = normRate(lm[1]);
    const type = label.includes("スロ") ? "スロット" : "パチンコ";
    const listStart = part.indexOf('<ul class="list"');
    if (listStart < 0) continue;
    const listEnd = part.indexOf("</ul>", listStart);
    const list = part.slice(listStart, listEnd < 0 ? undefined : listEnd);
    for (const it of list.split(/<li class="item"/).slice(1)) {
      const a = it.match(/href="\/machines\/(\d+)"[^>]*>([\s\S]*?)<\/a>/);
      const n = it.match(/class="number">\s*(\d{1,4})/);
      if (!a || !n) continue;
      const mname = stripTags(a[2]);
      if (!mname) continue;
      machines[`${a[1]}|${rate}`] = { name: mname, type, rate, count: parseInt(n[1], 10) };
    }
  }
  const vals = Object.values(machines);
  return {
    name, dmm_updated, machines,
    total: vals.reduce((s, m) => s + m.count, 0),
    unique: new Set(Object.keys(machines).map((k) => k.split("|")[0])).size,
  };
}

// P-WORLD 新台スケジュール → [{name,type,date,stores}]
function parseCalendar(html) {
  const out = [];
  const seen = new Set();
  const blocks = html.split(/<div class="machineList(?: [^"]*)?"/).slice(1);
  for (const b of blocks) {
    const dm = b.match(/^[^>]*id="(\d{4}-\d{2}-\d{2})"/);
    if (!dm) continue;
    const date = dm[1];
    for (const it of b.split(/<li class="machineList-item"/).slice(1)) {
      const tm = it.match(/machineList-item-title"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/);
      if (!tm) continue;
      const name = stripTags(tm[1]);
      if (!name || seen.has(name + date)) continue;
      seen.add(name + date);
      const ty = it.match(/machineList-item-type"[^>]*>([^<]*)</);
      const type = ty && /スロ/.test(ty[1]) ? "スロット" : "パチンコ";
      const sm = it.match(/導入予定[:：]\s*(\d+)\s*店舗/);
      out.push({ name, type, date, stores: sm ? parseInt(sm[1], 10) : null });
    }
  }
  return out;
}
// ---- parse end ----

// ---------- DB ----------
const db = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

async function requireUser(req: Request, sb: ReturnType<typeof db>) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const { data, error } = await sb.auth.getUser(token);
  return !error && !!data?.user;
}

async function fetchShop(sb: ReturnType<typeof db>, shop: any, source: string, today: string) {
  const url = (shop.url || `${DMM}/shops/${shop.key}`).replace(/\/$/, "") + "/machines";
  const p = parseShop(await fetchText(url), today);
  if (!Object.keys(p.machines).length) throw new Error("機種が1件も読み取れませんでした（ページ構成の変更の可能性）");
  // 同じ日に手動更新しても「その日に自動更新があった」記録は残す（比較の基準日がずれないように）
  if (source !== "auto") {
    const { data } = await sb.from("shindai_snapshot").select("source")
      .eq("store_id", STORE_ID).eq("shop_key", shop.key).eq("day", today).maybeSingle();
    if (data?.source === "auto") source = "auto";
  }
  const row = {
    store_id: STORE_ID, shop_key: shop.key, day: today,
    fetched_at: new Date().toISOString(), source, dmm_updated: p.dmm_updated,
    name: p.name || shop.name, total: p.total, unique_count: p.unique, machines: p.machines,
  };
  const { error } = await sb.from("shindai_snapshot").upsert(row, { onConflict: "store_id,shop_key,day" });
  if (error) throw error;
  if (p.name && p.name !== shop.name) {
    await sb.from("shindai_shop").update({ name: p.name }).eq("store_id", STORE_ID).eq("key", shop.key);
  }
  return { key: shop.key, name: row.name, ok: true, total: p.total, machines: p.unique, dmm_updated: p.dmm_updated };
}

async function fetchCalendar(sb: ReturnType<typeof db>, force: boolean, today: string) {
  const { data } = await sb.from("app_setting").select("value")
    .eq("store_id", STORE_ID).eq("key", "shindai_calendar").maybeSingle();
  const cur = data?.value || { machines: [] };
  if (!force && String(cur.fetched_at || "").slice(0, 10) === today) return { skipped: true };
  const fresh = parseCalendar(await fetchText(PWORLD_CAL));
  // 元ページは直近〜数ヶ月先しか載らないので、既存とマージして過去分を蓄積する
  const merged = new Map<string, any>();
  for (const m of [...(cur.machines || []), ...fresh]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(m.date || "")) continue;
    merged.set(`${m.name}|${m.date}`, m);
  }
  const cutoff = new Date(Date.now() - PRUNE_DAYS * 86400e3).toISOString().slice(0, 10);
  const machines = [...merged.values()].filter((m) => m.date >= cutoff)
    .sort((a, b) => (a.date === b.date ? a.name.localeCompare(b.name) : a.date < b.date ? 1 : -1));
  const value = { fetched_at: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 19), source: "P-WORLD 新台スケジュール", machines };
  const { error } = await sb.from("app_setting").upsert({ store_id: STORE_ID, key: "shindai_calendar", value }, { onConflict: "store_id,key" });
  if (error) throw error;
  return { count: fresh.length };
}

// 4店舗ずつ並行取得
async function runShops(sb: ReturnType<typeof db>, shops: any[], source: string, today: string) {
  const results: any[] = [];
  for (let i = 0; i < shops.length; i += 4) {
    const batch = shops.slice(i, i + 4);
    results.push(...await Promise.all(batch.map((s) =>
      fetchShop(sb, s, source, today).catch((e) => ({ key: s.key, name: s.name, ok: false, error: String(e?.message || e) })))));
  }
  return results;
}

async function handle(req: Request) {
  const body = await req.json().catch(() => ({}));
  const sb = db();
  const today = jstToday();

  if (body.action === "shop_info") {
    if (!(await requireUser(req, sb))) return json({ error: "ログインが必要です" }, 401);
    const key = String(body.key || "");
    if (!/^[a-z]+\/\d+$/.test(key)) return json({ error: "店舗の指定が正しくありません" }, 400);
    const p = parseShop(await fetchText(`${DMM}/shops/${key}/machines`), today);
    return json({ key, name: p.name, total: p.total, machines: p.unique });
  }

  const { data: shops, error } = await sb.from("shindai_shop").select("*")
    .eq("store_id", STORE_ID).eq("enabled", true).order("sort_order");
  if (error) throw error;

  if (body.action === "refresh") {
    if (!(await requireUser(req, sb))) return json({ error: "ログインが必要です" }, 401);
    const results = await runShops(sb, shops || [], "manual", today);
    const calendar = await fetchCalendar(sb, true, today).catch((e) => ({ error: String(e?.message || e) }));
    return json({ today, results, calendar });
  }

  if (body.action === "auto") {
    const { data: snaps } = await sb.from("shindai_snapshot").select("shop_key,fetched_at,dmm_updated")
      .eq("store_id", STORE_ID).eq("day", today);
    const byKey = new Map((snaps || []).map((s: any) => [s.shop_key, s]));
    const recent = Date.now() - RECHECK_MIN * 60e3;
    const targets = (shops || []).filter((s: any) => {
      const t = byKey.get(s.key);
      if (!t) return true;                                       // 今日まだ取っていない
      if (t.dmm_updated === today) return false;                 // DMMが今日付けに更新済み＝完了
      return new Date(t.fetched_at).getTime() < recent;          // 未更新：前回から25分以上なら取り直す
    });
    const results = await runShops(sb, targets, "auto", today);
    const calendar = await fetchCalendar(sb, false, today).catch((e) => ({ error: String(e?.message || e) }));
    return json({ today, checked: targets.length, results, calendar });
  }

  return json({ error: "unknown action" }, 400);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    return await handle(req);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});

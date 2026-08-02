// Supabase Edge Function: payout-fetch
// 出玉率(機械割)のWeb取得。一撃(1geki.jp)=設定別フルデータ優先、
// DMMぱちタウン(p-town.dmm.com)=レンジ(設定1・6)フォールバック。
// ブラウザ直取得はCORS不可のため、このサーバ関数が代理取得して返す。
//
// リクエスト(POST JSON):
//   { "action": "search", "keyword": "モンキーターン5", "limit": 3 }
//     -> { candidates: [{ id, source:"1geki"|"dmm", name, range:[lo,hi]|null, per6:[..6, 欠番null..]|null }] }
//   { "action": "fetch", "id": 1037 | "l_monkeyturn5", "source": "dmm"|"1geki" }
//     -> { id, source, name, range, per6 }
//
// デプロイ: supabase functions deploy payout-fetch --no-verify-jwt

const DMM = "https://p-town.dmm.com";
const GEKI = "https://1geki.jp";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&hellip;/g, "…")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "ja" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

// 名前照合用の正規化（フロント側normNameと揃える）。
function normName(s: string): string {
  let t = (s || "").normalize("NFKC").toUpperCase();
  t = t.replace(/[Ⅰ-Ⅻ]/g, (c) => String("ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ".indexOf(c) + 1));
  t = t.replace(/[\s　・･,.。、（）()【】\[\]「」"'~〜～\-_/☆★]/g, "");
  t = t.replace(/(スマスロ|パチスロ|スロット|SLOT)/g, "");
  return t;
}

function similarity(a: string, b: string): number {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const grams = (s: string) => { const g = new Set<string>(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; };
  const ga = grams(na), gb = grams(nb);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return (2 * inter) / (ga.size + gb.size);
}

// ---------- 一撃 (1geki.jp): 設定別フルデータ ----------

// slug->機種名の一覧。ウォーム起動間で30分キャッシュ。
let gekiIndex: { slug: string; name: string }[] | null = null;
let gekiIndexAt = 0;

async function getGekiIndex() {
  if (gekiIndex && Date.now() - gekiIndexAt < 30 * 60 * 1000) return gekiIndex;
  const pairs = new Map<string, string>();
  for (const url of [`${GEKI}/slot/`, `${GEKI}/slot/page/2/`, `${GEKI}/slot/page/3/`]) {
    let html = "";
    try { html = await fetchText(url); } catch { continue; }
    for (const m of html.matchAll(/href="https:\/\/1geki\.jp\/slot\/([\w-]+)\/"[^>]*>([\s\S]*?)<\/a>/g)) {
      const slug = m[1];
      if (slug.startsWith("page")) continue;
      const nm = m[2].match(/class="machine_name"[^>]*>\s*([^<]+?)\s*</);
      if (nm && !pairs.has(slug)) pairs.set(slug, decodeEntities(nm[1].trim()));
    }
  }
  gekiIndex = [...pairs].map(([slug, name]) => ({ slug, name }));
  gekiIndexAt = Date.now();
  return gekiIndex;
}

// 機種ページのスペック早見表(設定/初当り/出玉率)から設定別出玉率を抽出。欠番設定はnull。
function parseGeki(html: string, slug: string) {
  let text = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
  text = decodeEntities(text.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
  const tm = html.match(/<title>([^<|｜]+)/);
  const name = tm ? tm[1].trim() : slug;

  let per6: (number | null)[] | null = null;
  // 「設定 … 出玉率」ヘッダーの直後400文字窓から行(設定番号 [1/xxx.x]* NN.N%)を収集
  for (const hm of text.matchAll(/設定[^%]{0,60}出玉率/g)) {
    const win = text.slice(hm.index! + hm[0].length, hm.index! + hm[0].length + 400);
    const d: Record<number, number> = {};
    for (const r of win.matchAll(/([1-6])\s*(?:1\/[\d.]+\s*){0,3}(\d{2,3}\.\d)%/g)) {
      const st = parseInt(r[1], 10);
      if (!(st in d)) d[st] = parseFloat(r[2]);
    }
    if (Object.keys(d).length >= 3) {
      per6 = [1, 2, 3, 4, 5, 6].map((i) => (i in d ? d[i] : null));
      break;
    }
  }
  const known = per6 ? per6.filter((v) => v !== null) as number[] : [];
  const range: [number, number] | null = known.length >= 2 ? [Math.min(...known), Math.max(...known)] : null;
  return { id: slug, source: "1geki", name, range, per6 };
}

async function fetchGeki(slug: string) {
  return parseGeki(await fetchText(`${GEKI}/slot/${slug}/`), slug);
}

// ---------- DMMぱちタウン: レンジ(大半) / 設定別(稀) ----------

function parseDmm(html: string, id: number) {
  const tm = html.match(/<title>([^（<]+)/);
  const name = tm ? tm[1].trim() : "";

  let range: [number, number] | null = null;
  const rm = html.match(/機械割<\/th>\s*<td class="td">\s*([\d.]+)\s*%\s*[〜～~]\s*([\d.]+)\s*%/);
  if (rm) range = [parseFloat(rm[1]), parseFloat(rm[2])];

  let per6: (number | null)[] | null = null;
  for (const b of html.matchAll(/<div class="wysiwyg-box[^"]*">([\s\S]*?)<\/div>/g)) {
    const text = decodeEntities(b[1].replace(/<[^>]+>/g, " "));
    const d: Record<number, number> = {};
    for (const m of text.matchAll(/設定\s*([1-6])\D{0,4}(\d{2,3}(?:\.\d)?)\s*%/g)) {
      d[parseInt(m[1], 10)] = parseFloat(m[2]);
    }
    const vals = [1, 2, 3, 4, 5, 6].map((i) => (i in d ? d[i] : null));
    if (vals.every((v) => v !== null)) { per6 = vals; break; }
  }
  return { id, source: "dmm", name, range, per6 };
}

async function fetchDmm(id: number) {
  return parseDmm(await fetchText(`${DMM}/machines/${id}`), id);
}

async function searchDmm(keyword: string, limit: number) {
  const html = await fetchText(`${DMM}/machines/search?keyword=${encodeURIComponent(keyword)}`);
  const ids: number[] = [];
  for (const m of html.matchAll(/\/machines\/(\d+)"/g)) {
    const n = parseInt(m[1], 10);
    if (!ids.includes(n)) ids.push(n);
    if (ids.length >= limit) break;
  }
  return await Promise.all(ids.map((id) => fetchDmm(id).catch(() => null)));
}

// ---------- 統合検索: 一撃(設定別)優先 → DMM(レンジ) ----------

async function search(keyword: string, limit: number) {
  const out: unknown[] = [];
  // 一撃: インデックスから類似名を探し、上位を詳細取得
  try {
    const idx = await getGekiIndex();
    const hits = idx
      .map((e) => ({ ...e, score: similarity(keyword, e.name) }))
      .filter((e) => e.score >= 0.4)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);
    for (const h of hits) {
      const d = await fetchGeki(h.slug).catch(() => null);
      if (d && (d.per6 || d.range)) out.push({ ...d, name: h.name });
    }
  } catch { /* 一撃が落ちてもDMMで続行 */ }
  // DMM
  const dmm = await searchDmm(keyword, limit).catch(() => []);
  for (const d of dmm) if (d && d.name) out.push(d);
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json();
    const action = body.action;
    let out;
    if (action === "search") {
      out = { candidates: await search(String(body.keyword || ""), Math.min(body.limit || 3, 6)) };
    } else if (action === "fetch") {
      out = (body.source === "1geki" || typeof body.id === "string" && isNaN(Number(body.id)))
        ? await fetchGeki(String(body.id))
        : await fetchDmm(parseInt(body.id, 10));
    } else {
      return new Response(JSON.stringify({ error: "unknown action" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify(out), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e && (e as Error).message || e) }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});

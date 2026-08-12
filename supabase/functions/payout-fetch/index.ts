// Supabase Edge Function: payout-fetch
// 出玉率(機械割)のWeb取得。取得元はSOURCESに登録し、tier昇順(1=メーカー公式 → 2=解析サイト)、
// 同tier内は登録順に試す。設定別フルデータ(per6)が取れるソースが先、無ければレンジ(設定1・6)にフォールバック。
// ブラウザ直取得はCORS不可のため、このサーバ関数が代理取得して返す。
//
// リクエスト(POST JSON):
//   { "action": "search", "keyword": "モンキーターン5", "limit": 3 }
//     -> { candidates: [Spec, ...] }
//   { "action": "fetch", "id": 1037 | "l_monkeyturn5", "source": "dmm"|"1geki" }
//     -> Spec
//   { "action": "sources" }
//     -> { sources: [{ key, label, tier, origin, ready }, ...] }
//
//   Spec = { id, source, name, range:[lo,hi]|null, per6:[..6, 欠番null..]|null }
//
// 取得元を足す手順: SOURCESの該当エントリにfetch/searchを実装し、ready:trueにする。
// 呼び出し側(search/fetch/振り分け)の変更は不要。
// デプロイ: supabase functions deploy payout-fetch --no-verify-jwt

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Spec = {
  id: string | number;
  source: string;
  name: string;
  range: [number, number] | null;
  per6: (number | null)[] | null;
};

type Source = {
  key: string; // Spec.sourceに入る識別子。クライアントのSITE_LABELのキーと対応。
  label: string;
  tier: 1 | 2; // 1=メーカー公式, 2=解析サイト。小さいほど優先。
  origin: string;
  ready: boolean; // false=パーサ未実装。search/fetchのどちらからも使われない。
  idKind?: "num" | "slug"; // sourceが省略されたfetchを、idの形から振り分けるのに使う。
  fetch?: (id: string) => Promise<Spec>;
  search?: (keyword: string, limit: number) => Promise<(Spec | null)[]>;
};

// ---------- 共通ユーティリティ ----------

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

// 設定別が3つ以上埋まっていれば、その最小・最大をレンジとして併記する。
function rangeOf(per6: (number | null)[] | null): [number, number] | null {
  const known = per6 ? per6.filter((v) => v !== null) as number[] : [];
  return known.length >= 2 ? [Math.min(...known), Math.max(...known)] : null;
}

// ---------- 一撃 (1geki.jp): 設定別フルデータ ----------

const GEKI = "https://1geki.jp";

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
function parseGeki(html: string, slug: string): Spec {
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
  return { id: slug, source: "1geki", name, range: rangeOf(per6), per6 };
}

async function fetchGeki(slug: string): Promise<Spec> {
  return parseGeki(await fetchText(`${GEKI}/slot/${slug}/`), slug);
}

// インデックスから類似名を探し、上位2件だけ詳細を取る(1件ずつHTMLを引くため)。
async function searchGeki(keyword: string, _limit: number): Promise<(Spec | null)[]> {
  const idx = await getGekiIndex();
  const hits = idx
    .map((e) => ({ ...e, score: similarity(keyword, e.name) }))
    .filter((e) => e.score >= 0.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
  const out: (Spec | null)[] = [];
  for (const h of hits) {
    const d = await fetchGeki(h.slug).catch(() => null);
    if (d && (d.per6 || d.range)) out.push({ ...d, name: h.name });
  }
  return out;
}

// ---------- DMMぱちタウン: レンジ(大半) / 設定別(稀) ----------

const DMM = "https://p-town.dmm.com";

function parseDmm(html: string, id: number): Spec {
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

async function fetchDmm(id: string): Promise<Spec> {
  const n = parseInt(id, 10);
  return parseDmm(await fetchText(`${DMM}/machines/${n}`), n);
}

async function searchDmm(keyword: string, limit: number): Promise<(Spec | null)[]> {
  const html = await fetchText(`${DMM}/machines/search?keyword=${encodeURIComponent(keyword)}`);
  const ids: number[] = [];
  for (const m of html.matchAll(/\/machines\/(\d+)"/g)) {
    const n = parseInt(m[1], 10);
    if (!ids.includes(n)) ids.push(n);
    if (ids.length >= limit) break;
  }
  return await Promise.all(ids.map((id) => fetchDmm(String(id)).catch(() => null)));
}

// ---------- 取得元レジストリ ----------

// tier1(メーカー公式)を上、tier2(解析サイト)を下に置き、同tier内はこの配列の順で試す。
// ready:false はパーサ未実装。fetch/searchを書いてready:trueにすれば、他を触らずに参戦する。
// 各originは、開発時にHTML構造を調べるため環境のAllowed domainsに入れておく必要がある。
const SOURCES: Source[] = [
  // --- 第1優先: メーカー公式 ---
  { key: "sammy", label: "サミー", tier: 1, origin: "https://www.sammy.co.jp", ready: false },
  { key: "kitadenshi", label: "北電子", tier: 1, origin: "https://www.kitadenshi.co.jp", ready: false },
  { key: "yamasa", label: "山佐", tier: 1, origin: "https://www.yamasa.co.jp", ready: false },
  { key: "daito", label: "大都技研", tier: 1, origin: "https://www.daito.co.jp", ready: false },
  { key: "sankyo", label: "SANKYO", tier: 1, origin: "https://www.sankyo-fever.co.jp", ready: false },
  { key: "fujishoji", label: "藤商事", tier: 1, origin: "https://www.fujishoji.co.jp", ready: false },
  { key: "olympia", label: "オリンピア", tier: 1, origin: "https://www.olympia-tokyo.co.jp", ready: false },
  { key: "bisty", label: "ビスティ", tier: 1, origin: "https://www.bisty.co.jp", ready: false },
  { key: "pioneer", label: "パイオニア", tier: 1, origin: "https://www.pioneer-net.jp", ready: false },

  // --- 第2優先: 解析サイト ---
  // 実装済みの2件を先頭に置くことで、既存の「一撃 → DMM」の優先順を維持する。
  { key: "1geki", label: "一撃", tier: 2, origin: GEKI, ready: true, idKind: "slug", fetch: fetchGeki, search: searchGeki },
  { key: "dmm", label: "DMMぱちタウン", tier: 2, origin: DMM, ready: true, idKind: "num", fetch: fetchDmm, search: searchDmm },
  { key: "csplaza", label: "cs-plaza.com", tier: 2, origin: "https://cs62.cs-plaza.com", ready: false },
  { key: "pachi7", label: "パチ7", tier: 2, origin: "https://pachi7.jp", ready: false },
  { key: "pachiseven", label: "パチセブン", tier: 2, origin: "https://pachiseven.jp", ready: false },
  { key: "pworld", label: "P-WORLD", tier: 2, origin: "https://www.p-world.co.jp", ready: false },
  { key: "slobase", label: "slobase.jp", tier: 2, origin: "https://slobase.jp", ready: false },
  { key: "nanapress", label: "ナナプレス", tier: 2, origin: "https://nana-press.com", ready: false },
  { key: "chonborista", label: "ちょんぼりすた", tier: 2, origin: "https://chonborista.com", ready: false },
  { key: "pgabu", label: "p-gabu.jp", tier: 2, origin: "https://p-gabu.jp", ready: false },
  { key: "hazuse", label: "hazuse.com", tier: 2, origin: "https://hazuse.com", ready: false },
];

// 優先順に並べた、実装済みソースだけの配列。
function activeSources(): Source[] {
  return SOURCES.filter((s) => s.ready).sort((a, b) => a.tier - b.tier);
}

function sourceByKey(key: string): Source | undefined {
  return activeSources().find((s) => s.key === key);
}

// sourceが指定されない古い保存データ(dmm_mapにidだけが入っている場合)を、idの形から振り分ける。
function sourceForId(id: string): Source | undefined {
  const kind = isNaN(Number(id)) ? "slug" : "num";
  return activeSources().find((s) => s.idKind === kind);
}

// ---------- 統合検索 ----------

async function search(keyword: string, limit: number): Promise<Spec[]> {
  const out: Spec[] = [];
  for (const s of activeSources()) {
    try {
      const found = await s.search!(keyword, limit);
      for (const d of found) if (d && d.name) out.push(d);
    } catch { /* 1ソースが落ちても次のソースで続行 */ }
  }
  return out;
}

async function fetchOne(id: string, sourceKey?: string): Promise<Spec> {
  const s = (sourceKey && sourceByKey(sourceKey)) || sourceForId(id);
  if (!s) throw new Error(`no source for id=${id} source=${sourceKey ?? "-"}`);
  return await s.fetch!(id);
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
      out = await fetchOne(String(body.id), body.source ? String(body.source) : undefined);
    } else if (action === "sources") {
      out = { sources: SOURCES.map(({ key, label, tier, origin, ready }) => ({ key, label, tier, origin, ready })) };
    } else {
      return new Response(JSON.stringify({ error: "unknown action" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify(out), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e && (e as Error).message || e) }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});

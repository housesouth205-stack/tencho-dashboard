// 全タブを実際にブラウザで開いて、エラーが出ないことを確かめる。
//
// 構文チェックと import の照合だけでは、開いたときに落ちる画面を見つけられない。
// ここではSupabaseの代わりにブラウザ内保存（localStorage）で動かし、空の状態と、
// 仮のデータを入れた状態の両方で全タブを描画する。日別入力の保存と台別データの取込も通す。
//
//   node tools/check/smoke.mjs
//
// Playwright と Chromium が要る（この環境には入っている）。無ければその旨を出して終わる。
import http from "http";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".ttf": "font/ttf", ".svg": "image/svg+xml" };

// 配信。config.js だけ接続先を空にして、ブラウザ内保存で動かす（本番のデータには触らない）
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split("?")[0]);
  const file = path.join(ROOT, p === "/" ? "index.html" : p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  let body = fs.readFileSync(file);
  if (p === "/src/core/config.js") body = Buffer.from(String(body).replace(/export const SUPABASE_URL = ".*?";/, 'export const SUPABASE_URL = "";'));
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

let chromium;
try {
  const root = execSync("npm root -g").toString().trim();
  ({ chromium } = await import(path.join(root, "playwright/index.mjs")));
} catch { console.log("Playwright が見つからないので、画面の確認は飛ばしました"); server.close(); process.exit(0); }
const exe = fs.existsSync("/opt/pw-browsers") && (() => {
  for (const d of fs.readdirSync("/opt/pw-browsers")) for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
    const f = path.join("/opt/pw-browsers", d, sub); if (fs.existsSync(f)) return f;
  }
})();
const browser = await chromium.launch({ args: ["--no-sandbox"], ...(exe ? { executablePath: exe } : {}) });

const TABS = ["yojitsu", "simulator", "analysis", "payout", "shindai", "expense", "import", "settings"];
const fails = [];
async function run(label, width, seed) {
  const page = await (await browser.newContext({ viewport: { width, height: 900 } })).newPage();
  let where = "起動";
  page.on("pageerror", (e) => fails.push(`[${label}/${where}] ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|404/.test(m.text())) fails.push(`[${label}/${where}] ${m.text()}`); });
  await page.goto(`${base}/index.html#settings`);
  await page.waitForTimeout(600);
  if (seed) { where = "仮データ"; const r = await page.evaluate(seed); if (r !== "ok") fails.push(`[${label}] 仮データの投入に失敗: ${r}`); }
  for (const t of TABS) {
    where = t;
    await page.goto(`${base}/index.html#${t}`); await page.reload(); await page.waitForTimeout(1200);
    const text = await page.locator("#view").innerText();
    if (/表示できませんでした/.test(text)) fails.push(`[${label}/${t}] 画面がエラー表示: ${text.slice(0, 200)}`);
    if (!text.trim()) fails.push(`[${label}/${t}] 画面が空`);
    // はみ出し（ページ全体の横スクロール）はスマホで読めなくなる
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over > 2) fails.push(`[${label}/${t}] ページが横に ${over}px はみ出しています`);
  }
  await page.close();
}

// 仮データ: 予実2年度ぶん・島図・台別データ・月次損益。画面のコードをそのまま通して入れる
const SEED = `(async () => { try {
  const { state, loadSections } = await import("/src/core/state.js");
  const { repo } = await import("/src/core/repo.js");
  const secs = await loadSections();
  const pad = (n) => String(n).padStart(2, "0");
  const today = new Date(); const lim = today.getFullYear() + "-" + pad(today.getMonth() + 1) + "-" + pad(today.getDate());
  const m = [], p = [], a = []; let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let back = 400; back >= -40; back--) {   // 計画は先の日付まで入れる（月の途中の見え方を確かめるため）
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    const ymd = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    for (const sec of secs) {
      const count = sec.key === "S20" ? 144 : sec.key === "S5" ? 112 : 48, b = { store_id: state.storeId, ymd, section_id: sec.id };
      m.push({ ...b, count }); p.push({ ...b, out_per_unit: 4500, unit_price: sec.rate * 0.95, gross_rate: 0.12 });
      const out = 3500 + rnd() * 2500, sales = Math.round(out * count * sec.rate * 0.95);
      if (ymd < lim) a.push({ ...b, out_per_unit: Math.round(out), sales, gross: Math.round(sales * (0.05 + rnd() * 0.14)), source: "excel" });
    }
  }
  for (const [t, rows] of [["machines_day", m], ["plan_day", p], ["actual_day", a]]) await repo.upsert(t, rows, { onConflict: ["store_id", "ymd", "section_id"] });
  const lc = [], models = {};
  for (let d = 1; d <= 304; d++) { const bf = d > 144, i = bf ? d - 145 : d - 1;
    lc.push({ store_id: state.storeId, dai_no: d, floor: bf ? "BF" : "1F", grid_row: Math.floor(i / 16) * 3 + 1, grid_col: i % 16 + 1 });
    models[d] = ["Lｽﾏｽﾛ北斗の拳 転生の章2 MW", "S/新ﾊﾅﾋﾞR/HA", "マイジャグラーV", "L東京喰種"][Math.floor(d / 20) % 4]; }
  await repo.upsert("layout_cell", lc, { onConflict: ["store_id", "dai_no"] });
  await repo.upsert("app_setting", { store_id: state.storeId, key: "island_models", value: models }, { onConflict: ["store_id", "key"] });
  const lines = ["遊技台個別", "期間,2026/09/01,2026/09/30", "", "台番号,機種名,撤去台,投入,差引,出率,ＢＢ回数,台売上,機械粗利"];
  for (let d = 1; d <= 304; d++) { const o = 1500 + Math.floor(rnd() * 7000), sa = Math.floor(rnd() * 4000) - 2500;
    lines.push([d, models[d], "", o, sa, ((o + sa) / o * 100).toFixed(1), 10, o * 20, -sa * 20].join(",")); }
  const { importKtacsFiles } = await import("/src/features/import/view.js");
  await importKtacsFiles([new File([lines.join("\\r\\n")], "koben.csv")], { result: document.createElement("div") });
  const { parsePlTable } = await import("/src/import/plCsv.js");
  const { rows } = parsePlTable([["月度", "総売上高", "売上原価", "売上総利益", "一般管理費", "営業利益", "人件費"], ["R8.07", "110000", "95000", "15000", "12000", "3000", "5000"], ["R8.08", "112000", "96000", "16000", "12500", "3500", "5100"]], "t");
  await repo.upsert("pl_month", rows.map((r) => ({ ...r, store_id: state.storeId })), { onConflict: ["store_id", "ym", "kind"] });
  const snaps = await repo.select("machine_snapshot", {});
  if (snaps.length !== 304) return "台別データが " + snaps.length + " 台しか入っていません";
  return "ok";
} catch (e) { return String(e && e.stack || e); } })()`;

await run("空・PC", 1400, null);
await run("空・スマホ", 390, null);
await run("仮データ・PC", 1400, SEED);
await run("仮データ・スマホ", 390, SEED);

await browser.close(); server.close();
for (const f of fails) console.log("エラー " + f);
console.log(`全タブ × 4通り（空/仮データ × PC/スマホ）を描画: エラー ${fails.length}件`);
process.exit(fails.length ? 1 : 0);

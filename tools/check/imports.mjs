// import と export の食い違い・どこからも読まれないファイルを見つける。
//
// ビルド工程もCIも無いので、import した名前が相手に無くても、その画面を開くまで気づけない
// （実際に、関数を消したまま呼び出しが残り、会議サマリーの取込が本番で止まった）。
// コミット前に `node tools/check/imports.mjs` を通す。問題があれば終了コード1。
import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const SRC = path.join(ROOT, "src");
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) { if (f.name !== "lib") walk(p); } else if (f.name.endsWith(".js")) files.push(p);
  }
})(SRC);

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const exportsOf = new Map();
for (const f of files) {
  const s = strip(fs.readFileSync(f, "utf8"));
  const names = new Set();
  for (const m of s.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of s.matchAll(/export\s*\{([^}]*)\}/g)) for (const n of m[1].split(",")) { const t = n.trim().split(/\s+as\s+/).pop(); if (t) names.add(t); }
  if (/export\s+default\b/.test(s)) names.add("default");
  exportsOf.set(f, names);
}

const errors = [];
const used = new Set([path.join(SRC, "main.js")]);
const usedNames = new Map(); // file → Set(name)
const mark = (file, name) => { if (!usedNames.has(file)) usedNames.set(file, new Set()); usedNames.get(file).add(name); };
const rel = (f) => path.relative(ROOT, f);
for (const f of files) {
  const s = strip(fs.readFileSync(f, "utf8"));
  const resolve = (spec) => (spec.startsWith(".") ? path.resolve(path.dirname(f), spec) : null);
  const check = (target, names, how) => {
    if (!target) return;
    if (!exportsOf.has(target)) { errors.push(`${rel(f)}: ${how} "${rel(target)}" が存在しません`); return; }
    used.add(target);
    for (const n of names) {
      if (n === "*") { mark(target, "*"); continue; }
      mark(target, n);
      if (!exportsOf.get(target).has(n)) errors.push(`${rel(f)}: "${n}" は ${rel(target)} に export されていません`);
    }
  };
  // 静的 import
  for (const m of s.matchAll(/import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+[\w$]+)?\s*from\s*["']([^"']+)["']/g)) {
    const names = [];
    if (m[1]) names.push("default");
    if (m[2] != null) for (const n of m[2].split(",")) { const t = n.trim().split(/\s+as\s+/)[0].trim(); if (t) names.push(t); }
    if (!m[1] && m[2] == null) names.push("*");
    check(resolve(m[3]), names, "import");
  }
  // 動的 import。3つの形を見る:
  //   const { a, b } = await import("…")
  //   const [{ a }, { b }] = await Promise.all([import("…"), import("…")])
  //   それ以外の import("…")（名前は追えないので、ファイルがあることだけ確かめる）
  const seen = new Set();
  for (const m of s.matchAll(/\{([^{}]*)\}\s*=\s*await\s+import\(\s*["']([^"']+)["']\s*\)/g)) {
    seen.add(m.index + m[0].lastIndexOf("import("));
    check(resolve(m[2]), m[1].split(",").map((n) => n.trim().split(":")[0].trim()).filter(Boolean), "import()");
  }
  for (const m of s.matchAll(/\[((?:\s*\{[^{}]*\}\s*,?)+)\]\s*=\s*await\s+Promise\.all\(\[([^\]]*)\]/g)) {
    const groups = [...m[1].matchAll(/\{([^{}]*)\}/g)].map((g) => g[1].split(",").map((n) => n.trim().split(":")[0].trim()).filter(Boolean));
    const specs = [...m[2].matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)];
    const base = m.index + m[0].indexOf(m[2]);
    specs.forEach((sp, i) => { seen.add(base + sp.index); check(resolve(sp[1]), groups[i] || ["*"], "import()"); });
  }
  for (const m of s.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) if (!seen.has(m.index)) check(resolve(m[1]), ["*"], "import()");
}
for (const f of files) if (!used.has(f)) errors.push(`${rel(f)}: どこからも import されていません（使っていないなら消す）`);

// 使われていない export は警告に留める（同じファイル内で使っていることがある）
const warns = [];
for (const [f, names] of exportsOf) {
  const u = usedNames.get(f) || new Set();
  if (u.has("*")) continue;
  for (const n of names) if (!u.has(n) && !(f.endsWith("view.js") && n === "mount")) warns.push(`${rel(f)}: export "${n}" は他のファイルから使われていません`);
}
for (const w of warns) console.log("注意  " + w);
for (const e of errors) console.log("エラー " + e);
console.log(`${files.length}ファイルを確認: エラー ${errors.length}件 / 注意 ${warns.length}件`);
process.exit(errors.length ? 1 : 0);

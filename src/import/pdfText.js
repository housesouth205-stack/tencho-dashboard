// PDFから文字と座標を取り出す最小実装。
//
// pdf.js を同梱する手もあるが、この環境ではパッケージレジストリに出られないため
// 取得できない（pachislot-db 側で minihtml.py / minixlsx.py を書いたのと同じ事情）。
// 表を読むのに必要なのは「文字・だいたいの位置・ページ」だけなので、そこに絞って書いてある。
// 展開はブラウザ内蔵の DecompressionStream を使う（zlib は同梱しない）。
//
// 対応: FlateDecode / オブジェクトストリーム(ObjStm) / Type0(Identity-H)・単純フォント /
//       ToUnicode CMap（bfchar・bfrange）。
// 非対応: 暗号化PDF・画像だけのPDF（スキャン）・LZW/RunLength。読めないときは warnings に出す。

const latin1 = (u8) => {
  // 大きいPDFでも String.fromCharCode の引数上限に当たらないよう分割する
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return s;
};

async function inflate(u8) {
  for (const fmt of ["deflate", "deflate-raw"]) {
    try {
      const ds = new DecompressionStream(fmt);
      const buf = await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer();
      if (buf.byteLength) return new Uint8Array(buf);
    } catch { /* 次の方式を試す */ }
  }
  return null;
}

/* ───────── オブジェクトの取り出し ───────── */
// PDFは「N G obj … endobj」の並び。xrefを信用せず全部走査する
// （追記保存や壊れたxrefでも読めるほうが、月1回の資料には向いている）。
function scanObjects(raw) {
  const objs = new Map(); // 番号 → { dict, streamStart, streamEnd }
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(raw))) {
    const num = Number(m[1]);
    const bodyStart = m.index + m[0].length;
    const sIdx = raw.indexOf("stream", bodyStart);
    const eIdx = raw.indexOf("endobj", bodyStart);
    const hasStream = sIdx >= 0 && (eIdx < 0 || sIdx < eIdx);
    const dict = raw.slice(bodyStart, hasStream ? sIdx : (eIdx < 0 ? bodyStart : eIdx));
    let streamStart = -1, streamEnd = -1;
    if (hasStream) {
      streamStart = sIdx + 6;
      if (raw[streamStart] === "\r") streamStart++;
      if (raw[streamStart] === "\n") streamStart++;
      const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
      const endTag = raw.indexOf("endstream", streamStart);
      // /Length が直接書かれていればそれを信じる。無い（間接参照）ときだけ endstream を探す。
      streamEnd = len ? streamStart + Number(len[1]) : endTag;
      if (streamEnd < 0 || (endTag >= 0 && streamEnd > endTag + 2)) streamEnd = endTag;
    }
    objs.set(num, { num, dict, streamStart, streamEnd });
    // 次の obj からまた探す。stream の中に "N 0 obj" があっても拾わないよう飛ばす
    if (hasStream && streamEnd > 0) re.lastIndex = streamEnd;
  }
  return objs;
}

const REF = /^\s*(\d+)\s+\d+\s+R\s*$/;
const isRef = (s) => REF.test(String(s || ""));
const refNum = (s) => Number(REF.exec(s)[1]);

// 辞書から「/キー 値」を1つ取り出す。値は数・名前・参照・配列・入れ子辞書のどれか。
function dictGet(dict, key) {
  const i = dict.indexOf("/" + key);
  if (i < 0) return null;
  let j = i + key.length + 1;
  // 別のキーの一部（/Type と /TypeX）を拾わないようにする
  if (/[A-Za-z0-9]/.test(dict[j] || "")) return null;
  while (j < dict.length && /\s/.test(dict[j])) j++;
  const c = dict[j];
  if (c === "[") {
    let depth = 0, k = j;
    for (; k < dict.length; k++) { if (dict[k] === "[") depth++; else if (dict[k] === "]" && --depth === 0) break; }
    return dict.slice(j, k + 1);
  }
  if (c === "<" && dict[j + 1] === "<") {
    let depth = 0, k = j;
    for (; k < dict.length - 1; k++) {
      if (dict[k] === "<" && dict[k + 1] === "<") { depth++; k++; }
      else if (dict[k] === ">" && dict[k + 1] === ">") { if (--depth === 0) { k++; break; } k++; }
    }
    return dict.slice(j, k + 1);
  }
  const rest = dict.slice(j);
  const mr = /^(\d+\s+\d+\s+R)\b/.exec(rest);
  if (mr) return mr[1];
  const mv = /^(\/?[^\s/\[\]<>()]+)/.exec(rest);
  return mv ? mv[1] : null;
}
const refsIn = (v) => [...String(v || "").matchAll(/(\d+)\s+\d+\s+R/g)].map((x) => Number(x[1]));

/* ───────── PDF 全体 ───────── */
class Pdf {
  constructor(raw, bytes) { this.raw = raw; this.bytes = bytes; this.objs = scanObjects(raw); this.cache = new Map(); }

  dictOf(num) { return this.objs.get(num)?.dict || ""; }

  async streamOf(num) {
    if (this.cache.has(num)) return this.cache.get(num);
    const o = this.objs.get(num);
    let out = null;
    if (o && o.streamStart >= 0 && o.streamEnd > o.streamStart) {
      const slice = this.bytes.subarray(o.streamStart, o.streamEnd);
      out = /FlateDecode/.test(o.dict) ? await inflate(slice) : slice;
    }
    this.cache.set(num, out);
    return out;
  }

  // 圧縮オブジェクト（ObjStm）の中身を objs に展開する。
  // 近年のPDFはページやフォントの辞書がここに入っているので、これが無いと何も読めない。
  async expandObjStms() {
    for (const [num, o] of [...this.objs]) {
      if (!/\/Type\s*\/ObjStm/.test(o.dict)) continue;
      const data = await this.streamOf(num);
      if (!data) continue;
      const text = latin1(data);
      const n = Number(dictGet(o.dict, "N")) || 0;
      const first = Number(dictGet(o.dict, "First")) || 0;
      const head = text.slice(0, first).trim().split(/\s+/).map(Number);
      for (let i = 0; i < n; i++) {
        const objNum = head[i * 2], off = head[i * 2 + 1];
        if (!Number.isFinite(objNum) || !Number.isFinite(off)) continue;
        const end = i + 1 < n ? first + head[(i + 1) * 2 + 1] : text.length;
        if (!this.objs.has(objNum)) this.objs.set(objNum, { num: objNum, dict: text.slice(first + off, end), streamStart: -1, streamEnd: -1 });
      }
    }
  }

  // ページの並び。ページツリーを辿り、辿れなければ /Type /Page を番号順に拾う。
  pages() {
    const rootNum = (/\/Root\s+(\d+)\s+\d+\s+R/.exec(this.raw) || [])[1];
    const out = [];
    const seen = new Set();
    const walk = (num, inherited) => {
      if (seen.has(num) || out.length > 500) return;
      seen.add(num);
      const d = this.dictOf(num);
      const inh = { ...inherited };
      for (const k of ["Resources", "MediaBox"]) { const v = dictGet(d, k); if (v) inh[k] = v; }
      if (/\/Type\s*\/Page[^s]/.test(d) || (!/\/Kids/.test(d) && /\/Contents/.test(d))) { out.push({ num, dict: d, inh }); return; }
      for (const kid of refsIn(dictGet(d, "Kids"))) walk(kid, inh);
    };
    if (rootNum) {
      const pagesRef = dictGet(this.dictOf(Number(rootNum)), "Pages");
      if (isRef(pagesRef)) walk(refNum(pagesRef), {});
    }
    if (!out.length) {
      for (const [num, o] of [...this.objs].sort((a, b) => a[0] - b[0])) {
        if (/\/Type\s*\/Page[^s]/.test(o.dict)) out.push({ num, dict: o.dict, inh: {} });
      }
    }
    return out;
  }
}

/* ───────── ToUnicode CMap ───────── */
// 「グリフ番号 → 文字」の対応表。日本語のPDFはこれが無いと数字以外が読めない。
function parseCMap(text) {
  const map = new Map();
  const hex = (h) => parseInt(h, 16);
  const toStr = (h) => {
    let s = "";
    for (let i = 0; i + 3 < h.length + 1; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return s;
  };
  for (const blk of text.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
    for (const m of blk.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) map.set(hex(m[1]), toStr(m[2]));
  }
  for (const blk of text.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
    // <lo> <hi> <dst> と <lo> <hi> [<d1> <d2> …] の2通りがある
    for (const m of blk.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[\s\S]*?\])/g)) {
      const lo = hex(m[1]), hi = hex(m[2]);
      if (m[3][0] === "[") {
        const list = [...m[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => toStr(x[1]));
        for (let c = lo; c <= hi && c - lo < list.length; c++) map.set(c, list[c - lo]);
      } else {
        const base = hex(m[3].slice(1, -1));
        for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, String.fromCharCode(base + (c - lo)));
      }
    }
  }
  return map;
}

async function fontsOf(pdf, resources) {
  const fonts = new Map();
  const fdict = dictGet(resources || "", "Font");
  if (!fdict) return fonts;
  const src = isRef(fdict) ? pdf.dictOf(refNum(fdict)) : fdict;
  for (const m of src.matchAll(/\/([^\s/\[\]<>()]+)\s+(\d+)\s+\d+\s+R/g)) {
    const d = pdf.dictOf(Number(m[2]));
    const two = /\/Subtype\s*\/Type0/.test(d);
    let map = null;
    const tu = dictGet(d, "ToUnicode");
    if (isRef(tu)) {
      const data = await pdf.streamOf(refNum(tu));
      if (data) map = parseCMap(latin1(data));
    }
    fonts.set(m[1], { two, map });
  }
  return fonts;
}

/* ───────── 内容ストリームの読み取り ───────── */
// 文字列リテラル (…) の中はエスケープと括弧の入れ子がある。素直に1文字ずつ見る。
function readLiteral(s, i) {
  let depth = 1, out = "";
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      const n = s[++i];
      const oct = /[0-7]/.test(n) ? (s.slice(i, i + 3).match(/^[0-7]{1,3}/) || [n])[0] : null;
      if (oct) { out += String.fromCharCode(parseInt(oct, 8)); i += oct.length - 1; }
      else out += { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" }[n] || n;
    } else if (c === "(") { depth++; out += c; }
    else if (c === ")") { if (--depth === 0) return [out, i]; out += c; }
    else out += c;
  }
  return [out, i];
}

// 内容ストリームを走らせて、表示された文字とその位置を集める。
// 目的は表の行・列を組み直すことなので、行列は平行移動と拡大だけ見る（回転は使っていない）。
function runContent(text, fonts, items) {
  let tm = [1, 0, 0, 1, 0, 0], tlm = tm.slice();
  const ctmStack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  let font = null, leading = 0;
  const stack = [];
  const mul = (a, b) => [
    a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
  ];
  const numAt = (k) => Number(stack[stack.length - k]) || 0;

  const decode = (s) => {
    if (!font) return s;
    if (font.two) {
      let out = "";
      for (let i = 0; i + 1 < s.length; i += 2) {
        const code = (s.charCodeAt(i) << 8) | s.charCodeAt(i + 1);
        out += font.map?.get(code) ?? "";
      }
      return out;
    }
    if (!font.map) return s;
    let out = "";
    for (let i = 0; i < s.length; i++) out += font.map.get(s.charCodeAt(i)) ?? s[i];
    return out;
  };
  const show = (str) => {
    const t = decode(str);
    if (!t.trim()) return;
    const m = mul(tm, ctm);
    items.push({ str: t, x: m[4], y: m[5] });
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") { const [lit, j] = readLiteral(text, i + 1); stack.push({ str: lit }); i = j; continue; }
    if (c === "<" && text[i + 1] !== "<") {
      const j = text.indexOf(">", i);
      const hex = text.slice(i + 1, j).replace(/\s/g, "");
      let s = "";
      for (let k = 0; k + 1 < hex.length + 1; k += 2) s += String.fromCharCode(parseInt(hex.slice(k, k + 2).padEnd(2, "0"), 16));
      stack.push({ str: s }); i = j; continue;
    }
    if (c === "[") { stack.push("["); continue; }
    if (c === "]") {
      const arr = [];
      while (stack.length && stack[stack.length - 1] !== "[") arr.unshift(stack.pop());
      stack.pop();
      stack.push({ arr }); continue;
    }
    if (/[\s]/.test(c)) continue;
    const tok = /^[^\s\[\]()<>]+/.exec(text.slice(i));
    if (!tok) continue;
    const t = tok[0];
    i += t.length - 1;
    if (/^[-+.\d]/.test(t) && !isNaN(Number(t))) { stack.push(t); continue; }
    if (t[0] === "/") { stack.push(t); continue; }
    switch (t) {
      case "q": ctmStack.push(ctm.slice()); break;
      case "Q": ctm = ctmStack.pop() || [1, 0, 0, 1, 0, 0]; break;
      case "cm": ctm = mul([numAt(6), numAt(5), numAt(4), numAt(3), numAt(2), numAt(1)], ctm); break;
      case "BT": tm = [1, 0, 0, 1, 0, 0]; tlm = tm.slice(); break;
      case "ET": break;
      case "Tf": font = fonts.get(String(stack[stack.length - 2] || "").slice(1)) || null; break;
      case "TL": leading = numAt(1); break;
      case "Td": tlm = mul([1, 0, 0, 1, numAt(2), numAt(1)], tlm); tm = tlm.slice(); break;
      case "TD": leading = -numAt(1); tlm = mul([1, 0, 0, 1, numAt(2), numAt(1)], tlm); tm = tlm.slice(); break;
      case "Tm": tlm = [numAt(6), numAt(5), numAt(4), numAt(3), numAt(2), numAt(1)]; tm = tlm.slice(); break;
      case "T*": tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice(); break;
      case "Tj": show(stack[stack.length - 1]?.str ?? ""); break;
      case "'": tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice(); show(stack[stack.length - 1]?.str ?? ""); break;
      case '"': tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice(); show(stack[stack.length - 1]?.str ?? ""); break;
      case "TJ": {
        const arr = stack[stack.length - 1]?.arr || [];
        // 配列の数値は字送りの微調整。位置は先頭だけで足りるので、文字だけつないで1つにする
        show(arr.filter((x) => x && x.str != null).map((x) => x.str).join(""));
        break;
      }
      default: break;
    }
    if (!/^(q|Q|\[|\])$/.test(t)) stack.length = 0;
  }
}

/* ───────── 入口 ───────── */
export async function extractPdfText(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const raw = latin1(bytes);
  const warnings = [];
  if (!/^%PDF-/.test(raw.slice(0, 8))) return { pages: [], warnings: ["PDFではないようです"] };
  if (/\/Encrypt\b/.test(raw)) warnings.push("暗号化されたPDFです。読めない部分があるかもしれません");
  if (typeof DecompressionStream === "undefined") return { pages: [], warnings: ["このブラウザではPDFを展開できません（更新してください）"] };

  const pdf = new Pdf(raw, bytes);
  await pdf.expandObjStms();
  const pages = [];
  for (const pg of pdf.pages()) {
    const items = [];
    const res = dictGet(pg.dict, "Resources") || pg.inh.Resources;
    const resDict = isRef(res) ? pdf.dictOf(refNum(res)) : (res || "");
    const fonts = await fontsOf(pdf, resDict);
    for (const num of refsIn(dictGet(pg.dict, "Contents"))) {
      const data = await pdf.streamOf(num);
      if (data) runContent(latin1(data), fonts, items);
    }
    const box = (dictGet(pg.dict, "MediaBox") || pg.inh.MediaBox || "[0 0 595 842]").match(/-?[\d.]+/g) || [];
    pages.push({ items, width: Number(box[2]) || 595, height: Number(box[3]) || 842 });
  }
  if (!pages.length) warnings.push("ページが読めませんでした");
  else if (!pages.some((p) => p.items.length)) warnings.push("文字が入っていません（画像だけのPDFかもしれません）");
  return { pages, warnings };
}

// 位置の近い文字をまとめて「行」にする。表を読み直すための下ごしらえ。
// yは下から上なので大きい順、xは左から右。
export function toRows(items, yTol = 3) {
  const rows = [];
  for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.find((r) => Math.abs(r.y - it.y) <= yTol);
    if (row) { row.cells.push(it); row.y = (row.y * row.cells.length + it.y) / (row.cells.length + 1); }
    else rows.push({ y: it.y, cells: [it] });
  }
  for (const r of rows) r.cells.sort((a, b) => a.x - b.x);
  return rows;
}

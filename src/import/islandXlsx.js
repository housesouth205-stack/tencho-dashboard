// 島図Excel パーサ（初回取込）。「島図」シートから台番の座標＋設備、
// 「設定表」シートから台番→機種名(正)を取り、重複台番を機種名照合で実位置に確定。
import { getXLSX } from "../util/sheetjs.js";

const FIX_KINDS = [
  [/女性トイレ/, "toilet_f", "女性トイレ"], [/男性トイレ/, "toilet_m", "男性トイレ"], [/トイレ/, "toilet", "トイレ"],
  [/出入口/, "exit", "出入口"], [/喫煙/, "smoking", "喫煙所"], [/精算/, "settle", "精算機"],
  [/景品/, "counter", "景品カウンター"], [/^MC$/, "mc", "MC"],
];

function norm(s) {
  if (s == null) return "";
  let t = String(s).replace(/[Ａ-Ｚａ-ｚ０-９／]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  return t.replace(/[\s　/・!！]/g, "").toUpperCase();
}
const isInt = (v) => typeof v === "number" && Number.isInteger(v);

// 設定表: 整数セルの右隣が文字列なら (台番→機種名)
function parseSetup(aoa) {
  const m = new Map();
  for (const row of aoa) {
    for (let c = 0; c < row.length - 1; c++) {
      const v = row[c], nx = row[c + 1];
      if (isInt(v) && v >= 1 && v <= 999 && typeof nx === "string" && nx.trim() && !m.has(v)) m.set(v, nx.trim());
    }
  }
  return m;
}

function rowOfText(aoa, re) {
  for (let r = 0; r < aoa.length; r++) if (aoa[r].some((c) => typeof c === "string" && re.test(c))) return r;
  return -1;
}

export async function parseIslandXlsx(arrayBuffer) {
  const XLSX = await getXLSX();
  const wb = XLSX.read(arrayBuffer, { type: "array" });
  const mapSheet = wb.Sheets["島図"] || wb.Sheets[wb.SheetNames[0]];
  const setSheet = wb.Sheets["設定表"];
  const warnings = [];
  const aoaMap = XLSX.utils.sheet_to_json(mapSheet, { header: 1, raw: true, blankrows: true, defval: null });
  const setupMap = setSheet ? parseSetup(XLSX.utils.sheet_to_json(setSheet, { header: 1, raw: true, defval: null })) : new Map();
  if (!setupMap.size) warnings.push("「設定表」シートが読めませんでした（機種名照合なしで座標を取ります）");

  // フロア領域
  const f1 = rowOfText(aoaMap, /1F.?フロア/);
  const fb = rowOfText(aoaMap, /BF.?フロア/);
  const legend = rowOfText(aoaMap, /撤去台/);
  const floor1 = [f1 < 0 ? 0 : f1, fb < 0 ? aoaMap.length : fb - 1];
  const floorB = fb < 0 ? null : [fb, (legend < 0 ? aoaMap.length : legend) - 1];
  const floorOf = (r) => (r >= floor1[0] && r <= floor1[1] ? "1F" : floorB && r >= floorB[0] && r <= floorB[1] ? "BF" : null);
  const floorStart = (fl) => (fl === "1F" ? floor1[0] : floorB[0]);

  const at = (r, c) => (r >= 0 && r < aoaMap.length && c >= 0 ? aoaMap[r][c] ?? null : null);
  const adjMachine = (r, c) => {
    for (const rr of [r - 1, r + 1]) { const v = at(rr, c); if (typeof v === "string" && v.trim()) return v.trim(); }
    return null;
  };

  // 台番候補セル
  const valid = (v) => isInt(v) && (setupMap.size ? setupMap.has(v) : v >= 1 && v <= 999);
  const cands = new Map();
  for (let r = 0; r <= (floorB ? floorB[1] : floor1[1]); r++) {
    const fl = floorOf(r);
    if (!fl) continue;
    for (let c = 0; c < (aoaMap[r] ? aoaMap[r].length : 0); c++) {
      const v = at(r, c);
      if (valid(v)) (cands.get(v) || cands.set(v, []).get(v)).push({ fl, r, c, m: adjMachine(r, c) });
    }
  }

  // 重複解決: 設定表の機種名に一致する候補を実位置に。
  const taken = new Set();
  const layout = [];
  const resolve = (dai, pick) => { taken.add(pick.r + "," + pick.c); layout.push({ dai_no: dai, floor: pick.fl, grid_row: pick.r - floorStart(pick.fl), grid_col: pick.c }); };
  for (const [dai, lst] of cands) {
    const target = norm(setupMap.get(dai));
    const match = target ? lst.filter((x) => x.m && norm(x.m) === target) : [];
    if (match.length) resolve(dai, match[0]);
    else if (lst.length === 1) resolve(dai, lst[0]);
    else {
      const free = lst.filter((x) => !taken.has(x.r + "," + x.c));
      const pick = free.find((x) => !x.m) || free[0] || lst[0];
      resolve(dai, pick);
      warnings.push(`台${dai}: 機種名照合できず暫定配置`);
    }
  }

  // 設備（結合セル＋単独セル）
  const merges = mapSheet["!merges"] || [];
  const fixtures = [];
  const usedFix = new Set();
  const kindOf = (txt) => { for (const [re, kind, label] of FIX_KINDS) if (re.test(txt)) return { kind, label }; return null; };
  for (const mg of merges) {
    const r = mg.s.r, c = mg.s.c, fl = floorOf(r);
    const v = at(r, c);
    if (!fl || typeof v !== "string") continue;
    const k = kindOf(v.trim());
    if (!k) continue;
    fixtures.push({ floor: fl, grid_row: r - floorStart(fl), grid_col: c, row_span: mg.e.r - mg.s.r + 1, col_span: mg.e.c - mg.s.c + 1, kind: k.kind, label: k.label });
    for (let rr = mg.s.r; rr <= mg.e.r; rr++) for (let cc = mg.s.c; cc <= mg.e.c; cc++) usedFix.add(rr + "," + cc);
  }
  for (let r = 0; r <= (floorB ? floorB[1] : floor1[1]); r++) {
    const fl = floorOf(r); if (!fl) continue;
    for (let c = 0; c < (aoaMap[r] ? aoaMap[r].length : 0); c++) {
      if (usedFix.has(r + "," + c)) continue;
      const v = at(r, c);
      if (typeof v !== "string") continue;
      const k = kindOf(v.trim());
      if (k) fixtures.push({ floor: fl, grid_row: r - floorStart(fl), grid_col: c, row_span: 1, col_span: 1, kind: k.kind, label: k.label });
    }
  }

  const models = Object.fromEntries(setupMap);
  return { layout, fixtures, models, warnings, counts: { total: layout.length, f1: layout.filter((l) => l.floor === "1F").length, bf: layout.filter((l) => l.floor === "BF").length } };
}

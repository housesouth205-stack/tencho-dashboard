// 月次会議サマリーExcel（TOHO_月次会議サマリー_YYYY-MM.xlsx）の読み取り。
// 会議資料PDFから作ったブックで、損益・経費明細・途中経過・レート別・機械入替・4店比較・所見が入っている。
// セル番地は決め打ちせず、見出しの文字（「① 」「項目」「所見・改善案」など）から表を探す。
// ブックの作りが少し変わっても、見出しが残っていれば読めるようにするため。
import { COLS, parseMonthLabel } from "./plCsv.js";

const s = (v) => (v == null ? "" : String(v).trim());
const n = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const t = String(v).replace(/[,\s￥¥]/g, "").replace(/^▲/, "-");
  const x = Number(t);
  return t !== "" && isFinite(x) ? x : null;
};

// シート全体の中から、正規表現に合う最初のセルを探す
function findCell(aoa, re, col = null) {
  for (let r = 0; r < aoa.length; r++) {
    const row = aoa[r] || [];
    for (let c = 0; c < row.length; c++) {
      if (col != null && c !== col) continue;
      if (re.test(s(row[c]))) return { r, c };
    }
  }
  return null;
}

// 見出しの下にある表。最初に「左端と右隣が両方埋まっている行」を見出し行とし、
// 左端が空になるまでを中身とする。見出しと同じ文字が2列目に出たら、そこから別の表とみなす
// （③レート別は「8月 月間」「9月 16日まで」の表が空行なしで続いている）。
function blocks(aoa, anchor, { maxCols = 8 } = {}) {
  if (!anchor) return [];
  const { c } = anchor;
  const cell = (r, i) => (aoa[r] || [])[c + i];
  let r = anchor.r + 1;
  while (r < aoa.length && !(cell(r, 0) != null && cell(r, 1) != null)) r++;
  const out = [];
  let cur = null;
  for (; r < aoa.length && cell(r, 0) != null; r++) {
    const row = Array.from({ length: maxCols }, (_, i) => cell(r, i) ?? null);
    if (!cur || (cur.header[1] != null && s(row[1]) === s(cur.header[1]) && n(row[1]) == null)) {
      let w = maxCols; while (w > 1 && row[w - 1] == null) w--;
      cur = { header: row.slice(0, w).map(s), rows: [] };
      out.push(cur);
      continue;
    }
    cur.rows.push(row.slice(0, cur.header.length));
  }
  return out;
}

// 所見・改善案：見出し（視点・コメント・信頼度）の下を読み、区切りの行（左端だけ）を節にする
function notesFrom(aoa, anchor) {
  const b = blocks(aoa, anchor, { maxCols: 3 })[0];
  if (!b) return [];
  const out = [];
  let sec = null;
  for (const [view, comment, conf] of b.rows) {
    if (comment == null && conf == null) { sec = { title: s(view), items: [] }; out.push(sec); continue; }
    if (!sec) { sec = { title: "", items: [] }; out.push(sec); }
    sec.items.push({ view: s(view), comment: s(comment), conf: s(conf) });
  }
  return out;
}

const sheetBy = (wb, re) => wb.SheetNames.find((nm) => re.test(nm));

// 店舗別営業実績表：期間（当月／累計）×項目 → 予算・実績・前年（千円。売上対人件費だけ比率）
function parsePl(XLSX, wb, warnings) {
  const nm = sheetBy(wb, /_PL$/);
  if (!nm) { warnings.push("「◯◯_PL」シートが見つかりません（損益が出せません）"); return null; }
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[nm], { header: 1, raw: true, defval: null });
  const h = findCell(aoa, /^項目$/);
  if (!h) { warnings.push(`${nm}: 「項目」の見出しが見つかりません`); return null; }
  const head = (aoa[h.r] || []).map(s);
  const col = (name) => head.indexOf(name);
  const iP = h.c - 1, iB = col("予算"), iA = col("実績"), iY = col("前年実績");
  const out = { store: nm.replace(/_PL$/, ""), month: [], cum: [] };
  for (let r = h.r + 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const per = s(row[iP]), item = s(row[h.c]);
    if (!item || (per !== "当月" && per !== "累計")) continue;
    (per === "当月" ? out.month : out.cum).push({ item, budget: n(row[iB]), actual: n(row[iA]), prev: n(row[iY]) });
  }
  return out;
}

// 一般管理費の明細：明細・小計・合計の行（千円）
function parseSga(XLSX, wb, warnings) {
  const nm = sheetBy(wb, /_経費明細$/);
  if (!nm) { warnings.push("「◯◯_経費明細」シートが見つかりません（経費の明細が出せません）"); return []; }
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[nm], { header: 1, raw: true, defval: null });
  const h = findCell(aoa, /^行種別$/);
  if (!h) { warnings.push(`${nm}: 「行種別」の見出しが見つかりません`); return []; }
  const head = (aoa[h.r] || []).map(s);
  const col = (name) => head.indexOf(name);
  const idx = { kind: col("行種別"), group: col("区分"), name: col("勘定科目"), budget: col("予算"), actual: col("実績"), prev: col("前年実績"),
    budgetCum: col("予算累計"), actualCum: col("実績累計"), prevCum: col("前年実績累計") };
  const out = [];
  for (let r = h.r + 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const kind = s(row[idx.kind]);
    if (!["明細", "小計", "合計"].includes(kind)) { if (out.length && !kind) break; continue; }
    const v = (k) => n(row[idx[k]]);
    out.push({ kind, group: s(row[idx.group]), name: s(row[idx.name]),
      budget: v("budget"), actual: v("actual"), prev: v("prev"), budgetCum: v("budgetCum"), actualCum: v("actualCum"), prevCum: v("prevCum") });
  }
  return out;
}

// 取込用シート → pl_month の行（円）。plCsv と同じ列名の対応表を使う
function parseImportSheet(XLSX, wb, warnings) {
  const nm = sheetBy(wb, /取込用/);
  if (!nm) return [];
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[nm], { header: 1, raw: true, defval: null });
  const h = findCell(aoa, /^月度$/);
  if (!h) return [];
  const head = (aoa[h.r] || []).map(s);
  const iSrc = head.indexOf("出典ファイル");
  const rows = [];
  for (let r = h.r + 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const ym = parseMonthLabel(row[h.c]);
    if (!ym) continue;
    const rec = { ym, kind: "actual", label: s(row[h.c]), src: iSrc >= 0 ? s(row[iSrc]) || null : null };
    for (const [key, names] of COLS) {
      const i = head.findIndex((x) => names.includes(x));
      if (i < 0) continue;
      const v = n(row[i]);
      // 元資料は千円単位。アプリ内の金額は円に揃えているので1000倍する
      rec[key] = v == null ? null : Math.round(v * 1000);
    }
    rows.push(rec);
  }
  if (!rows.length) warnings.push(`${nm}: 月度の行がありません`);
  return rows;
}

// 経費明細の予算から、pl_month の予算行（円）を作る。予算の推移も後で見られるように
function budgetRow(ym, label, pl, sga) {
  if (!pl) return null;
  const m = (item) => pl.month.find((x) => x.item === item)?.budget ?? null;
  const sub = (g) => sga.find((x) => x.kind === "小計" && x.group === g)?.budget ?? null;
  const item = (nm) => sga.find((x) => x.kind === "明細" && x.name === nm)?.budget ?? null;
  const k = (v) => (v == null ? null : Math.round(v * 1000));
  const kyuyo = [item("従業員給料"), item("外注給与")].filter((v) => v != null);
  return {
    ym, kind: "budget", label,
    sales: k(m("総売上高")), cogs: k(m("売上原価")), gross: k(m("売上総利益")), sga: k(m("一般管理費")), op: k(m("営業利益")), ordinary: k(m("経常利益")),
    jinken: k(sub("人件費")), hanbai: k(sub("販売費")), tatemono: k(sub("建物管理費")), koukyou: k(sub("公共料金")), shokeihi: k(sub("一般諸経費")), genka: k(item("減価償却費")),
    kyuyo: kyuyo.length ? k(kyuyo.reduce((a, b) => a + b, 0)) : null,
    kigu: k(item("消耗器具費")), suidou: k(item("水道光熱費")), yachin: k(item("地代家賃")), hoshu: k(item("保守料")), shuzen: k(item("修繕費")),
  };
}

/**
 * @returns {{ym, summary, plRows, warnings}}
 *   summary は app_setting に丸ごと保存して経費タブで描く（金額は資料のままの単位）。
 *   plRows は pl_month に入れる行（円）。月次の推移グラフはこちらを使う。
 */
export function parseMeetingXlsx(XLSX, arrayBuffer, filename = "") {
  const wb = XLSX.read(arrayBuffer, { type: "array" });
  const warnings = [];
  const sumName = sheetBy(wb, /^サマリー$/) || wb.SheetNames[0];
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sumName], { header: 1, raw: true, defval: null });
  const textAt = (pos) => (pos ? s(aoa[pos.r][pos.c]) : "");
  const title = textAt(findCell(aoa, /月次会議サマリー/));
  const tm = title.match(/令和\s*(\d+)\s*年\s*(\d+)\s*月/);
  const ym = tm ? parseMonthLabel(`令和${tm[1]}年${tm[2]}月`) : null;
  if (!ym) throw new Error(`${filename}: 表題から月度が読めません（「令和◯年◯月度」が見つかりません）`);

  const at = (re) => findCell(aoa, re);
  // ②〜④の見出しは所見の列にも同じ文字で出てくるので、①と同じ列に限って探す
  const left = at(/^① /)?.c ?? null;
  const sec2 = findCell(aoa, /^② /, left), sec3 = findCell(aoa, /^③ /, left), sec4 = findCell(aoa, /^④ /, left);
  const pl = parsePl(XLSX, wb, warnings);
  const sga = parseSga(XLSX, wb, warnings);
  const summary = {
    ym, title, file: filename, importedAt: new Date().toISOString(),
    note: textAt(at(/^締め：/)),
    check: textAt(at(/検算/)),
    pl, sga,
    progress: blocks(aoa, sec2)[0] || null,
    progressTitle: textAt(sec2),
    rates: blocks(aoa, sec3),
    ratesTitle: textAt(sec3),
    machines: blocks(aoa, sec4)[0] || null,
    stores: blocks(aoa, at(/^■\s*4店比較/), { maxCols: 6 })[0] || null,
    notes: notesFrom(aoa, at(/所見・改善案（(?!4店)/)),
    storeNotes: notesFrom(aoa, at(/所見・改善案（4店/)),
  };
  if (!summary.notes.length) warnings.push("所見・改善案が見つかりませんでした");
  const plRows = parseImportSheet(XLSX, wb, warnings);
  const label = `令和${tm[1]}年${tm[2]}月`;
  const b = budgetRow(ym, label, pl, sga);
  if (b) plRows.push(b);
  return { ym, summary, plRows, warnings };
}

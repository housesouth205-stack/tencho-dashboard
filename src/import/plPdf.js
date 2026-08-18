// 会議資料（店舗別営業実績表）のPDFから月次の損益・経費を読む。
//
// これまでは資料を見ながら手でCSVを作っていた。PDFのまま入れられるようにする。
// 表の作りは資料によって変わるので、決め打ちの座標では読まない。
// 「費目の名前が書いてある行」を探し、その行に並んだ数字を月の列に割り当てる。
//
// 読めたものは必ず確認画面に出してから保存する。取込タブ側でそうしている。
import { extractPdfText, toRows } from "./pdfText.js";
import { COLS, parseMonthLabel } from "./plCsv.js";

// 表記ゆれを吸収した照合キー。全角半角・空白・記号を落とす。
const key = (s) => String(s || "").normalize("NFKC").replace(/[\s　・（）()［］\[\]「」【】:：]/g, "").replace(/合計$/, "");

// 金額らしいセルか。△▲や(1,234)のマイナス表記も受ける。
const NUMRE = /^[△▲\-(]?\s*[\d,]+(?:\.\d+)?\s*\)?$/;
function toNum(s) {
  const t = String(s || "").normalize("NFKC").replace(/[\s￥¥円]/g, "");
  if (!NUMRE.test(t)) return null;
  const neg = /^[△▲\-(]/.test(t);
  const n = Number(t.replace(/[△▲\-()]/g, "").replace(/,/g, ""));
  if (!isFinite(n)) return null;
  return neg ? -n : n;
}

// セルは1文字ずつ別々に来ることがある（PDFは字送りごとに描くため）。
// 近い文字はつないで1つの語にする。
function words(cells, gap = 6) {
  const out = [];
  for (const c of cells) {
    const last = out[out.length - 1];
    if (last && c.x - last.xEnd <= gap) { last.str += c.str; last.xEnd = c.x + c.str.length * 4.5; }
    else out.push({ str: c.str, x: c.x, xEnd: c.x + c.str.length * 4.5 });
  }
  return out;
}

/**
 * @returns {{rows: object[], warnings: string[], sheets: object[]}}
 *   rows の金額は資料に書かれた数字のまま（単位の掛け算は呼び出し側でする）。
 *   sheets は確認画面に出すための「読めたもの」の一覧。
 */
export async function parsePlPdf(arrayBuffer, filename = "") {
  const { pages, warnings } = await extractPdfText(arrayBuffer);
  const found = new Map(); // ym → { ym, label, vals: {key: 円} }
  const sheets = [];

  for (const [pi, page] of pages.entries()) {
    const rows = toRows(page.items).map((r) => ({ y: r.y, w: words(r.cells) }));
    const text = rows.map((r) => r.w.map((x) => x.str).join(" ")).join("\n");

    // 月の見出し。1行に複数の月が並ぶ資料（月が列）と、ページ全体で1か月の資料がある。
    let months = [];
    for (const r of rows) {
      const hit = r.w.map((w) => ({ ym: parseMonthLabel(w.str), x: w.x, label: w.str })).filter((h) => h.ym);
      if (hit.length > months.length) months = hit;
    }
    if (!months.length) {
      // ページのどこかに「令和7年1月度」のような1つだけの月があればそれを使う。
      // 「令和」は途中で文字が分かれることがあるので、まとめて拾えるようにしておく。
      const m = text.match(/(?:令和|[RrＲｒ])\s*\d{1,2}\s*[年.\-/]\s*\d{1,2}|\d{4}\s*[年.\-/]\s*\d{1,2}/);
      const ym = m ? parseMonthLabel(m[0]) : null;
      if (ym) months = [{ ym, x: null, label: m[0].replace(/\s+/g, "") }];
    }
    // 1か月ぶんの資料は「予算／実績」が横に並ぶ。見出しを見つけて実績の列を選ぶ。
    // 見つからないまま先頭の数字を取ると、予算を実績として取り込んでしまう。
    if (months.length === 1 && months[0].x == null) {
      for (const r of rows) {
        const hit = r.w.find((w) => /^(実績|当月実績|当月)$/.test(key(w.str)));
        if (hit) { months[0].x = hit.x; break; }
      }
    }
    const rowsOut = [];
    let ambiguous = 0;
    if (months.length) {
      for (const r of rows) {
        const label = r.w.find((w) => toNum(w.str) == null && w.str.trim());
        if (!label) continue;
        const k = key(label.str);
        const col = COLS.find(([, names]) => names.some((n) => k === key(n) || k.startsWith(key(n))));
        if (!col) continue;
        const nums = r.w.map((w) => ({ v: toNum(w.str), x: w.x })).filter((n) => n.v != null);
        if (!nums.length) continue;
        for (const [i, mo] of months.entries()) {
          // 月が列に並ぶ資料は「いちばん近い列」、1か月だけの資料は先頭の数字を使う。
          if (mo.x == null && nums.length > 1) ambiguous++;
          const pick = mo.x == null ? nums[0]
            : nums.reduce((a, b) => (Math.abs(b.x - mo.x) < Math.abs(a.x - mo.x) ? b : a));
          if (pick == null) continue;
          const cell = found.get(mo.ym) || { ym: mo.ym, label: mo.label, vals: {} };
          // 同じ費目が2回出てきたら先に読めたほうを残す（合計行と内訳行が同名のことがある）
          // 単位（千円か円か）は資料によって違う。ここでは資料の数字のまま持ち、
          // 確認画面で選んでもらってから掛ける（勝手に1000倍して桁が狂うのを防ぐ）。
          if (cell.vals[col[0]] == null) cell.vals[col[0]] = pick.v;
          found.set(mo.ym, cell);
          rowsOut.push({ label: label.str, field: col[0], month: mo.ym, value: pick.v, col: i });
        }
      }
    }
    if (ambiguous) warnings.push(`${pi + 1}ページ: 1行に数字が複数あり、どれが実績か決められませんでした（左端の数字を取りました）`);
    sheets.push({ page: pi + 1, months: months.map((m) => m.label), hits: rowsOut.length,
      lines: rows.map((r) => r.w.map((x) => x.str).join("  ")).filter((t) => t.trim()) });
  }

  const rows = [...found.values()]
    .sort((a, b) => a.ym.localeCompare(b.ym))
    .map((c) => ({ ym: c.ym, kind: "actual", label: c.label, src: filename, ...c.vals }));

  if (!rows.length) warnings.push("月度と費目の組み合わせが見つかりませんでした");
  for (const r of rows) {
    const parts = ["jinken", "hanbai", "tatemono", "koukyou", "shokeihi", "genka"];
    if (r.sga != null && parts.every((k) => r[k] != null)) {
      const sum = parts.reduce((a, k) => a + r[k], 0);
      if (sum !== r.sga) warnings.push(`${r.label}: 内訳の合計 ${sum.toLocaleString()} が一般管理費 ${r.sga.toLocaleString()} と合いません（資料の単位のまま）`);
    }
  }
  return { rows, warnings, sheets };
}

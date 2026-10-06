// 列の選び直し画面。見出しの言葉で列が決まらなかった表を、人に選んでもらって読む。
//
// ホールコンの機種や出力設定が変わると、見出しの言い方が変わる（「投入」→「IN」など）。
// そのたびにプログラムへ呼び方を足すのでは、資料が届いた日に取り込めない。
// 画面で「どの列が何か」を選べば読めるようにし、選んだ対応は覚えておく
// （同じ見出しの表は次から聞かずに読む）。
import { el, modal } from "../../util/dom.js";
import { normKey, matchColumns } from "../../import/anyTable.js";

const STORE_KEY = "import:colmap";
// 見出しの並びで同じ表かを見分ける
const signature = (row) => row.map(normKey).join("|");

function loadAll() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); } catch { return {}; }
}
function saveOne(kind, headerRowCells, map) {
  try {
    const all = loadAll();
    all[kind] = { ...(all[kind] || {}), [signature(headerRowCells)]: map };
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch { /* 覚えられなくても取込はできる（次回また聞くだけ） */ }
}

// 前に選んだ対応がこの表に使えるか。見出し行がまったく同じなら使う。
export function rememberedMap(kind, rows) {
  const saved = loadAll()[kind] || {};
  for (let i = 0; i < Math.min(30, rows.length); i++) {
    const m = saved[signature(rows[i])];
    if (m) return { headerRow: i, map: m };
  }
  return null;
}

/**
 * @param fields [{ key, label, required?, names }]
 * @returns {Promise<{headerRow: number, map: object} | null>} やめたら null
 */
export function askColumnMap({ kind, title, rows, fields, note }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };

    // 見出し行の候補。先頭から文字の多い行を既定にする
    const maxRow = Math.min(15, rows.length);
    let headerRow = 0;
    for (let i = 0; i < maxRow; i++) {
      if (rows[i].filter((c) => c && isNaN(Number(String(c).replace(/,/g, "")))).length >
          rows[headerRow].filter((c) => c && isNaN(Number(String(c).replace(/,/g, "")))).length) headerRow = i;
    }
    const width = Math.max(...rows.slice(0, 40).map((r) => r.length), 1);
    const colName = (j) => {
      const h = rows[headerRow]?.[j];
      return `${String.fromCharCode(65 + (j % 26))}${j >= 26 ? Math.floor(j / 26) : ""}列${h ? `「${h}」` : ""}`;
    };

    const headSel = el("select", { class: "inp" });
    for (let i = 0; i < maxRow; i++) {
      headSel.appendChild(el("option", { value: i, text: `${i + 1}行目: ${rows[i].filter(Boolean).slice(0, 5).join(" / ").slice(0, 60)}` }));
    }
    headSel.value = String(headerRow);

    const sels = {};
    const grid = el("div", { style: "display:grid;grid-template-columns:auto 1fr;gap:6px 10px;align-items:center" });
    const preview = el("div", { class: "table-wrap", style: "max-height:30vh;overflow:auto" });

    const drawSelects = () => {
      grid.replaceChildren();
      const guess = matchColumns(rows[headerRow] || [], fields);
      for (const f of fields) {
        const s = el("select", { class: "inp" }, [el("option", { value: "", text: f.required ? "（選んでください）" : "（なし）" })]);
        for (let j = 0; j < width; j++) s.appendChild(el("option", { value: j, text: colName(j) }));
        if (guess[f.key] != null) s.value = String(guess[f.key]);
        s.addEventListener("change", drawPreview);
        sels[f.key] = s;
        grid.append(el("label", { style: "white-space:nowrap;font-weight:" + (f.required ? 700 : 400), text: f.label + (f.required ? " ＊" : "") }), s);
      }
    };
    // 選んだ列で実際にどう読めるかを数行だけ見せる（列を1つずらして選んでも気づける）
    const drawPreview = () => {
      // 選んだ項目だけ並べる（全項目だと列が細くなって数字が読めない）
      const use = fields.filter((f) => f.required || sels[f.key].value !== "");
      const t = el("table", { class: "grid compact mono" });
      t.appendChild(el("thead", {}, el("tr", {}, use.map((f) => el("th", { style: "white-space:nowrap", text: f.label })))));
      const tb = el("tbody");
      for (const r of rows.slice(headerRow + 1, headerRow + 6)) {
        tb.appendChild(el("tr", {}, use.map((f) => el("td", { style: "white-space:nowrap", text: sels[f.key].value === "" ? "—" : String(r[Number(sels[f.key].value)] ?? "") }))));
      }
      t.appendChild(tb);
      preview.replaceChildren(t);
    };
    headSel.addEventListener("change", () => { headerRow = Number(headSel.value); drawSelects(); drawPreview(); });
    drawSelects(); drawPreview();

    const err = el("div", { class: "hint", style: "color:#e35d6a" });
    const remember = el("input", { type: "checkbox", checked: "" });
    const close = modal(title, el("div", { class: "col", style: "gap:10px;min-width:min(640px,100%)" }, [
      el("p", { class: "hint", style: "margin:0", text: note || "見出しの言葉から列を決められませんでした。どの列が何かを選んでください。＊は必須です。" }),
      el("div", { class: "row", style: "gap:8px;align-items:center;flex-wrap:wrap" }, [el("label", { class: "lbl", style: "margin:0", text: "見出しの行" }), headSel]),
      grid,
      el("div", { class: "hint", text: "読み取りの見本（先頭5行）" }),
      preview,
      el("label", { class: "row", style: "gap:6px;align-items:center;font-size:12.5px" }, [remember, "同じ見出しの表は次からこの対応で読む（この端末に保存）"]),
      err,
    ]), el("div", { class: "row", style: "justify-content:flex-end;gap:8px;margin-top:12px" }, [
      el("button", { class: "btn ghost", text: "やめる", onclick: () => close() }),
      el("button", { class: "btn primary", text: "この対応で読む", onclick: () => {
        const map = {};
        for (const f of fields) if (sels[f.key].value !== "") map[f.key] = Number(sels[f.key].value);
        const lack = fields.filter((f) => f.required && map[f.key] == null).map((f) => f.label);
        if (lack.length) { err.textContent = `「${lack.join("」「")}」の列を選んでください`; return; }
        if (remember.checked) saveOne(kind, rows[headerRow], map);
        finish({ headerRow, map });
        close();
      } }),
    ]), { onClose: () => finish(null) });
  });
}

// 設定投入の島図（コンパクト）モジュール。画面（クリック編集可）・印刷共用。
import { el, floorBar, floorSplit } from "../../util/dom.js";
import { num } from "../../util/format.js";

export const SET_COLORS = { 1: "#eef1f6", 2: "#e9d8c8", 3: "#dfe4ec", 4: "#ffe08a", 5: "#ffc46b", 6: "#e9c8ff" };

// 台のある行・列だけ残し、間の空きは細い通路に圧縮（島図ビューと同方式）。
function pack(sorted, content, gap) {
  const map = new Map(); const tpl = []; let prev = null;
  for (const o of sorted) { if (prev !== null && o - prev !== 1) tpl.push(gap); map.set(o, tpl.length); tpl.push(content); prev = o; }
  return { map, tpl };
}

// 凡例（設定別台数）
export function buildLegend(placement) {
  const counts = {};
  for (const p of placement) counts[p.setting] = (counts[p.setting] || 0) + 1;
  return el("div", { class: "row", style: "display:flex;gap:12px;flex-wrap:wrap;font-size:12px;align-items:center" },
    [1, 2, 3, 4, 5, 6].filter((s) => counts[s]).map((s) => el("span", { style: "display:inline-flex;gap:4px;align-items:center" }, [
      el("span", { style: `display:inline-block;width:14px;height:14px;border-radius:3px;border:1px solid var(--line);background:${SET_COLORS[s]}` }),
      el("span", { text: `設定${s} ${num(counts[s])}台` }),
    ])));
}

// 1フロア分の島図グリッド。全台を描画。
// opts.editable(dai)=trueの台はクリック可（onCellClick(dai)を呼ぶ）。編集不可の台は薄表示。
export function buildPlacementFloor(layout, placement, floor, opts = {}) {
  const { onCellClick, editable, cellW } = opts;
  const pmap = new Map(placement.map((p) => [p.dai, p]));
  const cells = layout.filter((l) => l.floor === floor);
  // cellW を指定すると固定幅＋横スクロール（スマホ用）。既定は画面幅にフィット。
  const R = pack([...new Set(cells.map((c) => c.grid_row))].sort((a, b) => a - b), cellW ? "56px" : "46px", "8px");
  const C = pack([...new Set(cells.map((c) => c.grid_col))].sort((a, b) => a - b), cellW || "minmax(0,1fr)", "6px");
  const grid = el("div", { style: `display:grid;gap:2px;grid-template-columns:${C.tpl.join(" ")};grid-template-rows:${R.tpl.join(" ")};width:${cellW ? "max-content" : "100%"}` });
  for (const c of cells) {
    const p = pmap.get(c.dai_no);
    const canEdit = !!(p && editable && editable(c.dai_no));
    // 前日比較モード: dim=据え置き(白で目立たなくする) / changed=変更台(色付き・太枠・▲▼)
    let bg, border, extra = "";
    if (!p) { bg = "var(--panel-3)"; border = "1px solid var(--line)"; }
    else if (p.dim) { bg = "#fff"; border = "1px solid var(--line)"; }
    else if (p.changed) {
      const up = p.setting > p.prevSetting;
      bg = SET_COLORS[p.setting]; border = "2.5px solid " + (up ? "#e5484d" : "#3b82f6");
      extra = "box-shadow:0 0 0 1px " + (up ? "#e5484d" : "#3b82f6") + ";";
    } else {
      bg = SET_COLORS[p.setting]; border = "1px solid " + (p.color || "var(--line)");
      if (p.setting >= 4) extra = "box-shadow:0 0 0 1px " + (p.color || "var(--line)") + ";";
    }
    const arrow = p && p.changed ? (p.setting > p.prevSetting ? "▲" : "▼") : "";
    const cell = el("div", {
      title: p ? `台${c.dai_no} ${p.model}${p.secLabel ? `（${p.secLabel}）` : ""}\n設定${p.setting}${p.tip ? "\n" + p.tip : ""}${canEdit ? "\nクリックで選択中の設定を投入" : ""}` : `台${c.dai_no}（対象外）`,
      style: `grid-column:${C.map.get(c.grid_col) + 1};grid-row:${R.map.get(c.grid_row) + 1};overflow:hidden;` +
        `background:${bg};color:#333a46;border:${border};border-radius:3px;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1;padding:1px;` +
        `${p ? (canEdit ? "cursor:pointer;" : (p.dim ? "" : "opacity:.55;")) : "opacity:.35;"}` + extra,
      onclick: canEdit && onCellClick ? () => onCellClick(c.dai_no) : null,
    }, [
      el("div", { style: `font-size:9px;font-weight:700;line-height:1.1;color:${p && p.dim ? "#9aa2b1" : "#3d4454"}`, text: String(c.dai_no) }),
      p ? el("div", { style: `font-size:6.5px;line-height:1.05;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-all;opacity:${p.dim ? ".55" : ".85"};text-align:center`, text: p.model }) : null,
      p ? el("div", { style: `font-weight:800;font-size:12px;line-height:1;color:${p.dim ? "#9aa2b1" : "#333a46"}`, text: arrow ? `${arrow}${p.setting}` : String(p.setting) }) : null,
    ]);
    grid.appendChild(cell);
  }
  return opts.cellW ? grid
    : el("div", { style: "border:1px solid var(--line);border-radius:8px;padding:6px;background:var(--panel)" }, grid);
}

// 画面表示: 凡例＋全フロア（1F/BF両方、全台表示）
// opts.cellW 指定時はズーム対象としてまとめた中身だけを返す（枠は呼び出し側が付ける）。
export function buildPlacementMap(layout, placement, opts = {}) {
  const floors = [...new Set(layout.map((l) => l.floor))];
  const zoomed = !!opts.cellW;
  const wrap = el("div", { class: zoomed ? "placement-all" : "col", style: zoomed ? "width:max-content" : "gap:8px" });
  if (!zoomed) wrap.appendChild(buildLegend(placement));
  // 1FとBFを続けて並べるので、階の変わり目がはっきり分かるようにする（島図タブと同じ見た目）
  floors.forEach((fl, i) => {
    // ズーム表示(スマホ)では縮小されるため見出し・区切りを大きめにする
    if (i) wrap.appendChild(floorSplit(zoomed));
    wrap.appendChild(floorBar(fl, `${layout.filter((l) => l.floor === fl).length}台`, zoomed));
    wrap.appendChild(buildPlacementFloor(layout, placement, fl, opts));
  });
  return wrap;
}

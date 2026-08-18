// 増台位置の島図。設定投入の島図（miniMap）は設定色に強く結びついているので、
// ここは「どの台を入れ替えるか」だけを塗る軽い版を別に持つ。
// 画面・印刷で同じものを使う（印刷だけ別実装にすると片方だけ古くなる）。
import { el, floorBar, floorSplit } from "../../util/dom.js";
import { tweakCell } from "../../core/config.js";
import { rateKeyOfDai } from "../../core/daiSection.js";
import { SECS } from "./model.js";
import { secColor } from "./charts.js";
import { tint } from "../../util/colors.js";

// 増台の印は塗りつぶし、レートは淡い塗り。5スロの黄と紛れないよう「次回以降」は紫にしている。
export const MARK = { add: "#e5484d", next: "#8b5cf6", none: null };
const RATE_TINT = 0.13;

// 台のある行・列だけ残し、間の空きは細い通路に圧縮（島図と同じ方式）。
function pack(sorted, content, gap) {
  const map = new Map(); const tpl = []; let prev = null;
  for (const o of sorted) {
    if (prev !== null && o - prev !== 1) tpl.push(gap);
    map.set(o, tpl.length);
    tpl.push(content);
    prev = o;
  }
  return { map, tpl };
}

// marks: Map(台番 → "add" | "next")。それ以外の台はレート色の淡い塗り。
export function buildPlanFloor(layout, floor, marks, { cellW = 26 } = {}) {
  const cells = layout.map(tweakCell).filter((l) => l.floor === floor);
  const R = pack([...new Set(cells.map((c) => c.grid_row))].sort((a, b) => a - b), `${cellW}px`, "6px");
  const C = pack([...new Set(cells.map((c) => c.grid_col))].sort((a, b) => a - b), `${cellW}px`, "6px");
  const grid = el("div", { style: `display:grid;gap:2px;grid-template-columns:${C.tpl.join(" ")};grid-template-rows:${R.tpl.join(" ")};width:max-content` });
  for (const c of cells) {
    const mk = marks.get(c.dai_no);
    const rate = rateKeyOfDai(c.dai_no);
    const bg = mk ? MARK[mk] : tint(secColor(rate) || "#8a91a3", RATE_TINT);
    grid.appendChild(el("div", {
      title: `台${c.dai_no}${mk === "add" ? "（今回の増台）" : mk === "next" ? "（次回以降）" : ""}`,
      style: `grid-column:${C.map.get(c.grid_col) + 1};grid-row:${R.map.get(c.grid_row) + 1};` +
        `background:${bg};color:${mk ? "#fff" : "#3a4150"};border:1px solid ${mk ? bg : "var(--line)"};border-radius:3px;` +
        `display:flex;align-items:center;justify-content:center;font-size:${Math.round(cellW * 0.4)}px;` +
        `font-weight:${mk ? 800 : 600};line-height:1`,
      text: String(c.dai_no),
    }));
  }
  return el("div", { style: "border:1px solid var(--line);border-radius:8px;padding:8px;background:var(--panel);overflow:auto" }, grid);
}

export const floorsOf = (layout) => [...new Set(layout.map((l) => l.floor))];

export function buildPlanMap(layout, marks, opts = {}) {
  const floors = floorsOf(layout);
  const wrap = el("div", { class: "col", style: "gap:8px" });
  floors.forEach((fl, i) => {
    if (i) wrap.appendChild(floorSplit(false));
    const n = [...marks].filter(([dai, kind]) => kind === "add" && layout.some((l) => l.dai_no === dai && l.floor === fl)).length;
    wrap.appendChild(floorBar(fl, `${layout.filter((l) => l.floor === fl).length}台${n ? ` / 増台 ${n}台` : ""}`));
    wrap.appendChild(buildPlanFloor(layout, fl, marks, opts));
  });
  return wrap;
}

export function buildPlanLegend() {
  const item = (label, color, dashed) => el("span", { style: "display:inline-flex;gap:5px;align-items:center" }, [
    el("span", { style: `display:inline-block;width:13px;height:13px;border-radius:3px;box-sizing:border-box;` +
      (dashed ? "border:1px dashed var(--fg-dim)" : `background:${color};border:1px solid ${color}`) }),
    el("span", { text: label }),
  ]);
  return el("div", { style: "display:flex;gap:14px;flex-wrap:wrap;font-size:12px;align-items:center" }, [
    item("今回の増台", MARK.add), item("次回以降", MARK.next),
    el("span", { class: "hint", text: "｜レート" }),
    // 島図の塗りと同じ濃さにする。凡例だけ濃くすると増台の印と見分けがつかない
    ...SECS.map((s) => item(s.label, tint(secColor(s.key), RATE_TINT))),
  ]);
}

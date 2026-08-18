// 増台位置の島図。設定投入の島図（miniMap）は設定色に強く結びついているので、
// ここは「どの回でどの台を入れ替えるか」だけを塗る軽い版を別に持つ。
// 画面・印刷で同じものを使う（印刷だけ別実装にすると片方だけ古くなる）。
import { el, floorBar, floorSplit } from "../../util/dom.js";
import { tweakCell } from "../../core/config.js";
import { rateKeyOfDai } from "../../core/daiSection.js";
import { secColor } from "./charts.js";
import { tint } from "../../util/colors.js";

// 工事回ごとの色。レートの淡い塗りと紛れないよう、どれも濃い色にしてある。
export const ROUND_COLORS = ["#e5484d", "#7c3aed", "#0ea5e9", "#16a34a", "#d97706", "#db2777", "#0d9488", "#6366f1"];
export const roundColor = (i) => ROUND_COLORS[i % ROUND_COLORS.length];
const RATE_TINT = 0.13;

export const floorsOf = (layout) => [...new Set(layout.map((l) => l.floor))];

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

// marks: Map(台番 → { color, title }）。印の無い台はレート色の淡い塗り。
export function buildPlanFloor(layout, floor, marks, { cellW = 26 } = {}) {
  const cells = layout.map(tweakCell).filter((l) => l.floor === floor);
  const R = pack([...new Set(cells.map((c) => c.grid_row))].sort((a, b) => a - b), `${cellW}px`, "6px");
  const C = pack([...new Set(cells.map((c) => c.grid_col))].sort((a, b) => a - b), `${cellW}px`, "6px");
  const grid = el("div", { style: `display:grid;gap:2px;grid-template-columns:${C.tpl.join(" ")};grid-template-rows:${R.tpl.join(" ")};width:max-content` });
  for (const c of cells) {
    const mk = marks.get(c.dai_no);
    const bg = mk ? mk.color : tint(secColor(rateKeyOfDai(c.dai_no)) || "#8a91a3", RATE_TINT);
    grid.appendChild(el("div", {
      title: `台${c.dai_no}${mk ? `（${mk.title}）` : ""}`,
      style: `grid-column:${C.map.get(c.grid_col) + 1};grid-row:${R.map.get(c.grid_row) + 1};` +
        `background:${bg};color:${mk ? "#fff" : "#3a4150"};border:1px solid ${mk ? bg : "var(--line)"};border-radius:3px;` +
        `display:flex;align-items:center;justify-content:center;font-size:${Math.round(cellW * 0.4)}px;` +
        `font-weight:${mk ? 800 : 600};line-height:1`,
      text: String(c.dai_no),
    }));
  }
  return el("div", { style: "border:1px solid var(--line);border-radius:8px;padding:8px;background:var(--panel);overflow:auto" }, grid);
}

export function buildPlanMap(layout, marks, opts = {}) {
  const wrap = el("div", { class: "col", style: "gap:8px" });
  floorsOf(layout).forEach((fl, i) => {
    if (i) wrap.appendChild(floorSplit(false));
    const n = layout.filter((l) => l.floor === fl && marks.has(l.dai_no)).length;
    wrap.appendChild(floorBar(fl, `${layout.filter((l) => l.floor === fl).length}台${n ? ` / 印 ${n}台` : ""}`));
    wrap.appendChild(buildPlanFloor(layout, fl, marks, opts));
  });
  return wrap;
}

// 凡例。工事回は濃い色で日付と台番も出す（紙で見たときに回と場所が結びつくように）。
export function buildPlanLegend(rounds, secs) {
  const chip = (label, color, dashed) => el("span", { style: "display:inline-flex;gap:5px;align-items:center" }, [
    el("span", { style: "display:inline-block;width:13px;height:13px;border-radius:3px;box-sizing:border-box;" +
      (dashed ? "border:1px dashed var(--fg-dim)" : `background:${color};border:1px solid ${color}`) }),
    el("span", { text: label }),
  ]);
  return el("div", { style: "display:flex;gap:14px;flex-wrap:wrap;font-size:12px;align-items:center" }, [
    ...rounds.map((r, i) => chip(r.legend, roundColor(r.colorIndex ?? i))),
    rounds.length ? el("span", { class: "hint", text: "｜レート" }) : null,
    // 島図の塗りと同じ濃さにする。凡例だけ濃くすると工事回の印と見分けがつかない
    ...secs.map((s) => chip(s.label, tint(secColor(s.key), RATE_TINT))),
  ].filter(Boolean));
}

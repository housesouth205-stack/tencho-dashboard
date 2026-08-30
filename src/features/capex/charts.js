// 増台計画タブのグラフ。他タブと同じく依存ゼロのSVG自前描画。
// 支払いは棒＋累計線、設置比率は区分別の折れ線。印刷にもそのまま載せるので
// 画面幅に依存しない座標系で描き、viewBoxで伸縮させる。
import { SECS, ymLabel } from "./model.js";
import { SECTION_PALETTE, cssVar } from "../../util/colors.js";

const NS = "http://www.w3.org/2000/svg";
const C = { dim: "#8a91a3", line: "#e3e8f2", bar: "#4f8ff7", cum: "#2fb888" };

// bar/cum は売上=青・粗利=緑と同じ意味付きの色なので動かさない。
// 白い紙を前提にした目盛りとグリッドだけ、テーマから取り直す。
function syncChrome() {
  C.dim = cssVar("--fg-dim", "#8a91a3");
  C.line = cssVar("--line", "#e3e8f2");
}
export const secColor = (key) => SECTION_PALETTE[Math.max(0, SECS.findIndex((s) => s.key === key)) % SECTION_PALETTE.length];

function s(tag, attrs = {}, children = []) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  for (const c of [].concat(children)) if (c != null) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return n;
}
const man = (v) => Math.round(v / 10000).toLocaleString("ja-JP");

// 目盛りをきりの良い数字に（経費タブと同じ考え方）。
function niceScale(hi, count = 4) {
  const span = hi || 1;
  const mag = Math.pow(10, Math.floor(Math.log10(span / count)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= span / count) || 10 * mag;
  const ticks = [];
  for (let v = 0; v <= Math.ceil(hi / step) * step + step / 1000; v += step) ticks.push(v);
  return { hi: ticks[ticks.length - 1], ticks };
}

function wrap(title, svg, legend, note) {
  const box = document.createElement("div");
  box.className = "card";
  // SVGは viewBox の縦横比で描かれる。カードを画面幅いっぱいにすると横に間延びして
  // 絵だけ真ん中に小さく浮くので、座標系の幅あたりで頭打ちにする。
  box.style.cssText = "flex:1;min-width:300px;max-width:760px";
  if (title) { const h = document.createElement("div"); h.className = "hint"; h.textContent = title; box.appendChild(h); }
  box.appendChild(svg);
  const l = document.createElement("div");
  l.style.cssText = "display:flex;gap:12px;flex-wrap:wrap;margin-top:6px;font-size:11px;color:var(--fg-dim)";
  for (const [name, col] of legend || []) {
    l.insertAdjacentHTML("beforeend",
      `<span><span style="display:inline-block;width:10px;height:10px;background:${col};border-radius:2px;margin-right:4px"></span>${name}</span>`);
  }
  if (note) l.insertAdjacentHTML("beforeend", `<span style="margin-left:auto">${note}</span>`);
  if (legend || note) box.appendChild(l);
  return box;
}

// 月別の支払い（棒）と累計（線）。金額は万円。
// 円のまま目盛りに出すと8桁が並んで読めないので、他の資料と同じ万円で揃える。
export function paymentBars(rows, { title, narrow } = {}) {
  syncChrome();
  const w = narrow ? 360 : 680, h = narrow ? 190 : 220, f = narrow ? 1.3 : 1;
  const padL = 40 * f, padR = 42 * f, padT = 10, padB = 26 * f;
  const iw = w - padL - padR, ih = h - padT - padB;
  const svg = s("svg", { viewBox: `0 0 ${w} ${h}`, width: "100%", height: h, role: "img" });
  if (!rows.length) return wrap(title, svg, null, "データなし");

  const sc = niceScale(Math.max(...rows.map((r) => r.total), 1));
  const cumMax = Math.max(...rows.map((r) => r.cum), 1);
  const slot = iw / rows.length;
  const bw = Math.max(3, Math.min(slot * 0.66, 34));
  const cx = (i) => padL + slot * (i + 0.5);
  const yOf = (v) => padT + ih - (v / sc.hi) * ih;
  const yCum = (v) => padT + ih - (v / cumMax) * ih;

  for (const v of sc.ticks) {
    svg.appendChild(s("line", { x1: padL, y1: yOf(v), x2: padL + iw, y2: yOf(v), stroke: C.line }));
    svg.appendChild(s("text", { x: padL - 4, y: yOf(v) + 3, "text-anchor": "end", "font-size": 9 * f, fill: C.dim }, man(v)));
  }
  rows.forEach((r, i) => {
    if (r.total) svg.appendChild(s("rect", { x: cx(i) - bw / 2, y: yOf(r.total), width: bw, height: Math.max(1, ih - (yOf(r.total) - padT)), fill: C.bar, rx: 2 }));
  });
  svg.appendChild(s("polyline", {
    points: rows.map((r, i) => `${cx(i)},${yCum(r.cum)}`).join(" "),
    fill: "none", stroke: C.cum, "stroke-width": 2 * f,
  }));
  // 累計は棒とは桁が違うので別目盛り。目盛りを出さないと、線が棒より上にあるだけの
  // 意味不明な絵になる（実際そう見えていた）。右側に累計の目盛りを添える。
  for (const v of [0, cumMax / 2, cumMax]) {
    svg.appendChild(s("text", { x: padL + iw + 4, y: yCum(v) + 3, "font-size": 9 * f, fill: C.cum }, man(v)));
  }
  // 横軸。月が多いと重なるので、狭いときは1つおきに出す
  const skip = slot < 26 * f ? 2 : 1;
  rows.forEach((r, i) => {
    if (i % skip) return;
    svg.appendChild(s("text", { x: cx(i), y: h - 12 * f, "text-anchor": "middle", "font-size": 9 * f, fill: C.dim }, r.ym.slice(5)));
  });
  // 年は下段にまとめて（2026/01…と全部並べると読めない）
  let start = 0;
  for (let i = 1; i <= rows.length; i++) {
    if (i < rows.length && rows[i].ym.slice(0, 4) === rows[start].ym.slice(0, 4)) continue;
    svg.appendChild(s("text", { x: (cx(start) + cx(i - 1)) / 2, y: h - 1 * f, "text-anchor": "middle", "font-size": 9.5 * f, "font-weight": "700", fill: C.dim }, rows[start].ym.slice(0, 4) + "年"));
    start = i;
  }
  return wrap(title, svg, [["月の支払い（左目盛り）", C.bar], ["累計（右目盛り）", C.cum]], "単位: 万円");
}

// 区分ごとのスマート設置比率の推移。100%の線を引いて、どこで打ち止めかが分かるようにする。
export function rateLines(rows, { title, narrow } = {}) {
  syncChrome();
  const w = narrow ? 360 : 680, h = narrow ? 190 : 220, f = narrow ? 1.3 : 1;
  const padL = 36 * f, padR = 10 * f, padT = 10, padB = 26 * f;
  const iw = w - padL - padR, ih = h - padT - padB;
  const svg = s("svg", { viewBox: `0 0 ${w} ${h}`, width: "100%", height: h, role: "img" });
  if (!rows.length) return wrap(title, svg, null, "データなし");

  const cx = (i) => padL + (rows.length === 1 ? iw / 2 : (iw * i) / (rows.length - 1));
  const yOf = (r) => padT + ih - Math.min(1, r) * ih;
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    svg.appendChild(s("line", { x1: padL, y1: yOf(v), x2: padL + iw, y2: yOf(v), stroke: v === 1 ? C.dim : C.line, "stroke-dasharray": v === 1 ? "4 3" : null }));
    svg.appendChild(s("text", { x: padL - 4, y: yOf(v) + 3, "text-anchor": "end", "font-size": 9 * f, fill: C.dim }, (v * 100) + "%"));
  }
  for (const sec of SECS) {
    const pts = rows.map((r, i) => (r.rate[sec.key] == null ? null : `${cx(i)},${yOf(r.rate[sec.key])}`)).filter(Boolean);
    if (pts.length < 2) continue;
    svg.appendChild(s("polyline", { points: pts.join(" "), fill: "none", stroke: secColor(sec.key), "stroke-width": 2 * f }));
  }
  // 点が1つしかないと線が引けないので、印だけ置く（工事回1回のときに真っ白に見えていた）
  if (rows.length === 1) {
    for (const sec of SECS) {
      if (rows[0].rate[sec.key] == null) continue;
      svg.appendChild(s("circle", { cx: cx(0), cy: yOf(rows[0].rate[sec.key]), r: 3 * f, fill: secColor(sec.key) }));
    }
  }
  const skip = iw / rows.length < 30 * f ? 2 : 1;
  rows.forEach((r, i) => {
    if (i % skip) return;
    svg.appendChild(s("text", { x: cx(i), y: h - 4 * f, "text-anchor": "middle", "font-size": 8.5 * f, fill: C.dim },
      r.xlabel || ymLabel(r.ym).slice(2)));
  });
  return wrap(title, svg, SECS.map((x) => [x.label, secColor(x.key)]), "スマート設置比率");
}

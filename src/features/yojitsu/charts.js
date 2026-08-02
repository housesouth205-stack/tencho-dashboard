// 依存ゼロのSVG自前描画。ダークテーマ配色。
const NS = "http://www.w3.org/2000/svg";
const C = { ok: "#43b483", warn: "#e0a52e", bad: "#e35d6a", accent: "#e35d6a", blue: "#6f9fe0", dim: "#8a91a3", line: "#e3e8f2", plan: "#c3cbdb", fg: "#2f3440" };

function s(tag, attrs = {}, children = []) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  for (const c of [].concat(children)) if (c != null) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return n;
}
const achColor = (r) => (r == null ? C.dim : r >= 1 ? C.ok : r >= 0.9 ? C.warn : C.bad);
const abbr = (n) => (n == null ? "—" : Math.abs(n) >= 1e8 ? (n / 1e8).toFixed(1) + "億" : Math.abs(n) >= 1e4 ? Math.round(n / 1e4) + "万" : String(Math.round(n)));

// 達成率ドーナツ
export function donut(label, ratio) {
  const size = 130, cx = size / 2, cy = size / 2, r = 52, circ = 2 * Math.PI * r;
  const val = ratio == null ? 0 : Math.max(0, Math.min(ratio, 1.3));
  const svg = s("svg", { viewBox: `0 0 ${size} ${size + 22}`, width: "150", style: "max-width:100%" });
  svg.appendChild(s("circle", { cx, cy, r, fill: "none", stroke: C.line, "stroke-width": 12 }));
  svg.appendChild(s("circle", {
    cx, cy, r, fill: "none", stroke: achColor(ratio), "stroke-width": 12, "stroke-linecap": "round",
    "stroke-dasharray": `${(circ * val) / 1.3} ${circ}`, transform: `rotate(-90 ${cx} ${cy})`,
  }));
  svg.appendChild(s("text", { x: cx, y: cy + 2, "text-anchor": "middle", "font-size": "22", "font-weight": "700", fill: C.fg }, ratio == null ? "—" : Math.round(ratio * 100) + "%"));
  svg.appendChild(s("text", { x: cx, y: cy + 20, "text-anchor": "middle", "font-size": "11", fill: C.dim }, "達成率"));
  svg.appendChild(s("text", { x: cx, y: size + 14, "text-anchor": "middle", "font-size": "12", fill: C.dim }, label));
  return svg;
}

// 区分別 予算(計画)vs実績 横棒
export function hbars(rows, { title } = {}) {
  const w = 460, rowH = 34, pad = 74, top = 8, h = top + rows.length * rowH + 10;
  const max = Math.max(1, ...rows.map((r) => Math.max(r.plan, r.actual)));
  const bw = w - pad - 90;
  const svg = s("svg", { viewBox: `0 0 ${w} ${h}`, width: "100%", style: "max-width:520px" });
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    svg.appendChild(s("text", { x: 0, y: y + 20, "font-size": "12", fill: C.fg }, r.label));
    svg.appendChild(s("rect", { x: pad, y: y + 6, width: (bw * r.plan) / max, height: 20, rx: 3, fill: C.plan }));
    svg.appendChild(s("rect", { x: pad, y: y + 10, width: (bw * r.actual) / max, height: 12, rx: 3, fill: r.color || achColor(r.plan ? r.actual / r.plan : null) }));
    svg.appendChild(s("text", { x: pad + bw + 4, y: y + 20, "font-size": "11", fill: C.dim }, `${abbr(r.actual)}/${abbr(r.plan)}`));
  });
  return wrap(title, svg, [["計画", C.plan], ["実績", C.accent]]);
}

// 折れ線（計画 vs 実績）
export function line(series, { title } = {}) {
  const w = 620, h = 200, padL = 44, padB = 22, padT = 10, padR = 8;
  const max = Math.max(1, ...series.flatMap((d) => [d.plan || 0, d.actual || 0]));
  const iw = w - padL - padR, ih = h - padB - padT;
  const x = (i) => padL + (series.length <= 1 ? 0 : (iw * i) / (series.length - 1));
  const y = (v) => padT + ih - (ih * v) / max;
  const svg = s("svg", { viewBox: `0 0 ${w} ${h}`, width: "100%", style: "max-width:100%" });
  for (let g = 0; g <= 4; g++) {
    const gy = padT + (ih * g) / 4;
    svg.appendChild(s("line", { x1: padL, y1: gy, x2: w - padR, y2: gy, stroke: C.line }));
    svg.appendChild(s("text", { x: padL - 4, y: gy + 3, "text-anchor": "end", "font-size": "9", fill: C.dim }, abbr(max * (1 - g / 4))));
  }
  const path = (key, color, dash) => {
    const pts = series.map((d, i) => (d[key] == null ? null : `${x(i)},${y(d[key])}`)).filter(Boolean).join(" ");
    if (pts) svg.appendChild(s("polyline", { points: pts, fill: "none", stroke: color, "stroke-width": 2, "stroke-dasharray": dash }));
  };
  path("plan", C.plan, "5 4");
  path("actual", C.accent, null);
  // 31日分まではすべての日付ラベルを表示（偶数日も出す）
  const step = series.length <= 31 ? 1 : Math.ceil(series.length / 16);
  series.forEach((d, i) => { if (i % step === 0) svg.appendChild(s("text", { x: x(i), y: h - 6, "text-anchor": "middle", "font-size": "8.5", fill: C.dim }, d.label)); });
  return wrap(title, svg, [["計画", C.plan], ["実績", C.accent]]);
}

function wrap(title, svg, legend) {
  const box = document.createElement("div");
  box.className = "card";
  box.style.flex = "1";
  box.style.minWidth = "300px";
  if (title) { const h = document.createElement("div"); h.className = "hint"; h.textContent = title; box.appendChild(h); }
  box.appendChild(svg);
  if (legend) {
    const l = document.createElement("div");
    l.style.cssText = "display:flex;gap:14px;margin-top:6px;font-size:11px;color:var(--fg-dim)";
    for (const [name, col] of legend) l.insertAdjacentHTML("beforeend", `<span><span style="display:inline-block;width:10px;height:10px;background:${col};border-radius:2px;margin-right:4px"></span>${name}</span>`);
    box.appendChild(l);
  }
  return box;
}

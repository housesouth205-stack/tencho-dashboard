// 経費タブのグラフ。予実タブと同じく依存ゼロのSVG自前描画。
// 金額はDBには円で入っているが、表示は会議資料と同じ「千円」に揃える。
// 手元の紙とそのまま突き合わせられるほうが、桁を揃えるより価値が高い。
const NS = "http://www.w3.org/2000/svg";

// 積み上げの4色。色覚多様性の検証スクリプトを通してある
// （隣り合う色の見分けやすさ・明るさの帯・通常視力での差、すべて合格）。
// 地代家賃とその他はわざと彩度の低いグレーにして、動く費目（青・赤）を目立たせている。
export const CAT = [
  { key: "yachin", label: "地代家賃", color: "#4f5766" },
  { key: "jinken", label: "人件費", color: "#2a78d6" },
  { key: "kigu", label: "入替代", color: "#e34948" },
  { key: "other", label: "その他", color: "#aab2c2" },
];
const C = { dim: "#8a91a3", line: "#e3e8f2", fg: "#2f3440", pos: "#2a78d6", neg: "#e34948", zero: "#7d8595" };
// 入替代は積み上げグラフと同じ色にする（2つのグラフで同じものが同じ色に見えるように）。
const KIGU = CAT.find((c) => c.key === "kigu").color;

function s(tag, attrs = {}, children = []) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  for (const c of [].concat(children)) if (c != null) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return n;
}
// 円 → 千円の整数。表示はここを通す。
export const k = (v) => (v == null ? null : Math.round(v / 1000));
export const kf = (v) => (v == null ? "—" : k(v).toLocaleString("ja-JP"));

// 上の角だけ丸めた棒。積み上げの一番上（＝合計の先端）にだけ使う。
function topRounded(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}L${x},${y + rr}Q${x},${y} ${x + rr},${y}L${x + w - rr},${y}Q${x + w},${y} ${x + w},${y + rr}L${x + w},${y + h}Z`;
}

// 横軸。月の数字を並べ、年が変わるところで和暦年を下段に出す（R7.01を全部並べると読めない）。
function xAxis(svg, items, cx, h, slot, f = 1) {
  const short = slot < 26 * f;
  items.forEach((it, i) => {
    if (short && i % 2 === 1) return;
    svg.appendChild(s("text", { x: cx(i), y: h - 14, "text-anchor": "middle", "font-size": 9 * f, fill: C.dim }, String(it.month)));
  });
  let start = 0;
  for (let i = 1; i <= items.length; i++) {
    if (i < items.length && items[i].wy === items[start].wy) continue;
    const mid = (cx(start) + cx(i - 1)) / 2;
    svg.appendChild(s("text", { x: mid, y: h - 2, "text-anchor": "middle", "font-size": 9.5 * f, "font-weight": "700", fill: C.dim }, "令和" + items[start].wy + "年"));
    if (i < items.length) {
      const bx = (cx(i - 1) + cx(i)) / 2;
      svg.appendChild(s("line", { x1: bx, y1: h - 26, x2: bx, y2: h - 6, stroke: C.line }));
    }
    start = i;
  }
}

// 目盛りをきりの良い数字にする。データの最大値をそのまま4等分すると
// 「20,416」のような半端な数字が並んで読めない。
export function niceScale(lo, hi, count = 4) {
  const span = (hi - lo) || 1;
  const mag = Math.pow(10, Math.floor(Math.log10(span / count)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= span / count) || 10 * mag;
  const l = Math.floor(lo / step) * step, h = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = l; v <= h + step / 1000; v += step) ticks.push(Math.round(v));
  return { lo: l, hi: h, ticks };
}

function grid(svg, padL, iw, yOf, vals, fmt, f = 1) {
  for (const v of vals) {
    const gy = yOf(v);
    svg.appendChild(s("line", { x1: padL, y1: gy, x2: padL + iw, y2: gy, stroke: C.line }));
    svg.appendChild(s("text", { x: padL - 4, y: gy + 3, "text-anchor": "end", "font-size": 9 * f, fill: C.dim }, fmt(v)));
  }
}

// スマホは横幅が狭く、680の座標系のまま縮めると文字が4pxまで潰れて読めない。
// 座標系そのものを小さくして、実寸に近い大きさで描く。
// 返す f は文字の拡大率（座標系が小さいぶん文字は相対的に大きくする）。
const sizing = (narrow) => (narrow ? { w: 360, padL: 46, padR: 8, f: 1.3 } : { w: 680, padL: 54, padR: 10, f: 1 });

// 一般管理費の中身（積み上げ棒）。合計の高さが何で動いているかを見る。
export function stackedSga(items, { title, narrow } = {}) {
  const n = items.length;
  const { w, padL, padR, f } = sizing(narrow);
  const h = narrow ? 190 : 264, padT = 14, padB = 30 * f;
  const iw = w - padL - padR, ih = h - padT - padB;
  const sc = niceScale(0, Math.max(1, ...items.map((it) => it.row?.sga || 0)));
  const max = sc.hi;
  const slot = iw / Math.max(1, n);
  const bw = Math.max(5, Math.min(30, slot * 0.66));
  const cx = (i) => padL + slot * (i + 0.5);
  const y = (v) => padT + ih - (ih * v) / max;

  const svg = s("svg", { viewBox: `0 0 ${w} ${h}`, width: "100%", style: "max-width:100%" });
  grid(svg, padL, iw, y, sc.ticks, (v) => kf(v), f);

  items.forEach((it, i) => {
    const r = it.row;
    if (!r || r.sga == null) return;
    // 内訳をまだ読み取っていない月。全部「その他」で塗ると内訳が分かっているように
    // 見えてしまうので、枠線だけの棒にして「金額しか無い」と分かるようにする。
    if (!hasParts(r)) {
      const hh = (ih * r.sga) / max;
      svg.appendChild(s("rect", {
        x: cx(i) - bw / 2, y: padT + ih - hh, width: bw, height: hh, rx: 3,
        fill: "none", stroke: C.dim, "stroke-width": "1", "stroke-dasharray": "3 2",
      }, s("title", {}, `令和${it.wy}年${it.month}月度｜一般管理費 ${kf(r.sga)}千円（内訳は未取込）`)));
      return;
    }
    const parts = CAT.map((c) => ({ ...c, val: c.key === "other" ? otherOf(r) : (r[c.key] || 0) })).filter((p) => p.val > 0);
    const topIdx = parts.length - 1;
    const x = cx(i) - bw / 2;
    let acc = 0;
    parts.forEach((p, j) => {
      const raw = (ih * p.val) / max;
      // 塗り同士がつながって見えないよう2pxすき間をあける
      const hh = Math.max(1, raw - (j === topIdx ? 0 : 2));
      const top = padT + ih - acc - raw;
      const tip = s("title", {}, `令和${it.wy}年${it.month}月度｜${p.label} ${kf(p.val)}千円（一般管理費 ${kf(r.sga)}千円のうち）`);
      svg.appendChild(j === topIdx
        ? s("path", { d: topRounded(x, top, bw, hh, 4), fill: p.color }, tip)
        : s("rect", { x, y: top, width: bw, height: hh, fill: p.color }, tip));
      acc += raw;
    });
  });
  xAxis(svg, items, cx, h, slot, f);
  const legend = CAT.map((c) => [c.label, c.color]);
  if (items.some((it) => it.row && it.row.sga != null && !hasParts(it.row))) legend.push(["内訳なし（金額のみ）", "transparent"]);
  return wrap(title, svg, legend, "単位: 千円");
}
export const otherOf = (r) => Math.max(0, (r.sga || 0) - (r.yachin || 0) - (r.jinken || 0) - (r.kigu || 0));
// 内訳を読み取れている月かどうか。金額だけの月と区別する。
const hasParts = (r) => r.jinken != null || r.kigu != null || r.yachin != null;

// 入替代と営業利益。どちらも千円なので目盛りは1本で足りる。
export function kiguVsOp(items, { title, narrow } = {}) {
  const n = items.length;
  const { w, padL, f } = sizing(narrow);
  const h = narrow ? 180 : 250, padR = 46 * f, padT = 14, padB = 30 * f;
  const iw = w - padL - padR, ih = h - padT - padB;
  const seen = items.filter((it) => it.row);
  const sc = niceScale(
    Math.min(0, ...seen.map((it) => it.row.op ?? 0)),
    Math.max(1, ...seen.map((it) => Math.max(it.row.kigu ?? 0, it.row.op ?? 0))));
  const lo = sc.lo, span = sc.hi - sc.lo || 1;
  const y = (v) => padT + ih - (ih * (v - lo)) / span;
  const slot = iw / Math.max(1, n);
  const bw = Math.max(5, Math.min(22, slot * 0.5));
  const cx = (i) => padL + slot * (i + 0.5);

  const svg = s("svg", { viewBox: `0 0 ${w} ${h}`, width: "100%", style: "max-width:100%" });
  // 0より下は赤字の領域。線がここに入った月が赤字。
  if (lo < 0) {
    svg.appendChild(s("rect", { x: padL, y: y(0), width: iw, height: y(lo) - y(0), fill: C.neg, opacity: "0.06" }));
    svg.appendChild(s("text", { x: padL + 4, y: y(lo) - 4, "font-size": 9.5 * f, "font-weight": "700", fill: C.neg, opacity: "0.75" }, "赤字"));
  }
  grid(svg, padL, iw, y, sc.ticks, (v) => kf(v), f);
  svg.appendChild(s("line", { x1: padL, y1: y(0), x2: padL + iw, y2: y(0), stroke: C.zero, "stroke-width": "1.2" }));

  items.forEach((it, i) => {
    const v = it.row?.kigu;
    if (v == null) return;
    svg.appendChild(s("rect", { x: cx(i) - bw / 2, y: y(v), width: bw, height: Math.max(1, y(0) - y(v)), rx: 3, fill: KIGU, opacity: "0.85" },
      s("title", {}, `令和${it.wy}年${it.month}月度｜入替代 ${kf(v)}千円`)));
  });
  // 営業利益。資料が無い月は線を切って、無いものを繋がない。
  let seg = [];
  const flush = () => {
    if (seg.length > 1) svg.appendChild(s("polyline", { points: seg.join(" "), fill: "none", stroke: C.pos, "stroke-width": "2", "stroke-linejoin": "round" }));
    seg = [];
  };
  items.forEach((it, i) => {
    if (it.row?.op == null) { flush(); return; }
    seg.push(`${cx(i)},${y(it.row.op)}`);
  });
  flush();
  items.forEach((it, i) => {
    const v = it.row?.op;
    if (v == null) return;
    svg.appendChild(s("circle", { cx: cx(i), cy: y(v), r: 3.5 * f, fill: C.pos, stroke: "#fff", "stroke-width": 1.8 * f },
      s("title", {}, `令和${it.wy}年${it.month}月度｜営業利益 ${kf(v)}千円`)));
  });
  // 右端に最新月の営業利益を直接書く（凡例と目を往復しなくても読める）
  const lastI = items.map((it, i) => (it.row?.op != null ? i : -1)).filter((i) => i >= 0).pop();
  if (lastI != null) {
    const v = items[lastI].row.op;
    svg.appendChild(s("text", { x: padL + iw + 5, y: Math.max(padT + 8, Math.min(padT + ih, y(v))) + 3, "font-size": 10 * f, "font-weight": "800", fill: v < 0 ? C.neg : C.pos },
      (v < 0 ? "−" : "") + kf(Math.abs(v))));
  }
  xAxis(svg, items, cx, h, slot, f);
  return wrap(title, svg, [["入替代", KIGU], ["営業利益", C.pos]], "単位: 千円（目盛りは共通）");
}

function wrap(title, svg, legend, note) {
  const box = document.createElement("div");
  box.className = "card";
  box.style.flex = "1";
  box.style.minWidth = "300px";
  if (title) { const h = document.createElement("div"); h.className = "hint"; h.textContent = title; box.appendChild(h); }
  box.appendChild(svg);
  const l = document.createElement("div");
  l.style.cssText = "display:flex;gap:12px;flex-wrap:wrap;margin-top:6px;font-size:11px;color:var(--fg-dim)";
  for (const [name, col] of legend) {
    // 「内訳なし」はグラフ側も枠線だけなので、凡例も枠線だけで揃える。
    const box = col === "transparent"
      ? "border:1px dashed var(--fg-dim)"
      : `background:${col}`;
    l.insertAdjacentHTML("beforeend", `<span><span style="display:inline-block;width:10px;height:10px;${box};border-radius:2px;margin-right:4px;box-sizing:border-box"></span>${name}</span>`);
  }
  if (note) l.insertAdjacentHTML("beforeend", `<span style="margin-left:auto">${note}</span>`);
  box.appendChild(l);
  return box;
}

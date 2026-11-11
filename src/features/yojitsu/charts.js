// 依存ゼロのSVG自前描画。ダークテーマ配色。
import { cssVar } from "../../util/colors.js";
const NS = "http://www.w3.org/2000/svg";
// pos/neg は色覚多様性・コントラストの検証を通した発散ペア（青↔赤）。
// ref は計画（基準線）用のグレー。塗りではなく線なので plan より濃いものを使う。
const C = { ok: "#43b483", warn: "#e0a52e", bad: "#e35d6a", accent: "#e35d6a", dim: "#8a91a3", line: "#e3e8f2", plan: "#c3cbdb", fg: "#2f3440", pos: "#2a78d6", neg: "#e34948", ref: "#7d8595" };

// 系列の色（売上=青・粗利=緑…）は全画面で決めた意味付きの色なので動かさない。
// 動かすのは「地の色」だけ: 目盛りの文字(fg)・薄い文字(dim)・グリッド線(line)。
// この3つは白い紙を前提にした値なので、黒地のテーマではそのままだと読めない。
// Cを書き換える形にしてあるので、参照側（C.fg など）は一切変えなくてよい。
function syncChrome() {
  C.fg = cssVar("--fg", "#2f3440");
  C.dim = cssVar("--fg-dim", "#8a91a3");
  C.line = cssVar("--line", "#e3e8f2");
}

function s(tag, attrs = {}, children = []) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  for (const c of [].concat(children)) if (c != null) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return n;
}
const achColor = (r) => (r == null ? C.dim : r >= 1 ? C.ok : r >= 0.9 ? C.warn : C.bad);
const abbr = (n) => (n == null ? "—" : Math.abs(n) >= 1e8 ? (n / 1e8).toFixed(1) + "億" : Math.abs(n) >= 1e4 ? Math.round(n / 1e4) + "万" : String(Math.round(n)));


// 累計は億の桁になると abbr の1桁では「2.4億 vs 2.4億」と同じに見えるので2桁で出す
const abbr2 = (n) => (n == null ? "—" : Math.abs(n) >= 1e8 ? (n / 1e8).toFixed(2) + "億" : abbr(n));

// 日付ラベル（31個までは全部、それ以上は間引く）
function xLabels(svg, series, x, h, size = 8.5) {
  // 31日を全部並べると文字が詰まるので、大きい字のときは1日と5日おきだけ出す
  const step = series.length <= 12 ? 1 : size > 9 ? 5 : series.length <= 31 ? 1 : Math.ceil(series.length / 16);
  series.forEach((d, i) => { if (i === 0 || (i + 1) % step === 0 || step === 1) svg.appendChild(s("text", { x: x(i), y: h - 6, "text-anchor": "middle", "font-size": String(size), fill: C.dim }, d.label)); });
}


// 今年と昨年の累計を重ねる。日別の棒は曜日で上下して差が読み取りにくいので、
// 「月を通してどれだけ差がついたか」はこちらで見る。
// 昨年は月末まで引き、今年は実績のある日で止める（先を計画で伸ばすと前年比が濁る）。
// avg=true のときは {cur:[合計,台数]} を受け取り、累計ではなく「そこまでの平均」を描く。
// アウトは台あたりの数字なので足し上げても意味がなく、台数で重みづけした平均で見る。
export function cumCompare(series, { title, color = C.pos, unit = "", avg = false, seriesLabel = "累計" } = {}) {
  syncChrome();
  const n = series.length;
  const w = 620, h = 210, padL = 46, padB = 22, padT = 14, padR = 74;
  const iw = w - padL - padR, ih = h - padB - padT;
  const norm = (v) => (avg ? (v && v[1] ? { v: v[0], w: v[1] } : null) : (v == null ? null : { v, w: 1 }));
  let cv = 0, cw = 0, bv = 0, bw = 0, last = -1;
  const A = [], B = [];
  series.forEach((d) => {
    const c = norm(d.cur), b = norm(d.base);
    if (!c) A.push(null);
    else { cv += c.v; cw += c.w; A.push(avg ? cv / cw : cv); last = A.length - 1; }
    if (!b) B.push(null);
    else { bv += b.v; bw += b.w; B.push(avg ? bv / bw : bv); }
  });
  const seen = [...A, ...B].filter((v) => v != null);
  const max = Math.max(1, ...seen);
  // 平均（アウト）は0から描くと2本が重なって差が見えない。下を実測値に寄せる。
  // 目盛りの数字は実際の値を出すので、0起点でないことは軸を見れば分かる。
  const lo = avg && seen.length ? Math.min(...seen) * 0.95 : 0;
  const span = max - lo || 1;
  const x = (i) => padL + (n <= 1 ? 0 : (iw * i) / (n - 1));
  const y = (v) => padT + ih - (ih * (v - lo)) / span;
  const svg = s("svg", { viewBox: `0 0 ${w} ${h}`, width: "100%", style: "max-width:100%" });
  for (let g = 0; g <= 4; g++) {
    const gy = padT + (ih * g) / 4;
    svg.appendChild(s("line", { x1: padL, y1: gy, x2: padL + iw, y2: gy, stroke: C.line }));
    svg.appendChild(s("text", { x: padL - 4, y: gy + 3, "text-anchor": "end", "font-size": "9", fill: C.dim }, abbr(lo + span * (1 - g / 4))));
  }
  // 今日時点の差を面で見せる。線2本だけだと、どちらがどれだけ上かが読み取りにくい
  if (last >= 0) {
    const pts = [];
    for (let i = 0; i <= last; i++) if (B[i] != null) pts.push(`${x(i)},${y(B[i])}`);
    for (let i = last; i >= 0; i--) if (B[i] != null) pts.push(`${x(i)},${y(A[i])}`);
    if (pts.length) svg.appendChild(s("polygon", { points: pts.join(" "), fill: A[last] >= (B[last] || 0) ? color : C.neg, opacity: "0.12" }));
  }
  const poly = (arr, col, dash, width) => {
    const pts = arr.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(" ");
    if (pts) svg.appendChild(s("polyline", { points: pts, fill: "none", stroke: col, "stroke-width": width, "stroke-dasharray": dash, "stroke-linejoin": "round" }));
  };
  poly(B, C.ref, "5 4", 2);
  poly(A, color, null, 2.5);
  if (last === 0) svg.appendChild(s("circle", { cx: x(0), cy: y(A[0]), r: 3.5, fill: color }));

  // 右端に直接ラベル。凡例を往復しなくても「今どれだけ差がついているか」が読める
  const clamp = (v) => Math.max(padT + 12, Math.min(padT + ih - 6, v));
  const lx = padL + iw + 6;
  const bEnd = [...B].reverse().find((v) => v != null);
  const ya0 = last >= 0 ? clamp(y(A[last])) : null;
  if (bEnd != null) {
    // 今年とほぼ同額だとラベルが重なって両方読めなくなるので、昨年側をずらす
    let yb = clamp(y(bEnd));
    if (ya0 != null && Math.abs(yb - ya0) < 26) yb = clamp(ya0 + (ya0 > padT + ih / 2 ? -26 : 26));
    svg.appendChild(s("text", { x: lx, y: yb + 3, "font-size": "10", "font-weight": "700", fill: C.ref }, "昨年 " + abbr2(bEnd)));
  }
  if (last >= 0) {
    const ya = ya0;
    svg.appendChild(s("circle", { cx: x(last), cy: y(A[last]), r: 4.5, fill: color, stroke: "#fff", "stroke-width": 2 }));
    svg.appendChild(s("text", { x: lx, y: ya - 2, "font-size": "10.5", "font-weight": "800", fill: color }, "今年 " + abbr2(A[last])));
    const r = B[last] ? A[last] / B[last] - 1 : null;
    if (r != null) svg.appendChild(s("text", { x: lx, y: ya + 10, "font-size": "9.5", "font-weight": "700", fill: r >= 0 ? C.pos : C.neg },
      `${series[last].label}時点 ${r >= 0 ? "+" : "−"}${(Math.abs(r) * 100).toFixed(1)}%`));
  }
  series.forEach((d, i) => {
    if (A[i] == null && B[i] == null) return;
    const tip = `${d.label}｜今年の${seriesLabel} ${A[i] == null ? "—" : abbr2(A[i])}／昨年の${seriesLabel} ${B[i] == null ? "—" : abbr2(B[i])}${unit}`;
    svg.appendChild(s("rect", { x: x(i) - iw / Math.max(1, n) / 2, y: padT, width: iw / Math.max(1, n), height: ih, fill: "transparent" }, s("title", {}, tip)));
  });
  xLabels(svg, series, x, h);
  return wrap(title, svg, [[`今年の${seriesLabel}`, color], [`昨年の${seriesLabel}（破線）`, C.ref]]);
}


// 日別の実績を縦棒で、計画をその上の細い横線で重ねる。
// 計画と実績を2本並べると31日ぶんでは1本3px以下になって比較できないため、
// 「棒＝実績／線＝計画」にして1日1本に収めている。線より棒が高ければ達成。
//
// series は [{ label, plan, actual, kind }]。kind は "sat"|"sun"|"holiday"|""。
// 売上と粗利は桁が10倍違うので同じ軸に載せず、呼び出し側で2つに分けて使う。
// baseLabel: 横線が何を指すか。日別の表は計画とも昨年とも比べるので、
// 凡例とツールチップの文言を呼び出し側から変えられるようにしている。
export function dailyBars(series, { title, color = C.pos, unit = "", baseLabel = "計画" } = {}) {
  syncChrome();
  const n = series.length;
  const w = 640, h = 168, padL = 46, padB = 20, padT = 14, padR = 10;
  const iw = w - padL - padR, ih = h - padB - padT;
  const max = Math.max(1, ...series.map((d) => Math.max(d.plan || 0, d.actual || 0)));
  const y = (v) => padT + ih - (ih * v) / max;
  const x = (i) => padL + (iw * (i + 0.5)) / Math.max(1, n);
  const bw = Math.max(3, Math.min(16, (iw / Math.max(1, n)) * 0.62));
  const svg = s("svg", { viewBox: `0 0 ${w} ${h}`, width: "100%", style: "max-width:100%" });

  // 土日祝の帯。曜日で山谷が動くので、これが無いと増減の理由が読めない
  series.forEach((d, i) => {
    if (!d.kind) return;
    svg.appendChild(s("rect", {
      x: x(i) - (iw / Math.max(1, n)) / 2, y: padT, width: iw / Math.max(1, n), height: ih,
      fill: d.kind === "weekday" ? "none" : "#f0a12e", opacity: d.kind === "sat" ? 0.06 : 0.1,
    }));
  });

  for (const g of [1, 0.5]) {
    const gy = y(max * g);
    svg.appendChild(s("line", { x1: padL, y1: gy, x2: padL + iw, y2: gy, stroke: C.line }));
    svg.appendChild(s("text", { x: padL - 4, y: gy + 3, "text-anchor": "end", "font-size": "9", fill: C.dim }, abbr(max * g)));
  }
  svg.appendChild(s("line", { x1: padL, y1: y(0), x2: padL + iw, y2: y(0), stroke: C.dim }));

  series.forEach((d, i) => {
    // 実績が無い日は棒を描かない。0で描くと未入力が「売上ゼロの日」に見える
    if (d.actual != null) {
      const top = y(d.actual);
      const ratio = d.plan ? d.actual / d.plan : null;
      svg.appendChild(s("rect", { x: x(i) - bw / 2, y: top, width: bw, height: Math.max(1.5, y(0) - top), rx: 2, fill: color },
        s("title", {}, `${d.label}｜実績 ${abbr(d.actual)}${unit} / ${baseLabel} ${abbr(d.plan)}${unit}`
          + (ratio == null ? "" : `（${Math.round(ratio * 100)}%）`))));
    }
    if (d.plan) {
      const py = y(d.plan);
      svg.appendChild(s("line", {
        x1: x(i) - bw / 2 - 1.5, y1: py, x2: x(i) + bw / 2 + 1.5, y2: py,
        stroke: C.ref, "stroke-width": 1.6,
      }, s("title", {}, `${d.label}｜${baseLabel} ${abbr(d.plan)}${unit}`)));
    }
  });
  xLabels(svg, series, x, h);
  return wrap(title, svg, [["実績", color], [`${baseLabel}（横線）`, C.ref], ["土日祝", "#f0a12e"]]);
}

// 計画との差の累計（貯金・借金グラフ）。毎日「実績−計画」を足していき、0より上＝計画を上回っている
// （貯金）、下＝足りていない（借金）。累計の線を2本並べるより、差そのものが読める。
// 実績の無い日から先は描かない（未入力の日を0として足すと、差が横ばいに見える）。
export function cushionChart(series, { title, unit = "日" } = {}) {
  syncChrome();
  const n = series.length;
  const w = 620, h = 250, padL = 66, padR = 74, padT = 18, padB = 24;
  const iw = w - padL - padR, ih = h - padT - padB;
  let c = 0;
  const cum = series.map((d) => (d.actual == null ? null : (c += d.actual - (d.plan || 0))));
  const pts = cum.map((v, i) => [i, v]).filter(([, v]) => v != null);
  const svg = s("svg", { viewBox: `0 0 ${w} ${h}`, width: "100%" });
  const x = (i) => padL + (n <= 1 ? iw / 2 : (i * iw) / (n - 1));
  if (!pts.length) {
    svg.appendChild(s("text", { x: w / 2, y: h / 2, "text-anchor": "middle", "font-size": "14", fill: C.dim }, "実績が入るとここに出ます"));
    return wrap(title, svg, null);
  }
  const mx = Math.max(1, ...pts.map(([, v]) => Math.abs(v))) * 1.2;
  const y = (v) => padT + ih / 2 - (v / mx) * (ih / 2);
  // 目盛り（上下対称）
  for (const v of [mx / 1.2, mx / 2.4, -mx / 2.4, -mx / 1.2]) {
    svg.appendChild(s("line", { x1: padL, x2: padL + iw, y1: y(v), y2: y(v), stroke: C.line }));
    svg.appendChild(s("text", { x: padL - 6, y: y(v) + 4, "text-anchor": "end", "font-size": "11", fill: C.dim }, (v > 0 ? "+" : "▲") + abbr(Math.abs(v))));
  }
  const line = pts.map(([i, v], k) => `${k ? "L" : "M"}${x(i)},${y(v)}`).join("");
  const area = `${line}L${x(pts[pts.length - 1][0])},${y(0)}L${x(pts[0][0])},${y(0)}Z`;
  // 0の線で上下に切って、上を緑・下を赤で塗る
  const id = "cu" + Math.random().toString(36).slice(2, 8);
  svg.appendChild(s("defs", {}, [
    s("clipPath", { id: id + "u" }, s("rect", { x: 0, y: 0, width: w, height: y(0) })),
    s("clipPath", { id: id + "d" }, s("rect", { x: 0, y: y(0), width: w, height: h })),
  ]));
  svg.appendChild(s("path", { d: area, fill: C.ok, opacity: "0.22", "clip-path": `url(#${id}u)` }));
  svg.appendChild(s("path", { d: area, fill: C.bad, opacity: "0.22", "clip-path": `url(#${id}d)` }));
  svg.appendChild(s("line", { x1: padL, x2: padL + iw, y1: y(0), y2: y(0), stroke: C.fg, "stroke-width": "1.5" }));
  svg.appendChild(s("text", { x: padL - 6, y: y(0) + 4, "text-anchor": "end", "font-size": "12", "font-weight": "700", fill: C.fg }, "計画"));
  svg.appendChild(s("path", { d: line, fill: "none", stroke: C.fg, "stroke-width": "2.5", "stroke-linejoin": "round" }));
  const [li, lv] = pts[pts.length - 1];
  const col = lv >= 0 ? "#1f9d70" : "#c8323f";
  svg.appendChild(s("circle", { cx: x(li), cy: y(lv), r: 5, fill: col }));
  svg.appendChild(s("text", { x: x(li) + 9, y: y(lv) + 5, "font-size": "15", "font-weight": "700", fill: col }, (lv >= 0 ? "+" : "▲") + abbr(Math.abs(lv))));
  xLabels(svg, series, x, h, 11);
  return wrap(title, svg, [["計画より多い（貯金）", C.ok], ["足りない（借金）", C.bad]]);
}

// 日別の実績を区分の色で積み上げ、その日の計画を横線で重ねる。1本の棒で「その日の合計が
// 計画に届いたか」と「どの区分が稼いだか」の両方が読める。実績の無い日は計画の線だけ（破線）。
// マイナスの粗利（出した日）は0の下に積む。
export function stackedDaily(series, sections, colorOf, { title, unit = "日" } = {}) {
  syncChrome();
  const n = series.length;
  const w = 620, h = 250, padL = 66, padR = 12, padT = 14, padB = 24;
  const iw = w - padL - padR, ih = h - padT - padB;
  const pos = (d) => sections.reduce((a, sec) => a + Math.max(0, d.bySec?.[sec.id] || 0), 0);
  const neg = (d) => sections.reduce((a, sec) => a + Math.min(0, d.bySec?.[sec.id] || 0), 0);
  const top = Math.max(1, ...series.map((d) => Math.max(pos(d), d.plan || 0))) * 1.08;
  const bottom = Math.min(0, ...series.map(neg)) * 1.08;
  const y = (v) => padT + ((top - v) / (top - bottom)) * ih;
  const bw = iw / n;
  const x = (i) => padL + i * bw + bw / 2;
  const svg = s("svg", { viewBox: `0 0 ${w} ${h}`, width: "100%" });
  for (const v of [top / 1.08, top / 2.16]) {
    svg.appendChild(s("line", { x1: padL, x2: padL + iw, y1: y(v), y2: y(v), stroke: C.line }));
    svg.appendChild(s("text", { x: padL - 6, y: y(v) + 4, "text-anchor": "end", "font-size": "11", fill: C.dim }, abbr(v)));
  }
  svg.appendChild(s("line", { x1: padL, x2: padL + iw, y1: y(0), y2: y(0), stroke: C.fg, "stroke-width": "1" }));
  const gap = Math.min(4, bw * 0.25);
  series.forEach((d, i) => {
    const x0 = padL + i * bw + gap / 2, bwi = bw - gap;
    let up = 0, dn = 0;
    if (d.actual != null) {
      for (const sec of sections) {
        const v = d.bySec?.[sec.id];
        if (!v) continue;
        const from = v >= 0 ? up : dn, to = from + v;
        if (v >= 0) up = to; else dn = to;
        svg.appendChild(s("rect", { x: x0, width: bwi, y: y(Math.max(from, to)), height: Math.max(0.5, Math.abs(y(from) - y(to))), fill: colorOf(sec) },
          s("title", {}, `${d.label}${unit === "日" ? "日" : ""} ${sec.label} ${abbr(v)}`)));
      }
    }
    if (d.plan) {
      svg.appendChild(s("line", { x1: x0 - 1, x2: x0 + bwi + 1, y1: y(d.plan), y2: y(d.plan), stroke: C.fg, "stroke-width": "2",
        "stroke-dasharray": d.actual == null ? "3 3" : null, opacity: d.actual == null ? "0.45" : null }));
    }
  });
  xLabels(svg, series, x, h, 11);
  return wrap(title, svg, [...sections.map((sec) => [sec.label, colorOf(sec)]), ["計画（横線）", C.fg]]);
}

function wrap(title, svg, legend) {
  const box = document.createElement("div");
  box.className = "card";
  box.style.flex = "1";
  box.style.minWidth = "300px";
  const l = legend ? document.createElement("div") : null;
  if (l) {
    l.className = "chart-legend";
    for (const [name, col] of legend) l.insertAdjacentHTML("beforeend", `<span><span style="display:inline-block;width:10px;height:10px;background:${col};border-radius:2px;margin-right:4px"></span>${name}</span>`);
  }
  if (title) {
    // 見出しの行はまるごと空いているので、凡例をその右端に載せて1行ぶん詰める。
    const head = document.createElement("div");
    head.className = "row chart-head";
    head.style.cssText = "align-items:baseline;gap:10px;flex-wrap:wrap";
    const h = document.createElement("div");
    h.className = "hint";
    h.textContent = title;
    head.appendChild(h);
    if (l) { l.style.marginTop = "0"; l.style.marginLeft = "auto"; head.appendChild(l); }
    box.appendChild(head);
    box.appendChild(svg);
  } else {
    box.appendChild(svg);
    if (l) box.appendChild(l);   // 見出しが無いグラフは従来どおり下に置く
  }
  return box;
}

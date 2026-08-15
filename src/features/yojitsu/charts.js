// 依存ゼロのSVG自前描画。ダークテーマ配色。
const NS = "http://www.w3.org/2000/svg";
// pos/neg は色覚多様性・コントラストの検証を通した発散ペア（青↔赤）。
// ref は計画（基準線）用のグレー。塗りではなく線なので plan より濃いものを使う。
const C = { ok: "#43b483", warn: "#e0a52e", bad: "#e35d6a", accent: "#e35d6a", dim: "#8a91a3", line: "#e3e8f2", plan: "#c3cbdb", fg: "#2f3440", pos: "#2a78d6", neg: "#e34948", ref: "#7d8595" };

function s(tag, attrs = {}, children = []) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  for (const c of [].concat(children)) if (c != null) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return n;
}
const achColor = (r) => (r == null ? C.dim : r >= 1 ? C.ok : r >= 0.9 ? C.warn : C.bad);
const abbr = (n) => (n == null ? "—" : Math.abs(n) >= 1e8 ? (n / 1e8).toFixed(1) + "億" : Math.abs(n) >= 1e4 ? Math.round(n / 1e4) + "万" : String(Math.round(n)));

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

// 累計は億の桁になると abbr の1桁では「2.4億 vs 2.4億」と同じに見えるので2桁で出す
const abbr2 = (n) => (n == null ? "—" : Math.abs(n) >= 1e8 ? (n / 1e8).toFixed(2) + "億" : abbr(n));

// 日付ラベル（31個までは全部、それ以上は間引く）
function xLabels(svg, series, x, h) {
  const step = series.length <= 31 ? 1 : Math.ceil(series.length / 16);
  series.forEach((d, i) => { if (i % step === 0) svg.appendChild(s("text", { x: x(i), y: h - 6, "text-anchor": "middle", "font-size": "8.5", fill: C.dim }, d.label)); });
}

// 累計の予実。日別の折れ線は曜日変動が支配的で差が読めなかったため累計にした。
// 実績が途切れた先は「残りは計画どおり」で伸ばした着地見込み（アプリの着地KPIと同じ定義）。
export function cumLine(series, { title } = {}) {
  const n = series.length;
  const w = 620, h = 226, padL = 46, padB = 22, padT = 14, padR = 68;
  const iw = w - padL - padR, ih = h - padB - padT;

  let cp = 0, ca = 0, last = -1;
  const P = [], A = [];
  series.forEach((d) => {
    cp += d.plan || 0; P.push(cp);
    if (d.actual == null) A.push(null);
    else { ca += d.actual; A.push(ca); last = A.length - 1; }
  });
  const F = series.map(() => null);
  if (last >= 0 && last < n - 1) { let cf = ca; F[last] = cf; for (let i = last + 1; i < n; i++) { cf += series[i].plan || 0; F[i] = cf; } }
  const landing = last < 0 ? null : (F[n - 1] != null ? F[n - 1] : A[last]);

  const max = Math.max(1, cp, ...A.filter((v) => v != null), ...F.filter((v) => v != null));
  const x = (i) => padL + (n <= 1 ? 0 : (iw * i) / (n - 1));
  const y = (v) => padT + ih - (ih * v) / max;
  const svg = s("svg", { viewBox: `0 0 ${w} ${h}`, width: "100%", style: "max-width:100%" });
  for (let g = 0; g <= 4; g++) {
    const gy = padT + (ih * g) / 4;
    svg.appendChild(s("line", { x1: padL, y1: gy, x2: padL + iw, y2: gy, stroke: C.line }));
    svg.appendChild(s("text", { x: padL - 4, y: gy + 3, "text-anchor": "end", "font-size": "9", fill: C.dim }, abbr(max * (1 - g / 4))));
  }
  // 計画線と実績線のあいだを塗る。この面積の広さがそのまま遅れ（先行）の大きさ。
  if (last >= 0) {
    const behind = A[last] < P[last];
    const pts = [];
    for (let i = 0; i <= last; i++) pts.push(`${x(i)},${y(P[i])}`);
    for (let i = last; i >= 0; i--) pts.push(`${x(i)},${y(A[i])}`);
    svg.appendChild(s("polygon", { points: pts.join(" "), fill: behind ? C.neg : C.pos, opacity: "0.12" }));
  }
  const poly = (arr, color, dash, width) => {
    const pts = arr.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(" ");
    if (pts) svg.appendChild(s("polyline", { points: pts, fill: "none", stroke: color, "stroke-width": width, "stroke-dasharray": dash, "stroke-linejoin": "round" }));
  };
  poly(P, C.ref, "5 4", 2);
  poly(F, C.pos, "2 3", 2);
  poly(A, C.pos, null, 2.5);
  // 実績が1点しかない月初は線が引けないので点で示す
  if (last === 0) svg.appendChild(s("circle", { cx: x(0), cy: y(A[0]), r: 3.5, fill: C.pos }));

  // 右端に直接ラベル。凡例を目で往復しなくても読めるようにする。
  // 着地は点と対で読ませたいので実位置に置き、ぶつかるときは計画側をずらす。
  const clamp = (v) => Math.max(padT + 12, Math.min(padT + ih - 6, v));
  const yl = landing == null ? null : clamp(y(landing));
  let yp = clamp(y(P[n - 1]));
  if (yl != null && Math.abs(yp - yl) < 28) yp = clamp(yl + (yl > padT + ih / 2 ? -28 : 28));
  const lx = padL + iw + 6;
  svg.appendChild(s("text", { x: lx, y: yp + 3, "font-size": "10", "font-weight": "700", fill: C.ref }, "計画 " + abbr2(P[n - 1])));
  if (landing != null) {
    const gap = landing - P[n - 1];
    svg.appendChild(s("circle", { cx: x(n - 1), cy: y(landing), r: 4.5, fill: C.pos, stroke: "#fff", "stroke-width": 2 }));
    svg.appendChild(s("text", { x: lx, y: yl - 2, "font-size": "10.5", "font-weight": "800", fill: C.pos }, "着地 " + abbr2(landing)));
    svg.appendChild(s("text", { x: lx, y: yl + 10, "font-size": "9.5", "font-weight": "700", fill: gap < 0 ? C.neg : C.pos }, (gap >= 0 ? "+" : "−") + abbr(Math.abs(gap))));
  }
  // ホバーで各日の数字を出す（当たり判定は列全体）
  const bw = iw / Math.max(1, n);
  series.forEach((d, i) => {
    const tip = `${d.label}｜計画累計 ${abbr2(P[i])}` + (A[i] == null ? "（実績未取込）" : `／実績累計 ${abbr2(A[i])}（差 ${A[i] - P[i] >= 0 ? "+" : "−"}${abbr(Math.abs(A[i] - P[i]))}）`);
    svg.appendChild(s("rect", { x: x(i) - bw / 2, y: padT, width: bw, height: ih, fill: "transparent" }, s("title", {}, tip)));
  });
  xLabels(svg, series, x, h);
  return wrap(title, svg, [["計画の累計（破線）", C.ref], ["実績の累計", C.pos], ["着地見込み（点線）", C.pos]]);
}

// 今年と昨年の累計を重ねる。日別の棒は曜日で上下して差が読み取りにくいので、
// 「月を通してどれだけ差がついたか」はこちらで見る。
// 昨年は月末まで引き、今年は実績のある日で止める（先を計画で伸ばすと前年比が濁る）。
export function cumCompare(series, { title, color = C.pos, unit = "" } = {}) {
  const n = series.length;
  const w = 620, h = 210, padL = 46, padB = 22, padT = 14, padR = 74;
  const iw = w - padL - padR, ih = h - padB - padT;
  let cc = 0, cb = 0, last = -1;
  const A = [], B = [];
  series.forEach((d) => {
    if (d.cur == null) A.push(null);
    else { cc += d.cur; A.push(cc); last = A.length - 1; }
    if (d.base == null) B.push(null);
    else { cb += d.base; B.push(cb); }
  });
  const max = Math.max(1, ...A.filter((v) => v != null), ...B.filter((v) => v != null));
  const x = (i) => padL + (n <= 1 ? 0 : (iw * i) / (n - 1));
  const y = (v) => padT + ih - (ih * v) / max;
  const svg = s("svg", { viewBox: `0 0 ${w} ${h}`, width: "100%", style: "max-width:100%" });
  for (let g = 0; g <= 4; g++) {
    const gy = padT + (ih * g) / 4;
    svg.appendChild(s("line", { x1: padL, y1: gy, x2: padL + iw, y2: gy, stroke: C.line }));
    svg.appendChild(s("text", { x: padL - 4, y: gy + 3, "text-anchor": "end", "font-size": "9", fill: C.dim }, abbr(max * (1 - g / 4))));
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
    const tip = `${d.label}｜今年累計 ${A[i] == null ? "—" : abbr2(A[i])}／昨年累計 ${B[i] == null ? "—" : abbr2(B[i])}${unit}`;
    svg.appendChild(s("rect", { x: x(i) - iw / Math.max(1, n) / 2, y: padT, width: iw / Math.max(1, n), height: ih, fill: "transparent" }, s("title", {}, tip)));
  });
  xLabels(svg, series, x, h);
  return wrap(title, svg, [["今年の累計", color], ["昨年の累計（破線）", C.ref]]);
}

// 日別の過不足（実績−計画）。0を基準にした発散バーで「どの日で落としたか」が分かる。
export function diffBars(series, { title } = {}) {
  const n = series.length;
  const w = 620, h = 190, padL = 46, padB = 22, padT = 16, padR = 10;
  const iw = w - padL - padR, ih = h - padB - padT;
  const vals = series.map((d) => (d.actual == null ? null : d.actual - (d.plan || 0)));
  const seen = vals.filter((v) => v != null);
  const m = Math.max(1, ...seen.map(Math.abs));
  const zy = padT + ih / 2;
  const y = (v) => zy - (ih / 2) * (v / m);
  const x = (i) => padL + (iw * (i + 0.5)) / Math.max(1, n);
  const bw = Math.max(3, Math.min(18, (iw / Math.max(1, n)) * 0.66));
  const svg = s("svg", { viewBox: `0 0 ${w} ${h}`, width: "100%", style: "max-width:100%" });
  for (const g of [1, 0.5, -0.5, -1]) {
    const gy = y(m * g);
    svg.appendChild(s("line", { x1: padL, y1: gy, x2: padL + iw, y2: gy, stroke: C.line }));
    svg.appendChild(s("text", { x: padL - 4, y: gy + 3, "text-anchor": "end", "font-size": "9", fill: C.dim }, (g > 0 ? "+" : "−") + abbr(m * Math.abs(g))));
  }
  // 0（＝計画どおり）の基準線だけ濃くする
  svg.appendChild(s("line", { x1: padL, y1: zy, x2: padL + iw, y2: zy, stroke: C.dim, "stroke-width": 1.2 }));
  svg.appendChild(s("text", { x: padL - 4, y: zy + 3, "text-anchor": "end", "font-size": "9", "font-weight": "700", fill: C.fg }, "計画"));

  let best = -1, worst = -1;
  vals.forEach((v, i) => {
    if (v == null) return;
    if (best < 0 || v > vals[best]) best = i;
    if (worst < 0 || v < vals[worst]) worst = i;
  });
  vals.forEach((v, i) => {
    if (v == null) return;
    const top = v >= 0 ? y(v) : zy, hh = Math.max(1.5, Math.abs(y(v) - zy));
    svg.appendChild(s("rect", { x: x(i) - bw / 2, y: top, width: bw, height: hh, rx: 3, fill: v >= 0 ? C.pos : C.neg },
      s("title", {}, `${series[i].label}｜計画 ${abbr(series[i].plan)} / 実績 ${abbr(series[i].actual)}（${v >= 0 ? "+" : "−"}${abbr(Math.abs(v))}）`)));
    // 最良日・最悪日だけ数字を添える（全部に付けると読めなくなる）
    if (i === best || i === worst) svg.appendChild(s("text", {
      x: x(i), y: v >= 0 ? y(v) - 4 : y(v) + 11, "text-anchor": "middle", "font-size": "9", "font-weight": "700", fill: v >= 0 ? C.pos : C.neg,
    }, (v >= 0 ? "+" : "−") + abbr(Math.abs(v))));
  });
  xLabels(svg, series, x, h);
  return wrap(title, svg, [["計画を上回った日", C.pos], ["下回った日", C.neg]]);
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
  const n = series.length;
  const w = 640, h = 168, padL = 46, padB = 20, padT = 14, padR = 10;
  const iw = w - padL - padR, ih = h - padB - padT;
  const vals = series.map((d) => d.actual);
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

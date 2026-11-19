// 景品タブ：景品管理表から、金景品（大・中・小）とタバコの出庫と入庫を見る。
//
// 1日平均は「出庫の合計 ÷ 記入済みの日数」。未記入の日は0とせず日数から外す
// （月の途中で0の日を数えると平均が下がり、在庫が何日もつかを長く見積もってしまう）。
import { el, clear } from "../../util/dom.js";
import { num } from "../../util/format.js";
import { loadMonths, loadMonth } from "./data.js";

let selYm = null;

// 金景品は大・中・小の順に濃く。タバコは1色。入庫はどちらもグレー（前年・参考と同じ扱いの色）
const GOLD_COLOR = { 大: "#1d4fa8", 中: "#4f8ff7", 小: "#a9c8fb" };
const TOBACCO_COLOR = "#2fb888";
const IN_COLOR = "#8a91a3";

const md = (ymd) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
const f1 = (v) => (v == null ? "—" : (Math.round(v * 10) / 10).toFixed(1));
const sum = (a) => a.reduce((x, y) => x + (y || 0), 0);

// 1か月ぶんを集計する。days は記入済みの日だけ（ymd順）
function summarize(month) {
  const days = Object.entries(month.days || {}).map(([ymd, d]) => ({ ymd, ...d })).sort((a, b) => (a.ymd < b.ymd ? -1 : 1));
  const N = days.length;
  const items = new Map(); // key -> {key, kind, name, outs[], ins, picks, zan, errs}
  const errors = [];
  for (const d of days) {
    for (const it of d.items) {
      if (!items.has(it.key)) items.set(it.key, { key: it.key, kind: it.kind, name: it.name, outs: [], in: 0, pick: 0, zan: null, errDays: 0 });
      const x = items.get(it.key);
      x.name = it.name; x.outs.push(it.out || 0); x.in += it.in || 0; x.pick += it.pick || 0;
      x.zan = it.zan; // 最後の記入日の残
      if (it.err) { x.errDays++; errors.push({ ymd: d.ymd, name: it.name, err: it.err, writer: d.writer }); }
    }
  }
  const rows = [...items.values()].map((x) => {
    const out = sum(x.outs), avg = N ? out / N : null;
    return { ...x, out, avg, max: Math.max(0, ...x.outs), outDays: x.outs.filter(Boolean).length, stockDays: avg ? (x.zan ?? 0) / avg : null };
  });
  const daily = days.map((d) => {
    const by = (kind) => d.items.filter((it) => it.kind === kind);
    const g = {}; for (const it of by("gold")) g[it.key] = it.out || 0;
    return { ymd: d.ymd, gold: g, goldIn: sum(by("gold").map((it) => (it.in || 0) + (it.pick || 0))),
      tobOut: sum(by("tobacco").map((it) => it.out)), tobIn: sum(by("tobacco").map((it) => (it.in || 0) + (it.pick || 0))) };
  });
  return { N, first: days[0]?.ymd, last: days[N - 1]?.ymd, gold: rows.filter((r) => r.kind === "gold"), tobacco: rows.filter((r) => r.kind === "tobacco"), daily, errors };
}

export async function mount(host) {
  clear(host);
  const months = await loadMonths();
  const head = el("div", { class: "view-head" }, [el("h1", { text: "景品" }), el("span", { class: "sub", text: "景品管理表の出庫と入庫（金景品・タバコ）" })]);
  host.appendChild(head);
  if (!months.length) {
    host.appendChild(el("div", { class: "placeholder", text: "景品管理表がまだありません。右上の「📂 取込」に景品管理表のExcel（1日1シート）を入れてください。" }));
    return;
  }
  if (!selYm || !months.includes(selYm)) selYm = months[months.length - 1];
  const sel = el("select", { class: "inp", onchange: (e) => { selYm = e.target.value; mount(host); } },
    months.slice().reverse().map((ym) => el("option", { value: ym, selected: ym === selYm ? "" : null, text: `${ym.slice(0, 4)}年${Number(ym.slice(5))}月` })));
  head.appendChild(el("div", { class: "ops" }, [sel]));

  const cur = summarize(await loadMonth(selYm));
  // 前月があれば1日平均を比べる（月の途中でも比べられるよう、合計ではなく1日平均で）
  const prevYm = months[months.indexOf(selYm) - 1];
  const prev = prevYm ? summarize(await loadMonth(prevYm)) : null;

  host.appendChild(el("div", { class: "hint", style: "margin:-6px 0 12px", text:
    `${md(cur.first)}〜${md(cur.last)}の記入済み ${cur.N}日ぶん。1日平均＝出庫の合計÷${cur.N}日（未記入の日は数えない）` }));

  // ---------- 要点
  const goldOut = sum(cur.gold.map((r) => r.out)), tobOut = sum(cur.tobacco.map((r) => r.out));
  const pAvg = (rows) => (prev && prev.N ? sum(rows.map((r) => r.out)) / prev.N : null);
  const cmpAvg = (now, before) => before == null ? null : el("span", {}, ["前月 ", el("b", { text: f1(before) }), `／日（${now >= before ? "+" : ""}${f1(now - before)}）`]);
  const kpi = (label, value, color, cmps) => el("div", { class: "card kpi" }, [
    el("div", { class: "kpi-lbl", text: label }), el("div", { class: "kpi-num", style: `color:${color}`, text: value }),
    el("div", { class: "kpi-cmp" }, cmps.filter(Boolean)),
  ]);
  const goldIn = sum(cur.gold.map((r) => r.in)), tobIn = sum(cur.tobacco.map((r) => r.in));
  host.appendChild(el("div", { class: "kpis", style: "margin-bottom:14px" }, [
    kpi("金景品 出庫（1日平均）", f1(cur.N ? goldOut / cur.N : null), GOLD_COLOR.中, [
      el("span", {}, ["合計 ", el("b", { text: num(goldOut) })]), el("span", {}, ["入庫 ", el("b", { text: num(goldIn) })]), cmpAvg(cur.N ? goldOut / cur.N : 0, pAvg(prev?.gold || [])),
    ]),
    kpi("タバコ 出庫（1日平均）", f1(cur.N ? tobOut / cur.N : null), TOBACCO_COLOR, [
      el("span", {}, ["合計 ", el("b", { text: num(tobOut) })]), el("span", {}, ["入庫 ", el("b", { text: num(tobIn) })]), cmpAvg(cur.N ? tobOut / cur.N : 0, pAvg(prev?.tobacco || [])),
    ]),
    kpi("タバコの在庫（最新）", num(sum(cur.tobacco.map((r) => r.zan || 0))), "var(--fg)", [
      el("span", {}, ["全銘柄で ", el("b", { text: f1(tobOut ? sum(cur.tobacco.map((r) => r.zan || 0)) / (tobOut / cur.N) : null) }), "日分"]),
      (() => { const short = cur.tobacco.filter((r) => r.stockDays != null && r.stockDays < 14).length; return short ? el("span", { style: "color:var(--bad-fg)" }, ["2週間もたない銘柄 ", el("b", { text: String(short) })]) : null; })(),
    ]),
  ]));

  // ---------- 金景品
  host.appendChild(el("h2", { class: "pz-h", text: "金景品（大・中・小）" }));
  host.appendChild(dailyChart(cur, "gold"));
  const goldOrder = ["大", "中", "小"];
  const gRows = goldOrder.map((k) => cur.gold.find((r) => r.key === k)).filter(Boolean);
  host.appendChild(el("div", { class: "card table-wrap", style: "margin:10px 0 18px;padding:0" }, el("table", { class: "sum" }, [
    el("thead", {}, el("tr", {}, ["", "出庫 合計", "1日平均", "前月 1日平均", "1日 最大", "入庫 合計", "拾い入庫", "最新の残", "誤差のあった日"].map((h) => el("th", { text: h })))),
    el("tbody", {}, [
      ...gRows.map((r) => {
        const p = prev?.gold.find((x) => x.key === r.key);
        return el("tr", {}, [
          el("td", {}, [el("span", { class: "pz-dot", style: `background:${GOLD_COLOR[r.key]}` }), r.key]),
          el("td", { text: num(r.out) }), el("td", { text: f1(r.avg) }), el("td", { text: p ? f1(p.avg) : "—" }), el("td", { text: num(r.max) }),
          el("td", { text: num(r.in) }), el("td", { text: num(r.pick) }), el("td", { text: r.zan == null ? "—" : num(r.zan) }),
          el("td", { text: r.errDays ? `${r.errDays}日` : "なし" }),
        ]);
      }),
      el("tr", { class: "tot" }, [el("td", { text: "計" }), el("td", { text: num(goldOut) }), el("td", { text: f1(cur.N ? goldOut / cur.N : null) }),
        el("td", { text: prev?.N ? f1(sum(prev.gold.map((r) => r.out)) / prev.N) : "—" }), el("td", { text: "" }),
        el("td", { text: num(goldIn) }), el("td", { text: num(sum(gRows.map((r) => r.pick))) }), el("td", { text: num(sum(gRows.map((r) => r.zan || 0))) }), el("td", { text: "" })]),
    ]),
  ])));

  // ---------- タバコ
  host.appendChild(el("h2", { class: "pz-h", text: "タバコ" }));
  host.appendChild(dailyChart(cur, "tobacco"));
  const used = cur.tobacco.filter((r) => r.out || r.zan).sort((a, b) => b.avg - a.avg || b.zan - a.zan);
  const idle = cur.tobacco.filter((r) => !r.out && !r.zan);
  // 在庫が何日もつか。2週間を切ったら黄、1週間を切ったら赤（補充の目安）
  const stockBadge = (d) => d == null ? el("span", { class: "rate none", text: "—" })
    : el("span", { class: "rate " + (d < 7 ? "bad" : d < 14 ? "warn" : "ok"), text: `${Math.round(d)}日` });
  host.appendChild(el("div", { class: "card table-wrap", style: "margin:10px 0 6px;padding:0" }, el("table", { class: "sum" }, [
    el("thead", {}, el("tr", {}, ["銘柄", "出庫 合計", "1日平均", "前月 1日平均", "1日 最大", "入庫 合計", "最新の残", "在庫は何日分"].map((h) => el("th", { text: h })))),
    el("tbody", {}, [
      ...used.map((r) => {
        const p = prev?.tobacco.find((x) => x.key === r.key);
        return el("tr", {}, [
          el("td", { text: r.name }), el("td", { text: num(r.out) }), el("td", { text: f1(r.avg) }), el("td", { text: p ? f1(p.avg) : "—" }),
          el("td", { text: num(r.max) }), el("td", { text: num(r.in) }), el("td", { text: r.zan == null ? "—" : num(r.zan) }), el("td", {}, stockBadge(r.stockDays)),
        ]);
      }),
      el("tr", { class: "tot" }, [el("td", { text: "計" }), el("td", { text: num(tobOut) }), el("td", { text: f1(cur.N ? tobOut / cur.N : null) }),
        el("td", { text: prev?.N ? f1(sum(prev.tobacco.map((r) => r.out)) / prev.N) : "—" }), el("td", { text: "" }),
        el("td", { text: num(tobIn) }), el("td", { text: num(sum(used.map((r) => r.zan || 0))) }), el("td", { text: "" })]),
    ]),
  ])));
  if (idle.length) host.appendChild(el("div", { class: "hint", style: "margin-bottom:18px", text: `出庫も在庫も無い銘柄（${idle.length}）：${idle.map((r) => r.name).join("、")}` }));

  // ---------- 誤差（本日残とPOS残の差）。棚卸しのずれは日付と記入者が分かれば追える
  host.appendChild(el("h2", { class: "pz-h", text: "POS残との誤差" }));
  host.appendChild(cur.errors.length
    ? el("div", { class: "card table-wrap", style: "padding:0" }, el("table", { class: "sum" }, [
      el("thead", {}, el("tr", {}, ["日付", "品目", "誤差", "記入者"].map((h) => el("th", { text: h })))),
      el("tbody", {}, cur.errors.map((e) => el("tr", {}, [el("td", { text: md(e.ymd) }), el("td", { style: "text-align:left", text: e.name }),
        el("td", { style: "color:var(--bad-fg);font-weight:700", text: (e.err > 0 ? "+" : "") + num(e.err) }), el("td", { style: "text-align:left", text: e.writer || "—" })]))),
    ]))
    : el("div", { class: "hint", text: `${cur.N}日とも誤差なし` }));
}

// 日ごとの出庫（棒）と入庫（グレーの棒）。月の全日を並べ、未記入の日は空けておく
// （0の棒を描くと「出庫ゼロの日」に見える）。
function dailyChart(cur, kind) {
  const [y, m] = (cur.first || "2000-01").split("-").map(Number);
  const nDays = new Date(y, m, 0).getDate();
  const byDay = new Map(cur.daily.map((d) => [Number(d.ymd.slice(8, 10)), d]));
  const outOf = (d) => (kind === "gold" ? sum(Object.values(d.gold)) : d.tobOut);
  const inOf = (d) => (kind === "gold" ? d.goldIn : d.tobIn);
  // 縦軸は出庫に合わせる。タバコの入庫は月に1〜2回まとめて入る（実物で1日2,000個）ので、
  // 入庫に合わせると出庫の棒が底に張り付いて読めない。はみ出す入庫は上で切って数字を添える。
  const maxOut = Math.max(0, ...cur.daily.map(outOf)), maxIn = Math.max(0, ...cur.daily.map(inOf));
  const maxV = Math.max(1, maxOut ? Math.max(maxOut * 1.15, Math.min(maxIn, maxOut * 3)) : maxIn);
  // スマホは描く幅を狭くして、縮めて表示したときに目盛りの字が小さくなりすぎないようにする
  const W = window.matchMedia("(max-width: 700px)").matches ? 520 : 960, H = 220, padL = 50, padB = 24, padT = 8, cw = (W - padL - 8) / nDays, bw = Math.max(3, cw * 0.36);
  const yv = (v) => padT + (H - padT - padB) * (1 - v / maxV);
  const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find((s) => maxV / s <= 5) || 1000;
  let s = "";
  for (let v = 0; v <= maxV; v += step) s += `<line x1="${padL}" x2="${W - 8}" y1="${yv(v)}" y2="${yv(v)}" stroke="#e3e7ee"/><text x="${padL - 6}" y="${yv(v) + 4}" text-anchor="end" font-size="13" fill="#6b7280">${v}</text>`;
  for (let day = 1; day <= nDays; day++) {
    const x0 = padL + (day - 1) * cw + cw / 2;
    if (day === 1 || day % 5 === 0) s += `<text x="${x0}" y="${H - 6}" text-anchor="middle" font-size="13" fill="#6b7280">${day}</text>`;
    const d = byDay.get(day);
    if (!d) continue;
    let top = yv(0);
    if (kind === "gold") {
      for (const k of ["大", "中", "小"]) {
        const v = d.gold[k] || 0; if (!v) continue;
        const h = yv(0) - yv(v); top -= h;
        s += `<rect x="${x0 - bw}" y="${top}" width="${bw}" height="${h}" fill="${GOLD_COLOR[k]}"><title>${m}/${day} ${k} 出庫 ${v}</title></rect>`;
      }
    } else {
      const v = d.tobOut; s += `<rect x="${x0 - bw}" y="${yv(v)}" width="${bw}" height="${yv(0) - yv(v)}" fill="${TOBACCO_COLOR}"><title>${m}/${day} 出庫 ${v}</title></rect>`;
    }
    const iv = inOf(d);
    if (iv) {
      const cut = iv > maxV, top2 = yv(Math.min(iv, maxV));
      s += `<rect x="${x0}" y="${top2}" width="${bw}" height="${yv(0) - top2}" fill="${IN_COLOR}" opacity=".7"><title>${m}/${day} 入庫 ${iv}</title></rect>`;
      if (cut) s += `<text x="${x0 + bw + 3}" y="${top2 + 13}" font-size="13" font-weight="700" fill="#5b6273">${num(iv)}↑</text>`;
    }
  }
  const legend = kind === "gold" ? [["大", GOLD_COLOR.大], ["中", GOLD_COLOR.中], ["小", GOLD_COLOR.小], ["入庫", IN_COLOR]] : [["出庫", TOBACCO_COLOR], ["入庫", IN_COLOR]];
  const box = el("div", { class: "card" });
  const headRow = el("div", { class: "row chart-head", style: "align-items:baseline;gap:10px" }, [
    el("div", { class: "hint", text: "日ごとの出庫（左の棒）と入庫（右のグレー）。空いている日は未記入" }),
    el("div", { class: "chart-legend", style: "margin:0 0 0 auto" }, legend.map(([n, c]) => el("span", {}, [el("span", { class: "pz-dot", style: `background:${c}` }), n]))),
  ]);
  const svg = el("div");
  svg.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">${s}</svg>`;
  box.append(headRow, svg);
  return box;
}

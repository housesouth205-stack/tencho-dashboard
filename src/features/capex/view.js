// 増台計画タブ。見積（単価）→ 導入ラウンド → 支払予定 → 設置比率の推移、を1本につなぐ。
// もとは「202611 増台数と数値.xlsx」を毎回手で作り直していた作業。数字の出どころを
// 単価台帳1か所にまとめ、計画を変えたら支払予定と比率が同時に動くようにしてある。
import { el, clear, modal } from "../../util/dom.js";
import { repo } from "../../core/repo.js";
import { state } from "../../core/state.js";
import { setSaveState, toast, errorToast } from "../../core/errors.js";
import { yen, num, pct } from "../../util/format.js";
import { printContent, fitToPages } from "../../print/printService.js";
import { parseRanges, inRanges } from "../../util/daiRange.js";
import { paymentBars, rateLines, secColor } from "./charts.js";
import { buildPlanMap, buildPlanFloor, buildPlanLegend, floorsOf } from "./planMap.js";
import {
  loadPlan, saveItems, saveRounds, saveGrowth, newId,
  KINDS, PAY_MODES, unitPriceOf, paymentSchedule, projectGrowth,
  roundsFromScenario, addMonth, ymOf, ymLabel, SECS,
} from "./model.js";

const narrow = () => window.matchMedia("(max-width: 700px)").matches;
const PANES = [
  { key: "plan", label: "増台計画" },
  { key: "pay", label: "支払予定" },
  { key: "items", label: "単価台帳" },
  { key: "map", label: "島図" },
];
let pane = "plan";

let plan = null;      // { items, rounds, growth }
let layout = [];      // 島図（layout_cell）

export async function mount(host) {
  clear(host);
  host.appendChild(el("div", { class: "view-title" }, [
    el("h1", { text: "増台計画" }),
    el("small", { text: "見積の単価・支払予定・スマート設置比率" }),
  ]));

  const body = el("div", { class: "col" });
  const chips = el("div", { class: "row", style: "gap:8px;flex-wrap:wrap;margin-bottom:12px" });
  const drawChips = () => {
    clear(chips);
    for (const p of PANES) chips.appendChild(el("button", {
      class: "btn sm " + (pane === p.key ? "primary" : "ghost"), text: p.label,
      onclick: () => { pane = p.key; drawChips(); render(); },
    }));
  };
  host.appendChild(chips);
  host.appendChild(body);
  drawChips();

  try {
    plan = await loadPlan();
    layout = await repo.select("layout_cell", { eq: { store_id: state.storeId } }).catch(() => []);
  } catch (e) { errorToast(e); return; }
  render();

  function render() {
    clear(body);
    if (pane === "plan") paneGrowth(body, render);
    else if (pane === "pay") panePayment(body, render);
    else if (pane === "items") paneItems(body, render);
    else paneMap(body);
  }
}

/* ══════════ 共通の小物 ══════════ */
const inp = (value, opts = {}) => el("input", {
  type: opts.type || "text", value: value == null ? "" : String(value),
  style: `width:${opts.w || 110}px;text-align:${opts.type === "number" ? "right" : "left"}`,
  ...(opts.attrs || {}),
});
const sel = (options, value, w = 120) => {
  const s = el("select", { class: "inp", style: `width:${w}px` });
  for (const o of options) s.appendChild(el("option", { value: o.key, text: o.label, selected: o.key === value ? "selected" : null }));
  return s;
};
const th = (t, cls) => el("th", { class: cls || "", text: t });
const td = (t, cls) => el("td", { class: cls || "", text: t });
const cardOf = (title, sub, nodes) => el("section", { class: "card col" }, [
  el("div", {}, [el("h2", { style: "margin:0;font-size:15px", text: title }),
    sub ? el("div", { class: "hint", text: sub }) : null]),
  ...[].concat(nodes),
]);
const wrapTable = (t) => el("div", { class: "table-wrap" }, t);

// 印刷用に「画面と同じ中身」を作って渡す。印刷だけ別に組むと必ず片方が古くなる。
function doPrint(nodes, title, orientation = "landscape") {
  doPrintPages([el("div", {}, [el("h2", { text: title }), ...[].concat(nodes)])], orientation);
}

// 1ノード＝1ページ。fitToPages は各ノードを紙1枚に収まるまで縮めるので、
// ページに分けたいものは分けて渡さないと、はみ出したぶんが次ページに送られて
// 下が切れた紙が増える（島図で実際にそうなる）。
function doPrintPages(pages, orientation = "landscape") {
  const fitted = fitToPages(pages, { orientation });
  // 改ページ指定は一番外側の要素に付いていないと効かない
  printContent(fitted.map((n, i) => el("div", { class: "floor" + (i ? " page-break" : "") }, n)),
    { title: "", orientation });
}

/* ══════════ ① 増台計画 ══════════ */
function paneGrowth(host, rerender) {
  const g = plan.growth;

  /* 現状の台数 */
  const baseInputs = {};
  const bt = el("table", { class: "grid" });
  bt.appendChild(el("thead", {}, el("tr", {}, [th("区分", "txt"), th("総台数"), th("現在スマート"), th("設置比率")])));
  const bb = el("tbody");
  const rateCells = {};
  const recalcBase = () => {
    for (const s of SECS) {
      const t = Number(baseInputs[s.key].total.value) || 0;
      const m = Number(baseInputs[s.key].smart.value) || 0;
      rateCells[s.key].textContent = t ? pct(m / t) : "—";
    }
  };
  for (const s of SECS) {
    const t = inp(g.base?.[s.key]?.total ?? 0, { type: "number", w: 90 });
    const m = inp(g.base?.[s.key]?.smart ?? 0, { type: "number", w: 90 });
    t.addEventListener("input", recalcBase); m.addEventListener("input", recalcBase);
    baseInputs[s.key] = { total: t, smart: m };
    const rc = el("td", { class: "mono" });
    rateCells[s.key] = rc;
    bb.appendChild(el("tr", {}, [el("td", { class: "txt", text: s.label }), el("td", {}, t), el("td", {}, m), rc]));
  }
  bt.appendChild(bb);
  recalcBase();
  const readBase = () => Object.fromEntries(SECS.map((s) => [s.key,
    { total: Number(baseInputs[s.key].total.value) || 0, smart: Number(baseInputs[s.key].smart.value) || 0 }]));

  /* シナリオ */
  const scHost = el("div", { class: "col" });
  const scInputs = new Map();
  const drawScenarios = () => {
    clear(scHost);
    scInputs.clear();
    for (const sc of g.scenarios) scHost.appendChild(scenarioCard(sc));
    scHost.appendChild(el("div", { class: "row", style: "gap:8px;flex-wrap:wrap" }, [
      el("button", { class: "btn sm ghost", text: "＋ 案を追加", onclick: () => {
        g.scenarios.push({ id: newId(), label: "新しい案", every: 3, start: addMonth(ymOf(new Date().toISOString()), 1), per: { S20: 13, S5: 0, S2: 0 }, count: 8 });
        drawScenarios(); drawCompare();
      } }),
      el("button", { class: "btn primary sm", text: "計画を保存", onclick: save }),
    ]));
  };

  function readScenario(sc) {
    const f = scInputs.get(sc.id);
    return {
      ...sc, label: f.label.value.trim() || "案", start: f.start.value.slice(0, 7),
      every: Number(f.every.value) || 3, count: Number(f.count.value) || 1,
      per: Object.fromEntries(SECS.map((s) => [s.key, Number(f.per[s.key].value) || 0])),
      workItemName: f.work.value,
    };
  }

  function scenarioCard(sc) {
    const f = { per: {} };
    f.label = inp(sc.label, { w: 130 });
    f.start = el("input", { type: "month", value: sc.start, style: "width:158px" });
    f.every = inp(sc.every, { type: "number", w: 62 });
    f.count = inp(sc.count, { type: "number", w: 62 });
    for (const s of SECS) f.per[s.key] = inp(sc.per?.[s.key] ?? 0, { type: "number", w: 62 });
    const works = plan.items.filter((i) => i.kind === "work");
    f.work = sel(works.map((w) => ({ key: w.name, label: w.name })).concat([{ key: "", label: "（工事費なし）" }]), sc.workItemName || "", 190);
    scInputs.set(sc.id, f);

    const out = el("div", { class: "col", style: "gap:8px" });
    const redraw = () => {
      clear(out);
      const cur = readScenario(sc);
      const { rows, added, finalRate } = projectGrowth(readBase(), cur);
      const rounds = roundsFromScenario(cur, readBase(), plan.items);
      const { total } = paymentSchedule(rounds, plan.items);
      out.appendChild(el("div", { class: "row", style: "gap:16px;flex-wrap:wrap;font-size:13px" }, [
        el("div", {}, [el("div", { class: "hint", text: "増台合計" }), el("b", { text: `${num(added)}台` })]),
        el("div", {}, [el("div", { class: "hint", text: "完了" }), el("b", { text: rows.length ? ymLabel(rows[rows.length - 1].ym) : "—" })]),
        el("div", {}, [el("div", { class: "hint", text: "全体の設置比率" }), el("b", { text: pct(finalRate) })]),
        el("div", {}, [el("div", { class: "hint", text: "支払総額" }), el("b", { text: yen(total) })]),
      ]));
      out.appendChild(rateLines(rows, { title: `${cur.label}：設置比率の推移`, narrow: narrow() }));
      // 実際の計画は回ごとに台数の配分が変わる（1回目は20スロだけ、途中から5スロも）。
      // 表の増台数を直接直せるようにして、その回だけの指定として持つ。
      out.appendChild(wrapTable(growthTable(rows, (ym, key, v) => {
        sc.overrides = { ...(sc.overrides || {}) };
        sc.overrides[ym] = { ...(sc.overrides[ym] || {}), [key]: v };
        redraw(); drawCompare();
      })));
      out.appendChild(el("div", { class: "row", style: "gap:8px;flex-wrap:wrap" }, [
        el("button", { class: "btn sm", text: "この案で支払予定を作る", onclick: async () => {
          const cur2 = readScenario(sc);
          const rs = roundsFromScenario(cur2, readBase(), plan.items);
          if (!rs.length) { toast("増台する回がありません", "err"); return; }
          if (!confirm(`「${cur2.label}」の${rs.length}回ぶんで支払予定を作り直します。今の支払予定は置き換わります。`)) return;
          plan.rounds = rs;
          await saveRounds(rs);
          toast(`${rs.length}回ぶんの支払予定を作りました`, "ok");
          pane = "pay";
          rerender();
        } }),
        el("button", { class: "btn sm ghost", text: "🖨 この案を印刷", onclick: () => {
          const cur2 = readScenario(sc);
          const p = projectGrowth(readBase(), cur2);
          doPrint([rateLines(p.rows, { title: "設置比率の推移" }), growthTable(p.rows)], `増台計画 ${cur2.label}`);
        } }),
        g.scenarios.length > 1 ? el("button", { class: "btn sm danger", text: "この案を削除", onclick: () => {
          if (!confirm(`「${sc.label}」を削除します。`)) return;
          g.scenarios = g.scenarios.filter((x) => x.id !== sc.id);
          drawScenarios(); drawCompare();
        } }) : null,
      ]));
    };
    for (const node of [f.label, f.start, f.every, f.count, f.work, ...Object.values(f.per)]) {
      node.addEventListener("change", () => { redraw(); drawCompare(); });
    }

    const head = el("div", { class: "row", style: "gap:10px;flex-wrap:wrap;align-items:flex-end" }, [
      el("div", {}, [el("label", { class: "lbl", text: "案の名前" }), f.label]),
      el("div", {}, [el("label", { class: "lbl", text: "開始月" }), f.start]),
      el("div", {}, [el("label", { class: "lbl", text: "間隔(ヶ月)" }), f.every]),
      el("div", {}, [el("label", { class: "lbl", text: "回数" }), f.count]),
      ...SECS.map((s) => el("div", {}, [el("label", { class: "lbl", text: `${s.label}/回` }), f.per[s.key]])),
      el("div", {}, [el("label", { class: "lbl", text: "工事費の品目" }), f.work]),
    ]);
    redraw();
    return el("section", { class: "card col", style: `border-left:4px solid ${secColor("S20")}` }, [head, out]);
  }

  /* 案の比較 */
  const cmpHost = el("div", { class: "col" });
  const drawCompare = () => {
    clear(cmpHost);
    const base = readBase();
    const rows = g.scenarios.map((sc) => {
      const cur = scInputs.has(sc.id) ? readScenario(sc) : sc;
      const p = projectGrowth(base, cur);
      const rounds = roundsFromScenario(cur, base, plan.items);
      const { total } = paymentSchedule(rounds, plan.items);
      const work = plan.items.find((i) => i.name === cur.workItemName);
      const workTotal = work && work.qty ? rounds.reduce((n, r) => {
        const ln = r.lines.find((l) => l.itemId === work.id);
        return n + (ln ? (work.amount / work.qty) * ln.qty : 0);
      }, 0) : 0;
      return { label: cur.label, rounds: rounds.length, added: p.added,
        end: p.rows.length ? ymLabel(p.rows[p.rows.length - 1].ym) : "—", finalRate: p.finalRate, total, workTotal };
    });
    const t = el("table", { class: "grid" });
    t.appendChild(el("thead", {}, el("tr", {}, [th("案", "txt"), th("工事回数"), th("増台合計"), th("完了"),
      th("設置比率"), th("うち工事費"), th("支払総額"), th("1台あたり")])));
    const tb = el("tbody");
    // 案ごとに増台合計が違うので、総額の大小だけでは判断できない。
    // 太字にするのは「1台あたりがいちばん安い案」にする（工事をまとめた効果はここに出る）。
    const per = (r) => (r.added ? r.total / r.added : Infinity);
    const best = Math.min(...rows.map(per));
    for (const r of rows) tb.appendChild(el("tr", {}, [
      el("td", { class: "txt", text: r.label }), td(num(r.rounds)), td(num(r.added) + "台"), td(r.end),
      td(pct(r.finalRate)), td(yen(r.workTotal)), td(yen(r.total)),
      el("td", { class: "mono", style: per(r) === best ? "font-weight:800" : "", text: r.added ? yen(per(r)) : "—" }),
    ]));
    t.appendChild(tb);
    cmpHost.appendChild(wrapTable(t));
    if (rows.length > 1) {
      const sameCount = new Set(rows.map((r) => r.added)).size === 1;
      cmpHost.appendChild(el("div", { class: "hint", text: sameCount
        ? `増台合計が同じなので総額でそのまま比べられます。差は ${yen(Math.max(...rows.map((r) => r.total)) - Math.min(...rows.map((r) => r.total)))}。`
        : "増台合計が案ごとに違うので、総額ではなく「1台あたり」で比べてください（工事をまとめるほど設置作業費が下がります）。" }));
    }
  };

  async function save() {
    try {
      setSaveState("saving");
      g.base = readBase();
      g.scenarios = g.scenarios.map((sc) => (scInputs.has(sc.id) ? readScenario(sc) : sc));
      await saveGrowth(g);
      setSaveState("saved");
      toast("増台計画を保存しました", "ok");
    } catch (e) { errorToast(e); }
  }

  host.appendChild(cardOf("現状の台数", "総台数とスマート機の台数。ここが設置比率の分母・分子になります。", [wrapTable(bt)]));
  host.appendChild(cardOf("案の比較", "同じ台数を何回に分けるかで、設置作業費と支払総額が変わります。", [cmpHost]));
  host.appendChild(scHost);
  drawScenarios();
  drawCompare();
}

// onEdit を渡すと増台数の列が入力欄になる（印刷では渡さないので数字だけ出る）。
function growthTable(rows, onEdit) {
  const t = el("table", { class: "grid mono compact" });
  t.appendChild(el("thead", {}, el("tr", {}, [
    th("実施月", "txt"), th("合計"), ...SECS.map((s) => th(s.label + " 増台")),
    ...SECS.map((s) => th(s.label + " 台数")), ...SECS.map((s) => th(s.label + " 比率")),
  ])));
  const tb = el("tbody");
  for (const r of rows) {
    const addCells = SECS.map((s) => {
      if (!onEdit) return td(r.add[s.key] ? num(r.add[s.key]) : "—");
      const i = inp(r.add[s.key], { type: "number", w: 56 });
      // 入力のたびに組み直すと1文字で focus が外れる。確定（change）でだけ反映する。
      i.addEventListener("change", () => onEdit(r.ym, s.key, Number(i.value) || 0));
      return el("td", {}, i);
    });
    tb.appendChild(el("tr", {}, [
      el("td", { class: "txt", text: ymLabel(r.ym) }), td(num(r.sum)), ...addCells,
      ...SECS.map((s) => td(num(r.after[s.key]))),
      ...SECS.map((s) => td(pct(r.rate[s.key]))),
    ]));
  }
  t.appendChild(tb);
  return t;
}

// 支払条件のセル。1行に収めないと「ヶ月」「％」が縦に折れて読めなくなる。
function payCell(f) {
  const extra = el("span", { style: "display:inline-flex;gap:4px;align-items:center;white-space:nowrap" }, [
    el("span", { class: "hint", text: "初回" }), f.first,
    el("span", { class: "hint", text: "%／残" }), f.split, el("span", { class: "hint", text: "回" }),
  ]);
  const sync = () => { extra.style.display = f.mode.value === "split" ? "inline-flex" : "none"; };
  f.mode.addEventListener("change", sync);
  sync();
  return el("div", { style: "display:flex;gap:4px;align-items:center;white-space:nowrap" }, [
    f.mode, el("span", { class: "hint", text: "翌" }), f.lag, el("span", { class: "hint", text: "ヶ月" }), extra,
  ]);
}

/* ══════════ ② 支払予定 ══════════ */
function panePayment(host, rerender) {
  const { rows, total } = paymentSchedule(plan.rounds, plan.items);
  const names = [...new Set(rows.flatMap((r) => [...r.byItem.keys()]))];

  /* 工事回の一覧 */
  const rt = el("table", { class: "grid" });
  rt.appendChild(el("thead", {}, el("tr", {}, [th("工事日", "txt"), th("名前", "txt"), th("台数"), th("内訳", "txt"), th("金額"), th("")])));
  const rb = el("tbody");
  const byId = new Map(plan.items.map((i) => [i.id, i]));
  const amountOf = (r) => (r.lines || []).reduce((n, ln) => {
    const it = byId.get(ln.itemId);
    if (!it) return n;
    return n + (it.qty ? (it.amount / it.qty) * (ln.qty ?? it.qty) : it.amount);
  }, 0);
  for (const r of plan.rounds) {
    const detail = (r.lines || []).map((ln) => {
      const it = byId.get(ln.itemId);
      return it ? `${it.name}×${num(ln.qty ?? it.qty)}` : "（削除された品目）";
    }).join(" ／ ");
    rb.appendChild(el("tr", {}, [
      el("td", { class: "txt", text: r.workDate || "—" }),
      el("td", { class: "txt", text: r.label || "" }),
      td(r.dai ? num(r.dai) : "—"),
      el("td", { class: "txt", style: "font-size:12px", text: detail || "—" }),
      td(yen(amountOf(r))),
      el("td", {}, el("button", { class: "btn sm ghost", text: "編集", onclick: () => editRound(r, rerender) })),
    ]));
  }
  rt.appendChild(rb);

  const ctrl = el("div", { class: "row", style: "gap:8px;flex-wrap:wrap" }, [
    el("button", { class: "btn sm ghost", text: "＋ 工事回を追加", onclick: () => {
      const last = plan.rounds[plan.rounds.length - 1];
      editRound({ id: newId(), label: `${plan.rounds.length + 1}回目`, workDate: last ? addMonth(ymOf(last.workDate), 3) + "-01" : "", dai: last?.dai || 13, lines: last ? last.lines.map((l) => ({ ...l })) : [] }, rerender, true);
    } }),
    el("button", { class: "btn sm ghost", text: "🖨 支払予定を印刷", onclick: () =>
      doPrint([paymentBars(rows, { title: "月ごとの支払い" }), payTable(rows, names, total)], "支払予定") }),
  ]);

  host.appendChild(cardOf("工事回", "工事日と、その回に買うもの。ここから支払予定が出ます。", [wrapTable(rt), ctrl]));
  if (!rows.length) {
    host.appendChild(el("div", { class: "placeholder", text: "工事回がまだありません。「増台計画」で案を作って「この案で支払予定を作る」を押すか、上の「＋ 工事回を追加」で入れてください。" }));
    return;
  }
  const peak = rows.reduce((a, b) => (b.total > a.total ? b : a));
  host.appendChild(cardOf("支払予定", `${ymLabel(rows[0].ym)} 〜 ${ymLabel(rows[rows.length - 1].ym)}（${rows.length}ヶ月）`, [
    el("div", { class: "row", style: "gap:16px;flex-wrap:wrap;font-size:13px" }, [
      el("div", {}, [el("div", { class: "hint", text: "支払総額" }), el("b", { text: yen(total) })]),
      el("div", {}, [el("div", { class: "hint", text: "いちばん重い月" }), el("b", { text: `${yen(peak.total)}（${ymLabel(peak.ym)}）` })]),
      el("div", {}, [el("div", { class: "hint", text: "月の平均" }), el("b", { text: yen(total / rows.length) })]),
    ]),
    paymentBars(rows, { narrow: narrow() }),
    wrapTable(payTable(rows, names, total)),
  ]));
}

function payTable(rows, names, total) {
  const t = el("table", { class: "grid mono compact" });
  t.appendChild(el("thead", {}, el("tr", {}, [th("支払月", "txt"), ...names.map((n) => th(n)), th("合計"), th("累計")])));
  const tb = el("tbody");
  for (const r of rows) tb.appendChild(el("tr", {}, [
    el("td", { class: "txt", text: ymLabel(r.ym) }),
    ...names.map((n) => td(r.byItem.get(n) ? yen(r.byItem.get(n)) : "—")),
    el("td", { style: "font-weight:700", text: r.total ? yen(r.total) : "—" }),
    td(yen(r.cum)),
  ]));
  t.appendChild(tb);
  t.appendChild(el("tfoot", {}, el("tr", {}, [
    el("td", { class: "txt", style: "font-weight:800", text: "合計" }),
    ...names.map((n) => el("td", { style: "font-weight:700", text: yen(rows.reduce((s, r) => s + (r.byItem.get(n) || 0), 0)) })),
    el("td", { style: "font-weight:800", text: yen(total) }), el("td", { text: "" }),
  ])));
  return t;
}

// 工事回の編集。台番も持たせて、島図に増台位置を出せるようにする。
function editRound(round, rerender, isNew) {
  const f = {
    label: inp(round.label, { w: 160 }),
    workDate: el("input", { type: "date", value: round.workDate || "", style: "width:160px" }),
    dai: inp(round.dai ?? "", { type: "number", w: 80 }),
    daiText: inp(round.daiText || "", { w: 220 }),
  };
  const lineHost = el("div", { class: "col", style: "gap:6px" });
  let lines = (round.lines || []).map((l) => ({ ...l }));
  const drawLines = () => {
    clear(lineHost);
    lines.forEach((ln, i) => {
      const it = plan.items.find((x) => x.id === ln.itemId);
      const s = sel(plan.items.map((x) => ({ key: x.id, label: `${x.name}（${x.vendor || "—"}）` })), ln.itemId, 240);
      const q = inp(ln.qty ?? it?.qty ?? 1, { type: "number", w: 70 });
      s.addEventListener("change", () => { ln.itemId = s.value; });
      q.addEventListener("input", () => { ln.qty = Number(q.value) || 0; });
      lineHost.appendChild(el("div", { class: "row", style: "gap:6px;align-items:center;flex-wrap:wrap" }, [
        s, el("span", { class: "hint", text: "×" }), q,
        el("span", { class: "hint", text: it ? `単価 ${yen(unitPriceOf(it))}` : "" }),
        el("button", { class: "btn sm danger", text: "削除", onclick: () => { lines.splice(i, 1); drawLines(); } }),
      ]));
    });
    lineHost.appendChild(el("button", { class: "btn sm ghost", style: "align-self:flex-start", text: "＋ 品目を足す",
      onclick: () => { lines.push({ itemId: plan.items[0]?.id, qty: 1 }); drawLines(); } }));
  };
  drawLines();

  const body = el("div", { class: "col", style: "gap:10px;min-width:min(560px,86vw)" }, [
    el("div", { class: "row", style: "gap:10px;flex-wrap:wrap" }, [
      el("div", {}, [el("label", { class: "lbl", text: "名前" }), f.label]),
      el("div", {}, [el("label", { class: "lbl", text: "工事日" }), f.workDate]),
      el("div", {}, [el("label", { class: "lbl", text: "台数" }), f.dai]),
    ]),
    el("div", {}, [el("label", { class: "lbl", text: "増台する台番（島図に出ます。例: 82-94）" }), f.daiText]),
    el("div", {}, [el("label", { class: "lbl", text: "買うもの" }), lineHost]),
  ]);
  const save = async () => {
    const r = {
      ...round, label: f.label.value.trim(), workDate: f.workDate.value,
      dai: Number(f.dai.value) || null, daiText: f.daiText.value.trim(), lines,
    };
    if (!r.workDate) { toast("工事日を入れてください", "err"); return; }
    const list = isNew ? [...plan.rounds, r] : plan.rounds.map((x) => (x.id === r.id ? r : x));
    list.sort((a, b) => (a.workDate < b.workDate ? -1 : 1));
    try {
      setSaveState("saving");
      plan.rounds = list;
      await saveRounds(list);
      setSaveState("saved");
      close(); rerender();
    } catch (e) { errorToast(e); }
  };
  const close = modal(isNew ? "工事回を追加" : "工事回を編集", body,
    el("div", { class: "row", style: "justify-content:flex-end;gap:8px;margin-top:12px" }, [
      isNew ? null : el("button", { class: "btn danger", text: "削除", onclick: async () => {
        if (!confirm("この工事回を削除します。")) return;
        plan.rounds = plan.rounds.filter((x) => x.id !== round.id);
        await saveRounds(plan.rounds);
        close(); rerender();
      } }),
      el("button", { class: "btn ghost", text: "やめる", onclick: () => close() }),
      el("button", { class: "btn primary", text: "保存", onclick: save }),
    ]));
}

/* ══════════ ③ 単価台帳 ══════════ */
function paneItems(host, rerender) {
  const rowsHost = el("tbody");
  const fields = new Map();

  const draw = () => {
    clear(rowsHost);
    fields.clear();
    for (const it of plan.items) {
      const f = {
        name: inp(it.name, { w: 190 }), vendor: inp(it.vendor, { w: 100 }),
        kind: sel(KINDS, it.kind, 110), qty: inp(it.qty, { type: "number", w: 64 }),
        unit: inp(it.unit || "台", { w: 44 }), amount: inp(it.amount, { type: "number", w: 110 }),
        quoteDate: el("input", { type: "date", value: it.quoteDate || "", style: "width:140px" }),
        mode: sel(PAY_MODES, it.pay?.mode || "lump", 130),
        lag: inp(it.pay?.lag ?? 1, { type: "number", w: 48 }),
        first: inp(it.pay?.firstRatio != null ? Math.round(it.pay.firstRatio * 1000) / 10 : "", { type: "number", w: 56 }),
        split: inp(it.pay?.splitCount ?? "", { type: "number", w: 48 }),
        note: inp(it.note, { w: 180 }),
      };
      fields.set(it.id, f);
      const unitCell = el("td", { class: "mono", text: yen(unitPriceOf(it)) });
      const recalc = () => {
        const q = Number(f.qty.value) || 0, a = Number(f.amount.value) || 0;
        unitCell.textContent = q ? yen(a / q) : "—";
      };
      f.qty.addEventListener("input", recalc);
      f.amount.addEventListener("input", recalc);
      rowsHost.appendChild(el("tr", {}, [
        el("td", { class: "txt" }, f.name), el("td", {}, f.kind), el("td", { class: "txt" }, f.vendor),
        el("td", {}, f.qty), el("td", {}, f.unit), el("td", {}, f.amount), unitCell,
        el("td", {}, f.quoteDate),
        el("td", {}, payCell(f)),
        el("td", { class: "txt" }, f.note),
        el("td", {}, el("button", { class: "btn sm danger", text: "削除", onclick: () => {
          if (!confirm(`「${it.name}」を台帳から消します。`)) return;
          plan.items = plan.items.filter((x) => x.id !== it.id);
          draw();
        } })),
      ]));
    }
  };

  const read = () => plan.items.map((it) => {
    const f = fields.get(it.id);
    if (!f) return it;
    const mode = f.mode.value;
    return {
      ...it, name: f.name.value.trim(), kind: f.kind.value, vendor: f.vendor.value.trim(),
      qty: Number(f.qty.value) || 0, unit: f.unit.value.trim() || "台",
      amount: Number(f.amount.value) || 0, quoteDate: f.quoteDate.value,
      note: f.note.value.trim(),
      pay: mode === "split"
        ? { mode, lag: Number(f.lag.value) || 0, firstRatio: (Number(f.first.value) || 0) / 100, splitCount: Number(f.split.value) || 1 }
        : { mode, lag: Number(f.lag.value) || 0 },
    };
  });

  const t = el("table", { class: "grid compact" });
  t.appendChild(el("thead", {}, el("tr", {}, [
    th("品目", "txt"), th("区分"), th("仕入先", "txt"), th("数量"), th("単位"), th("金額(税込)"), th("単価"),
    th("見積日"), th("支払条件", "txt"), th("メモ", "txt"), th(""),
  ])));
  t.appendChild(rowsHost);
  draw();

  const cmpHost = el("div", { class: "col" });
  const drawCompare = (items) => {
    clear(cmpHost);
    const groups = new Map();
    for (const it of items) (groups.get(it.name) || groups.set(it.name, []).get(it.name)).push(it);
    const multi = [...groups.entries()].filter(([, v]) => v.length > 1);
    if (!multi.length) {
      cmpHost.appendChild(el("div", { class: "hint", text: "同じ品目名で2件以上あると、ここに単価の推移が出ます。新しい見積が来たら行を足してください（前の行は消さない）。" }));
      return;
    }
    const ct = el("table", { class: "grid mono" });
    ct.appendChild(el("thead", {}, el("tr", {}, [th("品目", "txt"), th("見積日"), th("仕入先", "txt"), th("数量"), th("金額"), th("単価"), th("前回比")])));
    const cb = el("tbody");
    for (const [name, list] of multi) {
      const sorted = [...list].sort((a, b) => String(a.quoteDate).localeCompare(String(b.quoteDate)));
      sorted.forEach((it, i) => {
        const u = unitPriceOf(it), prev = i ? unitPriceOf(sorted[i - 1]) : null;
        const d = prev != null && u != null ? u - prev : null;
        cb.appendChild(el("tr", {}, [
          el("td", { class: "txt", text: i ? "" : name }), td(it.quoteDate || "—"),
          el("td", { class: "txt", text: it.vendor || "—" }), td(num(it.qty)), td(yen(it.amount)), td(yen(u)),
          el("td", { style: d == null ? "" : `font-weight:700;color:${d > 0 ? "#e35d6a" : "#2fb888"}`,
            text: d == null ? "—" : `${d > 0 ? "＋" : "−"}${yen(Math.abs(d)).slice(1)}（${pct(d / prev)}）` }),
        ]));
      });
    }
    ct.appendChild(cb);
    cmpHost.appendChild(wrapTable(ct));
  };
  drawCompare(plan.items);

  const ctrl = el("div", { class: "row", style: "gap:8px;flex-wrap:wrap" }, [
    el("button", { class: "btn sm ghost", text: "＋ 品目を追加", onclick: () => {
      plan.items = [...read(), { id: newId(), name: "", kind: "part", vendor: "", qty: 1, unit: "台", amount: 0,
        quoteDate: "", pay: { mode: "lump", lag: 1 }, note: "" }];
      draw();
    } }),
    el("button", { class: "btn primary sm", text: "台帳を保存", onclick: async () => {
      try {
        setSaveState("saving");
        plan.items = read();
        await saveItems(plan.items);
        setSaveState("saved");
        toast("単価台帳を保存しました", "ok");
        drawCompare(plan.items);
      } catch (e) { errorToast(e); }
    } }),
    el("button", { class: "btn sm ghost", text: "🖨 台帳を印刷", onclick: () => doPrint([t.cloneNode(true)], "単価台帳") }),
  ]);

  host.appendChild(cardOf("単価台帳", "見積の金額と数量を入れると単価が出ます。支払条件もここで決まります（支払予定はこの条件で組まれます）。",
    [wrapTable(t), ctrl]));
  host.appendChild(cardOf("単価の比較", "同じ品目の見積を並べて、単価が上がったか下がったかを見ます。", [cmpHost]));
}

/* ══════════ ④ 島図 ══════════ */
function paneMap(host) {
  if (!layout.length) {
    host.appendChild(el("div", { class: "placeholder" }, [
      el("div", { text: "島図がまだ取り込まれていません。" }),
      el("div", { class: "hint", style: "margin-top:6px", text: "「取込」タブで島図Excelを読み込むと、ここに増台位置を出せます。" }),
    ]));
    return;
  }
  // 先頭の工事回を「今回」、それ以降を「次回以降」として塗る。
  // 台番の指定が無い回は塗れないので、その旨を出して気づけるようにする。
  const marks = new Map();
  const missing = [];
  plan.rounds.forEach((r, i) => {
    const { ranges, errors } = parseRanges(r.daiText || "");
    if (!ranges.length) { missing.push(r.label || r.workDate); return; }
    if (errors.length) missing.push(`${r.label}（${errors[0]}）`);
    for (const l of layout) {
      if (!inRanges(l.dai_no, ranges)) continue;
      if (!marks.has(l.dai_no)) marks.set(l.dai_no, i === 0 ? "add" : "next");
    }
  });
  const map = buildPlanMap(layout, marks);
  const legend = buildPlanLegend();
  host.appendChild(cardOf("増台位置", "工事回に入れた台番を島図に重ねています。台番は「支払予定」タブの工事回で編集できます。", [
    legend,
    missing.length ? el("div", { class: "hint", style: "color:#e0a52e",
      text: `台番の指定が無い工事回: ${missing.join(" / ")}` }) : null,
    map,
    el("div", { class: "row", style: "gap:8px" }, [
      el("button", { class: "btn sm ghost", text: "🖨 島図を印刷", onclick: () =>
        // 階ごとに1ページ。1枚に押し込むと台番が読めない大きさまで縮む
        doPrintPages(floorsOf(layout).map((fl) => el("div", {}, [
          el("h3", { text: `増台位置 — ${fl}フロア` }), buildPlanLegend(),
          el("div", { style: "height:6px" }), buildPlanFloor(layout, fl, marks),
        ]))) }),
    ]),
  ].filter(Boolean)));
}

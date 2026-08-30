// 増台計画タブ。工事回に「工事日・どのレートを何台・台番・買うもの」を入れると、
// 設置比率・支払予定・島図がまとめて動く。もとは「増台数と数値.xlsx」を増台のたびに
// 手で作り直していた作業で、同じ数字を3か所に書き写すのをやめるのが目的。
import { el, clear, modal } from "../../util/dom.js";
import { repo } from "../../core/repo.js";
import { state } from "../../core/state.js";
import { setSaveState, toast, errorToast } from "../../core/errors.js";
import { yen, num, pct } from "../../util/format.js";
import { printContent, fitToPages } from "../../print/printService.js";
import { parseRanges, countOf, formatRanges, inRanges } from "../../util/daiRange.js";
import { paymentBars, rateLines } from "./charts.js";
import { buildPlanMap, buildPlanFloor, buildPlanLegend, floorsOf, roundColor } from "./planMap.js";
import {
  loadPlan, saveItems, saveRounds, saveGrowth, newId,
  KINDS, PAY_MODES, unitPriceOf, paymentSchedule, projectFromRounds,
  addsByRate, addTotal, suggestLines, makeRounds, addMonth, ymOf, ymLabel, SECS, secLabel,
} from "./model.js";

const narrow = () => window.matchMedia("(max-width: 700px)").matches;
const PANES = [
  { key: "plan", label: "計画" },
  { key: "pay", label: "支払予定" },
  { key: "items", label: "単価台帳" },
  { key: "map", label: "島図" },
];
let pane = "plan";

let plan = null;   // { items, rounds, growth }
let layout = [];   // 島図（layout_cell）
let redrawAll = () => {};

export async function mount(host) {
  clear(host);
  host.appendChild(el("div", { class: "view-title" }, [
    el("h1", { text: "増台計画" }),
    el("small", { text: "工事回の数字を入れると、設置比率・支払予定・島図に反映されます" }),
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
  redrawAll = render;
  render();

  function render() {
    clear(body);
    if (pane === "plan") panePlan(body);
    else if (pane === "pay") panePayment(body);
    else if (pane === "items") paneItems(body);
    else paneMap(body);
  }
}

/* ══════════ 共通の小物 ══════════ */
const inp = (value, opts = {}) => el("input", {
  type: opts.type || "text", value: value == null ? "" : String(value),
  placeholder: opts.ph || null,
  style: `width:${opts.w || 110}px;text-align:${opts.type === "number" ? "right" : "left"}`,
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
  ...[].concat(nodes).filter(Boolean),
]);
const wrapTable = (t) => el("div", { class: "table-wrap" }, t);
const kpi = (label, value) => el("div", {}, [el("div", { class: "hint", text: label }), el("b", { text: value })]);

// 印刷用に「画面と同じ中身」を作って渡す。印刷だけ別に組むと必ず片方が古くなる。
function doPrint(nodes, title, orientation = "landscape") {
  doPrintPages([el("div", {}, [el("h2", { text: title }), ...[].concat(nodes).filter(Boolean)])], orientation);
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

const sortedRounds = () => [...plan.rounds].sort((a, b) => String(a.workDate).localeCompare(String(b.workDate)));
const roundTitle = (r, i) => `${i + 1}. ${r.label || ""}${r.workDate ? `（${r.workDate}）` : ""}`;

// 増台の内訳を「20スロ 13台 82-94」のような1行にする（表と凡例で同じ書き方に揃える）。
const addsText = (r) => (r.adds || []).filter((a) => Number(a.count) || a.daiText)
  .map((a) => `${secLabel(a.rate)} ${num(Number(a.count) || countOf(parseRanges(a.daiText || "").ranges))}台${a.daiText ? ` (${a.daiText})` : ""}`)
  .join(" ／ ") || "—";

async function persistRounds(list) {
  list.sort((a, b) => String(a.workDate).localeCompare(String(b.workDate)));
  setSaveState("saving");
  plan.rounds = list;
  await saveRounds(list);
  setSaveState("saved");
}

/* ══════════ ① 計画 ══════════ */
function panePlan(host) {
  const g = plan.growth;

  /* 現状の台数 */
  const baseInputs = {};
  const rateCells = {};
  const bt = el("table", { class: "grid" });
  bt.appendChild(el("thead", {}, el("tr", {}, [th("区分", "txt"), th("総台数"), th("現在スマート"), th("設置比率")])));
  const bb = el("tbody");
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
    rateCells[s.key] = el("td", { class: "mono" });
    bb.appendChild(el("tr", {}, [el("td", { class: "txt", text: s.label }), el("td", {}, t), el("td", {}, m), rateCells[s.key]]));
  }
  bt.appendChild(bb);
  recalcBase();
  const readBase = () => Object.fromEntries(SECS.map((s) => [s.key,
    { total: Number(baseInputs[s.key].total.value) || 0, smart: Number(baseInputs[s.key].smart.value) || 0 }]));

  const works = plan.items.filter((i) => i.kind === "work");
  const workSel = sel(works.map((w) => ({ key: w.name, label: w.name })).concat([{ key: "", label: "（入れない）" }]),
    g.workItemName || "", 200);

  const saveBase = el("button", { class: "btn primary sm", text: "現状と設定を保存", onclick: async () => {
    try {
      setSaveState("saving");
      g.base = readBase();
      g.workItemName = workSel.value;
      await saveGrowth(g);
      setSaveState("saved");
      toast("保存しました", "ok");
      redrawAll();
    } catch (e) { errorToast(e); }
  } });

  host.appendChild(cardOf("現状の台数", "総台数とスマート機の台数。ここが設置比率の分母・分子になります。", [
    wrapTable(bt),
    el("div", { class: "row", style: "gap:10px;flex-wrap:wrap;align-items:flex-end" }, [
      el("div", {}, [el("label", { class: "lbl", text: "工事回に自動で入れる工事費" }), workSel]),
      el("div", {}, saveBase),
    ]),
  ]));

  /* 工事回 */
  const rounds = sortedRounds();
  const rt = el("table", { class: "grid" });
  rt.appendChild(el("thead", {}, el("tr", {}, [
    th("", "txt"), th("工事日", "txt"), th("名前", "txt"), th("増台", "txt"), th("計"), th("買うもの", "txt"), th("金額"), th(""),
  ])));
  const rb = el("tbody");
  const byId = new Map(plan.items.map((i) => [i.id, i]));
  const amountOf = (r) => (r.lines || []).reduce((n, ln) => {
    const it = byId.get(ln.itemId);
    if (!it) return n;
    return n + (it.qty ? (it.amount / it.qty) * (ln.qty ?? it.qty) : it.amount);
  }, 0);
  rounds.forEach((r, i) => {
    const detail = (r.lines || []).map((ln) => {
      const it = byId.get(ln.itemId);
      return it ? `${it.name}×${num(ln.qty ?? it.qty)}` : "（削除された品目）";
    }).join(" ／ ");
    rb.appendChild(el("tr", {}, [
      el("td", { class: "txt", style: `border-left:5px solid ${roundColor(i)}`, text: String(i + 1) }),
      el("td", { class: "txt", text: r.workDate || "—" }),
      el("td", { class: "txt", text: r.label || "" }),
      el("td", { class: "txt", style: "font-size:12px", text: addsText(r) }),
      td(num(addTotal(r))),
      el("td", { class: "txt", style: "font-size:12px", text: detail || "—" }),
      td(yen(amountOf(r))),
      el("td", {}, el("button", { class: "btn sm ghost", text: "編集", onclick: () => editRound(r, false) })),
    ]));
  });
  rt.appendChild(rb);

  host.appendChild(cardOf("工事回", "1回ぶんの「工事日・どのレートを何台・台番・買うもの」。ここが計画の元になります。", [
    wrapTable(rt),
    el("div", { class: "row", style: "gap:8px;flex-wrap:wrap" }, [
      el("button", { class: "btn sm ghost", text: "＋ 工事回を追加", onclick: () => {
        const last = rounds[rounds.length - 1];
        editRound({
          id: newId(), label: `${rounds.length + 1}回目`,
          workDate: last?.workDate ? addMonth(ymOf(last.workDate), 3) + "-01" : "",
          adds: (last?.adds || [{ rate: "S20", count: 13, daiText: "" }]).map((a) => ({ ...a, daiText: "" })),
          lines: (last?.lines || []).map((l) => ({ ...l })),
        }, true);
      } }),
      el("button", { class: "btn sm ghost", text: "先々の計画をまとめて作る", onclick: () => bulkModal(readBase(), workSel.value) }),
    ]),
  ]));

  /* 設置比率の推移 */
  const proj = projectFromRounds(readBase(), plan.rounds);
  const { total } = paymentSchedule(plan.rounds, plan.items);
  if (!proj.rows.length) {
    host.appendChild(el("div", { class: "placeholder", text: "工事回がまだありません。上の「＋ 工事回を追加」で入れてください。" }));
    return;
  }
  host.appendChild(cardOf("設置比率の推移", "工事回を順に足していったときの、区分ごとのスマート設置比率です。", [
    el("div", { class: "row", style: "gap:16px;flex-wrap:wrap;font-size:13px" }, [
      kpi("工事回数", `${num(proj.rows.length)}回`),
      kpi("増台合計", `${num(proj.added)}台`),
      kpi("完了", proj.rows.filter((r) => r.sum).slice(-1)[0]?.workDate || "—"),
      kpi("全体の設置比率", pct(proj.finalRate)),
      kpi("支払総額", yen(total)),
    ]),
    proj.rows.some((r) => r.over)
      ? el("div", { class: "hint", style: "color:#e0a52e", text: "⚠ 総台数を超えるぶんは切り捨てて計算しています（増台数か総台数を見直してください）。" })
      : null,
    rateLines(chartRows(readBase(), proj.rows), { narrow: narrow() }),
    wrapTable(growthTable(proj.rows)),
    el("div", { class: "row", style: "gap:8px;flex-wrap:wrap" }, [
      el("button", { class: "btn sm ghost", text: "🖨 計画を印刷", onclick: () => {
        const p = projectFromRounds(readBase(), plan.rounds);
        doPrint([rateLines(chartRows(readBase(), p.rows), { title: "設置比率の推移" }), roundsTable(), growthTable(p.rows)], "増台計画");
      } }),
    ]),
  ]));
}

// グラフは「現在」から描き出す。工事回のぶんだけだと、どこから上がったのかが出ない
// （工事回が1回だけのときは点が1つで線も引けなかった）。
function chartRows(base, rows) {
  const rate = Object.fromEntries(SECS.map((s) => [s.key,
    base?.[s.key]?.total ? (base[s.key].smart || 0) / base[s.key].total : null]));
  return [{ ym: rows[0]?.ym || "", xlabel: "現在", rate }, ...rows];
}

// 印刷用の工事回一覧（画面の表から編集ボタンだけ抜いたもの）。
function roundsTable() {
  const t = el("table", { class: "grid mono compact" });
  t.appendChild(el("thead", {}, el("tr", {}, [th("回"), th("工事日", "txt"), th("増台の内訳", "txt"), th("計"), th("買うもの", "txt")])));
  const tb = el("tbody");
  const byId = new Map(plan.items.map((i) => [i.id, i]));
  sortedRounds().forEach((r, i) => tb.appendChild(el("tr", {}, [
    td(String(i + 1)), el("td", { class: "txt", text: r.workDate || "—" }),
    el("td", { class: "txt", text: addsText(r) }), td(num(addTotal(r))),
    el("td", { class: "txt", text: (r.lines || []).map((ln) => {
      const it = byId.get(ln.itemId);
      return it ? `${it.name}×${num(ln.qty ?? it.qty)}` : "";
    }).filter(Boolean).join(" ／ ") || "—" }),
  ])));
  t.appendChild(tb);
  return t;
}

function growthTable(rows) {
  const t = el("table", { class: "grid mono compact" });
  t.appendChild(el("thead", {}, el("tr", {}, [
    th("工事日", "txt"), th("計"), ...SECS.map((s) => th(s.label + " 増台")),
    ...SECS.map((s) => th(s.label + " 台数")), ...SECS.map((s) => th(s.label + " 比率")),
  ])));
  const tb = el("tbody");
  for (const r of rows) tb.appendChild(el("tr", {}, [
    el("td", { class: "txt", text: r.workDate || ymLabel(r.ym) }), td(num(r.sum)),
    ...SECS.map((s) => td(r.add[s.key] ? num(r.add[s.key]) : "—")),
    ...SECS.map((s) => td(num(r.after[s.key]))),
    ...SECS.map((s) => td(pct(r.rate[s.key]))),
  ]));
  t.appendChild(tb);
  return t;
}

/* ── 工事回の編集 ── */
function editRound(round, isNew) {
  const f = {
    label: inp(round.label, { w: 150 }),
    workDate: el("input", { type: "date", value: round.workDate || "", style: "width:160px" }),
  };
  let adds = (round.adds || []).map((a) => ({ ...a }));
  let lines = (round.lines || []).map((l) => ({ ...l }));

  const addHost = el("div", { class: "col", style: "gap:6px" });
  const lineHost = el("div", { class: "col", style: "gap:6px" });
  const sumBox = el("div", { class: "hint" });

  const totalAdds = () => adds.reduce((n, a) => n + (Number(a.count) || 0), 0);
  const refreshSum = () => {
    const bad = adds.filter((a) => a.daiText && parseRanges(a.daiText).errors.length);
    sumBox.textContent = `増台 合計 ${num(totalAdds())}台` + (bad.length ? `　⚠ 台番が読めません: ${bad[0].daiText}` : "");
    sumBox.style.color = bad.length ? "#e35d6a" : "";
  };

  const drawAdds = () => {
    clear(addHost);
    adds.forEach((a, i) => {
      const rate = sel(SECS.map((s) => ({ key: s.key, label: s.label })), a.rate || "S20", 110);
      const cnt = inp(a.count ?? "", { type: "number", w: 70 });
      const dai = inp(a.daiText || "", { w: 190, ph: "例: 82-94" });
      rate.addEventListener("change", () => { a.rate = rate.value; });
      cnt.addEventListener("input", () => { a.count = Number(cnt.value) || 0; refreshSum(); });
      // 台番を入れたら台数は数えられる。両方手で入れると必ずどちらかがずれる。
      dai.addEventListener("change", () => {
        a.daiText = dai.value.trim();
        const { ranges, errors } = parseRanges(a.daiText);
        if (!errors.length && ranges.length) {
          a.count = countOf(ranges);
          cnt.value = String(a.count);
          dai.value = formatRanges(ranges);
        }
        refreshSum();
      });
      addHost.appendChild(el("div", { class: "row", style: "gap:6px;align-items:center;flex-wrap:wrap" }, [
        rate, cnt, el("span", { class: "hint", text: "台　台番" }), dai,
        el("button", { class: "btn sm danger", text: "削除", onclick: () => { adds.splice(i, 1); drawAdds(); refreshSum(); } }),
      ]));
    });
    addHost.appendChild(el("button", { class: "btn sm ghost", style: "align-self:flex-start", text: "＋ レートを足す",
      onclick: () => { adds.push({ rate: "S20", count: 0, daiText: "" }); drawAdds(); } }));
  };

  const drawLines = () => {
    clear(lineHost);
    lines.forEach((ln, i) => {
      const it = plan.items.find((x) => x.id === ln.itemId);
      const s = sel(plan.items.map((x) => ({ key: x.id, label: `${x.name}（${x.vendor || "—"}）` })), ln.itemId, 250);
      const q = inp(ln.qty ?? it?.qty ?? 1, { type: "number", w: 70 });
      s.addEventListener("change", () => { ln.itemId = s.value; });
      q.addEventListener("input", () => { ln.qty = Number(q.value) || 0; });
      lineHost.appendChild(el("div", { class: "row", style: "gap:6px;align-items:center;flex-wrap:wrap" }, [
        s, el("span", { class: "hint", text: "×" }), q,
        el("span", { class: "hint", text: it ? `単価 ${yen(unitPriceOf(it))}` : "" }),
        el("button", { class: "btn sm danger", text: "削除", onclick: () => { lines.splice(i, 1); drawLines(); } }),
      ]));
    });
    lineHost.appendChild(el("div", { class: "row", style: "gap:8px;flex-wrap:wrap" }, [
      el("button", { class: "btn sm ghost", text: "＋ 品目を足す",
        onclick: () => { lines.push({ itemId: plan.items[0]?.id, qty: 1 }); drawLines(); } }),
      // 増台数を変えたあとに数量を直し忘れるので、入れ直すボタンを置く
      el("button", { class: "btn sm ghost", text: "増台数から入れ直す",
        onclick: () => { lines = suggestLines(totalAdds(), plan.items, plan.growth.workItemName); drawLines(); } }),
    ]));
  };

  drawAdds(); drawLines(); refreshSum();

  const body = el("div", { class: "col", style: "gap:10px;min-width:min(600px,86vw)" }, [
    el("div", { class: "row", style: "gap:10px;flex-wrap:wrap" }, [
      el("div", {}, [el("label", { class: "lbl", text: "名前" }), f.label]),
      el("div", {}, [el("label", { class: "lbl", text: "工事日" }), f.workDate]),
    ]),
    el("div", {}, [el("label", { class: "lbl", text: "どのレートを何台（台番を入れると台数を数えます・島図に出ます）" }), addHost]),
    sumBox,
    el("div", {}, [el("label", { class: "lbl", text: "買うもの（ユニット台数・HC-BOX台数・工事費）" }), lineHost]),
  ]);

  const close = modal(isNew ? "工事回を追加" : "工事回を編集", body,
    el("div", { class: "row", style: "justify-content:flex-end;gap:8px;margin-top:12px" }, [
      isNew ? null : el("button", { class: "btn danger", text: "削除", onclick: async () => {
        if (!confirm(`「${round.label || round.workDate}」を削除します。`)) return;
        try { await persistRounds(plan.rounds.filter((x) => x.id !== round.id)); close(); redrawAll(); }
        catch (e) { errorToast(e); }
      } }),
      el("button", { class: "btn ghost", text: "やめる", onclick: () => close() }),
      el("button", { class: "btn primary", text: "保存", onclick: async () => {
        const r = { ...round, label: f.label.value.trim(), workDate: f.workDate.value, adds, lines };
        if (!r.workDate) { toast("工事日を入れてください", "err"); return; }
        try {
          await persistRounds(isNew ? [...plan.rounds, r] : plan.rounds.map((x) => (x.id === r.id ? r : x)));
          close(); redrawAll();
        } catch (e) { errorToast(e); }
      } }),
    ].filter(Boolean)));
}

/* ── 先々の計画をまとめて作る ── */
function bulkModal(base, workItemName) {
  const last = sortedRounds().slice(-1)[0];
  const start = el("input", { type: "month", value: last?.workDate ? addMonth(ymOf(last.workDate), 3) : "", style: "width:158px" });
  const every = inp(3, { type: "number", w: 64 });
  const times = inp(8, { type: "number", w: 64 });
  const per = Object.fromEntries(SECS.map((s) => [s.key, inp(last ? addsByRate(last)[s.key] : (s.key === "S20" ? 13 : 0), { type: "number", w: 64 })]));
  const preview = el("div", { class: "hint" });

  const readAdds = () => SECS.map((s) => ({ rate: s.key, count: Number(per[s.key].value) || 0 }));
  const refresh = () => {
    const draft = makeRounds({ start: start.value, every: Number(every.value) || 3, times: Number(times.value) || 0,
      adds: readAdds(), items: plan.items, workItemName, startNo: plan.rounds.length + 1 });
    const p = projectFromRounds(base, [...plan.rounds, ...draft]);
    const last2 = p.rows.filter((r) => r.sum).slice(-1)[0];
    preview.textContent = draft.length
      ? `既にある${plan.rounds.length}回に${draft.length}回を足すと、増台合計 ${num(p.added)}台・全体の設置比率 ${pct(p.finalRate)}・${last2 ? last2.workDate : "—"}で完了。`
      : "回数を入れてください。";
  };
  for (const n of [start, every, times, ...Object.values(per)]) n.addEventListener("input", refresh);
  refresh();

  const body = el("div", { class: "col", style: "gap:10px;min-width:min(560px,86vw)" }, [
    el("p", { class: "hint", style: "margin:0", text: "同じ内訳を一定の間隔で並べます。台番は場所が毎回違うので入りません（作ったあと1回ずつ入れてください）。" }),
    el("div", { class: "row", style: "gap:10px;flex-wrap:wrap;align-items:flex-end" }, [
      el("div", {}, [el("label", { class: "lbl", text: "開始月" }), start]),
      el("div", {}, [el("label", { class: "lbl", text: "間隔(ヶ月)" }), every]),
      el("div", {}, [el("label", { class: "lbl", text: "回数" }), times]),
      ...SECS.map((s) => el("div", {}, [el("label", { class: "lbl", text: `${s.label}/回` }), per[s.key]])),
    ]),
    preview,
  ]);
  const close = modal("先々の計画をまとめて作る", body,
    el("div", { class: "row", style: "justify-content:flex-end;gap:8px;margin-top:12px" }, [
      el("button", { class: "btn ghost", text: "やめる", onclick: () => close() }),
      el("button", { class: "btn primary", text: "追加する", onclick: async () => {
        if (!start.value) { toast("開始月を入れてください", "err"); return; }
        const draft = makeRounds({ start: start.value, every: Number(every.value) || 3, times: Number(times.value) || 0,
          adds: readAdds(), items: plan.items, workItemName, startNo: plan.rounds.length + 1 });
        if (!draft.length) { toast("回数を入れてください", "err"); return; }
        try { await persistRounds([...plan.rounds, ...draft]); close(); redrawAll(); toast(`${draft.length}回を追加しました`, "ok"); }
        catch (e) { errorToast(e); }
      } }),
    ]));
}

/* ══════════ ② 支払予定 ══════════ */
function panePayment(host) {
  const { rows, total } = paymentSchedule(plan.rounds, plan.items);
  const names = [...new Set(rows.flatMap((r) => [...r.byItem.keys()]))];
  if (!rows.length) {
    host.appendChild(el("div", { class: "placeholder", text: "工事回がまだありません。「計画」タブで工事回を入れてください。" }));
    return;
  }
  const peak = rows.reduce((a, b) => (b.total > a.total ? b : a));
  host.appendChild(cardOf("支払予定", `${ymLabel(rows[0].ym)} 〜 ${ymLabel(rows[rows.length - 1].ym)}（${rows.length}ヶ月）`, [
    el("div", { class: "row", style: "gap:16px;flex-wrap:wrap;font-size:13px" }, [
      kpi("支払総額", yen(total)),
      kpi("いちばん重い月", `${yen(peak.total)}（${ymLabel(peak.ym)}）`),
      kpi("月の平均", yen(total / rows.length)),
    ]),
    paymentBars(rows, { narrow: narrow() }),
    wrapTable(payTable(rows, names, total)),
    el("div", { class: "row", style: "gap:8px" }, [
      el("button", { class: "btn sm ghost", text: "🖨 支払予定を印刷", onclick: () =>
        doPrint([paymentBars(rows, { title: "月ごとの支払い" }), roundsTable(), payTable(rows, names, total)], "支払予定") }),
    ]),
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

/* ══════════ ③ 単価台帳 ══════════ */
function paneItems(host) {
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
        el("td", {}, f.quoteDate), el("td", {}, payCell(f)), el("td", { class: "txt" }, f.note),
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
      amount: Number(f.amount.value) || 0, quoteDate: f.quoteDate.value, note: f.note.value.trim(),
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

  host.appendChild(cardOf("単価台帳", "見積の金額と数量を入れると単価が出ます。支払条件もここで決まります（支払予定はこの条件で組まれます）。", [
    wrapTable(t),
    el("div", { class: "row", style: "gap:8px;flex-wrap:wrap" }, [
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
    ]),
  ]));
  host.appendChild(cardOf("単価の比較", "同じ品目の見積を並べて、単価が上がったか下がったかを見ます。", [cmpHost]));
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

/* ══════════ ④ 島図 ══════════ */
// 工事回ごとに色を変えて塗る。先々の計画も同じ紙に出るので、
// どの島をいつ触るかが1枚で分かる。
function planMarks() {
  const marks = new Map();
  const legend = [];
  const missing = [];
  sortedRounds().forEach((r, i) => {
    const parts = [];
    for (const a of r.adds || []) {
      const { ranges, errors } = parseRanges(a.daiText || "");
      if (errors.length) missing.push(`${r.label || r.workDate}（${errors[0]}）`);
      if (!ranges.length) continue;
      parts.push(`${secLabel(a.rate)} ${formatRanges(ranges)}`);
      for (const l of layout) {
        // 先に決まっている回を優先。あとの回で同じ台を指定していたら気づけるよう警告する
        if (inRanges(l.dai_no, ranges) && !marks.has(l.dai_no)) {
          marks.set(l.dai_no, { color: roundColor(i), title: `${i + 1}回目 ${r.workDate}` });
        }
      }
    }
    if (!parts.length) missing.push(r.label || r.workDate || `${i + 1}回目`);
    else legend.push({ legend: `${i + 1}回目 ${r.workDate || ""}　${parts.join(" / ")}`, colorIndex: i });
  });
  return { marks, legend, missing };
}

function paneMap(host) {
  if (!layout.length) {
    host.appendChild(el("div", { class: "placeholder" }, [
      el("div", { text: "島図がまだ取り込まれていません。" }),
      el("div", { class: "hint", style: "margin-top:6px", text: "「取込」タブで島図Excelを読み込むと、ここに増台位置を出せます。" }),
    ]));
    return;
  }
  const { marks, legend, missing } = planMarks();
  host.appendChild(cardOf("増台位置", "工事回に入れた台番を島図に重ねています。台番は「計画」タブの工事回で編集できます。", [
    buildPlanLegend(legend, SECS),
    missing.length ? el("div", { class: "hint", style: "color:#e0a52e", text: `台番の指定が無い工事回: ${missing.join(" / ")}` }) : null,
    buildPlanMap(layout, marks),
    el("div", { class: "row", style: "gap:8px" }, [
      el("button", { class: "btn sm ghost", text: "🖨 島図を印刷", onclick: () => {
        // 階ごとに1ページ。1枚に押し込むと台番が読めない大きさまで縮む
        const m = planMarks();
        doPrintPages(floorsOf(layout).map((fl) => el("div", {}, [
          el("h3", { text: `増台位置 — ${fl}フロア` }), buildPlanLegend(m.legend, SECS),
          el("div", { style: "height:6px" }), buildPlanFloor(layout, fl, m.marks),
        ])));
      } }),
    ]),
  ]));
}

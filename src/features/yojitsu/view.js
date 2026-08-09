import { el, clear, modal } from "../../util/dom.js";
import { state, loadSections } from "../../core/state.js";
import { flushAll } from "../../core/autosave.js";
import { fiscalMonths, daysInMonth, calendarYear } from "../../util/dates.js";
import { monthAggregate, monthDailySeries, fyAggregate } from "../../calc/aggregate.js";
import { yen, pct, num } from "../../util/format.js";
import { sectionColor, tint } from "../../util/colors.js";
import { loadMonthMaps, loadFiscalMonthMaps } from "./monthData.js";
import { renderDayCalendar } from "./dayCalendar.js";
import { pickMonthlyPlan } from "./importPlan.js";
import { openBudgetInput, loadBudgetTotals } from "./budgetInput.js";
import { openTargetPlanner } from "./targetPlanner.js";
import { openDailyReport } from "./reportModal.js";
import { hbars, cumLine, diffBars } from "./charts.js";

let month = new Date().getMonth() + 1;
let gran = "month";
let keyHandler = null;

export async function mount(host) {
  await loadSections();
  clear(host);
  // ←→ で 月（月モード）／年度（年度モード）を切替
  if (keyHandler) document.removeEventListener("keydown", keyHandler);
  keyHandler = (e) => {
    if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const d = e.key === "ArrowLeft" ? -1 : 1;
    if (gran === "year") state.fy += d;
    else {
      const fm = fiscalMonths(); let i = fm.indexOf(month) + d;
      if (i < 0) { state.fy -= 1; i = 11; } else if (i > 11) { state.fy += 1; i = 0; }
      month = fm[i];
    }
    const fySel = document.getElementById("fySelect"); if (fySel) fySel.value = state.fy;
    mount(host);
  };
  document.addEventListener("keydown", keyHandler);
  host.appendChild(el("div", { class: "view-title" }, [
    el("h1", { text: "予実管理" }),
    el("small", { text: `${state.fy}年度` }),
  ]));

  const ctrl = el("div", { class: "row", style: "align-items:flex-end;gap:10px;flex-wrap:wrap;margin-bottom:14px" });
  const granBtns = el("div", { class: "row", style: "gap:2px" }, ["month", "year"].map((g) =>
    el("button", { class: "btn sm " + (g === gran ? "primary" : "ghost"), text: g === "month" ? "月" : "年度", onclick: () => { gran = g; mount(host); } })));
  ctrl.appendChild(el("div", {}, [el("label", { class: "lbl", text: "粒度" }), granBtns]));
  const monthSel = el("select", { class: "inp", style: "width:90px", onchange: (e) => { month = Number(e.target.value); refresh(); } },
    fiscalMonths().map((m) => el("option", { value: m, text: `${m}月`, selected: m === month ? "selected" : null })));
  if (gran === "month") ctrl.appendChild(el("div", {}, [el("label", { class: "lbl", text: "月" }), monthSel]));

  if (gran === "month") {
    ctrl.appendChild(el("button", { class: "btn primary", text: "日別入力", onclick: openCalendar }));
    ctrl.appendChild(el("button", { class: "btn", text: "🎯 目標粗利→計画", onclick: () => openTargetPlanner({ fy: state.fy, month, sections: state.sections, onDone: refresh }) }));
    ctrl.appendChild(el("button", { class: "btn", text: "📋 日報", onclick: () => openDailyReport({ fy: state.fy, month, sections: state.sections }) }));
  }
  ctrl.appendChild(el("button", { class: "btn", text: gran === "year" ? "年間目標" : "月間目標", onclick: () => openBudgetInput({ mode: gran, fy: state.fy, month, sections: state.sections, onDone: refresh }) }));
  ctrl.appendChild(el("button", { class: "btn ghost", text: "月計画表を取込", onclick: () => pickMonthlyPlan({ fy: state.fy, sections: state.sections, onDone: refresh }) }));
  host.appendChild(ctrl);

  const summary = el("div", { class: "col" });
  host.appendChild(summary);

  async function refresh() {
    let agg, series, showAverages = gran === "month";
    if (gran === "year") {
      const monthMaps = await loadFiscalMonthMaps(state.fy);
      const r = fyAggregate(state.sections, state.fy, monthMaps);
      agg = { perSection: r.perSection, total: r.total }; series = r.series;
    } else {
      const maps = await loadMonthMaps(state.fy, month);
      agg = monthAggregate(state.sections, maps.cy, month, maps);
      series = monthDailySeries(state.sections, maps.cy, month, maps);
    }
    const target = await loadBudgetTotals({ mode: gran, fy: state.fy, month });
    const opts = gran === "month" ? { daysTotal: daysInMonth(calendarYear(state.fy, month), month) } : {};
    renderSummary(summary, agg, series, target, showAverages, opts);
  }
  async function openCalendar() {
    const body = el("div");
    modal(`日別入力 ${state.fy}年度 ${month}月`, body, null);
    const modalEl = body.closest(".modal");
    if (modalEl) { modalEl.style.maxWidth = "min(1500px, 97vw)"; modalEl.style.width = "97vw"; }
    await renderDayCalendar(body, { fy: state.fy, month, sections: state.sections, onChanged: () => {} });
    const bg = body.closest(".modal-bg");
    const done = async () => { await flushAll(); refresh(); };
    bg.addEventListener("click", (e) => { if (e.target === bg) done(); });
    body.closest(".modal").querySelector(".close").addEventListener("click", done);
  }
  refresh();
}

// 指標色: 売上=青 / 粗利=緑（全画面で統一）。グループ色: 計画=鋼青 / 実績=深緑
const MC = { sales: "#4f8ff7", gross: "#2fb888", target: "#f0a12e", land: "#a56cf0" };
const GC = { plan: "#6b7f9e", actual: "#1f9d70" };

function miniKpi(label, value, color, sub) {
  return el("div", { style: "min-width:128px;flex:1" }, [
    el("div", { class: "hint", text: label }),
    el("div", { style: `font-size:21px;font-weight:800;margin-top:2px;color:${color}`, text: value }),
    sub ? el("div", { class: "hint", text: sub }) : null,
  ]);
}
function groupPanel(title, accent, items) {
  return el("div", { class: "card", style: `flex:1;min-width:300px;border-top:3px solid ${accent};background:${tint(accent, 0.05)}` }, [
    el("div", { style: `font-weight:800;font-size:13px;color:${accent};margin-bottom:8px`, text: title }),
    el("div", { class: "row", style: "gap:14px;flex-wrap:wrap" }, items),
  ]);
}
const secBadge = (sec) => { const c = sectionColor(sec); return el("span", { class: "badge", style: `background:${tint(c, 0.16)};color:${c};font-weight:700`, text: sec.label }); };
const dec = (v, d = 2) => (v == null || isNaN(v) ? "—" : Number(v).toFixed(d));

function renderSummary(host, agg, series, target, showAverages, opts = {}) {
  clear(host);
  const t = agg.total;
  // 左列: 計画→実績を縦に並べる（枠色で分離）。売上=青 / 粗利=緑 で統一
  const planRate = t.plan.sales ? t.plan.gross / t.plan.sales : null;
  const actualRate = t.actual.sales ? t.actual.gross / t.actual.sales : null;
  const planPanel = groupPanel("📋 計画", GC.plan, [
    miniKpi("売上", yen(t.plan.sales), MC.sales),
    miniKpi("粗利", yen(t.plan.gross), MC.gross, planRate == null ? "" : "粗利率 " + pct(planRate)),
  ]);
  const actualPanel = groupPanel("✅ 実績", GC.actual, [
    miniKpi("売上", yen(t.actual.sales), MC.sales),
    miniKpi("粗利", yen(t.actual.gross), MC.gross, actualRate == null ? "" : "粗利率 " + pct(actualRate)),
  ]);
  const left = el("div", { class: "col", style: "flex:1.25;min-width:300px;gap:12px" }, [planPanel, actualPanel]);

  // 右列: 区分別バー（上）＋達成状況（下、実績の右に位置）
  const bars = hbars(agg.perSection.map((r) => ({ label: r.section.label, plan: r.plan.gross, actual: r.actual.gross, color: sectionColor(r.section) })), { title: "区分別 計画vs実績（粗利）" });
  const right = el("div", { class: "col", style: "flex:1;min-width:300px;gap:12px" }, [bars, goalPanel(t, opts)]);

  host.appendChild(el("div", { class: "row", style: "flex-wrap:wrap;gap:14px;align-items:stretch" }, [left, right]));
  // 推移は2段構え。上=累計で「このままで届くか」、下=日別の過不足で「どこで落としたか」。
  const unit = gran === "year" ? "月" : "日";
  host.appendChild(el("div", { class: "col", style: "margin-top:12px;gap:12px" }, [
    cumLine(series, { title: `粗利の累計 予実｜点線は着地見込み（残りの${unit}は計画どおりの場合）` }),
    diffBars(series, { title: `${unit}別の過不足（実績−計画・粗利）` }),
  ]));

  // 予実テーブル
  host.appendChild(sectionTable(agg, t));

  // 実績平均・進捗（月モードのみ）
  if (showAverages) host.appendChild(averagesTable(agg, t));
}

// 🎯 達成状況: 粗利があといくら足りないか・残り日数で1日いくら必要かを一目で。
function goalPanel(t, { daysTotal }) {
  const ach = t.achieveGross;
  const hex = achieveHex(ach);
  const need = (t.plan.gross || 0) - (t.actual.gross || 0);
  const elapsed = t.actualDays || 0;
  const remainDays = daysTotal != null ? Math.max(0, daysTotal - elapsed) : null;
  const perDay = need > 0 && remainDays ? need / remainDays : null;
  // 進捗バー（円グラフの代わり）: 計画粗利に対する実績の到達度
  const bar = el("div", { style: "height:12px;background:var(--panel-2);border-radius:6px;overflow:hidden;border:1px solid var(--line)" },
    el("div", { style: `height:100%;width:${Math.min(Math.max(ach || 0, 0), 1) * 100}%;background:${hex};transition:width .3s` }));
  const items = [
    miniKpi("達成率（粗利）", ach == null ? "—" : pct(ach), hex, achieveLabel(ach) + (daysTotal != null ? `（${elapsed}/${daysTotal}日 経過）` : "")),
    need > 0
      ? miniKpi("残り必要粗利", yen(need), MC.target, remainDays != null ? `残り${remainDays}日` : "")
      : miniKpi("計画達成！超過分", yen(-need), "#43b483"),
    perDay != null
      ? miniKpi("1日あたり必要", yen(perDay), perDay > (t.avgGrossDay || 0) ? "#e35d6a" : "#43b483",
          t.avgGrossDay != null ? `現在の日平均 ${yen(t.avgGrossDay)}` : "")
      : null,
    miniKpi("着地見込", yen(t.landing.gross), MC.land, "実績＋残計画"),
  ].filter(Boolean);
  return el("div", { class: "card", style: `flex:1;border-top:3px solid ${hex};background:${tint(hex, 0.05)}` }, [
    el("div", { style: `font-weight:800;font-size:13px;color:${hex};margin-bottom:8px`, text: "🎯 達成状況（粗利）" }),
    bar,
    el("div", { class: "row", style: "gap:14px;flex-wrap:wrap;margin-top:10px" }, items),
  ]);
}

function sectionTable(agg, t) {
  const table = el("table", { class: "grid mono", style: "margin-top:14px" });
  const gBg = (c) => `background:${tint(c, 0.08)}`;
  // 2段ヘッダー: 計画/実績のグループ + 売上(青)/粗利(緑)
  table.appendChild(el("thead", {}, [
    el("tr", {}, [
      el("th", { class: "txt", rowspan: 2, text: "区分" }),
      el("th", { colspan: 2, style: `${gBg(GC.plan)};color:${GC.plan};text-align:center`, text: "📋 計画" }),
      el("th", { colspan: 2, style: `${gBg(GC.actual)};color:${GC.actual};text-align:center`, text: "✅ 実績" }),
      el("th", { rowspan: 2, text: "達成率(粗利)" }),
    ]),
    el("tr", {}, [
      el("th", { style: `${gBg(GC.plan)};color:${MC.sales}`, text: "売上" }),
      el("th", { style: `${gBg(GC.plan)};color:${MC.gross}`, text: "粗利" }),
      el("th", { style: `${gBg(GC.actual)};color:${MC.sales}`, text: "売上" }),
      el("th", { style: `${gBg(GC.actual)};color:${MC.gross}`, text: "粗利" }),
    ]),
  ]));
  const body = el("tbody");
  const dataRow = (label, r, isTotal) => el("tr", { style: isTotal ? "font-weight:700" : "" }, [
    el("td", { class: "txt" }, isTotal ? "合計" : secBadge(r.section)),
    el("td", { style: gBg(GC.plan), text: yen(r.plan.sales) }),
    el("td", { style: gBg(GC.plan), text: yen(r.plan.gross) }),
    el("td", { style: gBg(GC.actual), text: yen(r.actual.sales) }),
    el("td", { style: gBg(GC.actual), text: yen(r.actual.gross) }),
    el("td", { style: achieveColor(r.achieveGross), text: r.achieveGross == null ? "—" : pct(r.achieveGross) }),
  ]);
  for (const r of agg.perSection) body.appendChild(dataRow(null, r, false));
  body.appendChild(dataRow(null, t, true));
  table.appendChild(body);
  return table;
}

function averagesTable(agg, t) {
  const wrap = el("div", { class: "col", style: "margin-top:18px" }, el("h2", { style: "font-size:15px", text: "実績平均・進捗" }));
  const table = el("table", { class: "grid mono" });
  table.appendChild(el("thead", {}, el("tr", {}, ["区分", "平均アウト", "日平均売上", "日平均粗利", "粗利率", "玉単価", "玉粗利", "進捗ペース"].map((h, i) =>
    el("th", { class: i === 0 ? "txt" : "", text: h })))));
  const body = el("tbody");
  const rowFor = (label, r, isTotal) => el("tr", { style: isTotal ? "font-weight:700" : "" }, [
    el("td", { class: "txt" }, isTotal ? "合計" : secBadge(r.section)),
    el("td", { text: num(r.avgOut) }),
    el("td", { text: yen(r.avgSalesDay) }),
    el("td", { text: yen(r.avgGrossDay) }),
    el("td", { text: r.grossRate == null ? "—" : pct(r.grossRate) }),
    el("td", { text: dec(r.coinPrice, 2) }),
    el("td", { text: dec(r.coinGross, 3) }),
    paceCell(r.paceGross),
  ]);
  for (const r of agg.perSection) body.appendChild(rowFor(null, r, false));
  body.appendChild(rowFor(null, t, true));
  table.appendChild(body);
  wrap.appendChild(table);
  wrap.appendChild(el("p", { class: "hint", text: "進捗ペース＝実績 ÷ 計画（実績のある経過日数分）。100%以上＝順調、90%未満＝計画に対して不足ペース。" }));
  return wrap;
}

function paceCell(r) {
  if (r == null) return el("td", { text: "—" });
  const hex = achieveHex(r), label = r >= 1 ? "順調" : r >= 0.9 ? "やや遅れ" : "未達ペース";
  return el("td", { style: `background:${tint(hex, 0.16)};color:${hex};font-weight:700` }, `${pct(r)}  ${label}`);
}

const achieveHex = (r) => (r == null ? "#8a91a3" : r >= 1 ? "#43b483" : r >= 0.9 ? "#e0a52e" : "#e35d6a");
const achieveColor = (r) => (r == null ? "" : "color:" + achieveHex(r) + ";font-weight:600");
const achieveLabel = (r) => (r == null ? "" : r >= 1 ? "達成" : r >= 0.9 ? "あと一歩" : "未達");

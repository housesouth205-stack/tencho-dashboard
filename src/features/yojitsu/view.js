import { el, clear, modal } from "../../util/dom.js";
import { state, loadSections } from "../../core/state.js";
import { flushAll } from "../../core/autosave.js";
import { fiscalMonths, daysInMonth, calendarYear, fiscalYearOptions } from "../../util/dates.js";
import { monthAggregate, monthDailySeries, fyAggregate, sameDaysMaps, fyMonthlyTotals, sumMonths } from "../../calc/aggregate.js";
import { yen, pct, num } from "../../util/format.js";
import { sectionColor, tint } from "../../util/colors.js";
import { loadMonthMaps, loadMonthMapsWithPrev, loadFiscalMonthMaps } from "./monthData.js";
import { renderDayCalendar } from "./dayCalendar.js";
import { pickMonthlyPlan } from "./importPlan.js";
import { openBudgetInput, loadBudgetTotals } from "./budgetInput.js";
import { openTargetPlanner } from "./targetPlanner.js";
import { openDailyReport } from "./reportModal.js";
import { hbars, cumLine, diffBars, dailyBars, cumCompare } from "./charts.js";
import { renderDailyDetail } from "./dailyTable.js";

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
  // 年度はヘッダーにもあるが、スマホでは隠れて押しづらい。過去年度を見返すのは
  // この画面なので、月の選択と同じ場所にも置く（値はヘッダーと同期させる）。
  const fySel = el("select", { class: "inp", style: "width:104px", onchange: (e) => {
    state.fy = Number(e.target.value);
    const head = document.getElementById("fySelect");
    if (head) head.value = state.fy;
    mount(host);
  } }, fiscalYearOptions().map((y) => el("option", { value: y, text: `${y}年度`, selected: y === state.fy ? "selected" : null })));
  ctrl.appendChild(el("div", {}, [el("label", { class: "lbl", text: "年度" }), fySel]));
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
    let agg, series, maps = null, prevMaps = null, prev = null, prevMonthly = null, showAverages = gran === "month";
    if (gran === "year") {
      const monthMaps = await loadFiscalMonthMaps(state.fy);
      const r = fyAggregate(state.sections, state.fy, monthMaps);
      agg = { perSection: r.perSection, total: r.total }; series = r.series;
      // 前年度。同じ取得結果から年度違いで切り出せるので通信は増えない。
      const curM = fyMonthlyTotals(state.sections, state.fy, monthMaps);
      const prvM = fyMonthlyTotals(state.sections, state.fy - 1, (m) => monthMaps(m, state.fy - 1), (m) => monthMaps(m));
      // 前年度は「今年度に実績がある月」だけ足す。5ヶ月ぶんと12ヶ月ぶんを比べない。
      prev = {
        title: `📅 昨年度（${state.fy - 1}年度）`, unitLabel: "実績月数",
        cur: sumMonths(curM), base: sumMonths(prvM, (i) => curM[i].actualDays > 0),
        empty: `${state.fy - 1}年度の実績がありません。年度セレクタで${state.fy - 1}年度を開くと、入っているかを確認できます。`,
      };
      prevMonthly = curM.map((c, i) => ({
        label: `${c.month}月`,
        actual: c.actualDays ? c.actual.sales : null,
        base: prvM[i].actualDays ? prvM[i].actual.sales : null,
      }));
    } else {
      const both = await loadMonthMapsWithPrev(state.fy, month);
      maps = both.cur;
      agg = monthAggregate(state.sections, maps.cy, month, maps);
      series = monthDailySeries(state.sections, maps.cy, month, maps);
      prevMaps = both.prev;
      // 前年同月は、今年の実績がある日にちだけに絞ってから集計する（14日ぶん対1ヶ月ぶんにしない）
      const prevAgg = monthAggregate(state.sections, prevMaps.cy, month, sameDaysMaps(maps, prevMaps));
      prev = {
        title: `📅 昨年同月（${prevMaps.cy}年${month}月）`, unitLabel: "営業日数",
        cur: agg.total, base: prevAgg.total,
        empty: "昨年同月の実績がありません。「月計画表を取込」で昨年度のぶんを入れると増減が出ます。",
      };
    }
    const target = await loadBudgetTotals({ mode: gran, fy: state.fy, month });
    const opts = gran === "month" ? { daysTotal: daysInMonth(calendarYear(state.fy, month), month) } : {};
    renderSummary(summary, agg, series, target, showAverages, { ...opts, prev, prevMonthly });
    // 日別の実績は月モードだけ。年モードは1点が1ヶ月なので日別の表に意味がない。
    if (maps) renderDailyDetail(summary, { fy: state.fy, month, sections: state.sections, maps, prevMaps });
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

// 指標色: 売上=青 / 粗利=緑（全画面で統一）。グループ色: 計画=鋼青 / 実績=深緑 / 前年=グレー
// 前年は目標ではなく参考値なので、計画・実績と競わない無彩色にする。
const MC = { sales: "#4f8ff7", gross: "#2fb888", target: "#f0a12e", land: "#a56cf0" };
const GC = { plan: "#6b7f9e", actual: "#1f9d70", prev: "#8a91a3" };

// 金額は「¥122,760,000」まで伸びるが折り返せない。箱を content より狭くすると
// はみ出して隣の数字と重なるので、折り返し前提の幅を持たせる（スマホで実際に潰れていた）。
function miniKpi(label, value, color, sub) {
  return el("div", { class: "kpi-item" }, [
    el("div", { class: "hint", text: label }),
    el("div", { class: "kpi-value", style: `color:${color}`, text: value }),
    sub ? el("div", { class: "hint", text: sub }) : null,
  ]);
}
function groupPanel(title, accent, items) {
  return el("div", { class: "card", style: `flex:1;min-width:300px;border-top:3px solid ${accent};background:${tint(accent, 0.05)}` }, [
    el("div", { class: "panel-title", style: `color:${accent}`, text: title }),
    el("div", { class: "row", style: "gap:14px;flex-wrap:wrap" }, items),
  ]);
}
const secBadge = (sec) => { const c = sectionColor(sec); return el("span", { class: "badge", style: `background:${tint(c, 0.16)};color:${c};font-weight:700`, text: sec.label }); };
const dec = (v, d = 2) => (v == null || isNaN(v) ? "—" : Number(v).toFixed(d));

// 前年比。増減の主語は必ず「今年」（昨年の値の下に出すので、書かないと逆に読める）。
const yoy = (cur, base) => (base ? cur / base - 1 : null);
const yoyHex = (r) => (r == null ? GC.prev : r >= 0 ? "#43b483" : "#e35d6a");
const yoyText = (r, unit = "%") =>
  (r == null ? "今年 —" : `今年 ${r >= 0 ? "+" : "−"}${(Math.abs(r) * (unit === "%" ? 100 : 1)).toFixed(1)}${unit}`);

// 金額は「¥187,600,000」まで伸びる。折り返せない文字列なので、箱を狭くすると
// 隣の項目に重なって読めなくなる。折り返し前提で幅を確保する。
function prevKpi(label, value, sub, subHex, color) {
  return el("div", { class: "kpi-item sm" }, [
    el("div", { class: "hint", text: label }),
    el("div", { class: "kpi-value sm", style: `color:${color}`, text: value }),
    el("div", { class: "hint", style: `color:${subHex};font-weight:700;white-space:nowrap`, text: sub }),
  ]);
}

// 📅 昨年（月モードは昨年同月／年度モードは昨年度）。値は昨年の実績で、その下が今年の増減。
// 実績パネルの金額と桁が合わないように見えるが、それは今年の実績がある日（月）だけで
// 昨年を集計しているため（途中で1ヶ月ぶん・1年ぶんと比べると必ず大幅マイナスに見える）。
function prevPanel(prev) {
  const { title, cur: t, base: p, unitLabel } = prev;
  const box = (children) => el("div", { class: "card", style: `flex:1;min-width:300px;border-top:3px solid ${GC.prev};background:${tint(GC.prev, 0.05)}` },
    [el("div", { class: "panel-title", style: `color:${GC.prev}`, text: title }), ...children]);
  // 単位は日（月モード）と月（年度モード）で変わる。数え方が違うものを同じ欄に出すので
  // 「実績月数 5／今年 5」のように必ず両方の数を書く。
  const cnt = (a) => (unitLabel === "実績月数" ? a.months : a.actualDays);
  if (!cnt(p)) return box([el("div", { class: "hint", text: prev.empty })]);

  const rateDiff = p.grossRate != null && t.grossRate != null ? t.grossRate - p.grossRate : null;
  const kpi = (label, key, fmt, color) => {
    const r = yoy(t.actual[key], p.actual[key]);
    return prevKpi(label, fmt(p.actual[key]), yoyText(r), yoyHex(r), color);
  };
  const unit = unitLabel === "実績月数" ? "ヶ月" : "日";
  const items = [
    kpi("売上", "sales", yen, MC.sales),
    kpi("粗利", "gross", yen, MC.gross),
    prevKpi("アウト/台", num(p.avgOut), yoyText(yoy(t.avgOut, p.avgOut)), yoyHex(yoy(t.avgOut, p.avgOut)), "var(--fg)"),
    // 粗利率は率どうしの差なので%ではなくpt（28%→29%は「+3.6%」ではなく「+1.0pt」）
    prevKpi("粗利率", p.grossRate == null ? "—" : pct(p.grossRate), rateDiff == null ? "今年 —" : yoyText(rateDiff * 100, "pt"), yoyHex(rateDiff), MC.gross),
    prevKpi(unitLabel, `${cnt(p)}${unit}`, `今年 ${cnt(t)}${unit}`, GC.prev, "var(--fg)"),
  ];
  return box([
    el("div", { class: "row", style: "gap:14px;flex-wrap:wrap" }, items),
    el("div", { class: "hint xs", style: "margin-top:6px",
      text: unitLabel === "実績月数"
        ? "今年度に実績が入っている月の、同じ日にちだけで昨年度を集計しています（進行中の月も日数をそろえて比べられるように）。"
        : "今年の実績が入っている日にちと同じ日で昨年を集計しています（月の途中でも比べられるように）。" }),
  ]);
}

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
  const left = el("div", { class: "col", style: "flex:1.25;min-width:300px;gap:12px" },
    [planPanel, actualPanel, opts.prev ? prevPanel(opts.prev) : null].filter(Boolean));

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

  // 年度モードの前年比較。過去と比べるのは売上（粗利は釘・設定の判断がそのまま出て
  // 年をまたぐとぶれる）。月ごとの勝ち負けと、年度を通した差の両方を出す。
  const pm = opts.prevMonthly;
  if (pm && pm.some((r) => r.base != null)) {
    host.appendChild(el("div", { class: "col", style: "margin-top:12px;gap:12px" }, [
      dailyBars(pm.map((r) => ({ label: r.label, plan: r.base || 0, actual: r.actual })),
        { title: "月別 売上（棒＝今年度／横線＝昨年度）", color: MC.sales, unit: "円", baseLabel: "昨年度" }),
      cumCompare(pm.map((r) => ({ label: r.label, cur: r.actual, base: r.base })),
        { title: "売上の累計 今年度vs昨年度（実績のある月まで）", color: MC.sales, unit: "円" }),
    ]));
  }

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
    el("div", { class: "panel-title", style: `color:${hex}`, text: "🎯 達成状況（粗利）" }),
    bar,
    el("div", { class: "row", style: "gap:14px;flex-wrap:wrap;margin-top:10px" }, items),
  ]);
}

// スマホでは列の多い表が画面幅に収まらない。横スクロールさせるとグラフや達成状況と
// 見た目の幅が合わないため、区分ごとのカードに組み替えて縦に積む（横移動なしで読める）。
const narrow = () => window.matchMedia("(max-width: 700px)").matches;

// カード1枚。見出し（区分＋右肩の指標）＋ラベル/値の行。
function statCard(head, right, pairs, cols) {
  const line = ([label, value, color]) => el("div", { class: "row", style: "justify-content:space-between;gap:6px;align-items:baseline;min-width:0" }, [
    el("span", { class: "hint", style: "white-space:nowrap", text: label }),
    el("b", { class: "stat-value", style: `text-align:right${color ? ";color:" + color : ""}`, text: value }),
  ]);
  return el("div", { class: "card col", style: "padding:10px 12px;gap:6px" }, [
    el("div", { class: "row", style: "align-items:center;gap:8px" }, [head, el("div", { class: "grow" }), right].filter(Boolean)),
    el("div", { style: `display:grid;grid-template-columns:repeat(${cols}, minmax(0,1fr));gap:2px 14px` }, pairs.map(line)),
  ]);
}

// 計画と実績は枠で囲って分け、売上=青 / 粗利=緑 で色を分ける（画面上部の
// 📋計画/✅実績パネルと同じ配色にそろえる）。4行が同じ色・太さだと
// どれが計画でどれが実績か読み取れなかった。
function kv(label, value, color) {
  return el("div", { class: "row", style: "justify-content:space-between;gap:4px;align-items:baseline;min-width:0" }, [
    el("span", { class: "hint xs", text: label }),
    el("b", { class: "stat-value lg", style: `color:${color};white-space:nowrap`, text: value }),
  ]);
}
function grpBlock(title, accent, sales, gross) {
  return el("div", { class: "col", style: `flex:1;min-width:0;gap:2px;border:1px solid ${tint(accent, 0.3)};` +
    `border-top:3px solid ${accent};background:${tint(accent, 0.06)};border-radius:6px;padding:5px 7px` }, [
    el("div", { class: "mini-title", style: `color:${accent}`, text: title }),
    kv("売上", sales, MC.sales),
    kv("粗利", gross, MC.gross),
  ]);
}

function sectionCards(agg, t) {
  const card = (r, isTotal) => el("div", { class: "card col", style: "padding:10px 12px;gap:8px" }, [
    el("div", { class: "row", style: "align-items:center;gap:8px" }, [
      isTotal ? el("b", { text: "合計" }) : secBadge(r.section),
      el("div", { class: "grow" }),
      el("span", { class: "hint", style: "margin-right:4px", text: "達成率(粗利)" }),
      el("b", { style: (achieveColor(r.achieveGross) || "") + ";font-size:16px", text: r.achieveGross == null ? "—" : pct(r.achieveGross) }),
    ]),
    el("div", { class: "row", style: "gap:6px;align-items:stretch" }, [
      grpBlock("📋 計画", GC.plan, yen(r.plan.sales), yen(r.plan.gross)),
      grpBlock("✅ 実績", GC.actual, yen(r.actual.sales), yen(r.actual.gross)),
    ]),
  ]);
  return el("div", { class: "col", style: "gap:8px;margin-top:14px" },
    [...agg.perSection.map((r) => card(r, false)), card(t, true)]);
}

function averagesCards(agg, t) {
  const card = (r, isTotal) => statCard(
    isTotal ? el("b", { text: "合計" }) : secBadge(r.section),
    r.paceGross == null ? null : el("b", { class: "stat-value", style: `color:${achieveHex(r.paceGross)}`, text: `${pct(r.paceGross)} ${r.paceGross >= 1 ? "順調" : r.paceGross >= 0.9 ? "やや遅れ" : "未達ペース"}` }),
    // 売上系=青 / 粗利系=緑。区分別カードと同じ色分けにそろえる。
    [["平均アウト", num(r.avgOut)], ["粗利率", r.grossRate == null ? "—" : pct(r.grossRate), MC.gross],
      ["日平均売上", yen(r.avgSalesDay), MC.sales], ["玉単価", dec(r.coinPrice, 2), MC.sales],
      ["日平均粗利", yen(r.avgGrossDay), MC.gross], ["玉粗利", dec(r.coinGross, 3), MC.gross]], 2);
  return el("div", { class: "col", style: "gap:8px" },
    [...agg.perSection.map((r) => card(r, false)), card(t, true)]);
}

function sectionTable(agg, t) {
  if (narrow()) return sectionCards(agg, t);
  const table = el("table", { class: "grid mono" });
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
  // スマホでは6列が画面幅に収まらないので表の中だけスクロールさせる（グラフと幅を揃える）
  return el("div", { class: "table-wrap", style: "margin-top:14px" }, table);
}

function averagesTable(agg, t) {
  const wrap = el("div", { class: "col", style: "margin-top:18px" }, el("h2", { style: "font-size:15px", text: "実績平均・進捗" }));
  if (narrow()) {
    wrap.appendChild(averagesCards(agg, t));
    wrap.appendChild(el("p", { class: "hint", text: "進捗ペース＝実績 ÷ 計画（実績のある経過日数分）。100%以上＝順調、90%未満＝計画に対して不足ペース。" }));
    return wrap;
  }
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
  wrap.appendChild(el("div", { class: "table-wrap" }, table));
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

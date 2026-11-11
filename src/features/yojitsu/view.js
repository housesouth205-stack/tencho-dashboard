import { el, clear, modal } from "../../util/dom.js";
import { state, loadSections } from "../../core/state.js";
import { flushAll } from "../../core/autosave.js";
import { fiscalMonths, daysInMonth, calendarYear, fiscalYearOptions } from "../../util/dates.js";
import { monthAggregate, monthDailySeries, fyAggregate, sameDaysMaps, fyMonthlyTotals, sumMonths } from "../../calc/aggregate.js";
import { yen, pct, num } from "../../util/format.js";
import { sectionColor, tint } from "../../util/colors.js";
import { loadMonthMapsWithPrev, loadFiscalMonthMaps } from "./monthData.js";
import { renderDayCalendar } from "./dayCalendar.js";
import { openBudgetInput } from "./budgetInput.js";
import { openTargetPlanner } from "./targetPlanner.js";
import { openDailyReport } from "./reportModal.js";
import { cumLine, diffBars, dailyBars, cumCompare } from "./charts.js";
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
  // タイトルの行に操作を並べる。以前はタイトル・ラベル付きの選択欄・ボタンが3段に分かれ、
  // 数字が出るまでに縦を使っていた。
  // 年度はヘッダーにもあるが、スマホでは隠れて押しづらい。過去年度を見返すのは
  // この画面なので、ここにも置く（値はヘッダーと同期させる）。
  const fySel = el("select", { class: "inp", title: "年度", onchange: (e) => {
    state.fy = Number(e.target.value);
    const head = document.getElementById("fySelect");
    if (head) head.value = state.fy;
    mount(host);
  } }, fiscalYearOptions().map((y) => el("option", { value: y, text: `${y}年度`, selected: y === state.fy ? "selected" : null })));
  const monthSel = el("select", { class: "inp", title: "月", onchange: (e) => { month = Number(e.target.value); refresh(); } },
    fiscalMonths().map((m) => el("option", { value: m, text: `${m}月`, selected: m === month ? "selected" : null })));
  const granBtn = (g, label) => el("button", { class: "btn" + (g === gran ? " on" : ""), text: label, onclick: () => { gran = g; mount(host); } });
  const subTitle = el("span", { class: "sub" });
  host.appendChild(el("div", { class: "view-head" }, [
    el("h1", { text: "予実管理" }), subTitle,
    el("div", { class: "ops" }, [
      granBtn("month", "月"), granBtn("year", "年度"), fySel,
      gran === "month" ? monthSel : null,
      gran === "month" ? el("button", { class: "btn primary", text: "日別入力", onclick: openCalendar }) : null,
      gran === "month" ? el("button", { class: "btn", text: "日報", onclick: () => openDailyReport({ fy: state.fy, month, sections: state.sections }) }) : null,
      gran === "month" ? el("button", { class: "btn", text: "目標から計画を作る", onclick: () => openTargetPlanner({ fy: state.fy, month, sections: state.sections, onDone: refresh }) }) : null,
      el("button", { class: "btn", text: gran === "year" ? "年間目標" : "月間目標", onclick: () => openBudgetInput({ mode: gran, fy: state.fy, month, sections: state.sections, onDone: refresh }) }),
    ].filter(Boolean)),
  ]));

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
        empty: "昨年同月の実績がありません。右上の「📂 取込」で昨年度の月計画表を入れると増減が出ます。",
      };
    }
    const opts = gran === "month" ? { daysTotal: daysInMonth(calendarYear(state.fy, month), month) } : {};
    const days = agg.total.actualDays || 0;
    subTitle.textContent = gran === "month"
      ? `${calendarYear(state.fy, month)}年${month}月（${days ? `実績 ${days}日ぶん` : "実績なし"}）`
      : `${state.fy}年度`;
    renderSummary(summary, agg, series, showAverages, { ...opts, prev, prevMonthly });
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

// 万円表記（要点の数字用）。1万未満は円のまま出す
const man = (v) => (v == null || isNaN(v) ? "—" : Math.abs(v) >= 10000 ? `${Math.round(v / 10000).toLocaleString("ja-JP")}万` : yen(v));
const rateCls = (r) => (r == null ? "none" : r >= 1 ? "ok" : r >= 0.9 ? "warn" : "bad");
const rateBadge = (r) => el("span", { class: "rate " + rateCls(r), text: r == null ? "—" : pct(r) });
// 比較の1項目。「計画比 103.2%」のようにラベルは薄く、数字は太く
const cmp = (label, text, cls) => el("span", {}, [label + " ", el("b", { class: cls || "", text })]);
const signPct = (r) => (r == null ? "—" : `${r >= 0 ? "+" : "▲"}${(Math.abs(r) * 100).toFixed(1)}%`);

function kpiCard(label, value, color, cmps) {
  return el("div", { class: "card kpi" }, [
    el("div", { class: "kpi-lbl", text: label }),
    el("div", { class: "kpi-num", style: color ? `color:${color}` : "", text: value }),
    el("div", { class: "kpi-cmp" }, cmps.filter(Boolean)),
  ]);
}

// 要点の4枠。計画比は「実績のある日の計画」と比べ、前年比は同じ日にちで比べる（どちらも
// 月・年度の途中で、1か月ぶん・1年ぶんと比べて未達に見えるのを避けるため）。
function kpiRow(t, opts) {
  const p = opts.prev;
  const hasPrev = p && (p.unitLabel === "実績月数" ? p.base.months : p.base.actualDays);
  const yo = (k) => (hasPrev ? yoy(p.cur.actual[k], p.base.actual[k]) : null);
  const vs = (r) => (r == null ? null : cmp("計画比", pct(r), r >= 1 ? "up" : "down"));
  const prevCmp = (r) => (r == null ? null : cmp("前年比", signPct(r), r >= 0 ? "up" : "down"));
  const planRate = t.plan.sales ? t.plan.gross / t.plan.sales : null;
  const actualRate = t.actual.sales ? t.actual.gross / t.actual.sales : null;
  const prevRate = hasPrev ? p.base.grossRate : null;

  const need = (t.plan.gross || 0) - (t.actual.gross || 0);
  const elapsed = t.actualDays || 0;
  const remain = opts.daysTotal != null ? Math.max(0, opts.daysTotal - elapsed) : null;
  const perDay = need > 0 && remain ? need / remain : null;
  const goalLabel = opts.daysTotal != null ? "月計画まで（粗利）" : "年度計画まで（粗利）";
  const goal = !t.plan.gross
    ? kpiCard(goalLabel, "計画なし", "var(--fg-dim)", [])
    : need > 0
      ? kpiCard(goalLabel, `あと ${man(need)}`, null, [
        perDay != null ? cmp("1日あたり", man(perDay), t.avgGrossDay != null && perDay > t.avgGrossDay ? "down" : "") : null,
        remain != null ? cmp("残り", `${remain}日`) : null,
        cmp("着地見込", man(t.landing.gross)),
      ])
      : kpiCard(goalLabel, `達成 +${man(-need)}`, "#1f9d70", [cmp("着地見込", man(t.landing.gross))]);

  const none = !elapsed;
  return el("div", { class: "kpis" }, [
    kpiCard("売上（実績）", none ? "—" : yen(t.actual.sales), MC.sales, [vs(t.paceSales), prevCmp(yo("sales"))]),
    kpiCard("粗利（実績）", none ? "—" : yen(t.actual.gross), MC.gross, [vs(t.paceGross), prevCmp(yo("gross"))]),
    kpiCard("粗利率", actualRate == null ? "—" : pct(actualRate), null, [
      planRate == null ? null : cmp("計画", pct(planRate)),
      prevRate == null ? null : cmp("前年", pct(prevRate)),
    ]),
    goal,
  ]);
}

// 粗利の進み具合。店全体で横長のバー1本にして、区分を色でつなぐ（右端＝計画の合計）。
// 以前は区分ごとに別々のバーで、長さを最大の区分に合わせていたため、2スロのバーが
// 数ミリになって進み具合が読めなかった。区分ごとの数字はバーの下に並べる。
// 黒い線は「実績のある日までの計画」。色がこの線を越えていれば計画どおり。
function progressCard(agg, t, opts) {
  const plan = t.plan.gross || 0;
  const scope = opts.daysTotal != null ? "月計画" : "年度計画";
  if (!plan) {
    return el("div", { class: "card prog" }, [
      el("h2", { text: "粗利の進み具合" }),
      el("div", { class: "hint", text: "計画が入っていません。「日別入力」か右上の「📂 取込」（月計画表）で計画を入れると、ここに進み具合が出ます。" }),
    ]);
  }
  const secs = agg.perSection;
  const sumActual = Math.max(0, t.actual.gross || 0);
  // 計画を超えたときはバーの全長を実績に合わせる（色がはみ出さないように）
  const full = Math.max(plan, sumActual);
  const w = (v) => `${Math.max(0, v) / full * 100}%`;
  const bar = el("div", { class: "prog-bar" }, [
    ...secs.filter((r) => r.actual.gross > 0).map((r) => {
      const share = r.actual.gross / full;
      // 細い区間には文字を入れない（はみ出して隣に重なる）。数字はバーの下にある
      const text = share > 0.14 ? `${r.section.label} ${man(r.actual.gross)}` : share > 0.055 ? man(r.actual.gross) : "";
      return el("span", { style: `width:${w(r.actual.gross)};background:${sectionColor(r.section)}`, title: `${r.section.label} ${yen(r.actual.gross)}`, text });
    }),
    plan > sumActual ? el("span", { class: "rest", text: `残り ${man(plan - sumActual)}` }) : null,
  ].filter(Boolean));
  const paceAt = t.planElapsed?.gross ? Math.min(t.planElapsed.gross / full, 1) : null;
  // 期間の終わり（線が右端）では線を出さない。バーの端と重なって意味が無い
  const mark = paceAt == null || !t.actualDays || paceAt > 0.985 ? null
    : el("div", { class: "prog-mark", style: `left:${Math.min(Math.max(paceAt * 100, 6), 94)}%`, "data-label": `ここまでの計画 ${man(t.planElapsed.gross)}` });
  return el("div", { class: "card prog" }, [
    el("div", { class: "prog-head" }, [
      el("h2", { text: `粗利の進み具合（${scope} ${man(plan)} に対して）` }),
      el("div", { class: "prog-legend" }, [
        ...secs.map((r) => el("span", {}, [el("i", { style: `background:${sectionColor(r.section)}` }), r.section.label])),
        el("span", {}, [el("i", { style: "background:#e6ebf3" }), "計画の残り"]),
      ]),
    ]),
    el("div", { class: "prog-track" }, [bar, mark].filter(Boolean)),
    el("div", { class: "prog-scale" }, [
      el("span", { text: "0" }),
      el("span", {}, ["実績合計 ", el("b", { text: `${man(t.actual.gross)}（${pct(t.actual.gross / plan)}）` })]),
      el("span", { text: `計画 ${man(plan)}` }),
    ]),
    el("div", { class: "prog-secs" }, secs.map((r) => el("div", { class: "prog-sec", style: `border-color:${sectionColor(r.section)}` }, [
      el("span", { class: "nm", text: r.section.label }),
      el("b", { text: man(r.actual.gross) }),
      el("span", { class: "of", text: `/ ${man(r.plan.gross)}` }),
      r.paceGross == null ? null : el("span", { class: "rate " + rateCls(r.paceGross), title: "実績のある日の計画に対する比", text: `計画比 ${pct(r.paceGross)}` }),
    ].filter(Boolean)))),
  ]);
}

function renderSummary(host, agg, series, showAverages, opts = {}) {
  clear(host);
  const t = agg.total;
  host.appendChild(kpiRow(t, opts));
  host.appendChild(progressCard(agg, t, opts));
  // 昨年の内訳（アウト/台・営業日数など）は要点の枠に入りきらないので、ここに残す
  if (opts.prev) host.appendChild(prevPanel(opts.prev));
  // 推移は2段構え。上=累計で「このままで届くか」、下=日別の過不足で「どこで落としたか」。
  const unit = gran === "year" ? "月" : "日";
  // 2つのグラフは左右に並べる。横幅いっぱいに1つずつだと、横長に引き伸ばされて文字だけ大きくなり、
  // 縦も2枚ぶん長くなっていた（広い画面のときだけ。狭い画面は今までどおり上下）
  host.appendChild(el("div", { class: "yj-pair" }, [
    // 見出しは1行に収まる長さにする。点線の意味は凡例の「着地見込み（点線）」に出ている
    cumLine(series, { title: "粗利の累計 予実" }),
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

  // 表は横幅いっぱいに1つずつ置く。左右に並べると列が詰まり、数字を小さくするしかなかった
  host.appendChild(el("div", { class: "col", style: "margin-top:12px;gap:12px" },
    [sectionTable(agg, t), showAverages ? averagesTable(agg, t) : null].filter(Boolean)));
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
  // 計画比は進み具合のバーと同じく「実績のある日の計画」との比。月の計画全体と比べると、
  // 月の途中は必ず未達に見える。
  const table = el("table", { class: "sum" });
  table.appendChild(el("thead", {}, el("tr", {}, [
    el("th", { text: "区分" }), el("th", { text: "計画売上" }), el("th", { text: "実績売上" }),
    el("th", { text: "計画粗利" }), el("th", { class: "hl", text: "実績粗利" }),
    el("th", { text: "粗利率" }), el("th", { text: "計画比（粗利）" }),
  ])));
  const body = el("tbody");
  const dataRow = (r, isTotal) => el("tr", { class: isTotal ? "tot" : "" }, [
    el("td", {}, isTotal ? "合計" : el("b", { text: r.section.label })),
    el("td", { text: yen(r.plan.sales) }),
    el("td", { text: r.actualDays ? yen(r.actual.sales) : "—" }),
    el("td", { text: yen(r.plan.gross) }),
    el("td", { class: "hl" }, el("b", { text: r.actualDays ? yen(r.actual.gross) : "—" })),
    el("td", { text: r.grossRate == null ? "—" : pct(r.grossRate) }),
    el("td", {}, rateBadge(r.paceGross)),
  ]);
  for (const r of agg.perSection) body.appendChild(dataRow(r, false));
  body.appendChild(dataRow(t, true));
  table.appendChild(body);
  return el("div", { class: "card", style: "padding:0;overflow:hidden" }, [
    el("div", { class: "table-wrap" }, table),
    el("div", { class: "hint", style: "padding:6px 16px", text: "計画売上・計画粗利は期間全体の計画。計画比は、実績が入っている日の計画と比べた値です。" }),
  ]);
}

function averagesTable(agg, t) {
  const wrap = el("div", { class: "col", style: "gap:6px" }, el("h2", { style: "margin:0", text: "1日・1台あたりの実績" }));
  if (narrow()) {
    wrap.appendChild(averagesCards(agg, t));
    wrap.appendChild(el("p", { class: "hint", text: "進捗ペース＝実績 ÷ 計画（実績のある経過日数分）。100%以上＝順調、90%未満＝計画に対して不足ペース。" }));
    return wrap;
  }
  const table = el("table", { class: "sum" });
  table.appendChild(el("thead", {}, el("tr", {}, ["区分", "平均アウト", "日平均売上", "日平均粗利", "玉単価", "玉粗利"].map((h) => el("th", { text: h })))));
  const body = el("tbody");
  const rowFor = (r, isTotal) => el("tr", { class: isTotal ? "tot" : "" }, [
    el("td", {}, isTotal ? "合計" : el("b", { text: r.section.label })),
    el("td", { text: num(r.avgOut) }),
    el("td", { text: yen(r.avgSalesDay) }),
    el("td", { text: yen(r.avgGrossDay) }),
    el("td", { text: dec(r.coinPrice, 2) }),
    el("td", { text: dec(r.coinGross, 3) }),
  ]);
  for (const r of agg.perSection) body.appendChild(rowFor(r, false));
  body.appendChild(rowFor(t, true));
  table.appendChild(body);
  wrap.appendChild(el("div", { class: "card", style: "padding:0;overflow:hidden" }, el("div", { class: "table-wrap" }, table)));
  return wrap;
}


const achieveHex = (r) => (r == null ? "#8a91a3" : r >= 1 ? "#43b483" : r >= 0.9 ? "#e0a52e" : "#e35d6a");
const achieveColor = (r) => (r == null ? "" : "color:" + achieveHex(r) + ";font-weight:600");

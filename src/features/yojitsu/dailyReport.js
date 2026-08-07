// 日報テキストの組み立て。アプリは有料API不使用の方針なので、AIによる文章生成では
// なく実績からテンプレートで組む（数字は必ず既存の計算層 planCalc/actualCalc を通す）。
// 用途で書式が変わるため2モードを持つ:
//   report  … 本部・上司への報告用。数字と対計画だけを淡々と並べる
//   review  … 自分の振り返り用。前日比や要因、残り必要粗利などの気づきを足す
import { planCalc } from "../../calc/planCalc.js";
import { actualCalc } from "../../calc/actualCalc.js";
import { monthAggregate } from "../../calc/aggregate.js";
import { daysInMonth, ymd } from "../../util/dates.js";

const YEN = (n) => (n == null || isNaN(n) ? "—" : "¥" + Math.round(n).toLocaleString("ja-JP"));
const NUM = (n, d = 0) => (n == null || isNaN(n) ? "—" : Number(n).toLocaleString("ja-JP", { maximumFractionDigits: d }));
const PCT = (r, d = 1) => (r == null || isNaN(r) ? "—" : (r * 100).toFixed(d) + "%");
const SIGNED_PCT = (r) => (r == null || isNaN(r) ? "—" : (r >= 0 ? "+" : "") + (r * 100).toFixed(1) + "%");
// 差額は符号を金額の前に出す（¥-20,000 は読みにくいため -¥20,000 にする）
const DIFF = (n) => (n == null || isNaN(n) ? "—" : (n >= 0 ? "+" : "-") + YEN(Math.abs(n)));
const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

const hasActual = (a) => a && (a.sales != null || a.gross != null || a.out_per_unit != null);

// 1日ぶんを区分別に集計する。count(台数)はmachines_dayから。
function dayTotals(sections, date, maps) {
  const rows = [];
  const sum = { sales: 0, gross: 0, outTotal: 0, planSales: 0, planGross: 0, count: 0 };
  let any = false;
  for (const s of sections) {
    const k = `${date}|${s.id}`;
    const count = maps.machines.get(k)?.count;
    const p = planCalc(maps.plan.get(k), count);
    const aRow = maps.actual.get(k);
    const has = hasActual(aRow);
    const a = has ? actualCalc(aRow, count) : null;
    if (has) any = true;
    rows.push({ section: s, count, plan: p, actual: a });
    sum.planSales += p.sales; sum.planGross += p.gross;
    if (a) { sum.sales += a.sales; sum.gross += a.gross; sum.outTotal += a.outTotal; sum.count += count || 0; }
  }
  return { rows, sum, any };
}

// 実績が入っている最新の日を探す（未入力の当日を対象にしても中身が空になるため）。
export function latestActualDay(sections, year, month, maps) {
  for (let d = daysInMonth(year, month); d >= 1; d--) {
    const date = ymd(year, month, d);
    if (dayTotals(sections, date, maps).any) return d;
  }
  return null;
}

// 全角は2文字ぶんの幅で数える。全角スペースで埋めると等幅フォントでも桁がずれるため、
// 表示幅を計算して半角スペースだけで揃える。
const dispW = (s) => [...String(s)].reduce(
  (n, c) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(c) ? 2 : 1), 0);
const padR = (s, n) => String(s) + " ".repeat(Math.max(0, n - dispW(s)));
const padL = (s, n) => " ".repeat(Math.max(0, n - dispW(s))) + String(s);

function table(rows, sum) {
  const shown = rows.filter((r) => r.actual);
  const labelW = Math.max(6, ...shown.map((r) => dispW(r.section.label))) + 2;
  const COL = [12, 11, 10, 8]; // 売上 / 粗利 / 台あたりアウト / 粗利率
  const row = (label, a, b, c, d) =>
    padR(label, labelW) + padL(a, COL[0]) + padL(b, COL[1]) + padL(c, COL[2]) + padL(d, COL[3]);
  const line = [row("区分", "売上", "粗利", "アウト/台", "粗利率")];
  for (const r of shown) {
    const rate = r.actual.sales ? r.actual.gross / r.actual.sales : null;
    const per = r.count ? r.actual.outTotal / r.count : null;
    line.push(row(r.section.label, YEN(r.actual.sales), YEN(r.actual.gross), NUM(per), PCT(rate)));
  }
  const rate = sum.sales ? sum.gross / sum.sales : null;
  line.push(row("合計", YEN(sum.sales), YEN(sum.gross), "", PCT(rate)));
  return line.join("\n");
}

// mode: "report"(本部報告) / "review"(振り返り)
export function buildDailyReport({ mode, sections, year, month, day, maps, storeName, monthBudgetGross }) {
  const date = ymd(year, month, day);
  const dt = new Date(year, month - 1, day);
  const head = `【日報】${year}年${month}月${day}日（${WEEK[dt.getDay()]}）${storeName ? " " + storeName : ""}`;
  if (!dayTotals(sections, date, maps).any) {
    return `${head}\n\nこの日の実績はまだ入力されていません。`;
  }
  const today = dayTotals(sections, date, maps);
  // 月間累計はその日までで締める。過去日の日報を出し直したときに、後の日の実績まで
  // 混ざって「累計」と日付が食い違うのを防ぐ（着地見込もその日時点の見込みになる）。
  const upTo = { ...maps, actual: new Map([...maps.actual].filter(([k]) => k.split("|")[0] <= date)) };
  const agg = monthAggregate(sections, year, month, upTo);
  const out = [head, "", "■ 本日実績", table(today.rows, today.sum)];

  // 対計画（その日ぶん）
  const achSales = today.sum.planSales ? today.sum.sales / today.sum.planSales : null;
  const achGross = today.sum.planGross ? today.sum.gross / today.sum.planGross : null;
  out.push("", "■ 対計画（本日）",
    `売上 ${PCT(achSales)}（計画 ${YEN(today.sum.planSales)} / 差 ${DIFF(today.sum.sales - today.sum.planSales)}）`,
    `粗利 ${PCT(achGross)}（計画 ${YEN(today.sum.planGross)} / 差 ${DIFF(today.sum.gross - today.sum.planGross)}）`);

  // 月間累計
  const t = agg.total;
  out.push("", `■ 月間累計（${month}月1日〜${day}日 / 実績${t.actualDays}日）`,
    `売上 ${YEN(t.actual.sales)}　計画比 ${PCT(t.paceSales)}`,
    `粗利 ${YEN(t.actual.gross)}　計画比 ${PCT(t.paceGross)}`,
    `着地見込 粗利 ${YEN(t.landing.gross)}（月間計画 ${YEN(t.plan.gross)}）`);
  if (monthBudgetGross) {
    out.push(`月間目標 ${YEN(monthBudgetGross)}　目標比 ${PCT(t.landing.gross / monthBudgetGross)}`);
  }

  if (mode === "report") return out.join("\n");

  // ---- 以下は振り返り用の気づき（ルールベース） ----
  const notes = [];

  // 区分ごとの対計画の外れ（大きい順に最大3件）
  const misses = today.rows
    .filter((r) => r.actual && r.plan.gross)
    .map((r) => ({ label: r.section.label, diff: r.actual.gross - r.plan.gross, ratio: r.actual.gross / r.plan.gross }))
    .sort((a, b) => a.diff - b.diff);
  for (const m of misses.slice(0, 3)) {
    if (m.ratio < 0.95) notes.push(`${m.label} の粗利が計画を${PCT(1 - m.ratio, 0)}下回りました（${DIFF(m.diff)}）`);
  }
  const best = misses[misses.length - 1];
  if (best && best.ratio > 1.05) notes.push(`${best.label} は計画を${PCT(best.ratio - 1, 0)}上回りました（${DIFF(best.diff)}）`);

  // 前日比・前週同曜日比
  const compare = (backDays, label) => {
    const d2 = new Date(year, month - 1, day - backDays);
    if (d2.getMonth() + 1 !== month || d2.getFullYear() !== year) return; // 月をまたぐ分は対象外
    const prev = dayTotals(sections, ymd(year, month, d2.getDate()), maps);
    if (!prev.any || !prev.sum.gross) return;
    notes.push(`粗利は${label}比 ${SIGNED_PCT(today.sum.gross / prev.sum.gross - 1)}（${YEN(prev.sum.gross)} → ${YEN(today.sum.gross)}）`);
  };
  compare(1, "前日");
  compare(7, "前週同曜日");

  // 残りで必要な日平均粗利（目標があれば目標、無ければ計画に対して）
  const goal = monthBudgetGross || t.plan.gross;
  const restDays = daysInMonth(year, month) - day;
  if (goal && restDays > 0) {
    const need = (goal - t.actual.gross) / restDays;
    const pace = t.avgGrossDay;
    notes.push(`残り${restDays}日で${monthBudgetGross ? "目標" : "計画"}到達には日平均 ${YEN(need)} が必要` +
      (pace ? `（直近の日平均 ${YEN(pace)}）` : ""));
    if (pace && need > pace * 1.05) notes.push("現在のペースでは未達の見込みです");
  }

  out.push("", "■ 気づき", ...(notes.length ? notes.map((n) => "・" + n) : ["・特記事項なし"]));
  return out.join("\n");
}

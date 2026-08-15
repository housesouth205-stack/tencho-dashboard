import { planCalc } from "./planCalc.js";
import { actualCalc } from "./actualCalc.js";
import { daysInMonth, ymd, fiscalMonths, calendarYear } from "../util/dates.js";

const key = (d, s) => `${d}|${s}`;
export const indexRows = (rows) => new Map((rows || []).map((r) => [key(r.ymd, r.section_id), r]));
const hasActual = (a) => a && (a.sales != null || a.gross != null || a.out_per_unit != null);

// 集計ノードの派生指標を確定（達成率・進捗ペース・実績平均）。
function finalize(a) {
  a.achieveGross = a.plan.gross ? a.actual.gross / a.plan.gross : null;
  a.achieveSales = a.plan.sales ? a.actual.sales / a.plan.sales : null;
  // 進捗ペース: 実績 ÷ 計画(実績のある経過日分)
  a.paceGross = a.planElapsed.gross ? a.actual.gross / a.planElapsed.gross : null;
  a.paceSales = a.planElapsed.sales ? a.actual.sales / a.planElapsed.sales : null;
  // 実績平均
  a.avgOut = a.sumCount ? a.actual.outTotal / a.sumCount : null;      // 台あたり平均アウト
  a.avgSalesDay = a.actualDays ? a.actual.sales / a.actualDays : null; // 日平均売上
  a.avgGrossDay = a.actualDays ? a.actual.gross / a.actualDays : null; // 日平均粗利
  a.grossRate = a.actual.sales ? a.actual.gross / a.actual.sales : null;
  a.coinPrice = a.actual.outTotal ? a.actual.sales / a.actual.outTotal : null; // 玉単価
  a.coinGross = a.actual.outTotal ? a.actual.gross / a.actual.outTotal : null; // 玉粗利
  return a;
}

// 1区分・1ヶ月の集計。plan/actual/landing(着地=実績優先, 無ければ計画)＋進捗・平均。
export function sectionMonth(section, year, month, maps) {
  const days = daysInMonth(year, month);
  const acc = {
    plan: { sales: 0, gross: 0, outTotal: 0 },
    actual: { sales: 0, gross: 0, outTotal: 0 },
    landing: { sales: 0, gross: 0 },
    planElapsed: { sales: 0, gross: 0 },
    actualDays: 0, sumCount: 0,
  };
  for (let d = 1; d <= days; d++) {
    const k = key(ymd(year, month, d), section.id);
    const count = maps.machines.get(k)?.count;
    const p = planCalc(maps.plan.get(k), count);
    acc.plan.sales += p.sales; acc.plan.gross += p.gross; acc.plan.outTotal += p.outTotal;
    const aRow = maps.actual.get(k);
    if (hasActual(aRow)) {
      const a = actualCalc(aRow, count);
      acc.actual.sales += a.sales; acc.actual.gross += a.gross; acc.actual.outTotal += a.outTotal;
      acc.landing.sales += a.sales; acc.landing.gross += a.gross;
      acc.planElapsed.sales += p.sales; acc.planElapsed.gross += p.gross;
      acc.actualDays++; acc.sumCount += count || 0;
    } else {
      acc.landing.sales += p.sales; acc.landing.gross += p.gross;
    }
  }
  return finalize(acc);
}

// 全区分＋合計。
export function monthAggregate(sections, year, month, maps) {
  const perSection = sections.map((s) => ({ section: s, ...sectionMonth(s, year, month, maps) }));
  const total = perSection.reduce((t, r) => {
    for (const g of ["plan", "actual", "landing", "planElapsed"]) for (const k of Object.keys(t[g])) t[g][k] += r[g][k];
    t.sumCount += r.sumCount; t.actualDays = Math.max(t.actualDays, r.actualDays);
    return t;
  }, { plan: { sales: 0, gross: 0, outTotal: 0 }, actual: { sales: 0, gross: 0, outTotal: 0 }, landing: { sales: 0, gross: 0 }, planElapsed: { sales: 0, gross: 0 }, actualDays: 0, sumCount: 0 });
  return { perSection, total: finalize(total) };
}

// 月の日次系列（全区分合算の 計画/実績 粗利・売上）。折れ線用。
export function monthDailySeries(sections, year, month, maps) {
  const days = daysInMonth(year, month);
  const out = [];
  for (let d = 1; d <= days; d++) {
    let pg = 0, ag = 0, hasA = false;
    for (const s of sections) {
      const k = key(ymd(year, month, d), s.id);
      const count = maps.machines.get(k)?.count;
      pg += planCalc(maps.plan.get(k), count).gross;
      const aRow = maps.actual.get(k);
      if (hasActual(aRow)) { ag += actualCalc(aRow, count).gross; hasA = true; }
    }
    out.push({ label: String(d), plan: pg, actual: hasA ? ag : null });
  }
  return out;
}

// 月の日次明細。区分ごと＋合計を、日単位で 計画/実績（アウト・売上・粗利）まで持つ。
// monthDailySeries はグラフ用に粗利だけを合算した薄い形なので、
// 表に出すぶんはここで作る。実績が無い日は actual を null にして、
// 0と「未入力」を取り違えないようにする（0を実績として描くと未入力日が谷に見える）。
//
// アウトは outTotal（総アウト）に加えて outAvg（台あたり平均）も持たせる。
// 総アウトは台数が変わると日ごとの比較にならないため、表には平均のほうを出す。
export function monthDailyDetail(sections, year, month, maps) {
  const days = daysInMonth(year, month);
  const rows = [];
  for (let d = 1; d <= days; d++) {
    const date = ymd(year, month, d);
    const bySection = new Map();
    const tp = { outTotal: 0, sales: 0, gross: 0 };
    const ta = { outTotal: 0, sales: 0, gross: 0 };
    let tCount = 0, tpCount = 0, taCount = 0, anyActual = false;

    for (const s of sections) {
      const k = key(date, s.id);
      const count = maps.machines.get(k)?.count;
      const p = planCalc(maps.plan.get(k), count);
      const aRow = maps.actual.get(k);
      const a = hasActual(aRow) ? actualCalc(aRow, count) : null;

      bySection.set(s.id, { count: count || 0, plan: withOutAvg(p, count), actual: a ? withOutAvg(a, count) : null });
      tp.outTotal += p.outTotal; tp.sales += p.sales; tp.gross += p.gross;
      tCount += count || 0;
      // 合計の平均は、その日に数字が入っている区分の台数だけで割る。全区分の台数で
      // 割ると、計画も実績も無い区分の台数まで分母に入って平均が沈む。
      if (p.outTotal) tpCount += count || 0;
      if (a) {
        anyActual = true;
        ta.outTotal += a.outTotal; ta.sales += a.sales; ta.gross += a.gross;
        taCount += count || 0;
      }
    }
    tp.outAvg = tpCount ? tp.outTotal / tpCount : null;
    ta.outAvg = taCount ? ta.outTotal / taCount : null;
    bySection.set("total", { count: tCount, planCount: tpCount, actualCount: taCount, plan: tp, actual: anyActual ? ta : null });
    rows.push({ day: d, date, bySection });
  }
  return rows;
}

// 台あたり平均アウト。台数が未入力の日は割れないので null（0にすると「アウト0の日」に見える）。
function withOutAvg(o, count) {
  o.outAvg = count ? o.outTotal / count : null;
  return o;
}

// 前年比較用に、今年の実績が入っている日にちだけを残した前年のマップを返す。
// 8月14日時点で「今年14日ぶん」と「昨年1ヶ月ぶん」を並べると、どんなに good な月でも
// 前年比マイナスに見える。達成率を planElapsed と比べるのと同じ理由で、日数をそろえる。
// 前年の同じ日が休業・未入力なら落ちるので、営業日数も一緒に見せること。
export function sameDaysMaps(curMaps, prevMaps) {
  const days = new Set();
  for (const [k, r] of curMaps.actual) if (hasActual(r)) days.add(k.slice(8, 10)); // "YYYY-MM-DD|section" の DD
  return { ...prevMaps, actual: new Map([...prevMaps.actual].filter(([k]) => days.has(k.slice(8, 10)))) };
}

// 年度の月別合計。前年度と月どうしで並べるために、月ごとの実績・計画と
// 「その月に実績が入っているか」を持つ（実績の無い月を0で埋めない）。
// alignMaps を渡すと、その年（＝今年度）に実績がある日にちだけを残して集計する。
// 前年度を出すときに使う。月単位でそろえるだけだと、進行中の月が「今年14日ぶん対
// 昨年1ヶ月ぶん」になって年度の前年比が沈む。
export function fyMonthlyTotals(sections, fy, monthMaps, alignMaps) {
  return fiscalMonths().map((m) => {
    const maps = monthMaps(m);
    const use = alignMaps ? sameDaysMaps(alignMaps(m), maps) : maps;
    const t = monthAggregate(sections, calendarYear(fy, m), m, use).total;
    return { month: m, plan: t.plan, actual: t.actual, actualDays: t.actualDays, sumCount: t.sumCount };
  });
}

// 実績のある月だけを足した合計。年度の途中で「今年5ヶ月ぶん」と「昨年度12ヶ月ぶん」を
// 比べると必ず大幅マイナスに見えるので、前年度は今年度と同じ月だけで足す。
export function sumMonths(rows, keep) {
  const acc = { actual: { sales: 0, gross: 0, outTotal: 0 }, actualDays: 0, sumCount: 0, months: 0 };
  rows.forEach((r, i) => {
    if (keep && !keep(i)) return;
    if (!r.actualDays) return;
    acc.actual.sales += r.actual.sales; acc.actual.gross += r.actual.gross; acc.actual.outTotal += r.actual.outTotal;
    acc.actualDays += r.actualDays; acc.sumCount += r.sumCount; acc.months++;
  });
  acc.avgOut = acc.sumCount ? acc.actual.outTotal / acc.sumCount : null;
  acc.grossRate = acc.actual.sales ? acc.actual.gross / acc.actual.sales : null;
  return acc;
}

// 会計年度集計。monthMaps(month)->maps を受け取り12ヶ月を合算＋月次系列。
export function fyAggregate(sections, fy, monthMaps) {
  const months = fiscalMonths();
  const zero = () => ({ plan: { sales: 0, gross: 0, outTotal: 0 }, actual: { sales: 0, gross: 0, outTotal: 0 }, landing: { sales: 0, gross: 0 } });
  const perMap = new Map(sections.map((s) => [s.id, { section: s, ...zero() }]));
  const total = zero();
  const series = [];
  for (const m of months) {
    const maps = monthMaps(m);
    const cy = calendarYear(fy, m);
    const agg = monthAggregate(sections, cy, m, maps);
    for (const r of agg.perSection) {
      const acc = perMap.get(r.section.id);
      for (const g of ["plan", "actual", "landing"]) for (const k of Object.keys(acc[g])) acc[g][k] += r[g][k];
    }
    for (const g of ["plan", "actual", "landing"]) for (const k of Object.keys(total[g])) total[g][k] += agg.total[g][k];
    // 実績のない月は null（0だとグラフが0まで落ちて未経過月が「大幅未達」に見える）
    series.push({ label: `${m}月`, plan: agg.total.plan.gross, actual: agg.total.actualDays ? agg.total.actual.gross : null });
  }
  const finish = (a) => { a.achieveGross = a.plan.gross ? a.actual.gross / a.plan.gross : null; a.achieveSales = a.plan.sales ? a.actual.sales / a.plan.sales : null; return a; };
  const perSection = [...perMap.values()].map(finish);
  finish(total);
  return { perSection, total, series };
}

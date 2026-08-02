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
    series.push({ label: `${m}月`, plan: agg.total.plan.gross, actual: agg.total.actual.gross });
  }
  const finish = (a) => { a.achieveGross = a.plan.gross ? a.actual.gross / a.plan.gross : null; a.achieveSales = a.plan.sales ? a.actual.sales / a.plan.sales : null; return a; };
  const perSection = [...perMap.values()].map(finish);
  finish(total);
  return { perSection, total, series };
}

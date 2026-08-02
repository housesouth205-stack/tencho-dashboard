import { FISCAL_START_MONTH } from "../core/config.js";

// 会計年度: 開始月(既定4月)〜翌年3月。日付が属する年度キーを返す。
export function fiscalYearOf(date) {
  const d = typeof date === "string" ? new Date(date) : date;
  const y = d.getFullYear();
  return d.getMonth() + 1 >= FISCAL_START_MONTH ? y : y - 1;
}

// 年度の実カレンダー月を並び順で返す（4月始まりなら 4..12,1..3）。
export function fiscalMonths() {
  const out = [];
  for (let i = 0; i < 12; i++) out.push(((FISCAL_START_MONTH - 1 + i) % 12) + 1);
  return out;
}

// 実カレンダー月(1-12)が属する暦年を年度から求める。
export function calendarYear(fy, month) {
  return month >= FISCAL_START_MONTH ? fy : fy + 1;
}

export function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

export function ymd(year, month, day) {
  const p = (n) => String(n).padStart(2, "0");
  return `${year}-${p(month)}-${p(day)}`;
}

export function todayFiscalYear() {
  return fiscalYearOf(new Date());
}

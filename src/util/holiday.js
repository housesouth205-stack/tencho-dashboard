// 日本の祝日判定（1980-2099目安・近似式）。振替休日対応。設定画面で上書き可（将来）。
const cache = new Map();

function equinox(year, spring) {
  const base = spring ? 20.8431 : 23.2488;
  return Math.floor(base + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}
function nthMonday(year, month, n) {
  const first = new Date(year, month - 1, 1).getDay();
  return 1 + ((8 - first) % 7) + (n - 1) * 7; // 第n月曜の日
}

function holidaysOf(year) {
  if (cache.has(year)) return cache.get(year);
  const h = new Map(); // 'MM-DD' -> name
  const p = (n) => String(n).padStart(2, "0");
  const add = (m, d, name) => h.set(`${p(m)}-${p(d)}`, name);
  add(1, 1, "元日");
  add(1, nthMonday(year, 1, 2), "成人の日");
  add(2, 11, "建国記念の日");
  add(2, 23, "天皇誕生日");
  add(3, equinox(year, true), "春分の日");
  add(4, 29, "昭和の日");
  add(5, 3, "憲法記念日");
  add(5, 4, "みどりの日");
  add(5, 5, "こどもの日");
  add(7, nthMonday(year, 7, 3), "海の日");
  add(8, 11, "山の日");
  add(9, nthMonday(year, 9, 3), "敬老の日");
  add(9, equinox(year, false), "秋分の日");
  add(10, nthMonday(year, 10, 2), "スポーツの日");
  add(11, 3, "文化の日");
  add(11, 23, "勤労感謝の日");

  // 振替休日: 日曜が祝日ならその後の最初の平日
  const set = new Set(h.keys());
  for (const key of [...h.keys()]) {
    const [m, d] = key.split("-").map(Number);
    if (new Date(year, m - 1, d).getDay() === 0) {
      let nd = new Date(year, m - 1, d + 1);
      while (set.has(`${p(nd.getMonth() + 1)}-${p(nd.getDate())}`)) nd.setDate(nd.getDate() + 1);
      h.set(`${p(nd.getMonth() + 1)}-${p(nd.getDate())}`, "振替休日");
    }
  }
  cache.set(year, h);
  return h;
}

// 種別: 'holiday' | 'sat' | 'sun' | 'weekday'
export function dayKind(year, month, day) {
  const name = holidaysOf(year).get(`${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  if (name) return "holiday";
  const w = new Date(year, month - 1, day).getDay();
  return w === 0 ? "sun" : w === 6 ? "sat" : "weekday";
}
export const holidayName = (y, m, d) =>
  holidaysOf(y).get(`${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`) || null;
// 一括入力の分類: 平日 / 土日祝
export const isWeekend = (kind) => kind === "sat" || kind === "sun" || kind === "holiday";

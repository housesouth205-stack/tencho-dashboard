// 新台入替の差分計算（旧PCアプリ pachi_diff.py の移植・純粋関数）。
// 2つの日次スナップショットを機種ID単位で突き合わせ、台単位で4区分に分ける：
//   新台      : 前回に無い新規モデルの台
//   レート移動: 同機種内で「あるレートの減少」と「別レートの増加」が重なった台数（min(増加計, 減少計)）
//   増台      : 移動で相殺されない純増分
//   撤去(減台): 移動で相殺されない純減分 ＋ まるごと消えた機種
// 1機種が複数区分にまたがりうる（例: 4パチ10→1パチ3 = 移動3台＋撤去7台）。

function agg(machines) {
  const out = {};
  for (const [k, m] of Object.entries(machines || {})) {
    const mid = k.split("|")[0];
    const e = out[mid] || (out[mid] = { name: m.name || "", type: m.type || "", total: 0, rates: {} });
    const c = m.count || 0;
    e.total += c;
    e.rates[m.rate || ""] = (e.rates[m.rate || ""] || 0) + c;
    e.name = m.name || e.name;
    e.type = m.type || e.type;
  }
  return out;
}

const rstr = (rates) => Object.keys(rates).join("・");

export function compute(cur, prev) {
  const curM = cur?.machines || {};
  const prevM = prev?.machines || {};
  const hasBaseline = Object.keys(prevM).length > 0;
  const curA = agg(curM), prevA = agg(prevM);
  const added = [], up = [], moved = [], removed = [];

  if (hasBaseline) {
    for (const [mid, c] of Object.entries(curA)) {
      const p = prevA[mid];
      if (!p) { added.push({ name: c.name, type: c.type, rate: rstr(c.rates), count: c.total }); continue; }
      const inc = {}, dec = {};
      for (const r of new Set([...Object.keys(c.rates), ...Object.keys(p.rates)])) {
        const d = (c.rates[r] || 0) - (p.rates[r] || 0);
        if (d > 0) inc[r] = d; else if (d < 0) dec[r] = -d;
      }
      const tinc = Object.values(inc).reduce((a, b) => a + b, 0);
      const tdec = Object.values(dec).reduce((a, b) => a + b, 0);
      const mv = Math.min(tinc, tdec), net = tinc - tdec;
      if (mv > 0) moved.push({ name: c.name, type: c.type, from_rate: Object.keys(dec).join("・") || "—", to_rate: Object.keys(inc).join("・") || "—", dai: mv });
      if (net > 0) up.push({ name: c.name, type: c.type, rate: Object.keys(inc).join("・"), dai: net });
      else if (net < 0) removed.push({ name: c.name, type: c.type, rate: Object.keys(dec).join("・"), dai: -net, full: false });
    }
    for (const [mid, p] of Object.entries(prevA)) {
      if (!curA[mid]) removed.push({ name: p.name, type: p.type, rate: rstr(p.rates), dai: p.total, full: true });
    }
  }
  added.sort((a, b) => b.count - a.count);
  for (const l of [up, removed, moved]) l.sort((a, b) => b.dai - a.dai);

  const sum = (l, k) => l.reduce((a, x) => a + (x[k] || 0), 0);
  const newDai = sum(added, "count"), upDai = sum(up, "dai"), rmDai = sum(removed, "dai"), mvDai = sum(moved, "dai");
  return {
    hasBaseline,
    summary: {
      new: added.length, up: up.length, moved: moved.length, removed: removed.length,
      new_dai: newDai, up_dai: upDai, removed_dai: rmDai, move_dai: mvDai,
      total: cur?.total || 0, prev_total: prev?.total || 0,
      net: newDai + upDai - rmDai,
    },
    new: added, up, moved, removed,
  };
}

const changed = (s) => s.new || s.up || s.moved || s.removed;

// 1店舗の履歴（連続する日付スナップショットの差分。変化のあった日だけ・新しい日付が先）
// snaps: その店舗のスナップショット（day昇順）
export function shopHistory(snaps) {
  const out = [];
  for (let i = 1; i < snaps.length; i++) {
    const c = compute(snaps[i], snaps[i - 1]);
    if (!changed(c.summary)) continue;
    out.push({ date: snaps[i].day, prev_date: snaps[i - 1].day, ...c });
  }
  return out.reverse();
}

// 全店舗の履歴を日付ごとに集約（新しい日付が先）。各項目に store / store_key を付ける。
// byShop: Map(shop_key -> snaps昇順), names: Map(shop_key -> 店舗名)
export function allHistory(byShop, names) {
  const days = new Map();
  const KEYS = ["new", "up", "moved", "removed", "new_dai", "up_dai", "move_dai", "removed_dai"];
  for (const [key, snaps] of byShop) {
    const store = names.get(key) || key;
    for (const e of shopHistory(snaps)) {
      const d = days.get(e.date) || { date: e.date, summary: Object.fromEntries(KEYS.map((k) => [k, 0])), stores: 0, new: [], up: [], moved: [], removed: [] };
      for (const k of KEYS) d.summary[k] += e.summary[k] || 0;
      d.stores++;
      for (const cat of ["new", "up", "moved", "removed"]) {
        for (const x of e[cat]) d[cat].push({ ...x, store, store_key: key });
      }
      days.set(e.date, d);
    }
  }
  return [...days.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}

// 比較基準（旧アプリと同じ）:
//   auto : 前回の自動更新の日（既定） / prev : 直近の別日 / week : 7日以上前で最新 / month : 30日以上前で最新
export const MODES = [["auto", "前回の自動更新から"], ["prev", "前回の記録から"], ["week", "1週間"], ["month", "1ヶ月"]];

export function baseline(snaps, mode) {
  if (snaps.length < 2) return null;
  const cur = snaps[snaps.length - 1];
  const older = snaps.slice(0, -1);
  if (mode === "auto") {
    const autos = older.filter((s) => s.source === "auto");
    return autos.length ? autos[autos.length - 1] : older[older.length - 1];
  }
  if (mode === "week" || mode === "month") {
    const days = mode === "week" ? 7 : 30;
    const lim = new Date(cur.day + "T00:00:00");
    lim.setDate(lim.getDate() - days);
    const ls = `${lim.getFullYear()}-${String(lim.getMonth() + 1).padStart(2, "0")}-${String(lim.getDate()).padStart(2, "0")}`;
    const o = older.filter((s) => s.day <= ls);
    return o.length ? o[o.length - 1] : older[0];
  }
  return older[older.length - 1];
}

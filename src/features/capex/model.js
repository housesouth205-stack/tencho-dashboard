// 増台計画（設備投資）のデータ。単価台帳・導入ラウンド・増台シナリオの3本立て。
//
// 専用テーブルを作らず app_setting のJSONBに置く。台番→区分の設定と同じ扱いで、
// マイグレーションを増やさずに項目を足せる（見積は毎回そろえ方が変わるので、
// 列を固定した表にすると次の見積でまた直すことになる）。
import { repo } from "../../core/repo.js";
import { STORE_ID } from "../../core/config.js";

const K_ITEMS = "capex_items";
const K_ROUNDS = "capex_rounds";
const K_GROWTH = "capex_growth";

export const KINDS = [
  { key: "unit", label: "ユニット" },
  { key: "box", label: "周辺機器" },
  { key: "work", label: "工事・作業費" },
  { key: "part", label: "部品" },
  { key: "other", label: "その他" },
];
export const kindLabel = (k) => KINDS.find((x) => x.key === k)?.label || "その他";

// 支払条件。lump=翌月一括 / split=初月に一部、残りを均等分割。
export const PAY_MODES = [
  { key: "lump", label: "一括" },
  { key: "split", label: "初回一部＋分割" },
];

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id" + Math.random().toString(36).slice(2));

/* ───────── 初期値 ─────────
   見積書と「202611 増台数と数値」から分かっている数字だけを種にする。
   推測した数字は入れない（空欄のまま店で埋めてもらう方が事故が少ない）。 */
function seedItems() {
  return [
    { id: uid(), name: "スマートユニット（MC本体差替）", kind: "unit", vendor: "光電子", qty: 13, unit: "台",
      amount: 3069000, quoteDate: "2026-11-01", pay: { mode: "split", lag: 1, firstRatio: 1 / 3, splitCount: 5 },
      note: "202611見積。初月1/3、残り5分割" },
    { id: uid(), name: "HC-BOX", kind: "box", vendor: "北電子", qty: 15, unit: "個",
      amount: 196900, quoteDate: "2026-11-01", pay: { mode: "lump", lag: 1 }, note: "202611見積。翌月一括" },
    { id: uid(), name: "HC-BOX", kind: "box", vendor: "北電子", qty: 15, unit: "個",
      amount: 293700, quoteDate: "2026-02-24", pay: { mode: "lump", lag: 1 }, note: "見積 IW-202602-73（前回）" },
    // 部品の単価。スマートユニット見積の内訳なので、工事回に足すと二重に数えてしまう。
    // 単価を並べて比べるためだけに置いてある（次の見積が来たら行を足す）。
    { id: uid(), name: "設定費 MDN-E", kind: "part", vendor: "光電子", qty: 1, unit: "式",
      amount: 35000, quoteDate: "2026-02-24", pay: { mode: "lump", lag: 1 }, note: "税抜。ユニット見積の内訳（工事回には入れない）" },
    { id: uid(), name: "通信テスト費", kind: "work", vendor: "光電子", qty: 1, unit: "式",
      amount: 120000, quoteDate: "2026-02-24", pay: { mode: "lump", lag: 1 }, note: "税抜。ユニット見積の内訳（工事回には入れない）" },
    { id: uid(), name: "運送費", kind: "work", vendor: "光電子", qty: 1, unit: "式",
      amount: 55000, quoteDate: "2026-02-24", pay: { mode: "lump", lag: 1 }, note: "税抜。ユニット見積の内訳（工事回には入れない）" },
    { id: uid(), name: "諸経費", kind: "other", vendor: "光電子", qty: 1, unit: "式",
      amount: 53000, quoteDate: "2026-02-24", pay: { mode: "lump", lag: 1 }, note: "税抜。ユニット見積の内訳（工事回には入れない）" },
    { id: uid(), name: "設置作業費（26台まとめ）", kind: "work", vendor: "—", qty: 26, unit: "台",
      amount: 586300, quoteDate: "2026-11-01", pay: { mode: "lump", lag: 1 }, note: "計画4年シートの備考。6ヶ月毎案で使う" },
    { id: uid(), name: "設置作業費（13台ずつ）", kind: "work", vendor: "—", qty: 13, unit: "台",
      amount: 436150, quoteDate: "2026-11-01", pay: { mode: "lump", lag: 1 }, note: "計画4年シートの備考。3ヶ月毎案で使う" },
  ];
}

function seedRounds(items) {
  const unit = items.find((i) => i.kind === "unit");
  const box = items.find((i) => i.kind === "box" && i.quoteDate >= "2026-11-01");
  return [{
    id: uid(), label: "1回目（20スロ 82〜94番台）", workDate: "2026-11-02", dai: 13, daiText: "82-94",
    lines: [unit && { itemId: unit.id, qty: 13 }, box && { itemId: box.id, qty: 15 }].filter(Boolean),
  }];
}

// 現状台数は「202611 増台数と数値」の値。増台後の設置比率はここから出す。
function seedGrowth() {
  return {
    base: { S20: { total: 144, smart: 81 }, S5: { total: 112, smart: 41 }, S2: { total: 48, smart: 16 } },
    scenarios: [
      { id: uid(), label: "3ヶ月毎", every: 3, start: "2026-11", per: { S20: 13, S5: 0, S2: 0 }, count: 16,
        workItemName: "設置作業費（13台ずつ）" },
      { id: uid(), label: "6ヶ月毎", every: 6, start: "2026-11", per: { S20: 13, S5: 13, S2: 0 }, count: 8,
        workItemName: "設置作業費（26台まとめ）" },
    ],
    activeId: null,
  };
}

/* ───────── 読み書き ───────── */
async function get(key, seed) {
  try {
    const row = (await repo.select("app_setting", { eq: { store_id: STORE_ID, key } }))[0];
    const v = row?.value;
    if (v && typeof v === "object" && (Array.isArray(v.list) ? v.list.length : Object.keys(v).length)) return v;
  } catch { /* 読めないときは種で立ち上げる（画面が真っ白になるより良い） */ }
  return seed;
}
const put = (key, value) =>
  repo.upsert("app_setting", { store_id: STORE_ID, key, value: { ...value, updated_at: new Date().toISOString() } },
    { onConflict: ["store_id", "key"] });

export async function loadPlan() {
  const it = await get(K_ITEMS, null);
  const items = it?.list || seedItems();
  const rd = await get(K_ROUNDS, null);
  const gr = await get(K_GROWTH, null);
  return {
    items,
    rounds: rd?.list || seedRounds(items),
    growth: gr?.base ? gr : seedGrowth(),
    seeded: { items: !it, rounds: !rd, growth: !gr },
  };
}
export const saveItems = (list) => put(K_ITEMS, { list });
export const saveRounds = (list) => put(K_ROUNDS, { list });
export const saveGrowth = (g) => put(K_GROWTH, g);
export const newId = uid;

/* ───────── 計算 ───────── */
export const unitPriceOf = (it) => (it && it.qty ? it.amount / it.qty : null);

// "2026-11" + n ヶ月
export function addMonth(ym, n) {
  const [y, m] = String(ym).slice(0, 7).split("-").map(Number);
  const t = (y * 12 + (m - 1)) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
export const ymOf = (ymd) => String(ymd || "").slice(0, 7);
export const ymLabel = (ym) => `${ym.slice(0, 4)}/${ym.slice(5, 7)}`;

// 1明細の支払いを月別に割り振る。端数は最終月に寄せる（合計が必ず金額に一致する）。
export function scheduleOfLine(amount, pay, workYm) {
  const out = [];
  const lag = Number(pay?.lag ?? 1);
  const base = addMonth(workYm, lag);
  if (!amount) return out;
  if (pay?.mode !== "split") { out.push({ ym: base, amount: Math.round(amount) }); return out; }
  const first = Math.round(amount * Number(pay.firstRatio || 0));
  const n = Math.max(1, Number(pay.splitCount || 1));
  const each = Math.floor((amount - first) / n);
  out.push({ ym: base, amount: first });
  for (let i = 1; i <= n; i++) out.push({ ym: addMonth(base, i), amount: i === n ? amount - first - each * (n - 1) : each });
  return out;
}

// 全ラウンド → 月別の支払予定。rows は月順、内訳は品目ごとに持つ。
export function paymentSchedule(rounds, items) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const months = new Map(); // ym -> { total, byItem: Map(name -> amount) }
  for (const r of rounds || []) {
    const workYm = ymOf(r.workDate);
    if (!workYm) continue;
    for (const ln of r.lines || []) {
      const it = byId.get(ln.itemId);
      if (!it) continue;
      const qty = ln.qty ?? it.qty;
      // 数量を変えたら金額も比例させる。単価×数量で持ち直すより、見積の総額を
      // 崩さずに済む（見積は「13台でいくら」という書かれ方をしている）。
      const amount = it.qty ? (it.amount / it.qty) * qty : it.amount;
      for (const p of scheduleOfLine(amount, it.pay, workYm)) {
        const cell = months.get(p.ym) || { ym: p.ym, total: 0, byItem: new Map() };
        cell.total += p.amount;
        cell.byItem.set(it.name, (cell.byItem.get(it.name) || 0) + p.amount);
        months.set(p.ym, cell);
      }
    }
  }
  const keys = [...months.keys()].sort();
  if (!keys.length) return { rows: [], total: 0 };
  // 支払いの無い月も行として出す。飛ばすと「この月は0円」が見えない
  const rows = [];
  for (let ym = keys[0]; ym <= keys[keys.length - 1]; ym = addMonth(ym, 1)) {
    rows.push(months.get(ym) || { ym, total: 0, byItem: new Map() });
  }
  let cum = 0;
  for (const r of rows) { cum += r.total; r.cum = cum; }
  return { rows, total: cum };
}

/* ───────── 増台シナリオ ───────── */
export const SECS = [
  { key: "S20", label: "20スロ" },
  { key: "S5", label: "5スロ" },
  { key: "S2", label: "2スロ" },
];

// シナリオ → 各回の増台と、区分ごとの設置比率の推移。
// 総台数を超えて増やさない（比率が100%を超えると計画として読めない）。
export function projectGrowth(base, sc) {
  const cur = {};
  for (const s of SECS) cur[s.key] = base?.[s.key]?.smart || 0;
  const rows = [];
  for (let i = 0; i < (sc.count || 0); i++) {
    const ym = addMonth(sc.start, i * (sc.every || 3));
    const add = {}, after = {}, rate = {};
    let sum = 0;
    for (const s of SECS) {
      const total = base?.[s.key]?.total || 0;
      // 回ごとに台数を変えたいことがある（1回目は20スロだけ、途中から5スロも など）。
      // 個別指定があればそれを使い、無ければ「毎回いくつ」の既定値。
      const want = Number(sc.overrides?.[ym]?.[s.key] ?? sc.per?.[s.key] ?? 0);
      const a = Math.max(0, Math.min(want, total - cur[s.key]));
      cur[s.key] += a;
      add[s.key] = a; after[s.key] = cur[s.key];
      rate[s.key] = total ? cur[s.key] / total : null;
      sum += a;
    }
    if (!sum) break; // 全区分が上限に達したら、増えない回は出さない（完了月がぼやける）
    rows.push({ ym, add, after, rate, sum });
  }
  const totalAll = SECS.reduce((n, s) => n + (base?.[s.key]?.total || 0), 0);
  const smartAll = SECS.reduce((n, s) => n + cur[s.key], 0);
  return { rows, added: rows.reduce((n, r) => n + r.sum, 0), finalRate: totalAll ? smartAll / totalAll : null };
}

// シナリオから導入ラウンドを組み立てる（支払予定はこのラウンドから出る）。
export function roundsFromScenario(sc, base, items) {
  const { rows } = projectGrowth(base, sc);
  const unit = items.find((i) => i.kind === "unit");
  const box = items.find((i) => i.kind === "box");
  // 工事費は名前で指定する。見つからないときに kind:"work" の先頭を拾うと、
  // 見積の内訳（通信テスト費など）を工事費として台数ぶん掛けてしまう。指定が無ければ入れない。
  const work = sc.workItemName ? items.find((i) => i.name === sc.workItemName) : null;
  return rows.filter((r) => r.sum).map((r, i) => ({
    id: uid(), label: `${i + 1}回目`, workDate: r.ym + "-01", dai: r.sum,
    lines: [
      unit && { itemId: unit.id, qty: r.sum },
      // HC-BOXは台数ぶん。見積は15個/13台と予備を含むので、同じ比率で増やす
      box && { itemId: box.id, qty: Math.round(r.sum * (box.qty / (unit?.qty || box.qty))) },
      work && { itemId: work.id, qty: r.sum },
    ].filter(Boolean),
  }));
}

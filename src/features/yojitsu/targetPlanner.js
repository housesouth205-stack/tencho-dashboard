import { el, modal } from "../../util/dom.js";
import { repo } from "../../core/repo.js";
import { state } from "../../core/state.js";
import { toast, errorToast, setSaveState } from "../../core/errors.js";
import { yen, pct } from "../../util/format.js";
import { calendarYear, daysInMonth, ymd } from "../../util/dates.js";
import { dayKind, isWeekend } from "../../util/holiday.js";

const round4 = (v) => Math.round(v * 10000) / 10000;
const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);

// 前月実績（不足時は全期間実績）から、平日/土日祝の平均アウト・コイン単価・台数を推定し、
// 対象月の日別予想売上（アウト×台数×コイン単価）を組み立てる。
export async function sectionStats({ fy, month, section }) {
  const cy = calendarYear(fy, month);
  let pm = month - 1, py = cy;
  if (pm < 1) { pm = 12; py -= 1; }
  const pPrefix = `${py}-${String(pm).padStart(2, "0")}`;
  const mPrefix = `${cy}-${String(month).padStart(2, "0")}`;

  const actualsAll = (await repo.select("actual_day", { eq: { store_id: state.storeId, section_id: section.id } })).filter((r) => r.out_per_unit != null);
  const machines = await repo.select("machines_day", { eq: { store_id: state.storeId, section_id: section.id } });
  const countByYmd = new Map(machines.map((m) => [m.ymd, m.count]));

  // 前月の実績を優先（4日以上あれば採用）。無ければ全期間で代用。
  const prev = actualsAll.filter((a) => String(a.ymd).startsWith(pPrefix));
  const base = prev.length >= 4 ? prev : actualsAll;
  const src = prev.length >= 4 ? `前月(${pm}月)実績` : "全期間実績";

  const outWk = [], outWe = [], priceS = [];
  for (const a of base) {
    const dt = new Date(a.ymd);
    const kind = dayKind(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
    (isWeekend(kind) ? outWe : outWk).push(a.out_per_unit);
    const cnt = countByYmd.get(a.ymd);
    if (a.sales != null && cnt) priceS.push(a.sales / (a.out_per_unit * cnt));
  }
  const allOut = [...outWk, ...outWe];
  const outWeekday = avg(outWk) ?? avg(allOut);
  const outWeekend = avg(outWe) ?? avg(allOut);
  const price = avg(priceS);
  if (outWeekday == null || price == null) return { ok: false, warning: `${section.label}: 実績が不足（アウト/単価を予想できません）` };

  const monthCounts = machines.filter((m) => String(m.ymd).startsWith(mPrefix));
  const monthCountByDay = new Map(monthCounts.map((m) => [Number(String(m.ymd).slice(8, 10)), m.count]));
  const fallbackCount = monthCounts.length ? Math.round(avg(monthCounts.map((m) => m.count)))
    : machines.length ? Math.round(avg(machines.map((m) => m.count))) : null;
  if (fallbackCount == null) return { ok: false, warning: `${section.label}: 台数データがありません` };

  const days = daysInMonth(cy, month);
  const rows = [];
  let totalSales = 0, wkDays = 0, weDays = 0;
  for (let d = 1; d <= days; d++) {
    const we = isWeekend(dayKind(cy, month, d));
    we ? weDays++ : wkDays++;
    const out = we ? outWeekend : outWeekday;
    const count = monthCountByDay.get(d) ?? fallbackCount;
    totalSales += out * count * price;
    rows.push({ d, out, count });
  }
  if (!totalSales) return { ok: false, warning: `${section.label}: 売上予想が0です` };
  return { ok: true, cy, outWeekday, outWeekend, price, src, rows, totalSales, monthCountByDay, wkDays, weDays };
}

// 目標粗利から、前月実績のアウト(平日/土日祝)・コイン単価で日別計画を自動生成し、
// 利益率を一律調整して月間計画粗利=目標粗利にそろえる。
export async function generatePlanFromTarget({ fy, month, section, targetGross, stats }) {
  const st = stats || await sectionStats({ fy, month, section });
  if (!st.ok) return st;
  const { cy, rows, totalSales, price, monthCountByDay } = st;
  const rate = targetGross / totalSales;

  const C = ["store_id", "ymd", "section_id"];
  const plans = [], machinesUp = [];
  for (const r of rows) {
    const yy = ymd(cy, month, r.d);
    plans.push({ store_id: state.storeId, ymd: yy, section_id: section.id, out_per_unit: Math.round(r.out), unit_price: round4(price), gross_rate: round4(rate) });
    if (!monthCountByDay.has(r.d)) machinesUp.push({ store_id: state.storeId, ymd: yy, section_id: section.id, count: r.count });
  }
  for (let i = 0; i < plans.length; i += 200) await repo.upsert("plan_day", plans.slice(i, i + 200), { onConflict: C });
  for (let i = 0; i < machinesUp.length; i += 200) await repo.upsert("machines_day", machinesUp.slice(i, i + 200), { onConflict: C });
  await repo.upsert("budget_month", { store_id: state.storeId, fy, month, section_id: section.id, gross: targetGross, sales: Math.round(totalSales) }, { onConflict: ["store_id", "fy", "month", "section_id"] });
  return { ok: true, outWeekday: st.outWeekday, outWeekend: st.outWeekend, price, rate, totalSales };
}

// 目標粗利入力モーダル。入力に応じて予想売上・粗利率・合計をライブ表示。
export async function openTargetPlanner({ fy, month, sections, onDone }) {
  const existing = new Map((await repo.select("budget_month", { eq: { store_id: state.storeId, fy, month } })).map((r) => [r.section_id, r]));
  // 各区分の予想（前月実績ベース）を先に計算
  const statsMap = new Map();
  await Promise.all(sections.map(async (s) => statsMap.set(s.id, await sectionStats({ fy, month, section: s }))));

  const GREEN = "#2fb888", BLUE = "#4f8ff7";
  const inputs = new Map();
  const rateCells = new Map();
  const t = el("table", { class: "grid mono" });
  t.appendChild(el("thead", {}, el("tr", {}, ["区分", "目標粗利（月）", "予想売上", "粗利率", "根拠（平日/土日祝アウト・コイン単価）"].map((h, i) =>
    el("th", { class: i === 0 || i === 4 ? "txt" : "", text: h })))));
  const tb = el("tbody");
  const totalCells = { gross: el("td", { style: `font-weight:700;color:${GREEN}` }), sales: el("td", { style: `font-weight:700;color:${BLUE}` }), rate: el("td", { style: "font-weight:700" }) };

  const recalc = () => {
    let g = 0, sales = 0;
    for (const s of sections) {
      const st = statsMap.get(s.id);
      const v = Number(inputs.get(s.id).value) || 0;
      const cell = rateCells.get(s.id);
      if (st.ok) {
        sales += st.totalSales;
        cell.textContent = v > 0 ? pct(v / st.totalSales) : "—";
      }
      g += v;
    }
    totalCells.gross.textContent = yen(g);
    totalCells.sales.textContent = yen(sales);
    totalCells.rate.textContent = sales ? pct(g / sales) : "—";
  };

  for (const s of sections) {
    const st = statsMap.get(s.id);
    const inp = el("input", { type: "number", step: "any", value: existing.get(s.id)?.gross ?? "", style: "width:150px;text-align:right", oninput: recalc });
    inputs.set(s.id, inp);
    const rateCell = el("td", { text: "—" });
    rateCells.set(s.id, rateCell);
    tb.appendChild(el("tr", {}, [
      el("td", { class: "txt" }, el("span", { class: "badge " + s.ptype.toLowerCase(), text: s.label })),
      el("td", {}, inp),
      el("td", { style: `color:${BLUE}`, text: st.ok ? yen(st.totalSales) : "—" }),
      rateCell,
      el("td", { class: "txt hint", text: st.ok
        ? `${Math.round(st.outWeekday)} / ${Math.round(st.outWeekend)}・単価${st.price.toFixed(2)}円（${st.src}、平日${st.wkDays}日+土日祝${st.weDays}日）`
        : "⚠ " + st.warning }),
    ]));
  }
  tb.appendChild(el("tr", { style: "background:var(--panel-2)" }, [
    el("td", { class: "txt", style: "font-weight:700", text: "合計" }),
    totalCells.gross, totalCells.sales, totalCells.rate, el("td", {}),
  ]));
  t.appendChild(tb);
  recalc();

  const body = el("div", { class: "col" }, [
    el("p", { class: "hint", text: `${fy}年度 ${month}月：各レートの目標粗利を入れると、前月実績から平日/土日祝の平均アウトとコイン単価を予想して予想売上・粗利率を表示します。「計画を自動生成」で利益率を調整し、月間計画粗利＝目標額になるよう日別計画を自動入力します。` }),
    el("div", { class: "table-wrap" }, t),
  ]);
  const gen = el("button", {
    class: "btn primary", text: "計画を自動生成（日別に入力）",
    onclick: async () => {
      gen.disabled = true; gen.textContent = "生成中…"; setSaveState("saving");
      try {
        const msgs = [];
        for (const s of sections) {
          const v = inputs.get(s.id).value;
          if (v === "" || Number(v) <= 0) continue;
          const res = await generatePlanFromTarget({ fy, month, section: s, targetGross: Number(v), stats: statsMap.get(s.id) });
          if (res.ok) msgs.push(`${s.label}: 平日ｱｳﾄ${Math.round(res.outWeekday)}/土日祝${Math.round(res.outWeekend)}・単価${res.price.toFixed(2)}・粗利率${(res.rate * 100).toFixed(1)}%`);
          else msgs.push("⚠ " + res.warning);
        }
        setSaveState("saved");
        toast("計画を生成しました", "ok");
        close(); onDone?.(msgs);
        // alertはブラウザによってはタブを固まらせるため、非ブロッキングのモーダルで結果表示
        if (msgs.length) modal("計画を生成しました", el("div", { class: "col", style: "gap:4px" },
          msgs.map((m) => el("div", { class: "hint mono", text: m }))), null);
      } catch (e) { errorToast(e); gen.disabled = false; gen.textContent = "計画を自動生成（日別に入力）"; }
    },
  });
  const close = modal("目標粗利から計画を自動生成", body, el("div", { class: "row", style: "justify-content:flex-end;margin-top:12px" }, gen));
  const modalEl = body.closest(".modal");
  if (modalEl) modalEl.style.maxWidth = "min(860px, 96vw)";
}

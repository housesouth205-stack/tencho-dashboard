import { el, modal } from "../../util/dom.js";
import { repo } from "../../core/repo.js";
import { state } from "../../core/state.js";
import { toast, errorToast, setSaveState } from "../../core/errors.js";
import { yen, num } from "../../util/format.js";
import { parseMonthlyPlan } from "../../import/monthlyPlanXlsx.js";
import { planCalc } from "../../calc/planCalc.js";

const CONFLICT = ["store_id", "ymd", "section_id"];

// 「月計画表を取込」ファイル選択→解析→プレビュー→確定upsert。
export function pickMonthlyPlan({ fy, sections, onDone }) {
  const input = el("input", { type: "file", accept: ".xlsx,.xls", style: "display:none" });
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const { rows, warnings } = await parseMonthlyPlan(buf, { fy, sections });
      showPreview(file.name, rows, warnings, onDone);
    } catch (e) { errorToast(e); }
  });
  document.body.appendChild(input);
  input.click();
  setTimeout(() => input.remove(), 0);
}

function showPreview(filename, rows, warnings, onDone) {
  const body = el("div", { class: "col" });
  body.appendChild(el("p", { class: "hint", text: `${filename} — 解析結果 ${rows.length} 行` }));

  for (const w of warnings) body.appendChild(el("div", { class: "card", style: "border-left:3px solid var(--warn)", text: "⚠ " + w }));

  // 区分別サマリー（計画・実績の合計。既知値と照合できる）
  const byKey = new Map();
  for (const r of rows) {
    const g = byKey.get(r.sectionKey) || { label: r.sectionLabel, days: 0, pSales: 0, pGross: 0, aSales: 0, aGross: 0 };
    g.days++;
    const pc = planCalc({ out_per_unit: r.planOut, unit_price: r.planPrice, gross_rate: r.planRate }, r.count);
    g.pSales += pc.sales; g.pGross += pc.gross;
    g.aSales += r.actSales || 0; g.aGross += r.actGross || 0;
    byKey.set(r.sectionKey, g);
  }
  const t = el("table", { class: "grid mono" });
  t.appendChild(el("thead", {}, el("tr", {}, ["区分", "日数", "計画売上", "計画粗利", "実績売上", "実績粗利"].map((h, i) =>
    el("th", { class: i === 0 ? "txt" : "", text: h })))));
  const tb = el("tbody");
  const tot = { pSales: 0, pGross: 0, aSales: 0, aGross: 0 };
  for (const [, g] of byKey) {
    for (const k of Object.keys(tot)) tot[k] += g[k];
    tb.appendChild(el("tr", {}, [
      el("td", { class: "txt", text: g.label }), el("td", { text: num(g.days) }),
      el("td", { text: yen(g.pSales) }), el("td", { text: yen(g.pGross) }),
      el("td", { text: yen(g.aSales) }), el("td", { text: yen(g.aGross) }),
    ]));
  }
  tb.appendChild(el("tr", { style: "font-weight:700" }, [
    el("td", { class: "txt", text: "合計" }), el("td", { text: "" }),
    el("td", { text: yen(tot.pSales) }), el("td", { text: yen(tot.pGross) }),
    el("td", { text: yen(tot.aSales) }), el("td", { text: yen(tot.aGross) }),
  ]));
  t.appendChild(tb);
  body.appendChild(el("div", { style: "overflow-x:auto" }, t));

  body.appendChild(el("p", { class: "hint", text: "計画（アウト/単価/粗利率）と実績（売上/粗利/アウト）を日別で取込みます。既存の同日・同区分は上書きされます。" }));

  const commit = el("button", {
    class: "btn primary", text: `取込を確定（${rows.length}行）`,
    onclick: async () => {
      commit.disabled = true; commit.textContent = "取込中…";
      try { await doImport(rows); toast(`${rows.length}行を取込みました`, "ok"); close(); onDone?.(); }
      catch (e) { errorToast(e); commit.disabled = false; commit.textContent = "取込を確定"; }
    },
  });
  const footer = el("div", { class: "row", style: "justify-content:flex-end;margin-top:12px" }, [
    el("button", { class: "btn ghost", text: "キャンセル", onclick: () => close() }), commit,
  ]);
  const close = modal("月計画表の取込プレビュー", body, footer);
}

async function doImport(rows) {
  setSaveState("saving");
  // 念のため (ymd, section) で重複排除（後勝ち）＝ upsertのバッチ内二重更新を防ぐ
  const uniq = new Map();
  for (const r of rows) uniq.set(r.ymd + "|" + r.sectionId, r);
  rows = [...uniq.values()];
  const machines = [], plans = [], actuals = [];
  for (const r of rows) {
    const base = { store_id: state.storeId, ymd: r.ymd, section_id: r.sectionId };
    if (r.count != null) machines.push({ ...base, count: r.count });
    if (r.hasPlan) plans.push({ ...base, out_per_unit: r.planOut, unit_price: r.planPrice, gross_rate: r.planRate });
    if (r.hasActual) actuals.push({ ...base, sales: r.actSales, gross: r.actGross, out_per_unit: r.actOut, source: "excel" });
  }
  const upsert = async (table, arr) => {
    for (let i = 0; i < arr.length; i += 200) await repo.upsert(table, arr.slice(i, i + 200), { onConflict: CONFLICT });
  };
  await upsert("machines_day", machines);
  await upsert("plan_day", plans);
  await upsert("actual_day", actuals);
  setSaveState("saved");
}

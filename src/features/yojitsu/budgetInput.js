import { el, modal } from "../../util/dom.js";
import { repo } from "../../core/repo.js";
import { state } from "../../core/state.js";
import { toast, errorToast, setSaveState } from "../../core/errors.js";

// 年間/月間目標(予算)の直接入力。budget_year / budget_month。
export async function openBudgetInput({ mode, fy, month, sections, onDone }) {
  const isYear = mode === "year";
  const table = isYear ? "budget_year" : "budget_month";
  const conflict = isYear ? ["store_id", "fy", "section_id"] : ["store_id", "fy", "month", "section_id"];
  const eq = isYear ? { store_id: state.storeId, fy } : { store_id: state.storeId, fy, month };
  const existing = new Map((await repo.select(table, { eq })).map((r) => [r.section_id, r]));

  const inputs = new Map();
  const t = el("table", { class: "grid" });
  t.appendChild(el("thead", {}, el("tr", {}, ["区分", "目標売上", "目標粗利"].map((h, i) =>
    el("th", { class: i === 0 ? "txt" : "", text: h })))));
  const tb = el("tbody");
  for (const sc of sections) {
    const cur = existing.get(sc.id) || {};
    const salesInp = el("input", { type: "number", step: "any", value: cur.sales ?? "", style: "width:130px;text-align:right" });
    const grossInp = el("input", { type: "number", step: "any", value: cur.gross ?? "", style: "width:130px;text-align:right" });
    inputs.set(sc.id, { salesInp, grossInp });
    tb.appendChild(el("tr", {}, [
      el("td", { class: "txt" }, el("span", { class: "badge " + sc.ptype.toLowerCase(), text: sc.label })),
      el("td", {}, salesInp), el("td", {}, grossInp),
    ]));
  }
  t.appendChild(tb);

  const body = el("div", { class: "col" }, [
    el("p", { class: "hint", text: isYear ? `${fy}年度の年間目標` : `${fy}年度 ${month}月の月間目標` }),
    t,
    el("p", { class: "hint", text: "空欄は未設定。実績との対比（対目標達成率）に使われます。" }),
  ]);
  const save = el("button", {
    class: "btn primary", text: "保存",
    onclick: async () => {
      try {
        setSaveState("saving");
        const rows = [];
        for (const sc of sections) {
          const { salesInp, grossInp } = inputs.get(sc.id);
          const rec = { ...eq, section_id: sc.id, sales: salesInp.value === "" ? null : Number(salesInp.value), gross: grossInp.value === "" ? null : Number(grossInp.value) };
          rows.push(rec);
        }
        await repo.upsert(table, rows, { onConflict: conflict });
        setSaveState("saved"); toast("目標を保存しました", "ok"); close(); onDone?.();
      } catch (e) { errorToast(e); }
    },
  });
  const close = modal(isYear ? "年間目標の入力" : "月間目標の入力", body,
    el("div", { class: "row", style: "justify-content:flex-end;margin-top:12px" }, save));
}

// 目標合計（対目標達成率用）。無ければnull。
export async function loadBudgetTotals({ mode, fy, month }) {
  const isYear = mode === "year";
  const eq = isYear ? { store_id: state.storeId, fy } : { store_id: state.storeId, fy, month };
  const rows = await repo.select(isYear ? "budget_year" : "budget_month", { eq });
  if (!rows.length) return null;
  return rows.reduce((t, r) => ({ sales: t.sales + (r.sales || 0), gross: t.gross + (r.gross || 0) }), { sales: 0, gross: 0 });
}

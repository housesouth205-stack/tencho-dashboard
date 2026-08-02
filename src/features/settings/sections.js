import { el, clear } from "../../util/dom.js";
import { repo } from "../../core/repo.js";
import { state, loadSections } from "../../core/state.js";
import { setSaveState, toast, errorToast } from "../../core/errors.js";

// 区分(レート)エディタ。追加/名称/種別S,P/貸単価/並び順/無効化。
export async function renderSectionEditor(host) {
  clear(host);
  await loadSections();

  const table = el("table", { class: "grid" });
  const body = el("tbody");
  table.appendChild(el("thead", {}, el("tr", {}, [
    el("th", { class: "txt", text: "キー" }),
    el("th", { class: "txt", text: "表示名" }),
    el("th", { text: "種別" }),
    el("th", { text: "貸単価" }),
    el("th", { text: "並び順" }),
    el("th", { text: "" }),
  ])));
  table.appendChild(body);

  const draw = () => {
    clear(body);
    for (const s of state.sections) body.appendChild(rowFor(s, redraw));
  };
  const redraw = async () => { await loadSections(); draw(); };
  draw();

  const addBtn = el("button", { class: "btn primary", text: "＋ 区分を追加", onclick: () => addRow(redraw) });

  host.appendChild(el("div", { class: "col" }, [
    el("p", { class: "hint", text: "計画/実績はこの区分ごとに入力します。パチンコ(P)はスタート・ベースを持ちます。" }),
    table,
    el("div", {}, addBtn),
  ]));
}

function rowFor(s, redraw) {
  const save = async (patch) => {
    try {
      setSaveState("saving");
      await repo.upsert("section_def", { ...s, ...patch }, { onConflict: ["store_id", "key"] });
      setSaveState("saved");
      await redraw();
    } catch (e) { errorToast(e); }
  };
  const keyCell = el("td", { class: "txt", text: s.key });
  const nameInp = el("input", { type: "text", value: s.label, onchange: (e) => save({ label: e.target.value }) });
  const typeSel = el("select", { class: "inp", onchange: (e) => save({ ptype: e.target.value }) }, [
    el("option", { value: "S", text: "スロット(S)", selected: s.ptype === "S" ? "selected" : null }),
    el("option", { value: "P", text: "パチンコ(P)", selected: s.ptype === "P" ? "selected" : null }),
  ]);
  const rateInp = el("input", { type: "number", step: "0.01", value: s.rate, onchange: (e) => save({ rate: Number(e.target.value) }) });
  const orderInp = el("input", { type: "number", step: "1", value: s.sort_order, onchange: (e) => save({ sort_order: Number(e.target.value) }) });
  const del = el("button", {
    class: "btn danger sm", text: "無効化",
    onclick: async () => {
      if (!confirm(`区分「${s.label}」を無効化しますか？（過去データは残ります）`)) return;
      await repo.upsert("section_def", { ...s, is_active: false }, { onConflict: ["store_id", "key"] });
      toast("無効化しました");
      await redraw();
    },
  });
  return el("tr", {}, [
    keyCell,
    el("td", { class: "txt" }, nameInp),
    el("td", {}, typeSel),
    el("td", {}, rateInp),
    el("td", {}, orderInp),
    el("td", {}, del),
  ]);
}

function addRow(redraw) {
  const key = (prompt("区分キー（英数字・例 S10 / P4）") || "").trim().toUpperCase();
  if (!key) return;
  if (state.sections.some((s) => s.key === key)) { toast("同じキーが既にあります", "err"); return; }
  const rec = {
    store_id: state.storeId, key, label: key, ptype: "S", rate: 20,
    sort_order: (state.sections.at(-1)?.sort_order || 0) + 1, is_active: true,
  };
  repo.upsert("section_def", rec, { onConflict: ["store_id", "key"] })
    .then(redraw).catch(errorToast);
}

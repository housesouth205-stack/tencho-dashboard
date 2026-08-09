// 島図Excelの取込と入替履歴。もとは島図タブにあったが、島図の閲覧を
// 設定投入シミュレーターへ統合したため、取込まわりは取込タブへ移した。
import { el, modal } from "../../util/dom.js";
import { repo } from "../../core/repo.js";
import { state } from "../../core/state.js";
import { toast, errorToast, setSaveState } from "../../core/errors.js";
import { num } from "../../util/format.js";
import { localYmd } from "../../util/dates.js";
import { parseIslandXlsx } from "../../import/islandXlsx.js";

const loadMeta = async () =>
  (await repo.select("app_setting", { eq: { store_id: state.storeId, key: "island_meta" } }))[0]?.value || {};

// 取込前に「いつからの島図か」を聞く。既定は今日。
function askEffectiveFrom(fileName) {
  return new Promise((resolve) => {
    const inp = el("input", { type: "date", value: localYmd(), style: "width:170px;font-size:15px;padding:6px" });
    const ok = el("button", { class: "btn primary", text: "この日付で取込む", onclick: () => { const v = inp.value; close(); resolve(v || null); } });
    const cancel = el("button", { class: "btn ghost", text: "やめる", onclick: () => { close(); resolve(null); } });
    const close = modal("島図の適用開始日", el("div", { class: "col", style: "gap:10px" }, [
      el("p", { class: "hint", style: "margin:0", text: `取込むファイル: ${fileName}` }),
      el("p", { style: "margin:0" }, [el("b", { text: "この島図はいつからの配置ですか？" })]),
      el("div", {}, [el("label", { class: "lbl", text: "適用開始日（入替日）" }), inp]),
      el("p", { class: "hint", style: "margin:0;font-size:11.5px", text: "記録した日付は入替履歴として残ります。" }),
    ]), el("div", { class: "row", style: "justify-content:flex-end;gap:8px;margin-top:12px" }, [cancel, ok]));
    setTimeout(() => inp.focus(), 50);
  });
}

// 入替履歴（いつからの島図か）を一覧表示
export async function showIslandHistory() {
  const meta = await loadMeta();
  const rows = [...(meta.history || [])].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  const t = el("table", { class: "grid mono" });
  t.appendChild(el("thead", {}, el("tr", {}, ["適用開始日", "台数", "1F", "BF", "取込日時", ""].map((h, i) =>
    el("th", { class: i === 0 ? "txt" : "", text: h })))));
  const tb = el("tbody");
  rows.forEach((h, i) => tb.appendChild(el("tr", { style: i === 0 ? "font-weight:700" : "" }, [
    el("td", { class: "txt", text: h.effectiveFrom || "—" }),
    el("td", { text: num(h.total ?? 0) }), el("td", { text: num(h.f1 ?? 0) }), el("td", { text: num(h.bf ?? 0) }),
    el("td", { text: (h.importedAt || "").slice(0, 16).replace("T", " ") }),
    el("td", { style: "color:var(--fg-dim)", text: i === 0 ? "現在" : "" }),
  ])));
  t.appendChild(tb);
  modal("島図の入替履歴", el("div", { class: "col" }, [
    el("p", { class: "hint", style: "margin:0", text: rows.length
      ? "取込のたびに記録されます。使われるのは最新（先頭行）の島図です。"
      : "まだ島図Excelを取り込んでいません。" }),
    el("div", { style: "overflow:auto;max-height:60vh" }, t),
  ]), null);
}

// 島図Excelを取り込んで配置・設備・機種名を入れ替える。
export async function importIslandXlsx(file, onDone) {
  if (!file) return;
  const meta = await loadMeta();
  const effectiveFrom = await askEffectiveFrom(file.name);
  if (!effectiveFrom) return; // キャンセル
  try {
    setSaveState("saving");
    const { layout: lay, fixtures: fx, models: mdl, warnings, counts } = await parseIslandXlsx(await file.arrayBuffer());
    await repo.remove("layout_cell", { store_id: state.storeId });
    await repo.remove("fixture", { store_id: state.storeId });
    const lc = lay.map((l) => ({ store_id: state.storeId, dai_no: l.dai_no, floor: l.floor, grid_row: l.grid_row, grid_col: l.grid_col }));
    for (let i = 0; i < lc.length; i += 200) await repo.upsert("layout_cell", lc.slice(i, i + 200), { onConflict: ["store_id", "dai_no"] });
    const frows = fx.map((f) => ({ store_id: state.storeId, ...f }));
    if (frows.length) await repo.upsert("fixture", frows, { onConflict: ["id"] });
    await repo.upsert("app_setting", { store_id: state.storeId, key: "island_models", value: mdl }, { onConflict: ["store_id", "key"] });
    // 適用開始日と入替履歴を保存（同じ適用日で取り直した場合は上書き）
    const entry = { effectiveFrom, importedAt: new Date().toISOString(), total: counts.total, f1: counts.f1, bf: counts.bf, file: file.name };
    const history = [...(meta.history || []).filter((h) => h.effectiveFrom !== effectiveFrom), entry]
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
    await repo.upsert("app_setting", { store_id: state.storeId, key: "island_meta", value: { ...entry, history } }, { onConflict: ["store_id", "key"] });
    setSaveState("saved");
    toast(`${counts.total}台を配置（1F ${counts.f1} / BF ${counts.bf}）・${effectiveFrom}から適用${warnings.length ? "・警告" + warnings.length : ""}`, "ok");
    onDone?.();
  } catch (e) { errorToast(e); }
}

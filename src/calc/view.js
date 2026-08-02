import { el, clear } from "../../util/dom.js";
import { repo } from "../../core/repo.js";
import { state } from "../../core/state.js";
import { toast, errorToast, setSaveState } from "../../core/errors.js";
import { num, yen } from "../../util/format.js";
import { heatColor, heatText, minMax, HEAT5, HEAT_MINUS, HEAT_ZERO } from "../../calc/heat.js";
import { printContent } from "../../print/printService.js";
import { parseIslandXlsx } from "../../import/islandXlsx.js";
import { loadCurrentPeriod, loadSnapshotRows } from "../snapshotData.js";

const METRICS = [["out_val", "アウト"], ["sales", "台売上"], ["gross", "台粗利"]];
const FIX_STYLE = {
  toilet_f: "#f3d9e6", toilet_m: "#d9e3f3", toilet: "#e6e0ef", exit: "#e2efe0",
  smoking: "#efe7d6", settle: "#dceceb", counter: "#f0e6cf", mc: "#e7e9ee",
};
let floor = "1F";
let metric = "out_val";

export async function mount(host) {
  clear(host);
  host.appendChild(el("div", { class: "view-title" }, [el("h1", { text: "島図" }), el("small", { text: "" })]));

  const [layout, fixtures, period, modelsSetting] = await Promise.all([
    repo.select("layout_cell", { eq: { store_id: state.storeId } }),
    repo.select("fixture", { eq: { store_id: state.storeId } }),
    loadCurrentPeriod(),
    repo.select("app_setting", { eq: { store_id: state.storeId, key: "island_models" } }),
  ]);
  const models = modelsSetting[0]?.value || {};
  const snapRows = period ? await loadSnapshotRows(period.id) : [];
  const snap = new Map(snapRows.map((r) => [r.dai_no, r]));
  host.querySelector(".view-title small").textContent = period ? `期間 ${period.label}` : "スナップショット未取込";

  const bar = el("div", { class: "row", style: "gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px" });
  host.appendChild(bar);
  const body = el("div");
  host.appendChild(body);

  const fileInput = el("input", { type: "file", accept: ".xlsx", style: "display:none", onchange: () => doImport(fileInput.files[0]) });
  bar.appendChild(fileInput);

  if (!layout.length) {
    bar.appendChild(el("button", { class: "btn primary", text: "島図Excelを取込", onclick: () => fileInput.click() }));
    body.appendChild(el("div", { class: "placeholder", text: "初回のみ島図Excel（島図＋設定表シート）を取込むと配置図が表示されます。" }));
    return;
  }

  const floors = [...new Set(layout.map((l) => l.floor))];
  floor = floors.includes(floor) ? floor : floors[0];
  const floorChips = floors.map((f) => mkChip(f, () => { floor = f; render(); }));
  const metricChips = METRICS.map(([key, label]) => mkChip(label, () => { metric = key; render(); }));
  floorChips.forEach((c) => bar.appendChild(c));
  bar.appendChild(sep());
  metricChips.forEach((c) => bar.appendChild(c));
  bar.appendChild(el("div", { class: "grow" }));
  bar.appendChild(el("button", { class: "btn sm ghost", text: "島図Excel再取込", onclick: () => fileInput.click() }));
  bar.appendChild(el("button", { class: "btn sm", text: "🖨 印刷", onclick: doPrint }));

  function render() {
    floorChips.forEach((c, i) => setChip(c, floors[i] === floor));
    metricChips.forEach((c, i) => setChip(c, METRICS[i][0] === metric));
    clear(body);
    body.appendChild(legend());
    body.appendChild(buildFloor(floor));
  }

  // 台のある行・列だけを content、間の空きは細い通路(gap)に圧縮。設備は非表示。
  function pack(sorted, content, gap) {
    const map = new Map(); const tpl = []; let prev = null;
    for (const o of sorted) { if (prev !== null && o - prev !== 1) tpl.push(gap); map.set(o, tpl.length); tpl.push(content); prev = o; }
    return { map, tpl };
  }

  function buildFloor(fl) {
    const cells = layout.filter((l) => l.floor === fl);
    const R = pack([...new Set(cells.map((c) => c.grid_row))].sort((a, b) => a - b), "44px", "11px");
    const Cc = pack([...new Set(cells.map((c) => c.grid_col))].sort((a, b) => a - b), "minmax(0,1fr)", "8px");
    const vals = cells.map((c) => snap.get(c.dai_no)?.[metric]).filter((v) => v != null);
    const mm = minMax(vals);
    // 画面幅にフィット(列=可変幅)＋縦は通路を細く
    const grid = el("div", { style: `display:grid;gap:2px;grid-template-columns:${Cc.tpl.join(" ")};grid-template-rows:${R.tpl.join(" ")};width:100%` });
    for (const c of cells) {
      const s = snap.get(c.dai_no);
      const model = s?.model_name || models[c.dai_no] || "";
      const v = s?.[metric];
      const color = heatColor(v, mm.min, mm.max);
      const fg = v == null ? "var(--fg-dim)" : heatText(color);
      const tip = [`台${c.dai_no} ${model}`, s ? `アウト:${num(s.out_val)} 差玉:${num(s.sa_val)} 出率:${s.payout ?? "—"}` : "データなし",
        s ? `大当り:${num(s.big_count)} 売上:${yen(s.sales)} 粗利:${yen(s.gross)}` : ""].filter(Boolean).join("\n");
      grid.appendChild(el("div", {
        title: tip,
        style: `grid-column:${Cc.map.get(c.grid_col) + 1};grid-row:${R.map.get(c.grid_row) + 1};overflow:hidden;` +
          `background:${v == null ? "var(--panel-3)" : color};color:${fg};` +
          `border:1px solid var(--line);border-radius:3px;padding:0 2px;cursor:default;display:flex;flex-direction:column;align-items:center`,
      }, [
        el("div", { style: "font-weight:800;font-size:14px;line-height:1.1", text: String(c.dai_no) }),
        el("div", { style: "font-size:7.5px;line-height:1;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-all;opacity:.85;text-align:center", text: model }),
      ]));
    }
    return el("div", { style: "overflow-x:hidden;border:1px solid var(--line);border-radius:8px;padding:8px;background:var(--panel)" }, grid);
  }

  function legend() {
    const label = METRICS.find((m) => m[0] === metric)[1];
    const box = (c) => el("span", { style: `display:inline-block;width:20px;height:12px;background:${c};border:1px solid var(--line)` });
    const sw = HEAT5.map(box);
    return el("div", { class: "row", style: "align-items:center;gap:6px;margin-bottom:8px;font-size:12px;color:var(--fg-dim);flex-wrap:wrap" },
      [el("span", { text: `${label}：低` }), ...sw, el("span", { text: "高" }),
       el("span", { style: "width:10px" }),
       box(HEAT_MINUS), el("span", { text: "マイナス" }),
       box(HEAT_ZERO), el("span", { text: "稼働なし" })]);
  }

  async function doImport(file) {
    if (!file) return;
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
      setSaveState("saved");
      toast(`${counts.total}台を配置（1F ${counts.f1} / BF ${counts.bf}）${warnings.length ? "・警告" + warnings.length : ""}`, "ok");
      mount(host);
    } catch (e) { errorToast(e); }
  }

  function doPrint() {
    // A4横・両面（表=1F / 裏=BF）: フロア順に各1ページ、2枚目以降に改ページ
    const ordered = [...new Set(layout.map((l) => l.floor))];
    const label = METRICS.find((m) => m[0] === metric)[1];
    const nodes = ordered.map((fl, i) => el("div", { class: "floor" + (i > 0 ? " page-break" : "") }, [
      el("h3", { text: `島図 ${fl}（${label}）` }),
      buildFloor(fl),
    ]));
    printContent(nodes, { orientation: "landscape" });
  }

  render();
}

function mkChip(label, onClick) { return el("button", { class: "btn sm", text: label, onclick: onClick }); }
function setChip(b, on) { b.classList.toggle("primary", on); b.classList.toggle("ghost", !on); }
const sep = () => el("span", { style: "width:1px;height:20px;background:var(--line)" });

import { el, clear } from "../../util/dom.js";
import { state, loadSections } from "../../core/state.js";
import { num, pct, shortModel } from "../../util/format.js";
import { heatColor, heatPoint, minMax, heatText } from "../../calc/heat.js";
import { printContent } from "../../print/printService.js";
import { loadCurrentPeriod, loadSnapshotRows } from "../snapshotData.js";

let filterKey = "ALL";
let sortCol = "dai_no";
let sortDir = 1;

// ランク（金🥇≥13 / 銀🥈≥10 / 銅🥉≥7）。点数は非表示、メダルのみ。
const RANKS = [[13, "🥇"], [10, "🥈"], [7, "🥉"]];
function rankOf(pts) { for (const r of RANKS) if (pts >= r[0]) return r; return null; }
function rankCell(pts) {
  const r = rankOf(pts);
  return el("td", { style: "text-align:center;font-size:17px", title: `${pts}pt` }, r ? r[1] : "");
}

export async function mount(host) {
  await loadSections();
  clear(host);
  const period = await loadCurrentPeriod();
  host.appendChild(el("div", { class: "view-title" }, [
    el("h1", { text: "機種分析" }),
    el("small", { text: period ? `期間 ${period.label}` : "CSV未取込" }),
  ]));
  if (!period) {
    host.appendChild(el("div", { class: "placeholder", text: "「取込」タブで遊技台個別CSVを取込むと表示されます。" }));
    return;
  }
  const rows = await loadSnapshotRows(period.id);

  const ctrl = el("div", { class: "row", style: "gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px" });
  const chip = (key, label) => el("button", { class: "btn sm " + (filterKey === key ? "primary" : "ghost"), text: label, onclick: () => { filterKey = key; render(); } });
  ctrl.appendChild(chip("ALL", "全区分"));
  for (const s of state.sections) ctrl.appendChild(chip(s.key, s.label));
  ctrl.appendChild(el("div", { class: "grow" }));
  ctrl.appendChild(el("button", { class: "btn sm", text: "🖨 印刷", onclick: doPrint }));
  host.appendChild(ctrl);

  host.appendChild(el("div", { class: "hint", style: "margin:-4px 0 10px", html:
    'ランク＝アウト/台売上/台粗利のヒート合計(各1〜5pt)。' +
    '🥇 13pt以上 ／ 🥈 10pt以上 ／ 🥉 7pt以上（ランク列クリックで並べ替え）' }));

  const tableHost = el("div", { style: "overflow-x:auto" });
  host.appendChild(tableHost);

  function aggregate() {
    const secById = new Map(state.sections.map((s) => [s.id, s]));
    const list = [];
    for (const r of rows) {
      const sec = secById.get(r.section_id);
      if (!sec) continue;
      if (filterKey !== "ALL" && sec.key !== filterKey) continue;
      list.push({
        dai_no: r.dai_no, model: r.model_name, sec,
        out: r.out_val, sales: r.sales, gross: r.gross,
        rate: r.sales ? r.gross / r.sales : null,
      });
    }
    // ヒートのmin/max→各行にポイント付与（黄1〜赤5、3指標合計 最大15）
    const heat = { out: minMax(list.map((r) => r.out)), sales: minMax(list.map((r) => r.sales)), gross: minMax(list.map((r) => r.gross)) };
    for (const r of list) {
      r.pOut = heatPoint(r.out, heat.out.min, heat.out.max);
      r.pSales = heatPoint(r.sales, heat.sales.min, heat.sales.max);
      r.pGross = heatPoint(r.gross, heat.gross.min, heat.gross.max);
      r.points = r.pOut + r.pSales + r.pGross;
    }
    list.sort((a, b) => ((a[sortCol] ?? -Infinity) - (b[sortCol] ?? -Infinity)) * sortDir);
    return { list, heat };
  }

  function render() {
    for (const b of ctrl.querySelectorAll(".btn.sm")) if (["全区分", ...state.sections.map((s) => s.label)].includes(b.textContent))
      b.className = "btn sm " + ((b.textContent === "全区分" ? "ALL" : state.sections.find((s) => s.label === b.textContent)?.key) === filterKey ? "primary" : "ghost");
    clear(tableHost);
    const { list, heat } = aggregate();
    tableHost.appendChild(buildTable(list, heat));
  }

  function buildTable(list, heat) {
    const t = el("table", { class: "grid mono" });
    const cols = [
      ["dai_no", "台番号", ""], ["model", "機種名", "txt"], ["secLabel", "区分", ""],
      ["out", "アウト", "heat"], ["sales", "台売上", "heat"], ["gross", "台粗利", "heat"],
      ["rate", "利益率", ""], ["points", "ランク", ""],
    ];
    t.appendChild(el("thead", {}, el("tr", {}, cols.map(([key, label, cls]) =>
      el("th", { class: cls === "txt" ? "txt" : "", style: "cursor:pointer", onclick: () => sortBy(key), text: label + (sortCol === key ? (sortDir < 0 ? " ▼" : " ▲") : "") })))));
    const tb = el("tbody");
    for (const r of list) {
      const heatCell = (key) => {
        const c = heatColor(r[key], heat[key].min, heat[key].max);
        return el("td", { style: `background:${c};color:${heatText(c)}`, text: num(r[key]) });
      };
      tb.appendChild(el("tr", {}, [
        el("td", { text: num(r.dai_no) }),
        el("td", { class: "txt", title: r.model, text: shortModel(r.model) }),
        el("td", {}, el("span", { class: "badge " + r.sec.ptype.toLowerCase(), text: r.sec.label })),
        heatCell("out"), heatCell("sales"), heatCell("gross"),
        el("td", { text: r.rate == null ? "—" : pct(r.rate) }),
        rankCell(r.points),
      ]));
    }
    t.appendChild(tb);
    return t;
  }

  function sortBy(key) { if (sortCol === key) sortDir *= -1; else { sortCol = key; sortDir = key === "dai_no" ? 1 : -1; } render(); }
  function doPrint() { const { list, heat } = aggregate(); printContent(buildTable(list, heat), { title: `機種分析 ${period.label}${filterKey === "ALL" ? "" : " / " + filterKey}` }); }

  render();
}

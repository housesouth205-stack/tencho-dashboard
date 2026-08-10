import { el, clear } from "../../util/dom.js";
import { state, loadSections } from "../../core/state.js";
import { num, pct, shortModel } from "../../util/format.js";
import { heatColor, heatPoint, minMaxByGroup, groupRange, heatText } from "../../calc/heat.js";
import { rateKeyOfDai } from "../../core/config.js";
import { printContent } from "../../print/printService.js";
import { mountZoomBar } from "../../util/pinchZoom.js";
import { loadCurrentPeriod, loadSnapshotRows } from "../snapshotData.js";

let filterKey = "ALL";
let sortCol = "dai_no";
let sortDir = 1;
// スマホの拡大表示。並べ替えや区分の切替で作り直しても倍率と位置を保つ。
const zoomSt = { zoom: null, pan: null };

// ヒートの比較単位＝レート。台番号レンジで判定し、範囲外の台のみ取込時の区分で補う。
const rateOf = (r) => rateKeyOfDai(r.dai_no) || r.sec.key;

// ランク（金🥇≥14 / 銀🥈≥12 / 銅🥉≥10）。点数は非表示、メダルのみ。
// ヒートは平均が真ん中(3pt)なので、3指標とも平均ちょうどの台は9pt。
// 銅を10ptからにして「銅＝平均を超えた台」に揃えている（平均並みは無印）。
const RANKS = [[14, "🥇"], [12, "🥈"], [10, "🥉"]];
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
    '🥇 14pt以上 ／ 🥈 12pt以上 ／ 🥉 10pt以上＝平均超え（ランク列クリックで並べ替え）<br>' +
    '色・ランクは<b>同じレート（20スロ/5スロ/2スロ）の中での高い/低い</b>で判定し、' +
    '<b>真ん中の色＝そのレートの平均</b>です（セルにカーソルを乗せると平均値を表示）。' }));

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
    // ヒートの基準は区分（レート）ごと。全区分をまとめると桁の大きい低貸に引っ張られ、
    // 20スロが一律で低く見えてしまうため、色もランクも「同じ区分の中での高低」で決める。
    const heat = {
      out: minMaxByGroup(list, rateOf, (r) => r.out),
      sales: minMaxByGroup(list, rateOf, (r) => r.sales),
      gross: minMaxByGroup(list, rateOf, (r) => r.gross),
    };
    for (const r of list) {
      r.pOut = heatPoint(r.out, groupRange(heat.out, rateOf(r)));
      r.pSales = heatPoint(r.sales, groupRange(heat.sales, rateOf(r)));
      r.pGross = heatPoint(r.gross, groupRange(heat.gross, rateOf(r)));
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
    const mobile = window.matchMedia("(max-width: 700px)").matches;
    const table = buildTable(list, heat, mobile);
    if (!mobile) { tableHost.appendChild(el("div", { class: "table-wrap" }, table)); return; }
    // スマホは横スクロールをやめ、全体を縮めて表示する。細かい数字は指で拡大して読む。
    // 島図と同じ操作にそろえてある（並べ替えの見出しタップもそのまま効く）。
    const bar = el("div");
    const content = el("div", { style: "width:max-content" }, table);
    // 高さは打ち切らない。枠の中で動かすより、ページをそのまま縦スクロールして
    // 読めるほうが表には合っている（横に広がったぶんだけ指で動かす）。
    const box = el("div", { style: "border:1px solid var(--line);border-radius:8px;padding:8px;background:var(--panel)" }, content);
    tableHost.appendChild(bar);
    tableHost.appendChild(box); // 実寸を測るため先にDOMへ入れる
    mountZoomBar(bar, box, content, {
      // 並べ替えや区分の切替で作り直すので、倍率と見ている位置を持ち越す
      initial: zoomSt.zoom ?? "fit", offset: zoomSt.pan, fullHeight: true,
      hint: "スライダー／2本指で拡大縮小。縦はページをそのままスクロール。見出しをタップで並べ替え",
      onChange: (s) => { zoomSt.zoom = s; },
      onMove: (x, y) => { zoomSt.pan = { x, y }; },
    });
  }

  function buildTable(list, heat, mobile) {
    // 列幅は固定。中身に合わせると、区分を切り替えるたびに台番号や機種名の幅が
    // 変わって見比べにくかった。全区分でも各レートでも同じ幅になる。
    const cols = [
      ["dai_no", "台番号", "", 60], ["model", "機種名", "txt", 200], ["secLabel", "区分", "", 72],
      ["out", "アウト", "heat", 84], ["sales", "台売上", "heat", 100], ["gross", "台粗利", "heat", 100],
      ["rate", "利益率", "", 70], ["points", "ランク", "", 60],
    ];
    const totalW = cols.reduce((a, c) => a + c[3], 0);
    const t = el("table", { class: "grid mono",
      style: `table-layout:fixed;width:${mobile ? totalW + "px" : "100%"}` });
    t.appendChild(el("colgroup", {}, cols.map(([, , , w]) => el("col", { style: `width:${w}px` }))));
    t.appendChild(el("thead", {}, el("tr", {}, cols.map(([key, label, cls]) =>
      el("th", { class: cls === "txt" ? "txt" : "", style: "cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", onclick: () => sortBy(key), text: label + (sortCol === key ? (sortDir < 0 ? " ▼" : " ▲") : "") })))));
    const tb = el("tbody");
    for (const r of list) {
      const heatCell = (key) => {
        const g = groupRange(heat[key], rateOf(r));
        const c = heatColor(r[key], g);
        return el("td", { style: `background:${c};color:${heatText(c)}`, title: `区分平均 ${num(Math.round(g.avg))}`, text: num(r[key]) });
      };
      tb.appendChild(el("tr", {}, [
        el("td", { text: num(r.dai_no) }),
        // 幅を固定したので、長い機種名は末尾を省略する（全文はカーソルを乗せると出る）
        el("td", { class: "txt", style: "white-space:nowrap;overflow:hidden;text-overflow:ellipsis",
          title: r.model, text: shortModel(r.model) }),
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

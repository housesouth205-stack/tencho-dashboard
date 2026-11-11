import { el, clear } from "../../util/dom.js";
import { state, loadSections } from "../../core/state.js";
import { num, pct } from "../../util/format.js";
import { sectionColor } from "../../util/colors.js";
import { heatColor, minMaxByGroup, groupRange, heatText } from "../../calc/heat.js";
import { rateKeyOfDai } from "../../core/daiSection.js";
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

// ランク A〜E。同じレートの中で台を並べ、上位10%＝A／10〜30%＝B／30〜70%＝C／70〜90%＝D／下位10%＝E。
// 並べる点数は、アウト・玉単価・台粗利それぞれが「そのレートの中で何%の位置か」を平均したもの。
// 以前のメダル（ヒート1〜5ptの合計）は同点が多く、上位何%という区切りにできなかった。
const RANKS = [[10, "A", "#e5484d"], [30, "B", "#f08c00"], [70, "C", "#d4a600"], [90, "D", "#1f9d70"], [100, "E", "#2f6fde"]];
const rankOf = (topPct) => RANKS.find(([lim]) => topPct <= lim) || RANKS[RANKS.length - 1];
function rankCell(r) {
  if (r.topPct == null) return el("td", { text: "—" });
  const [, letter, color] = rankOf(r.topPct);
  return el("td", { class: "an-rank" },
    el("span", { class: "an-rank-box", style: `color:${color};border-color:${color}`, title: `レート内 上位${Math.round(r.topPct)}%`, text: letter }));
}

// そのレートの中で、値が小さいほうから何割の位置か（0〜1。同じ値は真ん中を取る）。
// 値の無い台はいちばん下に置く。
function percentiles(items, valueOf) {
  const out = new Map();
  const vals = items.map((it) => valueOf(it)).filter((v) => v != null && !isNaN(v)).sort((a, b) => a - b);
  for (const it of items) {
    const v = valueOf(it);
    if (v == null || isNaN(v) || !vals.length) { out.set(it, 0); continue; }
    let lo = 0, hi = vals.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (vals[m] < v) lo = m + 1; else hi = m; }
    let eq = lo; while (eq < vals.length && vals[eq] === v) eq++;
    out.set(it, (lo + (eq - lo) / 2) / vals.length);
  }
  return out;
}
// 区分の目印。色の四角に数字（予実タブと同じ）
const secNum = (sec) => { const m = String(sec?.label || "").match(/\d+(\.\d+)?/); return m ? m[0] : String(sec?.label || "?").slice(0, 2); };

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
    'ランク＝同じレートの中での順位（アウト・玉単価・台粗利の位置の平均）。' +
    '<b style="color:#e5484d">A</b> 上位10%／<b style="color:#f08c00">B</b> 10〜30%／<b style="color:#d4a600">C</b> 30〜70%／' +
    '<b style="color:#1f9d70">D</b> 70〜90%／<b style="color:#2f6fde">E</b> 下位10%（ランク列クリックで並べ替え）<br>' +
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
        out: r.out_val, gross: r.gross,
        // 玉単価＝台売上 ÷ アウト。シミュレーターと同じ出し方にそろえている。
        coin: r.out_val ? +(r.sales / r.out_val).toFixed(3) : null,
        rate: r.sales ? r.gross / r.sales : null,
      });
    }
    // ヒートの基準は区分（レート）ごと。全区分をまとめると桁の大きい低貸に引っ張られ、
    // 20スロが一律で低く見えてしまうため、色もランクも「同じ区分の中での高低」で決める。
    const heat = {
      out: minMaxByGroup(list, rateOf, (r) => r.out),
      coin: minMaxByGroup(list, rateOf, (r) => r.coin),
      gross: minMaxByGroup(list, rateOf, (r) => r.gross),
    };
    // ランクは全区分を表示していても「同じレートの中」で決める（低貸と20スロを同じ物差しで比べない）
    const byRate = new Map();
    for (const r of list) { const k = rateOf(r); if (!byRate.has(k)) byRate.set(k, []); byRate.get(k).push(r); }
    for (const items of byRate.values()) {
      const po = percentiles(items, (r) => r.out), pc = percentiles(items, (r) => r.coin), pg = percentiles(items, (r) => r.gross);
      for (const r of items) r.score = (po.get(r) + pc.get(r) + pg.get(r)) / 3;
      const sorted = [...items].sort((a, b) => b.score - a.score);
      sorted.forEach((r, i) => { r.topPct = ((i + 1) / sorted.length) * 100; });
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
      // 幅は実測で決めた。見出しは小さい矢印込みで55px、区分は「20スロ」の
      // 区分は色の四角（32px）だけなので56pxで足りる。どの列もこれを下回ると見出しか中身が切れる。
      ["dai_no", "台番号", "", 60], ["model", "機種名", "txt", 300], ["secLabel", "区分", "", 56],
      ["out", "アウト", "heat", 80], ["coin", "玉単価", "heat", 56], ["gross", "台粗利", "heat", 76],
      ["rate", "利益率", "", 62], ["score", "ランク", "", 60],
    ];
    const totalW = cols.reduce((a, c) => a + c[3], 0);
    // compact: スマホは余白と見出しを詰めて1行を低くする（拡大して読む前提）
    const t = el("table", { class: "grid mono an-table" + (mobile ? " compact" : ""),
      style: `table-layout:fixed;width:${mobile ? totalW + "px" : "100%"}` });
    t.appendChild(el("colgroup", {}, cols.map(([, , , w]) => el("col", { style: `width:${w}px` }))));
    // 並べ替えの矢印は小さく添える。見出しと同じ大きさだと、その幅ぶん
    // 列を広げないと切れてしまい、ランクなど短い列を詰められなかった。
    t.appendChild(el("thead", {}, el("tr", {}, cols.map(([key, label, cls]) =>
      el("th", { class: cls === "txt" ? "txt" : "", style: "cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", onclick: () => sortBy(key) }, [
        label,
        sortCol === key ? el("span", { style: "font-size:9px;margin-left:1px", text: sortDir < 0 ? "▼" : "▲" }) : null,
      ])))));
    const tb = el("tbody");
    for (const r of list) {
      // 玉単価は小数、それ以外は整数で出す
      const fmt = (key, val) => (val == null ? "—" : key === "coin" ? Number(val).toFixed(2) : num(val));
      const heatCell = (key) => {
        const g = groupRange(heat[key], rateOf(r));
        const c = heatColor(r[key], g);
        // 色は内側の箱に塗って角を丸める（セルに塗ると表の線で四角く区切られる）
        return el("td", { class: "an-heat", title: `区分平均 ${fmt(key, g.avg)}` },
          el("span", { style: `background:${c};color:${heatText(c)}`, text: fmt(key, r[key]) }));
      };
      tb.appendChild(el("tr", {}, [
        el("td", { text: num(r.dai_no) }),
        // 機種名は出玉率タブと同じくCSVのままのフルネームで出す。頭の「L」「S」などを
        // 落とすと、出玉率タブや本部資料の機種名と並べたとき同じ機種か見分けにくい。
        // 短くするのは島図（マスが狭い）だけ。幅に収まらない分は末尾を省略し、全文はカーソルで出る。
        el("td", { class: "txt", style: "white-space:nowrap;overflow:hidden;text-overflow:ellipsis",
          title: r.model, text: r.model }),
        el("td", { class: "an-sec" }, el("span", { class: "an-sec-sq", style: `background:${sectionColor(r.sec)}`, title: r.sec.label, text: secNum(r.sec) })),
        heatCell("out"), heatCell("coin"), heatCell("gross"),
        el("td", { text: r.rate == null ? "—" : pct(r.rate) }),
        rankCell(r),
      ]));
    }
    t.appendChild(tb);
    return t;
  }

  function sortBy(key) { if (sortCol === key) sortDir *= -1; else { sortCol = key; sortDir = key === "dai_no" ? 1 : -1; } render(); }
  function doPrint() { const { list, heat } = aggregate(); printContent(buildTable(list, heat), { title: `機種分析 ${period.label}${filterKey === "ALL" ? "" : " / " + filterKey}` }); }

  render();
}

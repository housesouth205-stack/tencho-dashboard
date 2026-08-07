import { el, clear } from "../../util/dom.js";
import { repo } from "../../core/repo.js";
import { state } from "../../core/state.js";
import { num, yen, shortModel } from "../../util/format.js";
import { printContent } from "../../print/printService.js";
import { loadSnapshotRows } from "../snapshotData.js";
import { splitSwaps, summarize, netByDai, byNewModel, METRICS } from "../../calc/swapEffect.js";

const RATE_LABEL = { S20: "20スロ", S5: "5スロ", S2: "2スロ" };
let metric = "gross";
let prevId = null, curId = null;

export async function mount(host) {
  clear(host);
  host.appendChild(el("div", { class: "view-title" }, [
    el("h1", { text: "入替効果" }), el("small", { text: "" }),
  ]));

  const periods = (await repo.select("snapshot_period", { eq: { store_id: state.storeId } }))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); // 新しい順

  if (periods.length < 2) {
    host.appendChild(el("div", { class: "placeholder", text:
      "入替の前後を比べるには、遊技台個別CSVの取込が2期間ぶん必要です（現在 " + periods.length + " 期間）。" }));
    return;
  }

  curId = periods.some((p) => p.id === curId) ? curId : periods[0].id;
  prevId = periods.some((p) => p.id === prevId) ? prevId : periods[1].id;

  const bar = el("div", { class: "row", style: "gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px" });
  // selected は真偽値でなく "selected"/null で渡す（el()はsetAttributeするため
  // false でも属性が付いてしまい、最後の選択肢が選ばれてしまう）。
  const sel = (val, onchange) => el("select", {
    style: "font-size:13px;padding:4px",
    onchange: (e) => { onchange(e.target.value); render(); },
  }, periods.map((p) => el("option", {
    value: p.id, text: p.label || p.id.slice(0, 8),
    selected: p.id === val ? "selected" : null,
  })));
  const prevSel = sel(prevId, (v) => { prevId = v; });
  const curSel = sel(curId, (v) => { curId = v; });
  bar.appendChild(el("span", { class: "lbl", text: "入替前" }));
  bar.appendChild(prevSel);
  bar.appendChild(el("span", { text: "→" }));
  bar.appendChild(el("span", { class: "lbl", text: "入替後" }));
  bar.appendChild(curSel);
  bar.appendChild(el("span", { style: "width:10px" }));
  const metricChips = METRICS.map(([key, label]) => el("button", {
    class: "btn sm", text: label, onclick: () => { metric = key; render(); },
  }));
  metricChips.forEach((c) => bar.appendChild(c));
  bar.appendChild(el("div", { class: "grow" }));
  bar.appendChild(el("button", { class: "btn sm", text: "🖨 印刷", onclick: doPrint }));
  host.appendChild(bar);

  host.appendChild(el("div", { class: "hint", style: "margin:-2px 0 10px", html:
    "同じ台番で<b>機種が入れ替わった台</b>を検出し、前後の実績を比べます。" +
    "全体が上向きの期間は何を入れても数字が伸びるため、<b>同じレートの据置台の平均変化を差し引いた「正味効果」</b>で判定します。" }));

  const body = el("div");
  host.appendChild(body);
  let cache = null;

  async function load() {
    const [prevRows, curRows] = await Promise.all([loadSnapshotRows(prevId), loadSnapshotRows(curId)]);
    const { swapped, kept } = splitSwaps(prevRows, curRows);
    const byRate = summarize(swapped, kept);
    const rows = netByDai(swapped, byRate, metric);
    cache = { swapped, kept, byRate, rows, models: byNewModel(rows) };
    return cache;
  }

  async function render() {
    metricChips.forEach((c, i) => {
      c.classList.toggle("primary", METRICS[i][0] === metric);
      c.classList.toggle("ghost", METRICS[i][0] !== metric);
    });
    clear(body);
    body.appendChild(el("div", { class: "placeholder", text: "集計中…" }));
    const d = await load();
    clear(body);
    const pl = periods.find((p) => p.id === prevId), cl = periods.find((p) => p.id === curId);
    host.querySelector(".view-title small").textContent =
      `${pl?.label || "—"} → ${cl?.label || "—"}　入替 ${d.swapped.length}台 / 据置 ${d.kept.length}台`;
    if (!d.swapped.length) {
      body.appendChild(el("div", { class: "placeholder", text: "この2期間で機種が変わった台はありません。" }));
      return;
    }
    body.appendChild(kpiRow(d));
    body.appendChild(el("h3", { style: "margin:16px 0 6px", text: "レート別" }));
    body.appendChild(rateTable(d));
    body.appendChild(el("h3", { style: "margin:16px 0 6px", text: "機種別（入替後の機種ごと）" }));
    body.appendChild(modelTable(d));
    body.appendChild(el("h3", { style: "margin:16px 0 6px", text: "台別" }));
    body.appendChild(daiTable(d));
  }

  // 正味効果の合計＝入替でどれだけ上積みできたか。台粗利は日平均なので日あたりの額。
  function kpiRow(d) {
    const label = METRICS.find((m) => m[0] === metric)[1];
    const nets = d.rows.map((r) => r.net).filter((v) => v != null);
    const netSum = nets.reduce((a, b) => a + b, 0);
    const win = nets.filter((v) => v > 0).length;
    const fmt = metric === "out_val" ? (v) => num(Math.round(v)) : yen;
    const card = (title, value, sub, color) => el("div", { class: "panel", style: "flex:1;min-width:150px;padding:10px" }, [
      el("div", { style: "font-size:12px;color:var(--fg-dim)", text: title }),
      el("div", { style: `font-size:20px;font-weight:800;${color ? "color:" + color : ""}`, text: value }),
      el("div", { style: "font-size:11px;color:var(--fg-dim)", text: sub }),
    ]);
    const sign = (v) => (v > 0 ? "+" : "") + fmt(v);
    return el("div", { class: "row", style: "gap:8px;flex-wrap:wrap" }, [
      card(`正味効果の合計（${label}）`, sign(netSum),
        "据置台の変化を差し引いた上積み", netSum >= 0 ? "var(--ok, #4caf50)" : "var(--accent)"),
      card("当たった台", `${win} / ${nets.length}台`, "正味効果がプラスの台"),
    ]);
  }

  // レートごとの内訳。20スロと低貸では水準が違うので、平均変化は必ずレート別に出す
  // （混ぜて平均すると桁の大きい低貸に引っ張られて意味を持たない）。
  function rateTable(d) {
    const fmt = metric === "out_val" ? (v) => num(v == null ? null : Math.round(v)) : yen;
    const t = el("table", { class: "grid mono" });
    t.appendChild(el("thead", {}, el("tr", {}, ["レート", "入替台", "据置台", "入替台の平均変化", "据置台の平均変化", "正味効果"]
      .map((h, i) => el("th", { class: i === 0 ? "txt" : "", text: h })))));
    const tb = el("tbody");
    for (const [rate, r] of d.byRate) {
      if (!r.swapCount) continue;
      const m = r.metrics[metric];
      tb.appendChild(el("tr", {}, [
        el("td", { class: "txt", text: RATE_LABEL[rate] || rate }),
        el("td", { text: num(r.swapCount) }), el("td", { text: num(r.keptCount) }),
        el("td", { text: signed(m.swap, fmt) }), el("td", { text: signed(m.kept, fmt) }),
        el("td", { style: netStyle(m.net), text: signed(m.net, fmt) }),
      ]));
    }
    t.appendChild(tb);
    return t;
  }

  function modelTable(d) {
    const fmt = metric === "out_val" ? (v) => num(v == null ? null : Math.round(v)) : yen;
    const t = el("table", { class: "grid mono" });
    t.appendChild(el("thead", {}, el("tr", {}, ["機種（入替後）", "レート", "台数", "入替後の平均", "正味効果", "判定"]
      .map((h, i) => el("th", { class: i === 0 ? "txt" : "", text: h })))));
    const tb = el("tbody");
    for (const m of d.models) {
      tb.appendChild(el("tr", {}, [
        el("td", { class: "txt", title: m.model, text: shortModel(m.model) }),
        el("td", { text: RATE_LABEL[m.rate] || "—" }),
        el("td", { text: num(m.count) }),
        el("td", { text: fmt(m.curAvg) }),
        el("td", { style: netStyle(m.netAvg), text: signed(m.netAvg, fmt) }),
        el("td", { text: verdict(m.netAvg) }),
      ]));
    }
    t.appendChild(tb);
    return t;
  }

  function daiTable(d) {
    const fmt = metric === "out_val" ? (v) => num(v == null ? null : Math.round(v)) : yen;
    const t = el("table", { class: "grid mono" });
    t.appendChild(el("thead", {}, el("tr", {}, ["台番", "入替前の機種", "入替後の機種", "前", "後", "増減", "正味効果"]
      .map((h, i) => el("th", { class: i === 1 || i === 2 ? "txt" : "", text: h })))));
    const tb = el("tbody");
    for (const r of [...d.rows].sort((a, b) => (b.net ?? -Infinity) - (a.net ?? -Infinity))) {
      tb.appendChild(el("tr", {}, [
        el("td", { text: num(r.dai_no) }),
        el("td", { class: "txt", title: r.prevModel, text: shortModel(r.prevModel) }),
        el("td", { class: "txt", title: r.curModel, text: shortModel(r.curModel) }),
        el("td", { text: fmt(r.prevVal) }),
        el("td", { text: fmt(r.curVal) }),
        el("td", { text: signed(r.delta, fmt) }),
        el("td", { style: netStyle(r.net), text: signed(r.net, fmt) }),
      ]));
    }
    t.appendChild(tb);
    return t;
  }

  const signed = (v, fmt) => (v == null ? "—" : (v > 0 ? "+" : "") + fmt(v));
  const netStyle = (v) => (v == null ? "" : `font-weight:700;color:${v > 0 ? "var(--ok, #4caf50)" : "var(--accent)"}`);
  const verdict = (v) => (v == null ? "—" : v > 0 ? "◎ 上積みあり" : "△ 下回った");

  function doPrint() {
    if (!cache) return;
    const pl = periods.find((p) => p.id === prevId), cl = periods.find((p) => p.id === curId);
    printContent([
      el("h3", { text: `入替効果 ${pl?.label || ""} → ${cl?.label || ""}（${METRICS.find((m) => m[0] === metric)[1]}）` }),
      rateTable(cache), el("div", { style: "height:10px" }),
      modelTable(cache), el("div", { style: "height:10px" }), daiTable(cache),
    ], { title: "入替効果" });
  }

  render();
}

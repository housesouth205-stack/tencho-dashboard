import { el, clear } from "../../util/dom.js";
import { repo } from "../../core/repo.js";
import { state, loadSections } from "../../core/state.js";
import { setSaveState, toast, errorToast } from "../../core/errors.js";
import { daiRangeText, saveDaiRanges, daiRangesUpdatedAt, daiRangesSaved } from "../../core/daiSection.js";
import { parseMap, countOf, compressToRanges, formatRanges, inRanges } from "../../util/daiRange.js";
import { loadCurrentPeriod, loadSnapshotRows } from "../snapshotData.js";

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
    el("th", { class: "txt", text: "台番" }),
    el("th", { text: "並び順" }),
    el("th", { text: "" }),
  ])));
  table.appendChild(body);

  // 台番の入力欄は区分ごとにあるが、保存先は1つのJSON（app_setting）。
  // 行ごとに保存すると他の区分の値を巻き添えで消すので、全行まとめて書く。
  const daiInputs = new Map();
  const daiPanel = el("div", { class: "col", style: "gap:6px" });
  const currentMap = () => Object.fromEntries([...daiInputs].map(([k, i]) => [k, i.value.trim()]));

  const draw = () => {
    clear(body);
    daiInputs.clear();
    const saved = daiRangeText();
    for (const s of state.sections) body.appendChild(rowFor(s, redraw, saved[s.key] || "", daiInputs, checkDai));
    checkDai();
  };
  const redraw = async () => { await loadSections(); draw(); };

  // 台番設定の検証。入力のたびに走らせて、保存前に気づけるようにする。
  let known = null; // 島図（無ければ直近スナップショット）が知っている台番
  async function loadKnown() {
    const cells = await repo.select("layout_cell", { eq: { store_id: state.storeId } }).catch(() => []);
    if (cells.length) return { src: "島図", dai: cells.map((c) => c.dai_no) };
    const p = await loadCurrentPeriod();
    if (!p) return { src: null, dai: [] };
    const rows = await loadSnapshotRows(p.id);
    return { src: "直近の取込", dai: rows.map((r) => r.dai_no) };
  }
  function checkDai() {
    clear(daiPanel);
    const map = currentMap();
    const { parsed, errors } = parseMap(map);
    const per = state.sections.map((s) => `${s.label} ${countOf(parsed[s.key] || [])}台`).join(" / ");
    const total = state.sections.reduce((n, s) => n + countOf(parsed[s.key] || []), 0);
    daiPanel.appendChild(el("div", { style: "font-weight:700", text: `合計 ${total}台（${per}）` }));
    for (const e of errors) daiPanel.appendChild(el("div", { style: "color:#e35d6a;font-weight:600", text: "⚠ " + e }));
    if (known && known.src) {
      const miss = known.dai.filter((d) => !state.sections.some((s) => inRanges(d, parsed[s.key] || [])));
      daiPanel.appendChild(miss.length
        ? el("div", { style: "color:#e0a52e;font-weight:600",
          text: `⚠ ${known.src}の${known.dai.length}台のうち ${miss.length}台がどの区分にも入っていません（${formatRanges(compressToRanges(miss))}）` })
        : el("div", { class: "hint", text: `${known.src}の${known.dai.length}台はすべてどれかの区分に入っています。` }));
    }
    daiPanel.appendChild(el("div", { class: "hint", style: "font-size:11.5px",
      text: daiRangesSaved()
        ? `最終更新 ${String(daiRangesUpdatedAt()).slice(0, 10)}。入替でコーナーが変わったらここを直してください。`
        : "まだ保存されていません（初期値で判定中）。保存すると以後この設定が使われます。" }));
  }

  const saveBtn = el("button", { class: "btn primary", text: "台番設定を保存", onclick: async () => {
    const { errors } = parseMap(currentMap());
    if (errors.length && !confirm(`${errors.length}件の問題があります。このまま保存しますか？\n\n${errors.join("\n")}`)) return;
    try {
      setSaveState("saving");
      await saveDaiRanges(currentMap());
      setSaveState("saved");
      toast("台番設定を保存しました", "ok");
      checkDai();
    } catch (e) { errorToast(e); }
  } });

  const fromDataBtn = el("button", { class: "btn ghost", text: "取り込んだ実績から作る", onclick: async () => {
    try {
      const p = await loadCurrentPeriod();
      if (!p) { toast("取込済みのデータがありません", "err"); return; }
      const rows = await loadSnapshotRows(p.id);
      const byId = new Map(state.sections.map((s) => [s.id, s.key]));
      const acc = {};
      for (const r of rows) {
        const key = byId.get(r.section_id);
        if (key) (acc[key] = acc[key] || []).push(r.dai_no);
      }
      const made = Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, formatRanges(compressToRanges(v))]));
      const preview = state.sections.map((s) => `${s.label}: ${made[s.key] || "（なし）"}`).join("\n");
      if (!confirm(`直近の取込（${p.label || p.start_date || ""}）から作りました。入力欄に入れますか？\n\n${preview}`)) return;
      for (const [k, inp] of daiInputs) inp.value = made[k] || "";
      checkDai();
      toast("入力欄に入れました。内容を確認して「台番設定を保存」を押してください");
    } catch (e) { errorToast(e); }
  } });

  const addBtn = el("button", { class: "btn primary", text: "＋ 区分を追加", onclick: () => addRow(redraw) });

  host.appendChild(el("div", { class: "col" }, [
    el("p", { class: "hint", text: "計画/実績はこの区分ごとに入力します。パチンコ(P)はスタート・ベースを持ちます。" }),
    el("div", { class: "table-wrap" }, table),
    el("div", { class: "row", style: "gap:8px;flex-wrap:wrap" }, [addBtn, saveBtn, fromDataBtn]),
    el("div", { class: "card col", style: "gap:6px;background:var(--panel-2)" }, [
      el("div", { style: "font-weight:800;font-size:13px", text: "台番と区分の対応" }),
      el("p", { class: "hint", style: "margin:0", text:
        "「1-144, 305-320」のように書きます（カンマ区切りで複数、単発の台番も可）。取込のとき台番からレートを判定し、島図・シミュレーター・機種分析のヒートも同じ設定を見ます。" }),
      daiPanel,
    ]),
  ]));

  draw();
  loadKnown().then((k) => { known = k; checkDai(); });
}

function rowFor(s, redraw, daiText, daiInputs, onDaiInput) {
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
  // 台番だけは他の列と保存先が違う（区分ごとの行ではなく1つのJSON）。
  // その場保存にすると他の区分を巻き添えで消すので、明示的に保存ボタンを押してもらう。
  const daiInp = el("input", {
    type: "text", value: daiText, placeholder: "例 1-144, 305-320",
    style: "min-width:180px", oninput: onDaiInput,
  });
  daiInputs.set(s.key, daiInp);
  return el("tr", {}, [
    keyCell,
    el("td", { class: "txt" }, nameInp),
    el("td", {}, typeSel),
    el("td", {}, rateInp),
    el("td", { class: "txt" }, daiInp),
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

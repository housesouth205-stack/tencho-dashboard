import { el, clear, modal } from "../../util/dom.js";
import { repo } from "../../core/repo.js";
import { state } from "../../core/state.js";
import { toast, errorToast, setSaveState } from "../../core/errors.js";
import { num, yen, shortModel, sameModel } from "../../util/format.js";
import { heatColor, heatText, minMaxByGroup, groupRange, HEAT5, HEAT_MINUS, HEAT_ZERO } from "../../calc/heat.js";
import { rateKeyOfDai } from "../../core/config.js";
import { printContent } from "../../print/printService.js";
import { parseIslandXlsx } from "../../import/islandXlsx.js";
import { loadCurrentPeriod, loadSnapshotRows } from "../snapshotData.js";
import { attachPinchZoom } from "../../util/pinchZoom.js";

const METRICS = [["out_val", "アウト"], ["sales", "台売上"], ["gross", "台粗利"]];
const FIX_STYLE = {
  toilet_f: "#f3d9e6", toilet_m: "#d9e3f3", toilet: "#e6e0ef", exit: "#e2efe0",
  smoking: "#efe7d6", settle: "#dceceb", counter: "#f0e6cf", mc: "#e7e9ee",
};
let floor = "1F";
let metric = "out_val";
let zoom = null; // スマホのピンチ倍率。null=初回はフロア全体が収まる倍率から。切替後も保つ。

const isMobileView = () => window.matchMedia("(max-width: 700px)").matches;

export async function mount(host) {
  clear(host);
  host.appendChild(el("div", { class: "view-title" }, [el("h1", { text: "島図" }), el("small", { text: "" })]));

  const [layout, fixtures, period, modelsSetting, metaSetting] = await Promise.all([
    repo.select("layout_cell", { eq: { store_id: state.storeId } }),
    repo.select("fixture", { eq: { store_id: state.storeId } }),
    loadCurrentPeriod(),
    repo.select("app_setting", { eq: { store_id: state.storeId, key: "island_models" } }),
    repo.select("app_setting", { eq: { store_id: state.storeId, key: "island_meta" } }),
  ]);
  const models = modelsSetting[0]?.value || {};
  // 島図の適用開始日と入替履歴（island_meta: { effectiveFrom, importedAt, counts, history:[...] }）
  const meta = metaSetting[0]?.value || {};
  const snapRows = period ? await loadSnapshotRows(period.id) : [];
  const snap = new Map(snapRows.map((r) => [r.dai_no, r]));
  host.querySelector(".view-title small").textContent =
    (meta.effectiveFrom ? `この島図は ${meta.effectiveFrom} から適用　/　` : "") +
    (period ? `期間 ${period.label}` : "スナップショット未取込");

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
  if ((meta.history || []).length) bar.appendChild(el("button", { class: "btn sm ghost", text: `📅 入替履歴(${meta.history.length})`, onclick: showHistory }));
  bar.appendChild(el("button", { class: "btn sm", text: "🖨 印刷", onclick: doPrint }));

  // 島図の入替履歴（いつからの島図か）を一覧表示
  function showHistory() {
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
      el("p", { class: "hint", style: "margin:0", text: "取込のたびに記録されます。表示中の島図は最新（先頭行）のものです。" }),
      el("div", { style: "overflow:auto;max-height:60vh" }, t),
    ]), null);
  }

  function render() {
    floorChips.forEach((c, i) => setChip(c, floors[i] === floor));
    metricChips.forEach((c, i) => setChip(c, METRICS[i][0] === metric));
    clear(body);
    body.appendChild(legend());
    const box = buildFloor(floor);
    if (!isMobileView()) { body.appendChild(box); return; }
    // スマホのみ: ピンチズーム＋操作バー。倍率は再描画をまたいで維持する。
    // iOS Safariはピンチインをタブ一覧のジェスチャに取ることがあるため、
    // 指を使わずに縮小できるスライダーと「全体」ボタンを必ず用意する。
    const label = el("span", { style: "min-width:40px;text-align:right;color:var(--fg-dim);font-size:12px" });
    const z = { api: null };
    const btn = (t, fn) => el("button", { class: "btn sm ghost", style: "min-width:36px", text: t, onclick: () => z.api && fn(z.api) });
    // スライダーは倍率を対数で割り付ける（低倍率側の刻みを細かく）
    const slider = el("input", { type: "range", min: 0, max: 1000, value: 0, style: "flex:1;min-width:80px" });
    const toScale = (v) => { const a = z.api; return a.min * Math.pow(a.max / a.min, v / 1000); };
    const toSlider = (s) => { const a = z.api; return Math.round(1000 * Math.log(s / a.min) / Math.log(a.max / a.min)); };
    slider.oninput = () => z.api && z.api.setScale(toScale(+slider.value));
    body.appendChild(el("div", { class: "row", style: "gap:6px;align-items:center;margin-bottom:4px" }, [
      btn("−", (a) => a.zoomBy(1 / 1.25)), slider, btn("＋", (a) => a.zoomBy(1.25)),
      btn("全体", (a) => a.fitWidth()), label,
    ]));
    body.appendChild(el("div", { style: "font-size:11px;color:var(--fg-dim);margin-bottom:6px", text: "スライダー／2本指で拡大縮小・1本指で移動" }));
    body.appendChild(box);
    z.api = attachPinchZoom(box, box.querySelector(".island-grid"), {
      min: 0.4, max: 5, initial: zoom ?? "fit",
      onChange: (s) => { zoom = s; label.textContent = `${Math.round(s * 100)}%`; if (z.api) slider.value = toSlider(s); },
    });
    slider.value = toSlider(z.api.scale); // 初期化中はonChangeでz.apiがまだ無いのでここで合わせる
  }

  // 台のある行・列だけを content、間の空きは細い通路(gap)に圧縮。設備は非表示。
  function pack(sorted, content, gap) {
    const map = new Map(); const tpl = []; let prev = null;
    for (const o of sorted) { if (prev !== null && o - prev !== 1) tpl.push(gap); map.set(o, tpl.length); tpl.push(content); prev = o; }
    return { map, tpl };
  }

  function buildFloor(fl, forPrint) {
    const cells = layout.filter((l) => l.floor === fl);
    // PC: 従来どおり画面幅にフィット（横スクロールなし）。
    // スマホ: 画面幅に押し込むと1台が横長に潰れるため、固定サイズ(やや縦長)＋スクロール＋ピンチズーム。
    // 印刷は端末を問わずPCレイアウトで出す。
    const isMobile = !forPrint && isMobileView();
    const R = pack([...new Set(cells.map((c) => c.grid_row))].sort((a, b) => a - b), isMobile ? "68px" : "44px", "11px");
    const Cc = pack([...new Set(cells.map((c) => c.grid_col))].sort((a, b) => a - b), isMobile ? "58px" : "minmax(0,1fr)", "8px");
    // 色の基準は区分（レート）ごと。BFは2スロと5スロが混在し、まとめて基準にすると
    // 桁の大きい方に引っ張られて片方が一律で淡く見えてしまう。判定は台番号レンジ。
    const mmBy = minMaxByGroup(cells, (c) => rateKeyOfDai(c.dai_no), (c) => snap.get(c.dai_no)?.[metric]);
    // 画面幅にフィット(列=可変幅)＋縦は通路を細く
    const grid = el("div", { class: "island-grid", style: `display:grid;gap:2px;grid-template-columns:${Cc.tpl.join(" ")};grid-template-rows:${R.tpl.join(" ")};width:${isMobile ? "max-content" : "100%"}` });
    for (const c of cells) {
      const s = snap.get(c.dai_no);
      // 機種名は「島図Excel＝今の配置」を優先。Excelに無い台は実績データの機種名。
      const nowModel = models[c.dai_no] || "";
      const pastModel = s?.model_name || "";
      const model = nowModel || pastModel;
      // 実績期間と機種が入れ替わっている台は印を付ける（数字は旧機種のものなので注意喚起）。
      // 半角カナ・記号・型式コードの表記ゆれは同一機種として扱う（誤検出防止）。
      const swapped = !!(nowModel && pastModel && !sameModel(nowModel, pastModel));
      const v = s?.[metric];
      const mm = groupRange(mmBy, rateKeyOfDai(c.dai_no));
      const color = heatColor(v, mm);
      const fg = v == null ? "var(--fg-dim)" : heatText(color);
      const tip = [`台${c.dai_no} ${model}`,
        swapped ? `★期間中は「${pastModel}」→ 下の数字は旧機種の実績です` : "",
        s ? `アウト:${num(s.out_val)} 差玉:${num(s.sa_val)} 出率:${s.payout ?? "—"}` : "データなし",
        s ? `大当り:${num(s.big_count)} 売上:${yen(s.sales)} 粗利:${yen(s.gross)}` : "",
        mm.avg ? `${METRICS.find((m) => m[0] === metric)[1]}の${rateKeyOfDai(c.dai_no)}平均: ${num(Math.round(mm.avg))}` : ""].filter(Boolean).join("\n");
      grid.appendChild(el("div", {
        title: tip,
        style: `grid-column:${Cc.map.get(c.grid_col) + 1};grid-row:${R.map.get(c.grid_row) + 1};overflow:hidden;` +
          `background:${v == null ? "var(--panel-3)" : color};color:${fg};` +
          `border:${swapped ? "2px solid var(--accent)" : "1px solid var(--line)"};border-radius:3px;padding:0 2px;cursor:default;` +
          `display:flex;flex-direction:column;align-items:center;justify-content:center`,
      }, [
        el("div", { style: `font-weight:800;font-size:${isMobile ? 14 : 14}px;line-height:1.1`, text: String(c.dai_no) }),
        el("div", { style: `font-size:${isMobile ? 9.5 : 7.5}px;line-height:1.1;overflow:hidden;display:-webkit-box;-webkit-line-clamp:${isMobile ? 3 : 2};-webkit-box-orient:vertical;word-break:break-all;opacity:.88;text-align:center`, text: shortModel(model) }),
      ]));
    }
    // スマホは高さを区切って中だけスクロール（ズーム時に上下も指で送れるようにする）。
    const boxStyle = isMobile ? "overflow:auto;height:70vh;min-height:320px;" : "overflow-x:hidden;";
    return el("div", { style: `${boxStyle}-webkit-overflow-scrolling:touch;border:1px solid var(--line);border-radius:8px;padding:8px;background:var(--panel)` }, grid);
  }

  function legend() {
    const label = METRICS.find((m) => m[0] === metric)[1];
    const box = (c) => el("span", { style: `display:inline-block;width:20px;height:12px;background:${c};border:1px solid var(--line)` });
    const sw = HEAT5.map(box);
    return el("div", { class: "row", style: "align-items:center;gap:6px;margin-bottom:8px;font-size:12px;color:var(--fg-dim);flex-wrap:wrap" },
      [el("span", { text: `${label}：低` }), ...sw, el("span", { text: "高" }),
       el("span", { text: "（レートごと・真ん中＝平均）" }),
       el("span", { style: "width:10px" }),
       box(HEAT_MINUS), el("span", { text: "マイナス" }),
       box(HEAT_ZERO), el("span", { text: "稼働なし" }),
       el("span", { style: "width:10px" }),
       el("span", { style: "display:inline-block;width:20px;height:12px;background:transparent;border:2px solid var(--accent)" }),
       el("span", { text: "赤枠＝期間中と機種が入替（数字は旧機種の実績）" })]);
  }

  // 取込前に「いつからの島図か」を聞く。既定は今日。
  function askEffectiveFrom(fileName) {
    return new Promise((resolve) => {
      const inp = el("input", { type: "date", value: new Date().toISOString().slice(0, 10), style: "width:170px;font-size:15px;padding:6px" });
      const ok = el("button", { class: "btn primary", text: "この日付で取込む", onclick: () => { const v = inp.value; close(); resolve(v || null); } });
      const cancel = el("button", { class: "btn ghost", text: "やめる", onclick: () => { close(); resolve(null); } });
      const close = modal("島図の適用開始日", el("div", { class: "col", style: "gap:10px" }, [
        el("p", { class: "hint", style: "margin:0", text: `取込むファイル: ${fileName}` }),
        el("p", { style: "margin:0" }, [el("b", { text: "この島図はいつからの配置ですか？" })]),
        el("div", {}, [el("label", { class: "lbl", text: "適用開始日（入替日）" }), inp]),
        el("p", { class: "hint", style: "margin:0;font-size:11.5px", text: "記録した日付は島図画面に表示され、入替履歴として残ります。" }),
      ]), el("div", { class: "row", style: "justify-content:flex-end;gap:8px;margin-top:12px" }, [cancel, ok]));
      setTimeout(() => inp.focus(), 50);
    });
  }

  async function doImport(file) {
    if (!file) return;
    const effectiveFrom = await askEffectiveFrom(file.name);
    if (!effectiveFrom) { fileInput.value = ""; return; } // キャンセル
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
      const history = [...(meta.history || []).filter((h) => h.effectiveFrom !== effectiveFrom), entry].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
      await repo.upsert("app_setting", { store_id: state.storeId, key: "island_meta", value: { ...entry, history } }, { onConflict: ["store_id", "key"] });
      setSaveState("saved");
      toast(`${counts.total}台を配置（1F ${counts.f1} / BF ${counts.bf}）・${effectiveFrom}から適用${warnings.length ? "・警告" + warnings.length : ""}`, "ok");
      mount(host);
    } catch (e) { errorToast(e); }
  }

  function doPrint() {
    // A4横・両面（表=1F / 裏=BF）: フロア順に各1ページ、2枚目以降に改ページ
    const ordered = [...new Set(layout.map((l) => l.floor))];
    const label = METRICS.find((m) => m[0] === metric)[1];
    const nodes = ordered.map((fl, i) => el("div", { class: "floor" + (i > 0 ? " page-break" : "") }, [
      el("h3", { text: `島図 ${fl}（${label}）` }),
      buildFloor(fl, true),
    ]));
    printContent(nodes, { orientation: "landscape" });
  }

  render();
}

function mkChip(label, onClick) { return el("button", { class: "btn sm", text: label, onclick: onClick }); }
function setChip(b, on) { b.classList.toggle("primary", on); b.classList.toggle("ghost", !on); }
const sep = () => el("span", { style: "width:1px;height:20px;background:var(--line)" });

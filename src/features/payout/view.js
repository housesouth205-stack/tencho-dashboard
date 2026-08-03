import { el, clear } from "../../util/dom.js";
import { repo } from "../../core/repo.js";
import { state, loadSections } from "../../core/state.js";
import { toast, errorToast, setSaveState } from "../../core/errors.js";
import { num } from "../../util/format.js";
import { TYPES, TYPE_KEYS, payoutFromDmm, round1, fmt1 } from "../simulator/economics.js";
import { loadCurrentPeriod, loadSnapshotRows } from "../snapshotData.js";
import { dmmSearch, dmmFetch, rankCandidates, searchKeyword } from "./dmm.js";

const AT_HINT = /ジャグラー|ハナビ|クレア|ゲッターマウス|パルサー|バーサス|ドンちゃん|ハッピー|マイジャグ|ファンキー|ゴーゴー|ミスター|沖ドキ|ディスクアップ|アイムジャグ|ジャグ/;
const guessType = (m) => (AT_HINT.test(String(m).normalize("NFKC")) ? "Aタイプ" : "AT機");
const AUTO_SCORE = 0.55; // 一括取得で自動確定する名前類似度の下限

const SRC_LABEL = { manual: "手動", "dmm-per6": "Web実測", "dmm-range": "Web推定", default: "未登録" };
const SITE_LABEL = { "1geki": "一撃", dmm: "DMM" };

let filterText = "", onlyUnreg = false;

export async function mount(host) {
  await loadSections();
  clear(host);
  host.appendChild(el("div", { class: "view-title" }, [el("h1", { text: "出玉率管理" }), el("small", { text: "機種×設定の出玉率(機械割)。シミュレーターが自動参照" })]));

  const period = await loadCurrentPeriod();
  if (!period) { host.appendChild(el("div", { class: "placeholder", text: "「取込」タブで遊技台個別CSVを取込むと、機種一覧が表示されます。" })); return; }
  const snap = await loadSnapshotRows(period.id);
  const specs = await repo.select("model_spec", {});
  const specMap = new Map();
  for (const s of specs) { const a = specMap.get(s.model_name) || new Array(6).fill(null); if (s.setting >= 1 && s.setting <= 6) a[s.setting - 1] = round1(s.payout_rate); specMap.set(s.model_name, a); }
  const typeSetting = (await repo.select("app_setting", { eq: { store_id: state.storeId, key: "settei_types" } }))[0]?.value || {};
  const dmmMap = (await repo.select("app_setting", { eq: { store_id: state.storeId, key: "dmm_map" } }))[0]?.value || {}; // {model: dmm_id}
  const secLabel = new Map(state.sections.map((s) => [s.id, s.label]));

  const groups = new Map();
  for (const r of snap) {
    const g = groups.get(r.model_name) || { model: r.model_name, secs: new Set(), count: 0, minDai: r.dai_no };
    g.secs.add(secLabel.get(r.section_id) || "?"); g.count++;
    if (r.dai_no != null) g.minDai = Math.min(g.minDai ?? r.dai_no, r.dai_no);
    groups.set(r.model_name, g);
  }
  // 並びは台番号順（その機種の先頭台）。島図・シミュレーターと同じ見え方に揃える。
  const rows = [...groups.values()].map((g) => {
    const saved = specMap.get(g.model);
    const registered = saved && saved.every((x) => x != null);
    const type = typeSetting[g.model] || guessType(g.model);
    const payout = registered ? saved : [...TYPES[type]];
    return { model: g.model, secs: [...g.secs].join("/"), count: g.count, minDai: g.minDai ?? 9999, type, payout, registered, source: registered ? "manual" : "default", dmmId: dmmMap[g.model] || null };
  }).sort((a, b) => a.minDai - b.minDai);

  const bar = el("div", { class: "row", style: "gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px" });
  host.appendChild(bar);
  bar.appendChild(el("input", { type: "text", value: filterText, placeholder: "機種名で検索", style: "width:200px", oninput: (e) => { filterText = e.target.value; draw(); } }));
  bar.appendChild(chip("未登録のみ", () => onlyUnreg, () => { onlyUnreg = !onlyUnreg; draw(); }));
  bar.appendChild(el("button", { class: "btn sm", text: "機種名からタイプ自動推定", onclick: () => { rows.forEach((r) => { r.type = guessType(r.model); if (!r.registered) r.payout = [...TYPES[r.type]]; }); draw(); } }));
  bar.appendChild(el("button", { class: "btn sm ghost", text: "未登録にタイプ既定を適用", onclick: () => { rows.forEach((r) => { if (!r.registered) r.payout = [...TYPES[r.type]]; }); draw(); } }));
  const dmmBulkBtn = el("button", { class: "btn sm", style: "border-color:var(--blue);color:var(--blue)", text: "🌐 Webから一括取得", onclick: bulkFetch });
  bar.appendChild(dmmBulkBtn);
  bar.appendChild(el("div", { class: "grow" }));
  bar.appendChild(el("button", { class: "btn primary", text: "保存", onclick: save }));
  const regSpan = el("span", { class: "hint" });
  bar.appendChild(regSpan);

  const info = el("div", { class: "card", style: "border-left:4px solid var(--blue);font-size:12px", html:
    "出玉率(機械割)を機種×設定で登録すると、シミュレーターが自動で使います。<br>" +
    "🌐 <b>Web取得</b>: <a href=\"https://1geki.jp/slot/\" target=\"_blank\">一撃</a>(設定別実測=<b>Web実測</b>、最近のスマスロ中心)を優先し、無ければ<a href=\"https://p-town.dmm.com/machines/slot\" target=\"_blank\">DMMぱちタウン</a>のレンジ(設定1・6)からタイプ標準カーブで補間(<b>Web推定</b>)。行の🌐で個別、上の一括で自動照合(名前一致が曖昧な機種は候補から選択)。" });
  host.appendChild(info);

  const tableHost = el("div", { style: "overflow:auto;max-height:66vh" });
  host.appendChild(tableHost);

  function updateReg() { const reg = rows.filter((r) => r.registered).length; regSpan.textContent = `登録 ${reg}/${rows.length} 機種`; }

  function applyResult(r, res) { // res = {id, source, range, per6}
    const pay = payoutFromDmm(res, r.type);
    if (!pay) return false;
    r.payout = pay; r.registered = true;
    r.source = (res.per6 && res.per6.filter((v) => v != null).length >= 3) ? "dmm-per6" : "dmm-range";
    if (res.id) { r.dmmId = { id: res.id, source: res.source || "dmm" }; dmmMap[r.model] = r.dmmId; }
    return true;
  }

  const savedFetch = (r) => { const m = r.dmmId; if (!m) return null; const { id, source } = typeof m === "object" ? m : { id: m, source: "dmm" }; return dmmFetch(id, source); };

  async function fetchOne(r) {
    try {
      let res = r.dmmId ? await savedFetch(r) : null;
      if (!res || (!res.range && !res.per6)) {
        const { candidates = [] } = await dmmSearch(searchKeyword(r.model), 4);
        const ranked = rankCandidates(r.model, candidates).filter((c) => c.range || c.per6);
        if (!ranked.length) { toast(`「${r.model}」の候補が見つかりませんでした`, "warn"); return; }
        res = await pickCandidate(r.model, ranked);
        if (!res) return; // キャンセル
      }
      if (applyResult(r, res)) { updateReg(); draw(); toast(`「${r.model}」を${SRC_LABEL[r.source]}で反映`, "ok"); }
    } catch (e) { errorToast(e); }
  }

  async function bulkFetch() {
    const targets = rows.filter((r) => !onlyUnreg || !r.registered);
    if (!confirm(`${targets.length}機種をWeb(一撃/DMM)から取得します。名前が曖昧な機種は候補選択が出ます。続けますか？`)) return;
    dmmBulkBtn.disabled = true;
    let ok = 0, ask = [];
    try {
      for (const r of targets) {
        dmmBulkBtn.textContent = `取得中… ${ok + ask.length + 1}/${targets.length}`;
        try {
          let res = r.dmmId ? await savedFetch(r) : null;
          if (!res || (!res.range && !res.per6)) {
            const { candidates = [] } = await dmmSearch(searchKeyword(r.model), 4);
            const ranked = rankCandidates(r.model, candidates).filter((c) => c.range || c.per6);
            if (ranked[0] && ranked[0].score >= AUTO_SCORE) res = ranked[0];
            else { ask.push({ r, ranked }); continue; }
          }
          if (applyResult(r, res)) ok++;
        } catch { ask.push({ r, ranked: null }); }
      }
      updateReg(); draw();
      toast(`自動確定 ${ok}件 / 要確認 ${ask.length}件`, "ok");
      // 曖昧な機種を順番に候補選択
      for (const { r, ranked } of ask) {
        const list = ranked && ranked.length ? ranked : rankCandidates(r.model, (await dmmSearch(searchKeyword(r.model), 4).catch(() => ({ candidates: [] }))).candidates || []).filter((c) => c.range || c.per6);
        if (!list.length) continue;
        const res = await pickCandidate(r.model, list);
        if (res && applyResult(r, res)) { updateReg(); draw(); }
      }
    } finally { dmmBulkBtn.disabled = false; dmmBulkBtn.textContent = "🌐 Webから一括取得"; }
  }

  function draw() {
    for (const b of bar.querySelectorAll(".chip")) b.classList.toggle("primary", onlyUnreg), b.classList.toggle("ghost", !onlyUnreg);
    clear(tableHost);
    const q = filterText.trim().normalize("NFKC");
    const list = rows.filter((r) => (!onlyUnreg || !r.registered) && (!q || r.model.normalize("NFKC").includes(q)));
    const t = el("table", { class: "grid mono" });
    t.appendChild(el("thead", {}, el("tr", {}, ["台番", "機種名", "区分", "台数", "タイプ", "設定1", "設定2", "設定3", "設定4", "設定5", "設定6", "状態", ""].map((h, i) =>
      el("th", { class: i === 1 ? "txt" : "", text: h })))));
    const tb = el("tbody");
    for (const r of list) {
      const typeSel = el("select", { class: "inp", style: "width:92px", onchange: (e) => { r.type = e.target.value; if (!r.registered) r.payout = [...TYPES[r.type]]; draw(); } },
        TYPE_KEYS.map((k) => el("option", { value: k, text: k, selected: k === r.type ? "selected" : null })));
      const cells = [
        el("td", { style: "color:var(--fg-dim)", title: "この機種の先頭台番", text: r.minDai === 9999 ? "—" : num(r.minDai) }),
        el("td", { class: "txt", text: r.model }),
        el("td", { text: r.secs }), el("td", { text: num(r.count) }), el("td", {}, typeSel),
      ];
      // 出玉率は常に小数第1位で表示・保持（112 → 112.0、112.53 → 112.5）
      for (let s = 0; s < 6; s++) cells.push(el("td", {}, el("input", {
        type: "number", step: "0.1", value: fmt1(r.payout[s]), style: "width:62px;text-align:right",
        onchange: (e) => { const v = round1(e.target.value); if (v == null) { e.target.value = fmt1(r.payout[s]); return; } r.payout[s] = v; e.target.value = fmt1(v); r.registered = true; r.source = "manual"; },
      })));
      const sc = r.registered ? (r.source === "manual" ? "var(--ok)" : "var(--blue)") : "var(--warn)";
      cells.push(el("td", { style: `color:${sc}`, text: r.registered ? SRC_LABEL[r.source] : "未登録" }));
      cells.push(el("td", {}, el("button", { class: "btn sm ghost", title: "Web(一撃/DMM)から取得", text: "🌐", onclick: () => fetchOne(r) })));
      tb.appendChild(el("tr", {}, cells));
    }
    t.appendChild(tb);
    tableHost.appendChild(t);
  }
  updateReg(); draw();

  async function save() {
    try {
      setSaveState("saving");
      const specsOut = [], types = {};
      for (const r of rows) { types[r.model] = r.type; const src = String(r.source).startsWith("dmm") ? "web" : "manual"; for (let s = 0; s < 6; s++) specsOut.push({ model_name: r.model, setting: s + 1, payout_rate: round1(r.payout[s]), source: src }); }
      for (let i = 0; i < specsOut.length; i += 200) await repo.upsert("model_spec", specsOut.slice(i, i + 200), { onConflict: ["model_name", "setting"] });
      await repo.upsert("app_setting", { store_id: state.storeId, key: "settei_types", value: types }, { onConflict: ["store_id", "key"] });
      await repo.upsert("app_setting", { store_id: state.storeId, key: "dmm_map", value: dmmMap }, { onConflict: ["store_id", "key"] });
      rows.forEach((r) => { if (!r.registered) { r.registered = true; r.source = "manual"; } });
      setSaveState("saved"); toast("出玉率を保存しました", "ok"); updateReg(); draw();
    } catch (e) { errorToast(e); }
  }
}

// 候補選択モーダル。Promiseで選択された候補(またはnull)を返す。
function pickCandidate(model, ranked) {
  return new Promise((resolve) => {
    const close = (v) => { document.body.removeChild(ov); resolve(v); };
    const rows = ranked.slice(0, 6).map((c) => {
      const site = SITE_LABEL[c.source] || "DMM";
      const known = (c.per6 || []).filter((v) => v != null);
      const info = known.length >= 3 ? `${site}・設定別 ${known[0]}〜${known[known.length - 1]}%` : (c.range ? `${site}・レンジ ${c.range[0]}〜${c.range[1]}%` : `${site}・データ無`);
      return el("button", { class: "btn", style: "display:flex;justify-content:space-between;gap:12px;width:100%;text-align:left", onclick: () => close(c) },
        [el("span", { text: c.name }), el("span", { class: "hint", text: `${info} ・一致${Math.round(c.score * 100)}%` })]);
    });
    const box = el("div", { style: "background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;max-width:560px;width:92%;max-height:80vh;overflow:auto" }, [
      el("div", { style: "font-weight:700;margin-bottom:4px", text: "Web候補を選択" }),
      el("div", { class: "hint", style: "margin-bottom:10px", text: `当店機種: ${model}` }),
      el("div", { style: "display:flex;flex-direction:column;gap:6px" }, rows),
      el("div", { style: "margin-top:12px;text-align:right" }, el("button", { class: "btn sm ghost", text: "スキップ", onclick: () => close(null) })),
    ]);
    const ov = el("div", { style: "position:fixed;inset:0;background:rgba(20,24,33,.5);display:flex;align-items:center;justify-content:center;z-index:1000", onclick: (e) => { if (e.target === ov) close(null); } }, box);
    document.body.appendChild(ov);
  });
}

function chip(label, isOn, onClick) { const b = el("button", { class: "btn sm chip " + (isOn() ? "primary" : "ghost"), text: label, onclick: onClick }); return b; }

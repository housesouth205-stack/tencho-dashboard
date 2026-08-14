import { el, clear } from "../../util/dom.js";
import { repo } from "../../core/repo.js";
import { state, loadSections } from "../../core/state.js";
import { toast, errorToast, setSaveState } from "../../core/errors.js";
import { num } from "../../util/format.js";
import { TYPES, TYPE_KEYS, payoutFromDmm, round1, fmt1 } from "../simulator/economics.js";
import { loadCurrentPeriod, loadSnapshotRows } from "../snapshotData.js";
import { dmmSearch, dmmFetch, rankCandidates, searchKeyword } from "./dmm.js";
import { dbCandidates, dbMeta } from "./localdb.js";
import { buildMinSetting, MIN_CHOICES } from "../simulator/minSetting.js";

const AT_HINT = /ジャグラー|ハナビ|クレア|ゲッターマウス|パルサー|バーサス|ドンちゃん|ハッピー|マイジャグ|ファンキー|ゴーゴー|ミスター|沖ドキ|ディスクアップ|アイムジャグ|ジャグ/;
const guessType = (m) => (AT_HINT.test(String(m).normalize("NFKC")) ? "Aタイプ" : "AT機");
const AUTO_SCORE = 0.55; // Web一括取得で自動確定する名前類似度の下限
// 機種DBの一括適用で自動確定する名前類似度の下限。
// 完全一致だけに絞ると候補選択の手数が多くなるため、この値まで自動で入れる。
// 自動で入れたものは状態列に一致率を出し、備考にも照合相手を残して後から見直せる。
const DB_AUTO_SCORE = 0.3;

const SRC_LABEL = {
  manual: "手動", "dmm-per6": "Web実測", "dmm-range": "Web推定",
  "db-per6": "機種DB", "db-range": "機種DB推定", default: "未登録",
};
const SITE_LABEL = { "1geki": "一撃", dmm: "DMM", db: "機種DB" };

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
  // 設定1でパネルが消灯する機種の最低設定 {model: 1|2}。シミュレーターが参照する。
  const minSaved = (await repo.select("app_setting", { eq: { store_id: state.storeId, key: "settei_min" } }))[0]?.value || {};
  const minSetting = buildMinSetting(minSaved);
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
    // 空欄は「その機種に無い設定」を表すので、全部埋まっていることを登録済みの条件にしない。
    // 1つでも数字が入っていれば登録済みとして扱う。
    const registered = !!saved && saved.some((x) => x != null);
    const type = typeSetting[g.model] || guessType(g.model);
    const payout = registered ? saved : [...TYPES[type]];
    return { model: g.model, secs: [...g.secs].join("/"), count: g.count, minDai: g.minDai ?? 9999, type, payout, registered, source: registered ? "manual" : "default", dmmId: dmmMap[g.model] || null, min: minSetting.of(g.model) };
  }).sort((a, b) => a.minDai - b.minDai);

  const bar = el("div", { class: "row", style: "gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px" });
  host.appendChild(bar);
  bar.appendChild(el("input", { type: "text", value: filterText, placeholder: "機種名で検索", style: "width:200px", oninput: (e) => { filterText = e.target.value; draw(); } }));
  bar.appendChild(chip("未登録のみ", () => onlyUnreg, () => { onlyUnreg = !onlyUnreg; draw(); }));
  bar.appendChild(el("button", { class: "btn sm", text: "機種名からタイプ自動推定", onclick: () => { rows.forEach((r) => { r.type = guessType(r.model); if (!r.registered) r.payout = [...TYPES[r.type]]; }); draw(); } }));
  bar.appendChild(el("button", { class: "btn sm ghost", text: "未登録にタイプ既定を適用", onclick: () => { rows.forEach((r) => { if (!r.registered) r.payout = [...TYPES[r.type]]; }); draw(); } }));
  const dbBulkBtn = el("button", { class: "btn sm", style: "border-color:var(--ok);color:var(--ok)", text: "📚 機種DBから一括適用", onclick: bulkFromDb });
  bar.appendChild(dbBulkBtn);
  const dmmBulkBtn = el("button", { class: "btn sm", style: "border-color:var(--blue);color:var(--blue)", text: "🌐 Webから一括取得", onclick: bulkFetch });
  bar.appendChild(dmmBulkBtn);
  bar.appendChild(el("div", { class: "grow" }));
  bar.appendChild(el("button", { class: "btn primary", text: "保存", onclick: save }));
  const regSpan = el("span", { class: "hint" });
  bar.appendChild(regSpan);

  const info = el("div", { class: "card", style: "border-left:4px solid var(--blue);font-size:12px", html:
    "出玉率(機械割)を機種×設定で登録すると、シミュレーターが自動で使います。<br>" +
    "📚 <b>機種DB</b>(同梱・通信不要): スマスロ／6号機の出玉率を出典URL・信頼度つきで収録。設定別の表から取れた機種は<b>機種DB</b>、機械割のレンジしか無い機種はタイプ標準カーブで補間して<b>機種DB推定</b>。<b>まずこれを試すのが速い</b>。状態列にカーソルを乗せると信頼度・出典・照合相手が出ます。<br>" +
    "　一括適用は名前の一致率30%以上を自動で入れます。店舗の機種名が型式名でも照合できます（例「S/新ﾊﾅﾋﾞR/HA」）。完全一致でなかった機種は状態列に<b>一致率</b>を橙色で出すので、そこだけ見直してください。<br>" +
    "🌐 <b>Web取得</b>: 機種DBに無い機種向け。<a href=\"https://1geki.jp/slot/\" target=\"_blank\">一撃</a>(設定別実測=<b>Web実測</b>)を優先し、無ければ<a href=\"https://p-town.dmm.com/machines/slot\" target=\"_blank\">DMMぱちタウン</a>のレンジから補間(<b>Web推定</b>)。<br>" +
    "⬜ <b>空欄＝その機種にその設定は無い</b>（設定3が無い・設定1256しかない等）。空欄にすると<b>シミュレーターがその設定を入れなくなり</b>、入れようとすると1つ上の設定に寄せます。機種DBとWeb実測で取れた機種は自動で空欄になります。" });
  host.appendChild(info);

  const tableHost = el("div", { style: "overflow:auto;max-height:66vh" });
  host.appendChild(tableHost);

  function updateReg() { const reg = rows.filter((r) => r.registered).length; regSpan.textContent = `登録 ${reg}/${rows.length} 機種`; }

  function applyResult(r, res) { // res = {id, source, range, per6}
    // 機種DBはタイプも出典付きで持っているので、先にタイプを合わせてから出玉率を作る。
    // レンジからの補間はタイプ標準カーブを使うため、順番を逆にすると違うカーブで補間される。
    if (res.source === "db" && res.type && TYPES[res.type]) r.type = res.type;
    const pay = payoutFromDmm(res, r.type);
    if (!pay) return false;
    // レンジ補間は設定1〜6を必ず埋めるが、設定1・2・5・6しか無い機種がある。
    // 機種DBが「存在する設定」を持っていれば、そこに無い設定は空欄に戻す。
    // 空欄はシミュレーターへの「この設定は入れない」という指示でもある。
    if (res.source === "db" && res.lineup && res.lineup.length) {
      for (let s = 1; s <= 6; s++) if (!res.lineup.includes(s)) pay[s - 1] = null;
    }
    r.payout = pay; r.registered = true;
    const per6 = !!(res.per6 && res.per6.filter((v) => v != null).length >= 3);
    r.source = res.source === "db" ? (per6 ? "db-per6" : "db-range") : (per6 ? "dmm-per6" : "dmm-range");
    // 完全一致でないときは、どの機種名に当てたかと一致率を残す。
    // 一致率30%でも自動で入るので、後から見直せる手掛かりが要る。
    const who = res.katashiki && res.katashiki !== res.name ? `${res.name}（型式名 ${res.katashiki}）` : res.name;
    const matched = res.score != null && res.score < 1
      ? `\n照合: 「${who}」に一致率${Math.round(res.score * 100)}%で適用`
      : "";
    r.note = res.source === "db"
      ? `機種DB（信頼度 ${res.confidence || "—"}／条件 ${res.condition || "—"}）${matched}\n出典: ${(res.urls || []).join("\n")}`
      : null;
    r.matchScore = res.source === "db" ? (res.score ?? null) : null;
    r.sourceUrl = res.source === "db" ? (res.urls || [])[0] || null : null;
    if (res.source !== "db" && res.id) { r.dmmId = { id: res.id, source: res.source || "dmm" }; dmmMap[r.model] = r.dmmId; }
    return true;
  }

  const savedFetch = (r) => { const m = r.dmmId; if (!m) return null; const { id, source } = typeof m === "object" ? m : { id: m, source: "dmm" }; return dmmFetch(id, source); };

  async function fetchOneFromDb(r) {
    try {
      const list = await dbCandidates(r.model);
      if (!list.length) { toast(`「${r.model}」は機種DBに見つかりませんでした`, "warn"); return; }
      // 個別に押したときは候補を見せる。一括と違い、選ぶ手間より確実さを優先する。
      const res = (list.length === 1 && list[0].score >= 1) ? list[0] : await pickCandidate(r.model, list);
      if (!res) return; // キャンセル
      if (applyResult(r, res)) { updateReg(); draw(); toast(`「${r.model}」を機種DBから反映（信頼度 ${res.confidence || "—"}）`, "ok"); }
    } catch (e) { errorToast(e); }
  }

  async function fetchOne(r) {
    try {
      let res = r.dmmId ? await savedFetch(r) : null;
      if (!res || (!res.range && !res.per6)) {
        const { candidates = [] } = await dmmSearch(searchKeyword(r.model), 4);
        const ranked = rankCandidates(searchKeyword(r.model),candidates).filter((c) => c.range || c.per6);
        if (!ranked.length) { toast(`「${r.model}」の候補が見つかりませんでした`, "warn"); return; }
        res = await pickCandidate(r.model, ranked);
        if (!res) return; // キャンセル
      }
      if (applyResult(r, res)) { updateReg(); draw(); toast(`「${r.model}」を${SRC_LABEL[r.source]}で反映`, "ok"); }
    } catch (e) { errorToast(e); }
  }

  // 同梱の機種データベースから一括で埋める。通信不要なので先に試す想定。
  // 名前が曖昧な機種は Web取得と同じ候補選択モーダルに回す。
  async function bulkFromDb() {
    const targets = rows.filter((r) => !onlyUnreg || !r.registered);
    let meta;
    try { meta = await dbMeta(); } catch (e) { errorToast(e); return; }
    if (!confirm(`${targets.length}機種を機種DB（${meta.機種数}機種／取得日 ${meta.取得日}）から埋めます。続けますか？`)) return;
    dbBulkBtn.disabled = true;
    let ok = 0, miss = 0; const ask = [];
    try {
      for (const r of targets) {
        dbBulkBtn.textContent = `照合中… ${ok + ask.length + miss + 1}/${targets.length}`;
        const list = await dbCandidates(r.model).catch(() => []);
        if (!list.length) { miss++; continue; }
        // 一致率が閾値以上なら自動で入れる。完全一致でないものは
        // 状態列に一致率を出し、備考に照合相手を残して後から見直せるようにする。
        if (list[0].score >= DB_AUTO_SCORE) { if (applyResult(r, list[0])) ok++; }
        else ask.push({ r, ranked: list });
      }
      updateReg(); draw();
      toast(`機種DBから ${ok}件を反映 / 要確認 ${ask.length}件 / 該当なし ${miss}件`, "ok");
      for (const { r, ranked } of ask) {
        const res = await pickCandidate(r.model, ranked);
        if (res && applyResult(r, res)) { updateReg(); draw(); }
      }
    } finally { dbBulkBtn.disabled = false; dbBulkBtn.textContent = "📚 機種DBから一括適用"; }
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
            const ranked = rankCandidates(searchKeyword(r.model),candidates).filter((c) => c.range || c.per6);
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
        const list = ranked && ranked.length ? ranked : rankCandidates(searchKeyword(r.model),(await dmmSearch(searchKeyword(r.model), 4).catch(() => ({ candidates: [] }))).candidates || []).filter((c) => c.range || c.per6);
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
    t.appendChild(el("thead", {}, el("tr", {}, ["台番", "機種名", "区分", "台数", "タイプ", "最低設定", "設定1", "設定2", "設定3", "設定4", "設定5", "設定6", "状態", ""].map((h, i) =>
      el("th", { class: i === 1 ? "txt" : "", title: h === "最低設定" ? "設定1にするとパネルが消灯する機種は2にする。シミュレーターが設定1を割り当てなくなる。" : null, text: h })))));
    const tb = el("tbody");
    for (const r of list) {
      const typeSel = el("select", { class: "inp", style: "width:92px", onchange: (e) => { r.type = e.target.value; if (!r.registered) r.payout = [...TYPES[r.type]]; draw(); } },
        TYPE_KEYS.map((k) => el("option", { value: k, text: k, selected: k === r.type ? "selected" : null })));
      // 最低設定: 2にするとシミュレーターがこの機種に設定1を割り当てなくなる
      const minSel = el("select", {
        class: "inp", style: `width:64px${r.min > 1 ? ";border-color:var(--accent);font-weight:700" : ""}`,
        title: "設定1にするとパネルが消灯する機種は2にする",
        onchange: (e) => { r.min = Number(e.target.value); draw(); },
      }, MIN_CHOICES.map((v) => el("option", { value: v, text: `設定${v}`, selected: v === r.min ? "selected" : null })));
      const cells = [
        el("td", { style: "color:var(--fg-dim)", title: "この機種の先頭台番", text: r.minDai === 9999 ? "—" : num(r.minDai) }),
        el("td", { class: "txt", text: r.model }),
        el("td", { text: r.secs }), el("td", { text: num(r.count) }), el("td", {}, typeSel), el("td", {}, minSel),
      ];
      // 出玉率は常に小数第1位で表示・保持（112 → 112.0、112.53 → 112.5）
      // 空欄＝その機種にその設定は無い。シミュレーターはその設定を割り当てなくなる。
      for (let s = 0; s < 6; s++) {
        const none = r.payout[s] == null;
        cells.push(el("td", { style: none ? "background:var(--panel-2)" : "" }, el("input", {
          type: "number", step: "0.1", value: none ? "" : fmt1(r.payout[s]), placeholder: "なし",
          title: none ? "空欄＝この機種に設定" + (s + 1) + "は無い（投入されません）" : null,
          style: "width:62px;text-align:right",
          onchange: (e) => {
            r.payout[s] = round1(e.target.value); // 空欄はnull＝設定なし
            r.registered = true; r.source = "manual";
            draw();
          },
        })));
      }
      // 名前が完全一致でなかった機種は一致率を併記する。取り違えに気づけるようにするため。
      const inexact = r.matchScore != null && r.matchScore < 1;
      const sc = !r.registered ? "var(--warn)"
        : inexact ? "var(--accent)" : (r.source === "manual" ? "var(--ok)" : "var(--blue)");
      const label = r.registered
        ? SRC_LABEL[r.source] + (inexact ? ` ${Math.round(r.matchScore * 100)}%` : "")
        : "未登録";
      cells.push(el("td", { style: `color:${sc}`, title: r.note || null, text: label }));
      cells.push(el("td", { class: "row", style: "gap:4px" }, [
        el("button", { class: "btn sm ghost", title: "機種DBから適用", text: "📚", onclick: () => fetchOneFromDb(r) }),
        el("button", { class: "btn sm ghost", title: "Web(一撃/DMM)から取得", text: "🌐", onclick: () => fetchOne(r) }),
      ]));
      tb.appendChild(el("tr", {}, cells));
    }
    t.appendChild(tb);
    // 14列あるのでスマホでは表の中だけ横スクロールさせる
    tableHost.appendChild(el("div", { class: "table-wrap" }, t));
  }
  updateReg(); draw();

  async function save() {
    try {
      setSaveState("saving");
      const specsOut = [], types = {}, mins = { ...minSaved };
      for (const r of rows) {
        types[r.model] = r.type; mins[r.model] = r.min;
        const s0 = String(r.source);
        // 由来を残す。機種DB由来は出典URLも一緒に保存しておくと、後から根拠を辿れる。
        const src = s0.startsWith("db") ? "db" : s0.startsWith("dmm") ? "web" : "manual";
        for (let s = 0; s < 6; s++) {
          specsOut.push({ model_name: r.model, setting: s + 1, payout_rate: round1(r.payout[s]), source: src, source_url: src === "db" ? r.sourceUrl || null : null });
        }
      }
      for (let i = 0; i < specsOut.length; i += 200) await repo.upsert("model_spec", specsOut.slice(i, i + 200), { onConflict: ["model_name", "setting"] });
      await repo.upsert("app_setting", { store_id: state.storeId, key: "settei_types", value: types }, { onConflict: ["store_id", "key"] });
      await repo.upsert("app_setting", { store_id: state.storeId, key: "settei_min", value: mins }, { onConflict: ["store_id", "key"] });
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
      // 機種DBは信頼度を持っているので、候補選択の時点で見えるようにする
      const conf = c.source === "db" && c.confidence ? `・信頼度${c.confidence}` : "";
      const info = (known.length >= 3 ? `${site}・設定別 ${known[0]}〜${known[known.length - 1]}%`
        : (c.range ? `${site}・レンジ ${c.range[0]}〜${c.range[1]}%` : `${site}・データ無`)) + conf;
      // 店側の名前が型式名のことがあるので、候補にも型式名を並べて見分けやすくする
      const label = c.katashiki && c.katashiki !== c.name ? `${c.name}（${c.katashiki}）` : c.name;
      return el("button", { class: "btn", style: "display:flex;justify-content:space-between;gap:12px;width:100%;text-align:left", onclick: () => close(c) },
        [el("span", { text: label }), el("span", { class: "hint", text: `${info} ・一致${Math.round(c.score * 100)}%` })]);
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

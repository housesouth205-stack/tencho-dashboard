import { el, clear, modal } from "../../util/dom.js";
import { repo } from "../../core/repo.js";
import { state, loadSections } from "../../core/state.js";
import { toast, errorToast, setSaveState } from "../../core/errors.js";
import { yen, pct, num, shortModel, modelKey } from "../../util/format.js";
import { planCalc } from "../../calc/planCalc.js";
import { localYmd, addDays } from "../../util/dates.js";
import { loadCurrentPeriod, loadSnapshotRows } from "../snapshotData.js";
import { computeMachine, TYPES, sectionL, sectionTanka, round1, fmt1 } from "./economics.js";
import { buildMinSetting, clampSetting } from "./minSetting.js";
import { heatColor, minMaxByGroup, groupRange, HEAT5, HEAT_MINUS, HEAT_ZERO } from "../../calc/heat.js";
import { rateKeyOfDai, isBulkExcluded, bulkExcludeLabel } from "../../core/config.js";
import { buildPlacementMap, buildPlacementFloor, buildLegend, SET_COLORS } from "./miniMap.js";
import { mountZoomBar } from "../../util/pinchZoom.js";
import { printContent, fitToPages } from "../../print/printService.js";
import { sectionColor } from "../../util/colors.js";

const TROPHY = { 2: "🥉", 3: "🥈", 4: "🥇", 5: "🦒", 6: "🌈" }; // 5=キリン柄(サミー基準)
const AT_HINT = /ジャグラー|ハナビ|クレア|ゲッターマウス|パルサー|バーサス|ドンちゃん|ハッピー|マイジャグ|ファンキー|ゴーゴー|ミスター|沖ドキ|ディスクアップ|ニューアイム|アイムジャグ|ジャグ/;
const guessType = (model) => (AT_HINT.test(String(model).normalize("NFKC")) ? "Aタイプ" : "AT機");
const groupOf = (model, saved) => (((saved || guessType(model)) === "Aタイプ") ? "Aタイプ" : "AT機");

export async function mount(host) {
  await loadSections();
  clear(host);
  host.appendChild(el("div", { class: "view-title" }, [el("h1", { text: "設定投入シミュレーター" }), el("small", { text: "島図で設定を直接変更 → 粗利・計画比がその場で変わる" })]));

  const sSections = state.sections.filter((s) => s.ptype === "S");
  const st = {
    section: sSections[0], date: localYmd(), L: 5, K: 5, target: 0, targets: {},
    allUnits: [], layout: [], brush: 4, ex: {}, prev: null,
    // 実績で選んで投入するときの条件
    pick: { rate: "*", metric: "out", dir: "low", n: 10, set: 6, skipJug: true },
    islandModels: {}, minSaved: {}, sessions: [], savedAt: null, carriedOver: false,
    zoom: null, // スマホ島図の倍率（再描画をまたいで保つ）
    pan: null, // 同じく、見ている位置
    heat: "", // 背景に重ねる実績ヒート（""=設定色のみ / out / sales / gross）
    assign: {}, // 区分キー → { 台番: 設定 }。未指定は最低設定（通常1、パネル消灯機種は2）
    baseline: "{}", // 読み込み直後のassign。未保存の変更判定と、保存時の差分抽出に使う
    min: buildMinSetting(null), // 機種→最低設定。reloadで実データに差し替える
  };
  // 未保存の変更があるか。日付を移動する前に必ず確認する（黙って消えるのを防ぐ）
  const isDirty = () => JSON.stringify(st.assign) !== st.baseline;

  const ctrl = el("div", { class: "row", style: "gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px" });
  host.appendChild(ctrl);
  const secChips = sSections.map((s) => el("button", { class: "btn sm", text: s.label, onclick: () => { st.section = s; sync(); reload(); } }));
  ctrl.appendChild(el("div", {}, [el("label", { class: "lbl", text: "貸出/交換枚数の対象区分" }), el("div", { class: "row", style: "gap:4px" }, secChips)]));
  // 対象日は前後の矢印で送れるようにする（1か月ぶんを日単位で見ていく操作が多いため）
  // 日付欄は島図の上と下に1つずつ出るので、作った分をまとめて持っておく。
  const dateInps = [];
  const makeDateInp = () => {
    const i = el("input", { type: "date", value: st.date, style: "width:150px", onchange: (e) => goDate(e.target.value) });
    dateInps.push(i);
    return i;
  };
  const setDateVal = (v) => dateInps.forEach((i) => { i.value = v; });
  const stepDay = (n) => goDate(addDays(st.date, n));

  // 日付移動。未保存の変更があるときは必ず聞く。以前は黙って破棄していて、
  // 入れたはずの設定が消えたように見える事故につながっていた。
  function goDate(next) {
    if (!next || next === st.date) { setDateVal(st.date); return; }
    const move = () => { st.date = next; setDateVal(next); reload(); };
    if (!isDirty()) { move(); return; }
    setDateVal(st.date); // 保存/破棄が決まるまで表示は戻す
    const close = modal("保存していない変更があります", el("div", { class: "col", style: "gap:6px;min-width:min(420px,86vw)" }, [
      el("p", { style: "margin:0" }, [el("b", { text: `${st.date}` }), el("span", { text: " の設定を変更しましたが、まだ保存していません。" })]),
      el("p", { class: "hint", style: "margin:0", text: `このまま ${next} へ移動すると、この変更は失われます。` }),
    ]), el("div", { class: "row", style: "justify-content:flex-end;gap:8px;margin-top:12px" }, [
      el("button", { class: "btn ghost", text: "やめる", onclick: () => close() }),
      el("button", { class: "btn ghost", style: "color:var(--accent)", text: "破棄して移動", onclick: () => { close(); move(); } }),
      el("button", { class: "btn primary", text: "保存して移動", onclick: async () => { close(); await save({ silentForward: true }); move(); } }),
    ]));
  }
  // 日付は島図のすぐ上に置く（1日ずつ送りながら配置を見る操作が中心のため）。
  // render() で body に差し込むので、ここでは要素だけ作っておく。
  // 島図の上と下の両方に置くので、呼ぶたびに新しい行を作る（同じ要素は1箇所にしか置けない）。
  // 日付入力は複数になるため、値の書き戻しは setDateVal() で全部まとめて行う。
  const makeDateRow = ({ reset = false } = {}) => el("div", { class: "row", style: "gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0 6px" }, [
    el("span", { class: "lbl", style: "margin:0", text: "対象日" }),
    el("div", { class: "row", style: "gap:4px;align-items:center" }, [
      el("button", { class: "btn sm ghost", style: "min-width:34px", title: "前の日へ", text: "◀", onclick: () => stepDay(-1) }),
      makeDateInp(),
      el("button", { class: "btn sm ghost", style: "min-width:34px", title: "次の日へ", text: "▶", onclick: () => stepDay(1) }),
      el("button", { class: "btn sm ghost", title: "今日に戻る", text: "今日", onclick: () => goDate(localYmd()) }),
    ]),
    // 全部やり直すときの操作なので、日付のとなりに置く（島図の上にまとめる）
    reset ? el("button", { class: "btn sm ghost", title: "全区分をまとめて戻します（パネル消灯機種は設定2）",
      // スマホは長いラベルだと日付の行が折り返して2段になるので短くする
      text: window.matchMedia("(max-width: 700px)").matches ? "全台リセット" : "全台を最低設定に戻す",
      onclick: () => { st.assign = {}; render(); } }) : null,
  ]);
  const lInp = numI(st.L, (v) => { st.L = v; saveExchange(); render(); }, 0.1, 72);
  const kInp = numI(st.K, (v) => { st.K = v; saveExchange(); render(); }, 0.1, 72);
  ctrl.appendChild(el("div", {}, [el("label", { class: "lbl", text: "貸出枚数/100円" }), lInp]));
  ctrl.appendChild(el("div", {}, [el("label", { class: "lbl", text: "交換枚数(交換率)" }), kInp]));
  ctrl.appendChild(el("button", { class: "btn sm ghost", text: "等価", onclick: () => { st.K = st.L; kInp.value = st.K; saveExchange(); render(); } }));
  function sync() { secChips.forEach((b, i) => b.className = "btn sm " + (sSections[i] === st.section ? "primary" : "ghost")); }
  sync();

  async function saveExchange() {
    const cur = (await repo.select("app_setting", { eq: { store_id: state.storeId, key: "settei_exchange" } }))[0]?.value || {};
    cur[st.section.key] = { L: st.L, K: st.K };
    await repo.upsert("app_setting", { store_id: state.storeId, key: "settei_exchange", value: cur }, { onConflict: ["store_id", "key"] }).catch(() => {});
  }

  const body = el("div", { class: "col", style: "gap:12px" });
  host.appendChild(body);

  async function reload() {
    st.L = sectionL(st.section); st.K = st.L;
    st.ex = (await repo.select("app_setting", { eq: { store_id: state.storeId, key: "settei_exchange" } }))[0]?.value || {};
    const sv = st.ex[st.section.key]; if (sv) { if (sv.L != null) st.L = sv.L; if (sv.K != null) st.K = sv.K; }
    lInp.value = st.L; kInp.value = st.K;

    // 対象日の全区分の計画粗利（4ブロック表示用）
    const [dayPlans, dayMachines] = await Promise.all([
      repo.select("plan_day", { eq: { store_id: state.storeId, ymd: st.date } }),
      repo.select("machines_day", { eq: { store_id: state.storeId, ymd: st.date } }),
    ]);
    st.targets = {};
    for (const sec of sSections) {
      const p = dayPlans.find((r) => r.section_id === sec.id);
      const m = dayMachines.find((r) => r.section_id === sec.id);
      st.targets[sec.key] = p ? planCalc(p, m?.count).gross : 0;
    }
    st.target = st.targets[st.section.key] || 0;

    const period = await loadCurrentPeriod();
    const snap = period ? await loadSnapshotRows(period.id) : [];
    const specs = await repo.select("model_spec", {});
    const specMap = new Map();
    for (const s of specs) { const a = specMap.get(s.model_name) || new Array(6).fill(null); if (s.setting >= 1 && s.setting <= 6) a[s.setting - 1] = round1(s.payout_rate); specMap.set(s.model_name, a); }
    const typeSetting = (await repo.select("app_setting", { eq: { store_id: state.storeId, key: "settei_types" } }))[0]?.value || {};
    // 設定1でパネルが消灯する機種は最低設定2で運用する（出玉率タブで管理）
    const minSaved = (await repo.select("app_setting", { eq: { store_id: state.storeId, key: "settei_min" } }))[0]?.value || {};
    st.minSaved = minSaved;
    st.min = buildMinSetting(minSaved);
    // 機種名は「今の配置（島図Excel）」を優先する。台が移動・入替されるとスナップショットの
    // 機種名は前の期間のままなので、それを使うと最低設定の判定が旧機種に引きずられる。
    st.islandModels = (await repo.select("app_setting", { eq: { store_id: state.storeId, key: "island_models" } }))[0]?.value || {};
    st.layout = await repo.select("layout_cell", { eq: { store_id: state.storeId } });

    const sessions = await repo.select("sim_session", { eq: { store_id: state.storeId } });
    st.sessions = sessions;
    const newest = (a, b) => ((a.created_at || "") < (b.created_at || "") ? 1 : -1);

    // 前日比較用: 対象日より前で最新の保存済みシミュレーション（新形式assignのみ）
    const prevs = sessions.filter((s) => s.target_date && s.target_date < st.date && s.allocation?.assign);
    prevs.sort((a, b) => (a.target_date === b.target_date ? newest(a, b) : (a.target_date < b.target_date ? 1 : -1)));
    st.prev = prevs[0] || null;

    // 対象日の保存内容を復元する。これが無いと、保存しても日付を切り替えた時点で
    // 画面上は未投入に戻り「保存が消えた」ように見える（同名の不具合を修正）。
    // 保存が無い日は前日の設定を引き継ぐ。実機は触らなければ設定がそのまま残るため、
    // 毎日ゼロ（最低設定）から始めるのは運用と合わない。
    const sameDay = sessions.filter((s) => s.target_date === st.date && s.allocation?.assign).sort(newest);
    st.savedAt = sameDay[0]?.created_at || null;
    st.carriedOver = !sameDay[0] && !!st.prev;
    const src = sameDay[0]?.allocation?.assign || st.prev?.allocation?.assign || {};
    st.assign = JSON.parse(JSON.stringify(src));
    st.baseline = JSON.stringify(st.assign);

    const secById = new Map(state.sections.map((s) => [s.id, s]));
    const fullSpec = (name) => { const a = specMap.get(name); return a && a.every((x) => x != null) ? a : null; };
    st.allUnits = snap.map((r) => {
      const sec = secById.get(r.section_id);
      // 今の配置の機種名を優先。無ければスナップショット（実績期間）の機種名。
      const model = st.islandModels[r.dai_no] || r.model_name;
      return {
        dai: r.dai_no, model, pastModel: r.model_name, out: r.out_val || 0,
        sales: r.sales, gross: r.gross, // 実績ヒート表示用（機種分析と同じ値）
        coin: r.out_val ? (+(r.sales / r.out_val).toFixed(3) || 3.0) : 3.0,
        group: groupOf(model, typeSetting[model] || typeSetting[r.model_name]),
        sec, secKey: sec?.key, secLabel: sec?.label || "?",
        payout: fullSpec(model) || fullSpec(r.model_name),
      };
    });
    render();
  }

  const curUnits = () => st.allUnits.filter((u) => u.secKey === st.section.key);
  // その台で使ってよい最低設定。パネル消灯機種は2（設定1を割り当てない）。
  const minOf = (u) => st.min.of(u.model);
  const settingIn = (assign, u) => clampSetting((assign[u.secKey] || {})[u.dai] || minOf(u), minOf(u));
  const settingOf = (u) => settingIn(st.assign, u);
  // 前日（保存済みの直近シミュ）の設定。比較不能ならnull。
  const prevSettingOf = (u) => { const pa = st.prev?.allocation?.assign; return pa ? clampSetting((pa[u.secKey] || {})[u.dai] || minOf(u), minOf(u)) : null; };
  const curveOf = (u) => u.payout || TYPES[u.group];
  // 区分ごとの貸出/交換枚数（編集中の区分は入力値、他区分は保存値または既定=等価）
  const lkOf = (sec) => {
    if (sec === st.section) return { L: st.L, K: st.K };
    const sv = st.ex[sec.key] || {};
    const base = sectionL(sec);
    return { L: sv.L ?? base, K: sv.K ?? base };
  };
  const unitGross = (u, s) => {
    const { L, K } = lkOf(u.sec);
    return computeMachine({ out: u.out, coin: u.coin, payout: curveOf(u)[s - 1], L, K, tanka: sectionTanka(u.sec) }).gross;
  };

  // 区分キー指定の合計（省略時は選択中区分）
  function totalsFor(secKey) {
    let gross = 0, sales = 0, n = 0;
    const bySet = {};
    for (const u of st.allUnits) {
      if (u.secKey !== secKey) continue;
      const s = settingOf(u);
      gross += unitGross(u, s); sales += u.out * u.coin; n++;
      bySet[s] = (bySet[s] || 0) + 1;
    }
    return { gross, sales, n, rate: sales ? gross / sales : 0, bySet };
  }
  const totals = () => totalsFor(st.section.key);

  // 全区分まとめての合計（保存内容の要約用）。
  function totalsAll(assign, targets = st.targets) {
    let gross = 0, sales = 0, tgt = 0;
    const bySet = {};
    for (const u of st.allUnits) {
      if (!u.sec) continue;
      const s = settingIn(assign, u);
      gross += unitGross(u, s); sales += u.out * u.coin;
      bySet[s] = (bySet[s] || 0) + 1;
    }
    for (const sec of sSections) tgt += targets[sec.key] || 0;
    return { gross, sales, tgt, bySet };
  }

  // 島図表示用: 全区分・全台（未指定は設定1）。編集対象区分以外は薄表示。
  // 実績ヒート（機種分析と同じ考え方）。レートごとに基準を分け、平均が真ん中になる。
  const HEATS = [["", "設定のみ"], ["out", "アウト"], ["sales", "台売上"], ["gross", "台粗利"]];
  function heatRanges() {
    if (!st.heat) return null;
    return minMaxByGroup(st.allUnits.filter((u) => u.sec), (u) => rateKeyOfDai(u.dai), (u) => u[st.heat]);
  }

  // ── 実績の低い／高い台にまとめて投入 ──
  // 「20スロで アウトが低い順に 10台 に 設定6 を入れる」のように指定する。
  // 島を1台ずつ目で追わなくても、数字の悪い台・良い台へ一気に置ける。
  const METRICS = [["out", "アウト"], ["gross", "台粗利"]];
  function pickUnits() {
    const p = st.pick;
    const val = (u) => (p.metric === "out" ? u.out : u.gross);
    // ジャグラーの島は方針で設定を固定しているので、外すかどうかを選べるようにする
    const pool = st.allUnits.filter((u) => u.sec && !(p.skipJug && isBulkExcluded(u.dai))
      && (p.rate === "*" || u.sec.key === p.rate) && Number.isFinite(val(u)));
    pool.sort((a, b) => (p.dir === "low" ? val(a) - val(b) : val(b) - val(a)));
    return pool.slice(0, p.n);
  }
  function applyPick() {
    const chosen = pickUnits();
    if (!chosen.length) { toast("対象になる台がありません（実績が未取込かもしれません）", "err"); return; }
    let rounded = 0;
    for (const u of chosen) {
      const A = (st.assign[u.secKey] = st.assign[u.secKey] || {});
      const s = clampSetting(st.pick.set, minOf(u));
      if (s !== st.pick.set) rounded++;
      A[u.dai] = s;
    }
    toast(`${chosen.length}台に設定${st.pick.set}を入れました${rounded ? `（うち${rounded}台は設定1不可のため2）` : ""}`, "ok");
    render();
  }
  function buildPicker() {
    const p = st.pick;
    const opt = (list, cur) => list.map(([v, t]) => el("option", { value: v, text: t, selected: String(v) === String(cur) ? "selected" : null }));
    const preview = el("span", { class: "hint", style: "font-size:11.5px" });
    // 選び直すたびに対象台数だけ出し直す（島図まで描き直すと入力欄から手が離れる）
    const refresh = () => {
      const c = pickUnits();
      preview.textContent = c.length ? `対象 ${c.length}台（${c[0].dai}番〜）` : "対象になる台がありません";
    };
    const pick = (w, list, key, cast = (v) => v) => el("select", { class: "inp", style: `width:${w}px`,
      onchange: (e) => { p[key] = cast(e.target.value); refresh(); } }, opt(list, p[key]));
    // ジャグラー島を外すかどうか。方針で固定していることが多いので既定は外す。
    const jugBox = el("input", { type: "checkbox", style: "cursor:pointer",
      onchange: (e) => { p.skipJug = e.target.checked; refresh(); } });
    jugBox.checked = p.skipJug;
    const jugChk = el("label", { style: "display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px",
      title: `${bulkExcludeLabel()}番。チェックを外すとこの島も対象に含めます` },
      [jugBox, el("span", { text: "ジャグラー島は変更しない" })]);
    refresh();
    // スマホは幅が狭くバラバラに折り返すので、「どれを選ぶか」と「何を入れるか」の
    // 2行に分けておく。PCでも意味の区切りが分かりやすい。
    const line = (children) => el("div", { class: "row", style: "gap:6px;align-items:center;flex-wrap:wrap" }, children);
    const mobile = window.matchMedia("(max-width: 700px)").matches;
    const inner = el("div", { class: "col", style: "gap:6px" }, [
      line([
        mobile ? null : el("span", { class: "hint", style: "font-weight:700;white-space:nowrap", text: "実績で選んで投入" }),
        pick(92, [["*", "全レート"], ...sSections.map((s) => [s.key, s.label])], "rate"),
        pick(88, METRICS, "metric"),
        pick(80, [["low", "低い順"], ["high", "高い順"]], "dir"),
        el("input", { type: "number", min: "1", max: "999", value: String(p.n), style: "width:58px",
          onchange: (e) => { p.n = Math.max(1, Math.min(999, Math.round(+e.target.value || 1))); e.target.value = p.n; refresh(); } }),
        el("span", { class: "hint", style: "white-space:nowrap", text: "台" }),
      ]),
      line([
        el("span", { class: "hint", style: "white-space:nowrap", text: "→" }),
        pick(80, [1, 2, 3, 4, 5, 6].map((s) => [s, `設定${s}`]), "set", Number),
        el("button", { class: "btn primary sm", text: "入れる", onclick: applyPick }),
        jugChk,
        preview,
      ]),
    ]);
    // スマホは縦が貴重なので折りたたむ。毎回使う操作ではないため既定は閉じる。
    if (!mobile) return el("div", { class: "card", style: "padding:8px 10px" }, inner);
    return el("details", { class: "card", style: "padding:6px 10px" }, [
      el("summary", { style: "cursor:pointer;font-weight:700;font-size:13px;padding:2px 0", text: "🎯 実績で選んで投入" }),
      el("div", { style: "margin-top:6px" }, inner),
    ]);
  }

  function mergedPlacement() {
    // 前日比較は常時ON。前日から変えた台が分かることが目的なので切り替えは持たない。
    const diff = !!st.prev;
    const hr = heatRanges();
    const heatLabel = (HEATS.find((h) => h[0] === st.heat) || [])[1];
    return st.allUnits.filter((u) => u.sec).map((u) => {
      const s = settingOf(u);
      const editable = true; // 全区分を直接編集できる
      const prevSet = prevSettingOf(u);
      const changed = diff && prevSet != null && prevSet !== s;
      const min = minOf(u);
      return {
        dai: u.dai, model: shortModel(u.model), setting: s, minSetting: min, secLabel: u.secLabel, color: sectionColor(u.sec),
        prevSetting: diff ? prevSet : null, changed,
        // 据え置きでも「最低設定より上＝投入中」の台は色を残す。全部白にすると
        // 前日から入れっぱなしの高設定がどこにあるか分からなくなるため。
        dim: diff && !changed && s <= min,
        heat: hr ? heatColor(u[st.heat], groupRange(hr, rateKeyOfDai(u.dai))) : null,
        tip: [
          `アウト ${num(u.out)}・コイン単価 ${u.coin}（機種分析）`,
          st.heat ? `${heatLabel} ${num(u[st.heat])}（背景色＝同レート内の高低）` : "",
          `出玉率(設定${s}) ${fmt1(curveOf(u)[s - 1])}%（${u.payout ? "取込実データ" : "タイプ既定"}）`,
          editable ? `台粗利 ${yen(Math.round(unitGross(u, s)))}` : "",
          min > 1 ? `⚠ 設定1不可（パネル消灯）／最低設定${min}` : "",
          changed ? `前回 設定${prevSet} → 今回 設定${s}` : "",
        ].filter(Boolean).join("\n"),
      };
    });
  }

  function render() {
    const sy = document.scrollingElement ? document.scrollingElement.scrollTop : 0;
    clear(body);
    dateInps.length = 0; // 前回描画の日付欄は捨てる（body ごと作り直すため）
    if (!st.allUnits.length) { body.appendChild(el("div", { class: "placeholder", text: "「取込」タブで遊技台個別CSVを取込むと表示されます。" })); return; }
    // ── 4ブロック: レート別（計画粗利・予想粗利・計画比・投入設定）＋ 全体（総粗利・総売上） ──
    const setBadges = (bySet) => el("div", { class: "row", style: "gap:4px;flex-wrap:wrap;margin-top:4px" },
      [2, 3, 4, 5, 6].filter((s) => bySet[s]).map((s) => el("span", {
        style: `font-size:11px;font-weight:700;padding:1px 6px;border-radius:10px;background:${SET_COLORS[s]};color:#333a46;border:1px solid var(--line)`,
        text: `設定${s}${TROPHY[s] || ""}×${bySet[s]}`,
      })));
    const rateCards = sSections.map((sec) => {
      const tt = totalsFor(sec.key);
      const c = sectionColor(sec);
      const tgt = st.targets[sec.key] || 0;
      const gd = tt.gross - tgt;
      const anySet = [2, 3, 4, 5, 6].some((s) => tt.bySet[s]);
      return el("div", { class: "card", style: `flex:1;min-width:210px;padding:8px 12px;border-left:5px solid ${c};${sec === st.section ? "outline:2px solid " + c + ";" : ""}` }, [
        el("div", { class: "row", style: "align-items:baseline;gap:6px" }, [
          el("span", { style: `font-size:13px;color:${c};font-weight:800`, text: sec.label }),
          el("span", { class: "hint", text: `${num(tt.n)}台` }),
        ]),
        el("div", { class: "hint", style: "margin-top:3px", text: `計画粗利 ${yen(tgt)}` }),
        el("div", { class: "row", style: "align-items:baseline;gap:6px" }, [
          el("span", { style: "font-size:20px;font-weight:800;color:#2fb888", text: yen(tt.gross) }),
          el("span", { style: `font-size:12px;font-weight:700;color:${tt.gross >= tgt ? "#43b483" : "#e35d6a"}`, text: tgt ? `${pct(tt.gross / tgt)}（${gd >= 0 ? "+" : ""}${yen(gd)}）` : "" }),
        ]),
        anySet ? setBadges(tt.bySet) : el("div", { class: "hint", style: "margin-top:4px", text: "投入なし（全台が最低設定）" }),
      ]);
    });
    const allT = sSections.reduce((a, sec) => { const tt = totalsFor(sec.key); a.gross += tt.gross; a.sales += tt.sales; a.tgt += st.targets[sec.key] || 0; return a; }, { gross: 0, sales: 0, tgt: 0 });
    const agd = allT.gross - allT.tgt;
    rateCards.push(el("div", { class: "card", style: "flex:1.2;min-width:210px;padding:8px 12px;border-left:5px solid var(--fg);background:var(--panel-2)" }, [
      el("div", { style: "font-size:13px;font-weight:800", text: "🏢 全体（全レート合計）" }),
      el("div", { class: "hint", style: "margin-top:3px", text: `計画粗利 ${yen(allT.tgt)}` }),
      el("div", { class: "row", style: "align-items:baseline;gap:8px;flex-wrap:wrap;margin-top:2px" }, [
        el("span", {}, [el("span", { class: "hint", text: "総粗利 " }), el("span", { style: "font-size:22px;font-weight:800;color:#2fb888", text: yen(allT.gross) })]),
        el("span", { style: `font-size:12px;font-weight:700;color:${allT.gross >= allT.tgt ? "#43b483" : "#e35d6a"}`, text: allT.tgt ? `${pct(allT.gross / allT.tgt)}（${agd >= 0 ? "+" : ""}${yen(agd)}）` : "" }),
      ]),
      el("div", { style: "margin-top:2px" }, [el("span", { class: "hint", text: "総売上 " }), el("span", { style: "font-size:16px;font-weight:700;color:#4f8ff7", text: yen(allT.sales) })]),
    ]));
    body.appendChild(el("div", { class: "row", style: "flex-wrap:wrap;gap:10px" }, rateCards));

    // ── 操作: 保存/印刷（投入まわりは島図のすぐ上にまとめた） ──
    const opRow = el("div", { class: "row", style: "gap:8px;flex-wrap:wrap;align-items:center" }, [
      el("button", { class: "btn ghost sm", title: "どの日に何台入っているかを一覧で確認する", text: "📋 保存状況", onclick: openStatus }),
    ]);
    opRow.appendChild(el("div", { class: "grow" }));
    // 保存済みかどうかを出す。保存したのに消えたように見える事故を防ぐ。
    opRow.appendChild(el("span", {
      class: "hint",
      title: st.carriedOver ? `${st.prev.target_date} の設定をそのまま引き継いでいます。変更して保存すると確定します。` : "",
      text: st.savedAt ? `${st.date} は保存済み`
        : st.carriedOver ? `${st.date} は未保存（${st.prev.target_date} から引き継ぎ）` : `${st.date} は未保存`,
    }));
    opRow.appendChild(el("button", { class: "btn primary", text: "保存", onclick: save }));
    opRow.appendChild(el("button", { class: "btn sm", text: "🖨 印刷（A4 表1F/裏BF）", onclick: printPlacement }));
    body.appendChild(opRow);

    // ── 設定パレット（選んで台をクリックで投入） ──
    // PCでは1FとBFの間に置く（どちらのフロアからも近い）。スマホは島図がズーム枠の
    // 中に入るため枠内に置けず、画面に追従させて常に手元に残す。
    // 1〜6は幅を詰めて必ず横一列に収める（以前は「設定1」表記で幅を取り、スマホでは
    // 折り返して縦に伸びていた）。島図の上と下の両方に置くので毎回作り直す。
    const makePalette = ({ sticky = false } = {}) => el("div", {
      class: "col",
      style: "gap:6px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 8px;margin:6px 0" +
        (sticky ? ";position:sticky;top:52px;z-index:10" : ""),
    }, [
      el("div", { class: "row", style: "gap:4px;align-items:center" }, [
        el("span", { class: "hint", style: "font-weight:700;white-space:nowrap", text: "投入する設定" }),
        ...[1, 2, 3, 4, 5, 6].map((s) => el("button", {
          class: "btn sm",
          title: `設定${s}を選ぶ`,
          // 選択中は枠色と太字で示す（✓を足すと6行目が折り返して高さが揃わなかった）。
          // PCで間延びしないよう max-width も付ける。
          style: `flex:1;min-width:0;max-width:120px;height:36px;line-height:1;padding:0;text-align:center;white-space:nowrap;overflow:hidden;` +
            `background:${SET_COLORS[s]};color:#333a46;` +
            `border:2px solid ${s === st.brush ? "var(--accent)" : "var(--line)"};` +
            `box-shadow:${s === st.brush ? "0 0 0 2px var(--accent-dim)" : "none"};` +
            `font-weight:${s === st.brush ? "900" : "700"};font-size:${s === st.brush ? "17px" : "15px"}`,
          text: `${s}${TROPHY[s] || ""}`,
          onclick: () => { st.brush = s; render(); },
        })),
      ]),
      el("div", { class: "row", style: "gap:6px;align-items:center;flex-wrap:wrap" }, [
        // 実績ヒートを背景に重ねられるようにする。数字の良し悪しを見ながら設定を置ける。
        el("span", { class: "hint", style: "font-weight:700", text: "背景" }),
        el("select", { class: "inp", style: "width:130px", title: "台の背景に実績（機種分析の値）のヒートを重ねる",
          onchange: (e) => { st.heat = e.target.value; render(); } },
          HEATS.map(([v, t]) => el("option", { value: v, text: t, selected: v === st.heat ? "selected" : null }))),
        el("span", { class: "hint", style: "font-size:11.5px",
          text: window.matchMedia("(max-width: 700px)").matches
            ? `タップで設定${st.brush}を投入`
            : `台をタップすると設定${st.brush}が入ります（全区分そのまま編集できます）` }),
      ]),
    ]);

    // ヒート表示中は色の意味が変わるので凡例を出す
    if (st.heat) {
      const box = (c) => el("span", { style: `display:inline-block;width:20px;height:12px;background:${c};border:1px solid var(--line)` });
      body.appendChild(el("div", { class: "row", style: "gap:6px;flex-wrap:wrap;align-items:center;font-size:12px;color:var(--fg-dim)" }, [
        el("span", { style: "font-weight:700", text: `背景＝${(HEATS.find((h) => h[0] === st.heat) || [])[1]}の実績：低` }),
        ...HEAT5.map(box), el("span", { text: "高" }),
        el("span", { text: "（レートごと・真ん中＝平均）" }),
        box(HEAT_MINUS), el("span", { text: "マイナス" }), box(HEAT_ZERO), el("span", { text: "稼働なし" }),
        el("span", { class: "hint", text: "数字と枠は設定・前日比のまま" }),
      ]));
    }

    // ── 補足説明。常時出しておくと場所を取るので折りたたみにする ──
    const noOne = [...new Set(st.allUnits.filter((u) => u.sec && minOf(u) > 1).map((u) => shortModel(u.model)))];
    const cu = curUnits();
    const realN = cu.filter((u) => u.payout).length;
    const notes = el("details", { style: "font-size:11.5px" }, [
      el("summary", { style: "cursor:pointer;color:var(--fg-dim);padding:2px 0", text: "ℹ 設定1が使えない機種・データ元について" }),
      noOne.length ? el("div", { class: "hint", style: "font-size:11.5px;margin-top:4px", html:
        `⚠ <b>設定1が使えない機種</b>（設定1にするとパネルが消灯するため最低設定2）：` +
        `${noOne.join(" / ")} — 設定1を選んでクリックしても設定2が入ります。` +
        `対象機種の追加・解除は<b>出玉率タブ</b>の「最低設定」列で行えます。` }) : null,
      el("div", { class: "hint", style: "font-size:11.5px;margin-top:4px", html:
        `データ元：<b>アウト・コイン単価</b>＝機種分析の実績（台ごと） ／ <b>出玉率</b>＝出玉率タブの取込値` +
        `（この区分 ${realN}/${cu.length}台が取込実データ${realN < cu.length ? "、残りはタイプ既定" : "＝全台実データ"}）。台にマウスを乗せると各値を確認できます。` }),
    ]);
    body.appendChild(notes);

    // ── 前日比較の凡例 ──
    if (st.prev) {
      const ch = mergedPlacement().filter((p) => p.changed);
      const up = ch.filter((p) => p.setting > p.prevSetting).length;
      const down = ch.length - up;
      body.appendChild(el("div", { class: "row", style: "gap:10px;flex-wrap:wrap;align-items:center;font-size:12px" }, [
        el("span", { style: "font-weight:700", text: `📅 ${st.prev.target_date} と比較：` }),
        el("span", { style: "display:inline-flex;align-items:center;gap:4px" }, [
          el("span", { style: "display:inline-block;width:16px;height:16px;border:3px solid #d63c43;border-radius:3px" }),
          el("span", { style: "font-weight:700", text: `上げ ${up}台（▲・赤枠）` })]),
        el("span", { style: "display:inline-flex;align-items:center;gap:4px" }, [
          el("span", { style: "display:inline-block;width:16px;height:16px;border:3px solid #1f6feb;background:#bcd8ff;border-radius:3px" }),
          el("span", { style: "font-weight:700", text: `下げ ${down}台（▼・青塗り）` })]),
        el("span", { style: "display:inline-flex;align-items:center;gap:4px" }, [el("span", { style: "display:inline-block;width:14px;height:14px;border:1px solid var(--line);background:#fff;border-radius:3px" }), el("span", { text: "据え置き（白）" })]),
        el("span", { class: "hint", text: "マスの大きい数字が今日の設定。左の小さい取消線が前日（例 6▼1＝前日6を1へ下げる）" }),
      ]));
    }

    // ── 島図（デフォルト表示・全台） ──
    const placement = mergedPlacement();
    const unitByDai = new Map(st.allUnits.filter((u) => u.sec).map((u) => [u.dai, u]));
    if (st.layout.length) {
      // スマホは島図タブと同じ操作感にする: 1F/BFを縦に並べて固定サイズ＋ピンチズーム。
      const mobile = window.matchMedia("(max-width: 700px)").matches;
      const mapOpts = {
        // 区分を切り替えなくても全台に投入できる。20スロ/5スロ/2スロを行き来する手間をなくす。
        editable: (dai) => unitByDai.has(dai),
        cellW: mobile ? "44px" : null,
        onCellClick: (dai) => {
          const u = unitByDai.get(dai);
          if (!u) return;
          const A = (st.assign[u.secKey] = st.assign[u.secKey] || {}); // その台自身の区分に入れる
          const min = minOf(u);
          // パネル消灯機種に設定1を置こうとしたら最低設定に丸めて理由を知らせる
          if (st.brush < min) toast(`${shortModel(u.model)} は設定1不可（パネル消灯）のため設定${min}にしました`, "");
          A[dai] = clampSetting(st.brush, min); // 選択中の設定を置く（戻すには最低設定を選んでクリック）
          render();
        },
      };
      // 投入に使うものを島図のすぐ上にまとめる（上から順に使う流れになる）:
      // 対象日＋全台リセット → 実績で選んで投入 → 投入する設定 → 島図
      body.appendChild(makeDateRow({ reset: true }));
      body.appendChild(buildPicker());
      if (!mobile) {
        body.appendChild(makePalette());
        body.appendChild(buildPlacementMap(st.layout, placement, mapOpts));
      } else {
        body.appendChild(buildLegend(placement));
        body.appendChild(makePalette({ sticky: true })); // スマホはズーム枠に入れられないので追従表示のまま
        const bar = el("div");
        body.appendChild(bar);
        const box = el("div", {
          // 高さは上限。実際は中身（縮小後の島図）に合わせて縮む（pinchZoom の autoHeight）
          style: "overflow:auto;height:64vh;-webkit-overflow-scrolling:touch;" +
            "border:1px solid var(--line);border-radius:8px;padding:8px;background:var(--panel)",
        }, buildPlacementMap(st.layout, placement, mapOpts));
        body.appendChild(box); // 実寸を測るため先にDOMへ入れる
        mountZoomBar(bar, box, box.querySelector(".placement-all"), {
          initial: st.zoom ?? "fit",
          // 1台入れるたびに島図を作り直すので、倍率と見ている位置の両方を持ち越す。
          // 位置を持たないと設定を入れるたび左上へ戻ってしまう。
          offset: st.pan,
          hint: "スライダー／2本指で拡大縮小・1本指で移動。台をタップで設定を投入",
          onChange: (s) => { st.zoom = s; },
          onMove: (x, y) => { st.pan = { x, y }; },
        });
      }
      // BFの下にも日付と設定パレットを置く。下まで見たあと上へ戻らずに操作できるようにする。
      body.appendChild(makePalette());
      body.appendChild(makeDateRow());
    } else {
      body.appendChild(makeDateRow());
      body.appendChild(el("div", { class: "placeholder", text: "「取込」タブで島図Excelを取り込むと、ここに配置図が表示されます。" }));
    }
    requestAnimationFrame(() => { if (document.scrollingElement) document.scrollingElement.scrollTop = sy; });
  }

  // 島（列）の判定: 基本は島図の行(grid_row)でまとめる。
  // ただし縦向きの島(台212〜219のように1台ずつ別行に並ぶ)は行がバラけて
  // 「1台の島」が乱立し投入が偏るため、少数(3台未満)の行同士が台番連番で
  // 隣接している場合は1つの島に統合する。
  function islandsOf(units) {
    const rowOf = new Map(st.layout.map((l) => [l.dai_no, `${l.floor}:${l.grid_row}`]));
    // 1) まず行ごとにまとめる
    const byRow = new Map();
    for (const u of units) {
      const k = rowOf.get(u.dai) || "その他";
      if (!byRow.has(k)) byRow.set(k, []);
      byRow.get(k).push(u);
    }
    const groups = [...byRow.values()].map((g) => g.sort((a, b) => a.dai - b.dai));
    groups.sort((a, b) => a[0].dai - b[0].dai);
    // 2) 小さい行(3台未満)が台番連続で隣り合うなら統合（縦置き島の復元）
    const merged = [];
    for (const g of groups) {
      const last = merged[merged.length - 1];
      const smallPair = last && last.length < 3 && g.length < 3;
      const contiguous = last && g[0].dai - last[last.length - 1].dai === 1;
      if (smallPair && contiguous) last.push(...g);
      else merged.push([...g]);
    }
    return merged;
  }




  // 📋 保存状況の一覧。どの日に何台入っているか、前日から何台変えたかを並べる。
  // 「入れたはずの設定が反映されていない」を目視で確かめられるようにするための画面。
  function openStatus() {
    const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
    const byDate = new Map();
    for (const s of st.sessions) {
      if (!s.allocation?.assign) continue;
      const cur = byDate.get(s.target_date);
      if (!cur || (cur.created_at || "") < (s.created_at || "")) byDate.set(s.target_date, s);
    }
    const dates = [...byDate.keys()].sort();
    const countOf = (assign) => sSections.reduce((n, sec) => n + Object.keys(assign[sec.key] || {}).length, 0);
    const diffOf = (a, b) => {
      let n = 0;
      for (const sec of sSections) {
        const x = a[sec.key] || {}, y = b[sec.key] || {};
        for (const dai of new Set([...Object.keys(x), ...Object.keys(y)])) if ((x[dai] ?? null) !== (y[dai] ?? null)) n++;
      }
      return n;
    };
    const t = el("table", { class: "grid mono" });
    t.appendChild(el("thead", {}, el("tr", {}, ["日付", "曜", "投入台数", "前日から変更", ""].map((h, i) =>
      el("th", { class: i === 0 ? "txt" : "", text: h })))));
    const tb = el("tbody");
    dates.forEach((d, i) => {
      const a = byDate.get(d).allocation.assign;
      const prev = i ? byDate.get(dates[i - 1]).allocation.assign : null;
      const dt = new Date(`${d}T00:00:00`);
      const changed = prev ? diffOf(prev, a) : null;
      tb.appendChild(el("tr", { style: d === st.date ? "font-weight:800;background:var(--panel-2)" : "" }, [
        el("td", { class: "txt", text: d }),
        el("td", { text: WEEK[dt.getDay()] }),
        el("td", { text: num(countOf(a)) }),
        el("td", { style: changed ? "color:var(--accent);font-weight:700" : "color:var(--fg-dim)", text: changed == null ? "—" : `${changed}台` }),
        el("td", {}, el("button", { class: "btn sm ghost", text: "開く", onclick: () => { close(); goDate(d); } })),
      ]));
    });
    t.appendChild(tb);
    const close = modal("保存状況（設定投入）", el("div", { class: "col", style: "gap:8px;min-width:min(520px,88vw)" }, [
      el("p", { class: "hint", style: "margin:0", text:
        dates.length ? "保存済みの日と、その日の投入台数・前日からの変更台数です。行の「開く」でその日に移動します。"
          : "保存された日がまだありません。設定を入れて「保存」を押すとここに並びます。" }),
      el("div", { style: "overflow:auto;max-height:60vh" }, t),
    ]), el("div", { class: "row", style: "justify-content:flex-end;margin-top:10px" },
      el("button", { class: "btn ghost", text: "閉じる", onclick: () => close() })));
  }


  // 配置島図をA4横で印刷（表=1F / 裏=BF、両面印刷で1枚に）
  // BFは紙の高さをわずかに超えるので、fitToPages で1階＝1ページに収める。
  function printPlacement() {
    const placement = mergedPlacement();
    const floors = [...new Set(st.layout.map((l) => l.floor))];
    const bodies = floors.map((fl) => el("div", {}, [
      el("h3", { text: `設定投入配置 ${st.date} — ${fl}` }),
      buildLegend(placement),
      el("div", { style: "height:6px" }),
      buildPlacementFloor(st.layout, placement, fl),
    ]));
    const fitted = fitToPages(bodies, { orientation: "landscape" });
    // 改ページ指定は一番外側の要素に付いていないと効かない
    const nodes = fitted.map((n, i) => el("div", { class: "floor" + (i > 0 ? " page-break" : "") }, n));
    printContent(nodes, { title: "", orientation: "landscape" });
  }

  // 1日ぶんの保存。sim_session は (store_id, target_date) に一意制約が無く、onConflict:id では
  // idを持たない新規行が毎回作られて重複していくため、同じ日の行を消してから入れ直す。
  async function saveDay(date, assign, targets = st.targets) {
    const g = totalsAll(assign, targets);
    await repo.remove("sim_session", { store_id: state.storeId, target_date: date });
    await repo.upsert("sim_session", {
      store_id: state.storeId, target_date: date, plan_gross: Math.round(g.tgt),
      allocation: { L: st.L, K: st.K, assign, expectedGross: Math.round(g.gross), expectedSales: Math.round(g.sales), bySet: g.bySet },
      reason: `全区分: 予想粗利${Math.round(g.gross)}/計画${Math.round(g.tgt)}`, status: "draft",
    }, { onConflict: ["id"] });
  }

  // 読み込み時点(baseline)から変わった台を拾う。値がnullなら最低設定に戻した台。
  function changedUnits() {
    const before = JSON.parse(st.baseline || "{}");
    const out = [];
    for (const sec of sSections) {
      const b = before[sec.key] || {}, a = st.assign[sec.key] || {};
      for (const dai of new Set([...Object.keys(b), ...Object.keys(a)])) {
        const bv = b[dai] ?? null, av = a[dai] ?? null;
        if (bv !== av) out.push({ secKey: sec.key, dai, to: av });
      }
    }
    return out;
  }

  // 変更した台だけを以降の日にも適用する。実機は触らなければ設定が残るので、
  // ある日に入れた設定はその後も続くのが自然。以降の日をまるごと上書きすると
  // その日ごとの投入が消えてしまうため、変更した台だけを差し込む。
  async function applyForward(changes, fromDate) {
    const later = st.sessions.filter((s) => s.allocation?.assign && s.target_date > fromDate)
      .sort((a, b) => (a.target_date < b.target_date ? -1 : 1));
    const seen = new Set();
    let n = 0;
    for (const s of later) {
      if (seen.has(s.target_date)) continue; // 同じ日の重複行は最初の1件だけ
      seen.add(s.target_date);
      const assign = JSON.parse(JSON.stringify(s.allocation.assign));
      for (const c of changes) {
        const A = (assign[c.secKey] = assign[c.secKey] || {});
        if (c.to == null) delete A[c.dai]; else A[c.dai] = c.to;
      }
      await saveDay(s.target_date, assign, s.allocation.targets || st.targets);
      n++;
    }
    return n;
  }

  async function save(opts = {}) {
    const changes = changedUnits();
    try {
      setSaveState("saving");
      await saveDay(st.date, st.assign);
      st.sessions = await repo.select("sim_session", { eq: { store_id: state.storeId } });
      st.savedAt = new Date().toISOString();
      st.baseline = JSON.stringify(st.assign);
      setSaveState("saved");
      render();
      const laterDays = new Set(st.sessions.filter((s) => s.allocation?.assign && s.target_date > st.date).map((s) => s.target_date)).size;
      // 以降に保存済みの日があると、その日は自分の保存内容を表示するため
      // 今回の変更が反映されない。黙って放置せず、その場で反映するか聞く。
      if (changes.length && laterDays && !opts.silentForward) {
        askForward(changes, laterDays);
      } else {
        toast(`${st.date} の設定を保存しました（変更${changes.length}台）`, "ok");
      }
    } catch (e) { errorToast(e); }
  }

  function askForward(changes, laterDays) {
    const close = modal("以降の日にも反映しますか？", el("div", { class: "col", style: "gap:8px;min-width:min(460px,86vw)" }, [
      el("p", { style: "margin:0" }, [
        el("b", { text: `${st.date}` }), el("span", { text: ` の設定を保存しました（変更 ${changes.length}台）。` }),
      ]),
      el("p", { class: "hint", style: "margin:0", text:
        `${st.date} より後に保存済みの日が ${laterDays}日あります。それらは自分の保存内容を表示するため、` +
        "このままだと今回の変更は反映されません。" }),
      el("p", { class: "hint", style: "margin:0", text:
        "「以降にも反映」を選ぶと、変更した台だけを後の日にも差し込みます（その日ごとの他の投入はそのまま残ります）。" }),
    ]), el("div", { class: "row", style: "justify-content:flex-end;gap:8px;margin-top:12px" }, [
      el("button", { class: "btn ghost", text: "この日だけ", onclick: () => { close(); toast(`${st.date} のみ保存しました`, "ok"); } }),
      el("button", { class: "btn primary", text: `以降の${laterDays}日にも反映`, onclick: async () => {
        close();
        try {
          setSaveState("saving");
          const n = await applyForward(changes, st.date);
          st.sessions = await repo.select("sim_session", { eq: { store_id: state.storeId } });
          setSaveState("saved");
          toast(`${st.date} と以降${n}日に反映しました（変更${changes.length}台）`, "ok");
          render();
        } catch (e) { errorToast(e); }
      } }),
    ]));
  }

  reload();
}

function kpi(label, value, sub, color) {
  return el("div", { class: "card", style: `flex:1;min-width:150px;border-left:4px solid ${color}` }, [
    el("div", { class: "hint", text: label }),
    el("div", { style: `font-size:20px;font-weight:700;margin-top:3px;color:${color}`, text: value }),
    sub ? el("div", { class: "hint", text: sub }) : null,
  ]);
}
function numI(value, onchange, step = "any", w = 90) {
  return el("input", { type: "number", step, value, style: `width:${w}px;text-align:right`, onchange: (e) => onchange(Number(e.target.value)) });
}

import { el, clear, modal } from "../../util/dom.js";
import { repo } from "../../core/repo.js";
import { state, loadSections } from "../../core/state.js";
import { toast, errorToast, setSaveState } from "../../core/errors.js";
import { yen, pct, num, shortModel } from "../../util/format.js";
import { planCalc } from "../../calc/planCalc.js";
import { localYmd, addDays } from "../../util/dates.js";
import { loadCurrentPeriod, loadSnapshotRows } from "../snapshotData.js";
import { computeMachine, TYPES, sectionL, sectionTanka, round1, fmt1 } from "./economics.js";
import { buildMinSetting, clampSetting } from "./minSetting.js";
import { buildPlacementMap, buildPlacementFloor, buildLegend, SET_COLORS } from "./miniMap.js";
import { printContent } from "../../print/printService.js";
import { sectionColor } from "../../util/colors.js";

const TROPHY = { 2: "🥉", 3: "🥈", 4: "🥇", 5: "🦒", 6: "🌈" }; // 5=キリン柄(サミー基準)
const AT_HINT = /ジャグラー|ハナビ|クレア|ゲッターマウス|パルサー|バーサス|ドンちゃん|ハッピー|マイジャグ|ファンキー|ゴーゴー|ミスター|沖ドキ|ディスクアップ|ニューアイム|アイムジャグ|ジャグ/;
const guessType = (model) => (AT_HINT.test(String(model).normalize("NFKC")) ? "Aタイプ" : "AT機");
const groupOf = (model, saved) => (((saved || guessType(model)) === "Aタイプ") ? "Aタイプ" : "AT機");
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

export async function mount(host) {
  await loadSections();
  clear(host);
  host.appendChild(el("div", { class: "view-title" }, [el("h1", { text: "設定投入シミュレーター" }), el("small", { text: "島図で設定を直接変更 → 粗利・計画比がその場で変わる" })]));

  const sSections = state.sections.filter((s) => s.ptype === "S");
  const st = {
    section: sSections[0], date: localYmd(), L: 5, K: 5, target: 0, targets: {},
    allUnits: [], layout: [], brush: 4, ex: {}, prev: null, jugMore: false,
    islandModels: {}, minSaved: {}, sessions: [], savedAt: null,
    assign: {}, // 区分キー → { 台番: 設定 }。未指定は最低設定（通常1、パネル消灯機種は2）
    min: buildMinSetting(null), // 機種→最低設定。reloadで実データに差し替える
  };

  const ctrl = el("div", { class: "row", style: "gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px" });
  host.appendChild(ctrl);
  const secChips = sSections.map((s) => el("button", { class: "btn sm", text: s.label, onclick: () => { st.section = s; sync(); reload(); } }));
  ctrl.appendChild(el("div", {}, [el("label", { class: "lbl", text: "貸出/交換枚数の対象区分" }), el("div", { class: "row", style: "gap:4px" }, secChips)]));
  ctrl.appendChild(el("div", {}, [el("label", { class: "lbl", text: "対象日" }), el("input", { type: "date", value: st.date, style: "width:150px", onchange: (e) => { st.date = e.target.value; reload(); } })]));
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

    // 対象日の保存内容を復元する。これが無いと、保存しても日付を切り替えた時点で
    // 画面上は未投入に戻り「保存が消えた」ように見える（同名の不具合を修正）。
    const sameDay = sessions.filter((s) => s.target_date === st.date && s.allocation?.assign).sort(newest);
    st.assign = sameDay[0] ? JSON.parse(JSON.stringify(sameDay[0].allocation.assign)) : {};
    st.savedAt = sameDay[0]?.created_at || null;

    // 前日比較用: 対象日より前で最新の保存済みシミュレーション（新形式assignのみ）
    const prevs = sessions.filter((s) => s.target_date && s.target_date < st.date && s.allocation?.assign);
    prevs.sort((a, b) => (a.target_date === b.target_date ? newest(a, b) : (a.target_date < b.target_date ? 1 : -1)));
    st.prev = prevs[0] || null;

    const secById = new Map(state.sections.map((s) => [s.id, s]));
    const fullSpec = (name) => { const a = specMap.get(name); return a && a.every((x) => x != null) ? a : null; };
    st.allUnits = snap.map((r) => {
      const sec = secById.get(r.section_id);
      // 今の配置の機種名を優先。無ければスナップショット（実績期間）の機種名。
      const model = st.islandModels[r.dai_no] || r.model_name;
      return {
        dai: r.dai_no, model, pastModel: r.model_name, out: r.out_val || 0,
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
  function mergedPlacement() {
    // 前日比較は常時ON。前日から変えた台が分かることが目的なので切り替えは持たない。
    const diff = !!st.prev;
    return st.allUnits.filter((u) => u.sec).map((u) => {
      const s = settingOf(u);
      const editable = true; // 全区分を直接編集できる
      const prevSet = prevSettingOf(u);
      const changed = diff && prevSet != null && prevSet !== s;
      return {
        dai: u.dai, model: shortModel(u.model), setting: s, secLabel: u.secLabel, color: sectionColor(u.sec),
        prevSetting: diff ? prevSet : null, changed, dim: diff && !changed,
        tip: [
          `アウト ${num(u.out)}・コイン単価 ${u.coin}（機種分析）`,
          `出玉率(設定${s}) ${fmt1(curveOf(u)[s - 1])}%（${u.payout ? "取込実データ" : "タイプ既定"}）`,
          editable ? `台粗利 ${yen(Math.round(unitGross(u, s)))}` : "",
          minOf(u) > 1 ? `⚠ 設定1不可（パネル消灯）／最低設定${minOf(u)}` : "",
          changed ? `前回 設定${prevSet} → 今回 設定${s}` : "",
        ].filter(Boolean).join("\n"),
      };
    });
  }

  function render() {
    const sy = document.scrollingElement ? document.scrollingElement.scrollTop : 0;
    clear(body);
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

    // ── 操作: 🎲ランダム投入 ＋ 前日比較 ＋ リセット/保存/印刷 ──
    const jugChk = el("input", { type: "checkbox", id: "jugMore", style: "cursor:pointer",
      onchange: (e) => { st.jugMore = e.target.checked; } });
    jugChk.checked = st.jugMore;
    const opRow = el("div", { class: "row", style: "gap:8px;flex-wrap:wrap;align-items:center" }, [
      el("button", { class: "btn primary", text: "🎲 各島に1〜2台ランダムで入れる（予算内・選択中の設定）", onclick: randomPerRow }),
      el("label", { style: "display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:13px", title: "ジャグラー系の島に1台多く、優先して投入します" }, [
        jugChk, el("span", { text: "🎰 ジャグラーに多め" }),
      ]),
      el("button", { class: "btn ghost", title: "全区分をまとめて戻します（パネル消灯機種は設定2）", text: "全台を最低設定に戻す", onclick: () => { st.assign = {}; render(); } }),
      el("button", { class: "btn ghost sm", title: "設定1にするとパネルが消灯する機種を選ぶ", text: "⚙ 設定1不可の機種", onclick: openMinEditor }),
    ]);
    opRow.appendChild(el("button", { class: "btn ghost sm", title: "指定日から日数分のたたき台をまとめて作る", text: "📅 1か月分をまとめて作成", onclick: openBulk }));
    opRow.appendChild(el("div", { class: "grow" }));
    // 保存済みかどうかを出す。保存したのに消えたように見える事故を防ぐ。
    opRow.appendChild(el("span", { class: "hint", text: st.savedAt ? `${st.date} は保存済み` : `${st.date} は未保存` }));
    opRow.appendChild(el("button", { class: "btn primary", text: "保存", onclick: save }));
    opRow.appendChild(el("button", { class: "btn sm", text: "🖨 印刷（A4 表1F/裏BF）", onclick: printPlacement }));
    body.appendChild(opRow);

    // ── 設定パレット（選んで台をクリックで投入） ──
    // 画面に追従させる。地下フロアなど下の方の島を触るたびに上へ戻るのを避けるため。
    body.appendChild(el("div", {
      class: "row",
      style: "gap:6px;flex-wrap:wrap;align-items:center;position:sticky;top:52px;z-index:10;" +
        "background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 8px;margin:6px 0",
    }, [
      el("span", { class: "hint", style: "font-weight:700", text: "投入する設定を選択 →" }),
      ...[1, 2, 3, 4, 5, 6].map((s) => el("button", {
        class: "btn sm",
        style: `background:${SET_COLORS[s]};color:#333a46;border:2px solid ${s === st.brush ? "var(--accent)" : "var(--line)"};font-weight:${s === st.brush ? "800" : "600"};min-width:74px`,
        text: `設定${s}${TROPHY[s] || ""}${s === st.brush ? " ✓" : ""}`,
        onclick: () => { st.brush = s; render(); },
      })),
      el("span", { class: "hint", text: `台をクリックすると設定${st.brush}が入ります（全区分そのまま編集できます）` }),
    ]));

    // 設定1が使えない機種があることを明示（該当台は設定1を選んでも2が入る）
    const noOne = [...new Set(st.allUnits.filter((u) => u.sec && minOf(u) > 1).map((u) => shortModel(u.model)))];
    if (noOne.length) {
      body.appendChild(el("div", { class: "hint", style: "font-size:11.5px", html:
        `⚠ <b>設定1が使えない機種</b>（設定1にするとパネルが消灯するため最低設定2）：` +
        `${noOne.join(" / ")} — 設定1を選んでクリックしても設定2が入ります。` +
        `対象機種の追加・解除は<b>出玉率タブ</b>の「最低設定」列で行えます。` }));
    }

    // ── データ元の明示（アウト/コイン単価=機種分析、出玉率=取込） ──
    const cu = curUnits();
    const realN = cu.filter((u) => u.payout).length;
    body.appendChild(el("div", { class: "hint", style: "font-size:11.5px", html:
      `データ元：<b>アウト・コイン単価</b>＝機種分析の実績（台ごと） ／ <b>出玉率</b>＝出玉率タブの取込値` +
      `（この区分 ${realN}/${cu.length}台が取込実データ${realN < cu.length ? "、残りはタイプ既定" : "＝全台実データ"}）。台にマウスを乗せると各値を確認できます。` }));

    // ── 前日比較の凡例 ──
    if (st.prev) {
      const changedN = mergedPlacement().filter((p) => p.changed).length;
      body.appendChild(el("div", { class: "row", style: "gap:10px;flex-wrap:wrap;align-items:center;font-size:12px" }, [
        el("span", { style: "font-weight:700", text: `📅 ${st.prev.target_date} と比較：` }),
        el("span", { style: "display:inline-flex;align-items:center;gap:4px" }, [el("span", { style: "display:inline-block;width:14px;height:14px;border:2.5px solid #e5484d;border-radius:3px" }), el("span", { text: `変更する台 ${changedN}台（色付き・太枠）` })]),
        el("span", { style: "display:inline-flex;align-items:center;gap:4px" }, [el("span", { style: "display:inline-block;width:14px;height:14px;border:1px solid var(--line);background:#fff;border-radius:3px" }), el("span", { text: "据え置き（白・目立たない）" })]),
        el("span", { class: "hint", text: "▲＝上げ ▼＝下げ。色付きの台だけ設定変更すればOK" }),
      ]));
    }

    // ── 島図（デフォルト表示・全台） ──
    const placement = mergedPlacement();
    const unitByDai = new Map(st.allUnits.filter((u) => u.sec).map((u) => [u.dai, u]));
    if (st.layout.length) {
      body.appendChild(buildPlacementMap(st.layout, placement, {
        // 区分を切り替えなくても全台に投入できる。20スロ/5スロ/2スロを行き来する手間をなくす。
        editable: (dai) => unitByDai.has(dai),
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
      }));
    } else {
      body.appendChild(el("div", { class: "placeholder", text: "島図タブで島図Excelを取込むと、ここに配置図が表示されます。" }));
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

  // 🎲 各島に1台（10台以上の島は2台）、選択設定をランダム投入。
  // ・区分ごとに予算（計画粗利）を下回らない範囲へ自動で収める
  // ・「ジャグラーに多め」ONならジャグラー系の島を優先
  // 対象は全区分。日付をまたぐ一括作成からも同じ関数を使う。
  function buildRandomAssign(targets, brush = st.brush) {
    const isJug = (u) => /ジャグラー|ジャグ/.test(String(u.model).normalize("NFKC"));
    const assign = {};
    let placed = 0, skipped = 0, islandCount = 0;
    for (const sec of sSections) {
      const units = st.allUnits.filter((u) => u.secKey === sec.key);
      if (!units.length) continue;
      const islands = islandsOf(units);
      islandCount += islands.length;

      // 島ごとの候補（投入したい台）を作る。ジャグラー優先ONなら台数を上乗せ。
      const picks = [];
      for (const pool of islands) {
        const jugPool = pool.filter(isJug);
        const jugIsland = st.jugMore && jugPool.length >= Math.max(2, pool.length / 2);
        let n = pool.length >= 10 ? 2 : 1;
        if (jugIsland) n = Math.min(pool.length, n + 1); // ジャグラー島は1台増
        const src = st.jugMore && jugPool.length ? shuffle([...jugPool]).concat(shuffle(pool.filter((u) => !isJug(u)))) : shuffle([...pool]);
        picks.push({ list: src.slice(0, n), jug: jugIsland });
      }

      // 予算内に収める: 全台を最低設定にした状態を基準に、粗利の下がり幅が小さい台から順に採用。
      // 基準を設定1固定にすると、その機種で到達できない粗利を前提に枠を計算してしまう。
      const target = targets[sec.key] || 0;
      const cand = picks.flatMap((p) => p.list.map((u) => {
        const to = clampSetting(brush, minOf(u));
        return { u, jug: p.jug, to, drop: unitGross(u, minOf(u)) - unitGross(u, to) };
      })).filter((c) => c.to > minOf(c.u)); // 既に最低設定と同じなら投入する意味がない
      // ジャグラー優先時はジャグラーを先に、それ以外はコスト（粗利減）が小さい順
      cand.sort((a, b) => (st.jugMore && a.jug !== b.jug ? (a.jug ? -1 : 1) : a.drop - b.drop));

      const A = {};
      let total = 0;
      for (const u of units) total += unitGross(u, minOf(u)); // 全台を最低設定にしたときの粗利
      const baseGross = total;
      // 予算枠: 計画粗利を下回らない範囲。最低設定で既に計画割れの区分は投入不能に
      // なってしまうため、その場合は現状粗利の95%までを許容枠とする。
      const floor = target && baseGross >= target ? target : baseGross * 0.95;
      for (const c of cand) {
        if (total - c.drop < floor) { skipped++; continue; } // 枠割れは見送り
        A[c.u.dai] = c.to; total -= c.drop; placed++;
      }
      assign[sec.key] = A;
    }
    return { assign, placed, skipped, islands: islandCount };
  }

  function randomPerRow() {
    const r = buildRandomAssign(st.targets);
    st.assign = r.assign;
    render();
    toast(`全区分 ${r.islands}島に 設定${st.brush}${TROPHY[st.brush] || ""} を計${r.placed}台投入`
      + (r.skipped ? `（予算に収めるため${r.skipped}台見送り）` : "")
      + (st.jugMore ? "・ジャグラー優先" : ""), "ok");
  }

  // 📅 まとめて作成: 指定日から日数分をまとめて作って保存する。
  // 毎日ゼロから組むのは現実的でないため、たたき台を先に作って後から個別に直す運用にする。
  function openBulk() {
    const startInp = el("input", { type: "date", value: st.date, style: "width:150px" });
    const daysInp = el("input", { type: "number", value: 30, min: 1, max: 62, style: "width:80px" });
    const modeSel = el("select", { class: "inp", style: "width:230px" }, [
      el("option", { value: "random", text: "日ごとにランダム生成", selected: "selected" }),
      el("option", { value: "copy", text: "今の配置をそのままコピー" }),
    ]);
    const overwrite = el("input", { type: "checkbox", style: "cursor:pointer" });
    const log = el("div", { class: "hint", style: "min-height:18px" });
    const runBtn = el("button", { class: "btn primary", text: "作成して保存" });

    const close = modal("1か月分をまとめて作成", el("div", { class: "col", style: "gap:10px;min-width:min(460px,86vw)" }, [
      el("p", { class: "hint", style: "margin:0", text: "たたき台をまとめて作ります。作成後は日付を切り替えて個別に直せます。" }),
      el("div", { class: "row", style: "gap:8px;flex-wrap:wrap;align-items:flex-end" }, [
        el("div", {}, [el("label", { class: "lbl", text: "開始日" }), startInp]),
        el("div", {}, [el("label", { class: "lbl", text: "日数" }), daysInp]),
        el("div", {}, [el("label", { class: "lbl", text: "作り方" }), modeSel]),
      ]),
      el("label", { class: "row", style: "gap:6px;align-items:center;cursor:pointer;font-size:13px" },
        [overwrite, el("span", { text: "保存済みの日も上書きする（既定は空いている日だけ作成）" })]),
      el("p", { class: "hint", style: "margin:0;font-size:11.5px", text: "各日の計画粗利は予実タブの計画から読みます。計画が無い日は現状比95%を上限に投入します。" }),
      log,
    ]), el("div", { class: "row", style: "justify-content:flex-end;gap:8px;margin-top:10px" }, [
      el("button", { class: "btn ghost", text: "やめる", onclick: () => close() }), runBtn,
    ]));

    runBtn.onclick = async () => {
      const days = Math.max(1, Math.min(62, Number(daysInp.value) || 30));
      const start = startInp.value;
      if (!start) { log.textContent = "開始日を入れてください。"; return; }
      runBtn.disabled = true;
      try {
        // 期間ぶんの計画をまとめて取得（1日ずつ問い合わせると回数が増えるため）
        const [plans, machines] = await Promise.all([
          repo.select("plan_day", { eq: { store_id: state.storeId } }),
          repo.select("machines_day", { eq: { store_id: state.storeId } }),
        ]);
        const done = new Set(st.sessions.filter((s) => s.allocation?.assign).map((s) => s.target_date));
        let made = 0, skipped = 0;
        for (let i = 0; i < days; i++) {
          const date = addDays(start, i);
          if (!overwrite.checked && done.has(date)) { skipped++; continue; }
          const targets = {};
          for (const sec of sSections) {
            const p = plans.find((r) => r.ymd === date && r.section_id === sec.id);
            const m = machines.find((r) => r.ymd === date && r.section_id === sec.id);
            targets[sec.key] = p ? planCalc(p, m?.count).gross : 0;
          }
          const assign = modeSel.value === "copy"
            ? JSON.parse(JSON.stringify(st.assign))
            : buildRandomAssign(targets).assign;
          await saveDay(date, assign, targets);
          made++;
          log.textContent = `作成中… ${made}日ぶん（スキップ${skipped}）`;
        }
        st.sessions = await repo.select("sim_session", { eq: { store_id: state.storeId } });
        close();
        toast(`${made}日ぶん作成しました${skipped ? `（保存済み${skipped}日はそのまま）` : ""}`, "ok");
        render();
      } catch (e) { errorToast(e); runBtn.disabled = false; }
    };
  }

  // 設定1不可（最低設定2）の機種を選ぶ。出玉率タブの「最低設定」列と同じ設定を編集する。
  function openMinEditor() {
    const models = [...new Set(st.allUnits.map((u) => u.model))].filter(Boolean)
      .sort((a, b) => (a < b ? -1 : 1));
    const draft = { ...st.minSaved };
    const list = el("div", { class: "col", style: "gap:2px;max-height:56vh;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:6px" });
    const rows = models.map((m) => {
      const cb = el("input", { type: "checkbox", style: "cursor:pointer" });
      cb.checked = st.min.of(m) > 1;
      cb.onchange = () => { draft[m] = cb.checked ? 2 : 1; };
      const n = st.allUnits.filter((u) => u.model === m).length;
      const row = el("label", { class: "row", style: "gap:8px;align-items:center;cursor:pointer;padding:2px 4px;font-size:13px" }, [
        cb, el("span", { class: "grow", text: shortModel(m) }), el("span", { class: "hint", text: `${n}台` }),
      ]);
      return { m, row, cb };
    });
    const filter = el("input", { type: "text", placeholder: "機種名で絞り込み", style: "width:100%",
      oninput: (e) => { const q = e.target.value.normalize("NFKC"); rows.forEach((r) => { r.row.style.display = !q || r.m.normalize("NFKC").includes(q) ? "" : "none"; }); } });
    rows.forEach((r) => list.appendChild(r.row));
    const close = modal("設定1が使えない機種", el("div", { class: "col", style: "gap:8px;min-width:min(460px,86vw)" }, [
      el("p", { class: "hint", style: "margin:0", text: "設定1にするとパネルが消灯し、外から設定1と分かってしまう機種にチェックを入れてください。チェックした機種は最低設定2になり、シミュレーターが設定1を割り当てません。" }),
      filter, list,
    ]), el("div", { class: "row", style: "justify-content:flex-end;gap:8px;margin-top:10px" }, [
      el("button", { class: "btn ghost", text: "やめる", onclick: () => close() }),
      el("button", { class: "btn primary", text: "保存", onclick: async () => {
        try {
          setSaveState("saving");
          await repo.upsert("app_setting", { store_id: state.storeId, key: "settei_min", value: draft }, { onConflict: ["store_id", "key"] });
          st.minSaved = draft; st.min = buildMinSetting(draft);
          setSaveState("saved"); close(); render();
          toast(`設定1不可の機種を保存しました（${models.filter((m) => st.min.of(m) > 1).length}機種）`, "ok");
        } catch (e) { errorToast(e); }
      } }),
    ]));
  }

  // 配置島図をA4横で印刷（表=1F / 裏=BF、両面印刷で1枚に）
  function printPlacement() {
    const placement = mergedPlacement();
    const floors = [...new Set(st.layout.map((l) => l.floor))];
    const nodes = floors.map((fl, i) => el("div", { class: "floor" + (i > 0 ? " page-break" : "") }, [
      el("h3", { text: `設定投入配置 ${st.date} — ${fl}` }),
      buildLegend(placement),
      el("div", { style: "height:6px" }),
      buildPlacementFloor(st.layout, placement, fl),
    ]));
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

  async function save() {
    try {
      setSaveState("saving");
      await saveDay(st.date, st.assign);
      st.sessions = await repo.select("sim_session", { eq: { store_id: state.storeId } });
      st.savedAt = new Date().toISOString();
      setSaveState("saved"); toast(`${st.date} の設定を保存しました`, "ok");
      render();
    } catch (e) { errorToast(e); }
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

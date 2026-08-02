import { el, clear } from "../../util/dom.js";
import { repo } from "../../core/repo.js";
import { state, loadSections } from "../../core/state.js";
import { toast, errorToast, setSaveState } from "../../core/errors.js";
import { yen, pct, num, shortModel } from "../../util/format.js";
import { planCalc } from "../../calc/planCalc.js";
import { loadCurrentPeriod, loadSnapshotRows } from "../snapshotData.js";
import { computeMachine, TYPES, sectionL, sectionTanka } from "./economics.js";
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
    section: sSections[0], date: new Date().toISOString().slice(0, 10), L: 5, K: 5, target: 0, targets: {},
    allUnits: [], layout: [], brush: 4, ex: {}, prev: null, diffOn: true, jugMore: false,
    assign: {}, // 区分キー → { 台番: 設定 }。未指定は設定1。区分を切替えても保持
  };

  const ctrl = el("div", { class: "row", style: "gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px" });
  host.appendChild(ctrl);
  const secChips = sSections.map((s) => el("button", { class: "btn sm", text: s.label, onclick: () => { st.section = s; sync(); reload(); } }));
  ctrl.appendChild(el("div", {}, [el("label", { class: "lbl", text: "区分（編集対象）" }), el("div", { class: "row", style: "gap:4px" }, secChips)]));
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
    for (const s of specs) { const a = specMap.get(s.model_name) || new Array(6).fill(null); if (s.setting >= 1 && s.setting <= 6) a[s.setting - 1] = s.payout_rate; specMap.set(s.model_name, a); }
    const typeSetting = (await repo.select("app_setting", { eq: { store_id: state.storeId, key: "settei_types" } }))[0]?.value || {};
    st.layout = await repo.select("layout_cell", { eq: { store_id: state.storeId } });

    // 前日比較用: 対象日より前で最新の保存済みシミュレーション（新形式assignのみ）
    const sessions = await repo.select("sim_session", { eq: { store_id: state.storeId } });
    const prevs = sessions.filter((s) => s.target_date && s.target_date < st.date && s.allocation?.assign);
    prevs.sort((a, b) => (a.target_date === b.target_date
      ? ((a.created_at || "") < (b.created_at || "") ? 1 : -1)
      : (a.target_date < b.target_date ? 1 : -1)));
    st.prev = prevs[0] || null;

    const secById = new Map(state.sections.map((s) => [s.id, s]));
    st.allUnits = snap.map((r) => {
      const sec = secById.get(r.section_id);
      return {
        dai: r.dai_no, model: r.model_name, out: r.out_val || 0,
        coin: r.out_val ? (+(r.sales / r.out_val).toFixed(3) || 3.0) : 3.0,
        group: groupOf(r.model_name, typeSetting[r.model_name]),
        sec, secKey: sec?.key, secLabel: sec?.label || "?",
        payout: (specMap.get(r.model_name) && specMap.get(r.model_name).every((x) => x != null)) ? specMap.get(r.model_name) : null,
      };
    });
    render();
  }

  const curUnits = () => st.allUnits.filter((u) => u.secKey === st.section.key);
  const curAssign = () => (st.assign[st.section.key] = st.assign[st.section.key] || {});
  const settingOf = (u) => (st.assign[u.secKey] || {})[u.dai] || 1;
  // 前日（保存済みの直近シミュ）の設定。比較不能ならnull。
  const prevSettingOf = (u) => { const pa = st.prev?.allocation?.assign; return pa ? ((pa[u.secKey] || {})[u.dai] || 1) : null; };
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

  // 島図表示用: 全区分・全台（未指定は設定1）。編集対象区分以外は薄表示。
  function mergedPlacement() {
    const diff = st.diffOn && st.prev;
    return st.allUnits.filter((u) => u.sec).map((u) => {
      const s = settingOf(u);
      const editable = u.secKey === st.section.key;
      const prevSet = prevSettingOf(u);
      const changed = diff && prevSet != null && prevSet !== s;
      return {
        dai: u.dai, model: shortModel(u.model), setting: s, secLabel: u.secLabel, color: sectionColor(u.sec),
        prevSetting: diff ? prevSet : null, changed, dim: diff && !changed,
        tip: [
          `アウト ${num(u.out)}・コイン単価 ${u.coin}（機種分析）`,
          `出玉率(設定${s}) ${curveOf(u)[s - 1]}%（${u.payout ? "取込実データ" : "タイプ既定"}）`,
          editable ? `台粗利 ${yen(Math.round(unitGross(u, s)))}` : "",
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
        anySet ? setBadges(tt.bySet) : el("div", { class: "hint", style: "margin-top:4px", text: "投入設定なし（全台1）" }),
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
      el("button", { class: "btn ghost", text: `${st.section.label}を全台設定1に戻す`, onclick: () => { st.assign[st.section.key] = {}; render(); } }),
    ]);
    if (st.prev) {
      opRow.appendChild(el("button", {
        class: "btn sm " + (st.diffOn ? "primary" : "ghost"),
        text: `🔺前日比較 ${st.diffOn ? "ON" : "OFF"}`,
        title: `${st.prev.target_date} の保存内容と比較`,
        onclick: () => { st.diffOn = !st.diffOn; render(); },
      }));
    }
    opRow.appendChild(el("div", { class: "grow" }));
    opRow.appendChild(el("button", { class: "btn ghost", text: "保存", onclick: save }));
    opRow.appendChild(el("button", { class: "btn sm", text: "🖨 印刷（A4 表1F/裏BF）", onclick: printPlacement }));
    body.appendChild(opRow);

    // ── 設定パレット（選んで台をクリックで投入） ──
    body.appendChild(el("div", { class: "row", style: "gap:6px;flex-wrap:wrap;align-items:center" }, [
      el("span", { class: "hint", style: "font-weight:700", text: "投入する設定を選択 →" }),
      ...[1, 2, 3, 4, 5, 6].map((s) => el("button", {
        class: "btn sm",
        style: `background:${SET_COLORS[s]};color:#333a46;border:2px solid ${s === st.brush ? "var(--accent)" : "var(--line)"};font-weight:${s === st.brush ? "800" : "600"};min-width:74px`,
        text: `設定${s}${TROPHY[s] || ""}${s === st.brush ? " ✓" : ""}`,
        onclick: () => { st.brush = s; render(); },
      })),
      el("span", { class: "hint", text: `台をクリックすると設定${st.brush}が入ります（${st.section.label}のみ編集可）` }),
    ]));

    // ── データ元の明示（アウト/コイン単価=機種分析、出玉率=取込） ──
    const cu = curUnits();
    const realN = cu.filter((u) => u.payout).length;
    body.appendChild(el("div", { class: "hint", style: "font-size:11.5px", html:
      `データ元：<b>アウト・コイン単価</b>＝機種分析の実績（台ごと） ／ <b>出玉率</b>＝出玉率タブの取込値` +
      `（この区分 ${realN}/${cu.length}台が取込実データ${realN < cu.length ? "、残りはタイプ既定" : "＝全台実データ"}）。台にマウスを乗せると各値を確認できます。` }));

    // ── 前日比較の凡例 ──
    if (st.prev && st.diffOn) {
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
    const editSet = new Set(curUnits().map((u) => u.dai));
    if (st.layout.length) {
      body.appendChild(buildPlacementMap(st.layout, placement, {
        editable: (dai) => editSet.has(dai),
        onCellClick: (dai) => {
          const A = curAssign();
          A[dai] = st.brush; // 選択中の設定を置く（消すには設定1を選んでクリック）
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
  // ・予算（計画粗利）を下回らない範囲に自動で収める
  // ・「ジャグラーに多め」ONならジャグラー系の島を優先
  function randomPerRow() {
    const units = curUnits();
    const islands = islandsOf(units);
    const isJug = (u) => /ジャグラー|ジャグ/.test(String(u.model).normalize("NFKC"));

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

    // 予算内に収める: 全台設定1を基準に、粗利の下がり幅が小さい台から順に採用。
    const base = {};
    const target = st.target || 0;
    const cand = picks.flatMap((p) => p.list.map((u) => ({ u, jug: p.jug, drop: unitGross(u, 1) - unitGross(u, st.brush) })));
    // ジャグラー優先時はジャグラーを先に、それ以外はコスト（粗利減）が小さい順
    cand.sort((a, b) => (st.jugMore && a.jug !== b.jug ? (a.jug ? -1 : 1) : a.drop - b.drop));

    const A = {};
    let total = 0;
    for (const u of units) total += unitGross(u, 1); // 全台設定1の粗利
    const baseGross = total;
    // 予算枠: 計画粗利を下回らない範囲。ただし全台設定1で既に計画割れの区分は
    // 投入不能になってしまうため、その場合は現状粗利の95%までを許容枠とする。
    const floor = target && baseGross >= target ? target : baseGross * 0.95;
    let placed = 0, skipped = 0;
    for (const c of cand) {
      if (total - c.drop < floor) { skipped++; continue; } // 枠割れは見送り
      A[c.u.dai] = st.brush; total -= c.drop; placed++;
    }
    st.assign[st.section.key] = A;
    render();
    const limitTxt = target && baseGross >= target ? "計画粗利内" : "現状比95%以内";
    const msg = `${islands.length}島に 設定${st.brush}${TROPHY[st.brush] || ""} を計${placed}台投入`
      + (skipped ? `（${limitTxt}に収めるため${skipped}台見送り）` : `（${limitTxt}）`)
      + (st.jugMore ? "・ジャグラー優先" : "");
    toast(msg, "ok");
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

  async function save() {
    try {
      setSaveState("saving");
      const T = totals();
      await repo.upsert("sim_session", { store_id: state.storeId, target_date: st.date, plan_gross: Math.round(st.target),
        allocation: { section: st.section.key, L: st.L, K: st.K, assign: st.assign,
          expectedGross: Math.round(T.gross), expectedSales: Math.round(T.sales), bySet: T.bySet },
        reason: `${st.section.label}: 予想粗利${Math.round(T.gross)}/計画${Math.round(st.target)}`, status: "draft" }, { onConflict: ["id"] });
      setSaveState("saved"); toast("保存しました", "ok");
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

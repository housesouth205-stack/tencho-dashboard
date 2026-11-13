import { el, clear } from "../../util/dom.js";
import { repo } from "../../core/repo.js";
import { state, loadSections } from "../../core/state.js";
import { toast, errorToast, setSaveState } from "../../core/errors.js";
import { num } from "../../util/format.js";
import { TYPES, TYPE_KEYS, round1, fmt1 } from "../simulator/economics.js";
import { loadCurrentPeriod, loadSnapshotRows } from "../snapshotData.js";
import { buildMinSetting, MIN_CHOICES } from "../simulator/minSetting.js";
import { guessType } from "./autofill.js";
import { rateKeyOfDai } from "../../core/daiSection.js";
import { loadTable, importPayoutTable } from "./tableSource.js";
import { linkSupported, pickAndLink, readLinked, unlink } from "./linkedFile.js";

const SRC_LABEL = {
  manual: "手動", "dmm-per6": "Web実測", "dmm-range": "Web推定",
  "db-per6": "機種DB", "db-range": "機種DB推定", default: "未登録",
  // 保存済みの由来（model_spec.source）。島図取込の自動補完で入ったものを「手動」と見せないため
  db: "機種DB", web: "Web", file: "出玉率表",
};
let filterText = "", onlyUnreg = false;

export async function mount(host) {
  await loadSections();
  clear(host);
  host.appendChild(el("div", { class: "view-title" }, [el("h1", { text: "出玉率管理" }), el("small", { text: "機種×設定の出玉率(機械割)。シミュレーターが自動参照" })]));

  // 機種の一覧は島図を優先する。島図は入替のたびに取り込むので、台別CSV（前の期間の集計）より
  // 今の配置に近い。シミュレーターも島図の機種名で出玉率を引くので、ここも同じ名前で並べる。
  const islandModels = (await repo.select("app_setting", { eq: { store_id: state.storeId, key: "island_models" } }))[0]?.value || {};
  const islandMeta = (await repo.select("app_setting", { eq: { store_id: state.storeId, key: "island_meta" } }))[0]?.value || {};
  const useIsland = Object.keys(islandModels).length > 0;
  const period = useIsland ? null : await loadCurrentPeriod();
  if (!useIsland && !period) { host.appendChild(el("div", { class: "placeholder", text: "「取込」タブで島図Excelか遊技台個別CSVを取込むと、機種一覧が表示されます。" })); return; }
  const secByKey = new Map(state.sections.map((s) => [s.key, s]));
  const snap = useIsland
    ? Object.entries(islandModels).map(([dai, model]) => ({ dai_no: Number(dai), model_name: model, section_label: secByKey.get(rateKeyOfDai(Number(dai)))?.label }))
    : await loadSnapshotRows(period.id);
  const specs = await repo.select("model_spec", {});
  const specMap = new Map();
  const specSrc = new Map(specs.filter((x) => ["db", "web", "file"].includes(x.source)).map((x) => [x.model_name, x.source]));
  // 出玉率表から入れた機種は、どの表のどの機種名に当てたかを残しておく（状態列のカーソルで見える）
  const specUrl = new Map(specs.filter((x) => x.source_url).map((x) => [x.model_name, x.source_url]));
  for (const s of specs) { const a = specMap.get(s.model_name) || new Array(6).fill(null); if (s.setting >= 1 && s.setting <= 6) a[s.setting - 1] = round1(s.payout_rate); specMap.set(s.model_name, a); }
  const typeSetting = (await repo.select("app_setting", { eq: { store_id: state.storeId, key: "settei_types" } }))[0]?.value || {};
  // 設定1でパネルが消灯する機種の最低設定 {model: 1|2}。シミュレーターが参照する。
  const minSaved = (await repo.select("app_setting", { eq: { store_id: state.storeId, key: "settei_min" } }))[0]?.value || {};
  const minSetting = buildMinSetting(minSaved);
  const secLabel = new Map(state.sections.map((s) => [s.id, s.label]));

  const groups = new Map();
  for (const r of snap) {
    const g = groups.get(r.model_name) || { model: r.model_name, secs: new Set(), count: 0, minDai: r.dai_no };
    g.secs.add(r.section_label || secLabel.get(r.section_id) || "?"); g.count++;
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
    return { model: g.model, secs: [...g.secs].join("/"), count: g.count, minDai: g.minDai ?? 9999, type, payout, registered, source: registered ? (specSrc.get(g.model) || "manual") : "default", sourceUrl: specUrl.get(g.model) || null, note: specSrc.get(g.model) === "file" ? `出玉率表: ${specUrl.get(g.model) || ""}` : null, min: minSetting.of(g.model) };
  }).sort((a, b) => a.minDai - b.minDai);

  const bar = el("div", { class: "row", style: "gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px" });
  host.appendChild(bar);
  bar.appendChild(el("input", { type: "text", value: filterText, placeholder: "機種名で検索", style: "width:200px", oninput: (e) => { filterText = e.target.value; draw(); } }));
  bar.appendChild(chip("未登録のみ", () => onlyUnreg, () => { onlyUnreg = !onlyUnreg; draw(); }));
  // 「機種名からタイプ自動推定」「未登録にタイプ既定を適用」のボタンは外した。開いた時点で
  // タイプは機種名から推定済み、未登録の機種はタイプの標準値で表示済みなので、押しても何も変わらなかった。
  // 機種DB・Webからの一括取得は外した。出玉率は店長の出玉率表（PCのExcel）だけを使う。
  // 名前の似た別の機種の値が自動で入ることがあり、表のほうが確かで手間も少ないため。
  bar.appendChild(el("div", { class: "grow" }));
  bar.appendChild(el("button", { class: "btn primary", text: "保存", onclick: save }));
  const regSpan = el("span", { class: "hint" });
  bar.appendChild(regSpan);

  // 出玉率表と、埋め方の説明は畳める枠にまとめる。毎回開く画面の上に説明が並ぶと、肝心の表が下に押しやられる。
  // 機種一覧の出どころ（島図か台別データか）もここに入れる。毎回読む必要は無いが、機種が足りないときの手がかりになる。
  const listFrom = useIsland
    ? `機種の一覧は島図（${islandMeta.effectiveFrom || "日付不明"}から・${Object.keys(islandModels).length}台）の機種名です。島図を取り込むと入れ替わり、新しく入った機種は自動で埋めます。`
    : `機種の一覧は台別データ（${period.label || ""}）の機種名です。島図を取り込むと島図の機種に切り替わります。`;
  host.appendChild(await tableCard());
  host.appendChild(foldBox("howto", "出玉率の埋め方", null, el("div", { class: "col", style: "gap:6px" }, [
    el("div", { html:
      "ここで入れた出玉率を、シミュレーターがそのまま使います。入れ方は2つです。" }),
    el("ol", { style: "margin:0;padding-left:1.4em;display:flex;flex-direction:column;gap:4px", html:
      "<li>📄 <b>出玉率表</b>（PCのExcel）：上の「出玉率表」で参照するファイルを選んでおくと、Excelを保存し直すたびに、このタブを開いたとき自動で反映します。島図の入替で入った機種も表から埋めます。</li>" +
      "<li>✎ <b>手入力</b>：表のマスに直接打って「保存」。急ぎの1機種だけ直したいとき用。</li>" }),
    el("div", { html: "表に無い機種は「未登録」と出て、タイプの標準値で仮に計算します。<b>Excelに足して保存</b>してください。" }),
    el("div", { html: "表の機種名と店の機種名（型式名）が完全には一致しなかった機種は、状態の列に<b>一致率</b>を橙色で出します。そこだけ見直してください。" }),
    el("div", { html: "<b>空欄＝その機種にその設定は無い</b>。シミュレーターはその設定を入れず、1つ上の設定に寄せます。数字で埋めないでください。" }),
    el("div", { class: "hint", text: listFrom }),
  ])));

  // PCは表の中だけ縦に動かす（見出しが見えたまま）。スマホのカードは画面ごと縦に送る
  const tableHost = el("div", { style: window.matchMedia("(max-width: 700px)").matches ? "" : "overflow:auto;max-height:66vh" });
  host.appendChild(tableHost);

  function updateReg() { const reg = rows.filter((r) => r.registered).length; regSpan.textContent = `登録 ${reg}/${rows.length} 機種`; }

  const typeSelOf = (r) => el("select", { class: "inp", style: "width:92px", onchange: (e) => { r.type = e.target.value; if (!r.registered) r.payout = [...TYPES[r.type]]; draw(); } },
    TYPE_KEYS.map((k) => el("option", { value: k, text: k, selected: k === r.type ? "selected" : null })));
  // 最低設定: 2にするとシミュレーターがこの機種に設定1を割り当てなくなる
  const minSelOf = (r) => el("select", {
    // 幅は中身に合わせる。64px固定だと太字（設定2以上）のときに「設定2」の末尾が欠けていた
    class: "inp", style: `width:auto;min-width:64px${r.min > 1 ? ";border-color:var(--accent);font-weight:700" : ""}`,
    title: "設定1にするとパネルが消灯する機種は2にする",
    onchange: (e) => { r.min = Number(e.target.value); draw(); },
  }, MIN_CHOICES.map((v) => el("option", { value: v, text: `設定${v}`, selected: v === r.min ? "selected" : null })));
  // 出玉率は常に小数第1位で表示・保持（112 → 112.0、112.53 → 112.5）
  // 空欄＝その機種にその設定は無い。シミュレーターはその設定を割り当てなくなる。
  const payoutInp = (r, s, width) => el("input", {
    type: "number", step: "0.1", inputmode: "decimal", value: r.payout[s] == null ? "" : fmt1(r.payout[s]), placeholder: "なし",
    title: r.payout[s] == null ? "空欄＝この機種に設定" + (s + 1) + "は無い（投入されません）" : null,
    style: `width:${width};text-align:right`,
    onchange: (e) => {
      r.payout[s] = round1(e.target.value); // 空欄はnull＝設定なし
      r.registered = true; r.source = "manual";
      draw();
    },
  });
  // 名前が完全一致でなかった機種は一致率を併記する。取り違えに気づけるようにするため。
  const statusOf = (r) => {
    const inexact = r.matchScore != null && r.matchScore < 1;
    const color = !r.registered ? "var(--warn)" : inexact ? "var(--accent)" : (r.source === "manual" ? "var(--ok)" : "var(--blue)");
    const text = r.registered ? SRC_LABEL[r.source] + (inexact ? ` ${Math.round(r.matchScore * 100)}%` : "") : "未登録";
    return { color, text };
  };

  // スマホは1機種1行（名前は2行まで折り返し＋設定1〜6の入力欄）。1枚ずつのカードだと1画面に2機種しか
  // 入らず、見比べられなかった。文字は小さくなるが、機種の並びを一度に見られるほうを取った。
  // タイプ・最低設定は滅多に変えないので、スマホでは出さない（PCで変える）。
  function drawCards(list) {
    const t = el("table", { class: "po-mtable" }, [
      el("colgroup", {}, [el("col", { class: "po-mname" }), ...Array.from({ length: 6 }, () => el("col")), el("col", { class: "po-mst" })]),
      el("thead", {}, el("tr", {}, [el("th", { class: "txt", text: "機種" }), ...[1, 2, 3, 4, 5, 6].map((n) => el("th", { text: String(n) })), el("th")])),
    ]);
    const tb = el("tbody");
    for (const r of list) {
      const st = statusOf(r);
      // 状態は1文字分の幅しか無いので、見てほしいもの（未登録・一致率）だけ短く出す
      const short = !r.registered ? "未" : r.matchScore != null && r.matchScore < 1 ? `${Math.round(r.matchScore * 100)}%` : "";
      tb.appendChild(el("tr", {}, [
        el("td", { class: "txt" }, el("div", { class: "po-mname-in", title: r.model, text: r.model })),
        ...[0, 1, 2, 3, 4, 5].map((s) => el("td", { class: r.payout[s] == null ? "none" : "" }, payoutInp(r, s, "100%"))),
        el("td", { class: "po-mst", style: `color:${st.color}`, title: `${st.text}${r.note ? "\n" + r.note : ""}`, text: short }),
      ]));
    }
    t.appendChild(tb);
    if (!list.length) { tableHost.appendChild(el("div", { class: "placeholder", text: "該当する機種がありません" })); return; }
    tableHost.appendChild(t);
  }

  function draw() {
    for (const b of bar.querySelectorAll(".chip")) b.classList.toggle("primary", onlyUnreg), b.classList.toggle("ghost", !onlyUnreg);
    clear(tableHost);
    const q = filterText.trim().normalize("NFKC");
    const list = rows.filter((r) => (!onlyUnreg || !r.registered) && (!q || r.model.normalize("NFKC").includes(q)));
    // スマホは1機種1枚のカードにする。14列の表を横に動かすと、機種名と出玉率が同時に見えなかった
    if (window.matchMedia("(max-width: 700px)").matches) { drawCards(list); return; }
    const t = el("table", { class: "grid mono" });
    t.appendChild(el("thead", {}, el("tr", {}, ["台番", "機種名", "区分", "台数", "タイプ", "最低設定", "設定1", "設定2", "設定3", "設定4", "設定5", "設定6", "状態"].map((h, i) =>
      el("th", { class: i === 1 ? "txt" : "", title: h === "最低設定" ? "設定1にするとパネルが消灯する機種は2にする。シミュレーターが設定1を割り当てなくなる。" : null, text: h })))));
    const tb = el("tbody");
    for (const r of list) {
      const cells = [
        el("td", { style: "color:var(--fg-dim)", title: "この機種の先頭台番", text: r.minDai === 9999 ? "—" : num(r.minDai) }),
        el("td", { class: "txt", text: r.model }),
        el("td", { text: r.secs }), el("td", { text: num(r.count) }), el("td", {}, typeSelOf(r)), el("td", {}, minSelOf(r)),
      ];
      for (let s = 0; s < 6; s++) cells.push(el("td", { style: r.payout[s] == null ? "background:var(--panel-2)" : "" }, payoutInp(r, s, "62px")));
      const st = statusOf(r);
      cells.push(el("td", { style: `color:${st.color}`, title: r.note || null, text: st.text }));
      tb.appendChild(el("tr", {}, cells));
    }
    t.appendChild(tb);
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
        const src = s0.startsWith("db") ? "db" : s0.startsWith("dmm") || s0 === "web" ? "web" : s0 === "file" ? "file" : "manual";
        for (let s = 0; s < 6; s++) {
          specsOut.push({ model_name: r.model, setting: s + 1, payout_rate: round1(r.payout[s]), source: src, source_url: src === "db" || src === "file" ? r.sourceUrl || null : null });
        }
      }
      for (let i = 0; i < specsOut.length; i += 200) await repo.upsert("model_spec", specsOut.slice(i, i + 200), { onConflict: ["model_name", "setting"] });
      await repo.upsert("app_setting", { store_id: state.storeId, key: "settei_types", value: types }, { onConflict: ["store_id", "key"] });
      await repo.upsert("app_setting", { store_id: state.storeId, key: "settei_min", value: mins }, { onConflict: ["store_id", "key"] });
      rows.forEach((r) => { if (!r.registered) { r.registered = true; r.source = "manual"; } });
      setSaveState("saved"); toast("出玉率を保存しました", "ok"); updateReg(); draw();
    } catch (e) { errorToast(e); }
  }
}

function chip(label, isOn, onClick) { const b = el("button", { class: "btn sm chip " + (isOn() ? "primary" : "ghost"), text: label, onclick: onClick }); return b; }

// ---------------------------------------------------------------- 出玉率表（手元のファイル）
// 店長が作っている出玉率表を、取り込んだもの・参照しているファイルの両方からここで扱う。
const AUTO_KEY = "tencho.payoutAutoApply";
const autoOn = () => { try { return localStorage.getItem(AUTO_KEY) !== "0"; } catch { return true; } };
const setAuto = (v) => { try { localStorage.setItem(AUTO_KEY, v ? "1" : "0"); } catch { /* 覚えられなくても動く */ } };
const rerender = () => window.dispatchEvent(new HashChangeEvent("hashchange"));
const ymdhm = (t) => { if (!t) return "—"; const d = new Date(t); return isNaN(d) ? "—" : `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };

// 畳める枠。開け閉めはこの端末に覚える（毎回開き直さなくて済むように）。
// forceOpen は、読んでほしいこと（ファイルが更新された等）があるときだけ開いて見せる。
const FOLD_KEY = "tencho.payoutFold.";
function foldBox(key, title, summaryNote, body, { forceOpen = false, defaultOpen = false } = {}) {
  let open = defaultOpen;
  try { const v = localStorage.getItem(FOLD_KEY + key); if (v != null) open = v === "1"; } catch { /* 覚えられなくても動く */ }
  const note = el("span", { class: "hint po-fold-note" });
  if (summaryNote) note.append(summaryNote);
  const d = el("details", { class: "card po-fold", open: open || forceOpen ? "" : null }, [
    el("summary", {}, [el("b", { text: title }), note]), el("div", { class: "po-fold-body" }, body),
  ]);
  d.addEventListener("toggle", () => { try { localStorage.setItem(FOLD_KEY + key, d.open ? "1" : "0"); } catch { /* 同上 */ } });
  d.setNote = (text, color) => { note.textContent = text; note.style.color = color || ""; };
  return d;
}

async function tableCard() {
  const saved = await loadTable().catch(() => null);
  const status = el("div", { class: "col", style: "gap:4px" });
  const btns = el("div", { class: "row", style: "gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px" });
  const body = el("div", {}, [
    el("div", { text: "店長が作った出玉率表（機種名＋設定1〜6）。機種DB・Webより優先します。島図の入替で入った機種も、まずこの表から埋めます。" }),
    status, btns,
  ]);
  // 閉じていても今の様子が分かるよう、見出しの横に一言出す
  const card = foldBox("table", "📄 出玉率表", saved ? `${saved.file}（${saved.entries.length}機種）` : "未取込", body, { defaultOpen: !saved });

  status.appendChild(el("div", { class: "hint", text: saved
    ? `反映した表：${saved.file}（${saved.entries.length}機種・${ymdhm(saved.importedAt)}に取込${saved.lastModified ? `・ファイルの更新 ${ymdhm(saved.lastModified)}` : ""}）`
    : "まだ取り込んでいません。右上の「📂 取込」に表を入れるか、下のボタンでPCのファイルを選んでください。" }));
  if (saved) {
    btns.appendChild(el("button", { class: "btn sm", text: "表を機種に当て直す", title: "入替で機種が変わったときや、要確認の機種を選び直すとき",
      onclick: () => importPayoutTable({ entries: saved.entries, file: saved.file, lastModified: saved.lastModified, onDone: rerender }).catch(errorToast) }));
  }

  if (!linkSupported()) {
    status.appendChild(el("div", { class: "hint", text: "このブラウザ（iPhone・Safari等）はPCのファイルを参照できません。PCのChrome・Edgeで開くと、デスクトップの表の更新を自動で取り込めます。" }));
    return card;
  }
  const link = await readLinked();
  const linkLine = el("div", { class: "hint" });
  status.appendChild(linkLine);
  const readNow = async () => {
    try {
      const r = await readLinked({ interactive: true });
      if (r.state !== "ok") { toast(r.state === "missing" ? `「${r.name}」が見つかりません。移動・名前変更したなら選び直してください` : "ファイルを読む許可がありません", "err"); return; }
      const { importPayoutFile } = await import("../import/anyImport.js");
      await importPayoutFile(r.file, null, rerender);
    } catch (e) { errorToast(e); }
  };
  if (link.state === "none") {
    linkLine.textContent = "参照するファイル：未設定。PCの出玉率表を一度選んでおくと、次からはこのタブを開くだけで更新を取り込みます。";
    btns.appendChild(el("button", { class: "btn sm primary", text: "📁 参照するファイルを選ぶ", onclick: async () => {
      try { await pickAndLink(); await readNow(); } catch (e) { if (e?.name !== "AbortError") errorToast(e); }
    } }));
    return card;
  }
  const changed = link.state === "ok" && (!saved || saved.file !== link.file.name || (link.file.lastModified || 0) > (saved.lastModified || 0));
  linkLine.textContent = `参照するファイル：${link.name}` + ({
    ok: `（更新 ${ymdhm(link.file?.lastModified)}${changed ? "・まだ反映していない更新があります" : "・反映済み"}）`,
    prompt: "（ブラウザを開き直したので、読む許可がいります。「今すぐ読み込む」を押してください）",
    denied: "（読む許可がありません。「今すぐ読み込む」で許可してください）",
    missing: "（ファイルが見つかりません。移動・名前変更したなら選び直してください）",
  }[link.state] || "");
  // 手を動かしてほしいときは、閉じていても開いて見せる
  const needs = changed || link.state !== "ok";
  if (needs) { linkLine.style.color = "var(--warn-fg)"; card.open = true; }
  card.setNote(changed ? "更新あり" : link.state === "ok" ? `${link.name}・反映済み` : "要操作", needs ? "var(--warn-fg)" : "");
  const auto = el("input", { type: "checkbox", checked: autoOn() ? "" : null, onchange: (e) => setAuto(e.target.checked) });
  btns.append(
    el("button", { class: "btn sm primary", text: "今すぐ読み込む", onclick: readNow }),
    el("button", { class: "btn sm ghost", text: "参照するファイルを変更", onclick: async () => {
      try { await pickAndLink(); await readNow(); } catch (e) { if (e?.name !== "AbortError") errorToast(e); }
    } }),
    el("button", { class: "btn sm ghost", text: "参照をやめる", onclick: async () => { await unlink(); rerender(); } }),
    el("label", { class: "row hint", style: "gap:4px;align-items:center" }, [auto, "開いたとき、更新されていれば自動で反映"]),
  );
  // タブを開いたとき、ファイルが更新されていれば聞かずに反映する（自動で当たる機種だけ）。
  // 許可が切れているときは読めないので、上の案内とボタンに任せる。
  if (changed && autoOn()) {
    setTimeout(async () => {
      try {
        const { importPayoutFile } = await import("../import/anyImport.js");
        await importPayoutFile(link.file, null, rerender, { silent: true });
      } catch (e) { errorToast(e); }
    }, 0);
  }
  return card;
}

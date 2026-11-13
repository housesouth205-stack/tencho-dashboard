// 島図Excelの取込と入替履歴。もとは島図タブにあったが、島図の閲覧を
// 設定投入シミュレーターへ統合したため、取込まわりは取込タブへ移した。
import { el, modal } from "../../util/dom.js";
import { repo } from "../../core/repo.js";
import { state } from "../../core/state.js";
import { checkIslandRules } from "../../core/config.js";
import { toast, errorToast, setSaveState } from "../../core/errors.js";
import { num } from "../../util/format.js";
import { localYmd } from "../../util/dates.js";
import { parseIslandXlsx } from "../../import/islandXlsx.js";
import { autoFillModels } from "../payout/autofill.js";

const loadMeta = async () =>
  (await repo.select("app_setting", { eq: { store_id: state.storeId, key: "island_meta" } }))[0]?.value || {};

// 取込前に「いつからの島図か」を聞く。既定は今日。
// 読めた台数もここで見せる。今の島図より大きく減るときは、置き換える前に必ず目に入るようにする
// （島図でない表を入れると、台が数十台しかない島図に黙って置き換わったことがあった）。
function askEffectiveFrom(fileName, counts, current) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const shrink = current > 0 && counts.total < current * 0.8;
    const inp = el("input", { type: "date", value: localYmd(), style: "width:170px;font-size:15px;padding:6px" });
    const ok = el("button", { class: "btn primary", text: shrink ? "それでも置き換える" : "この日付で取込む", onclick: () => { finish(inp.value || null); close(); } });
    const cancel = el("button", { class: "btn ghost", text: "やめる", onclick: () => close() });
    const close = modal("島図の適用開始日", el("div", { class: "col", style: "gap:10px" }, [
      el("p", { class: "hint", style: "margin:0", text: `取込むファイル: ${fileName}` }),
      el("p", { style: "margin:0", text: `読めた台数：${counts.total}台（1F ${counts.f1}／BF ${counts.bf}）${current ? `　今の島図：${current}台` : ""}` }),
      shrink ? el("div", { class: "card", style: "margin:0;border-left:3px solid #e35d6a;color:#e35d6a;font-weight:700", text:
        `今の島図（${current}台）より大きく減ります。島図Excelではないファイル（出玉率表など）を選んでいないか確かめてください。置き換えると今の配置は消えます。` }) : null,
      el("p", { style: "margin:0" }, [el("b", { text: "この島図はいつからの配置ですか？" })]),
      el("div", {}, [el("label", { class: "lbl", text: "適用開始日（入替日）" }), inp]),
      el("p", { class: "hint", style: "margin:0;font-size:11.5px", text: "記録した日付は入替履歴として残ります。" }),
    ].filter(Boolean)), el("div", { class: "row", style: "justify-content:flex-end;gap:8px;margin-top:12px" }, [cancel, ok]), { onClose: () => finish(null) });
    setTimeout(() => inp.focus(), 50);
  });
}

// 入替履歴（いつからの島図か）を一覧表示
export async function showIslandHistory() {
  const meta = await loadMeta();
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
  // 控え（取り込む前の島図）。ここから台のレイアウトと機種をまとめて戻せる
  const backups = await loadBackups().catch(() => []);
  let close = () => {};
  const bk = el("div", { class: "col", style: "gap:6px;margin-top:6px" }, [
    el("h3", { style: "margin:4px 0 0", text: "前の島図に戻す" }),
    el("p", { class: "hint", style: "margin:0", text: backups.length
      ? "島図を取り込む前の台のレイアウトと機種を、新しい順に最大5件残しています。間違ったファイルを取り込んだときに使います。"
      : "まだ控えがありません（この仕組みを入れた後に島図を取り込むと、取り込む前の状態が残ります）。" }),
    ...backups.map((b) => el("div", { class: "row card", style: "gap:8px;align-items:center;flex-wrap:wrap;margin:0;padding:6px 10px" }, [
      el("b", { text: `${b.effectiveFrom || "日付不明"}から適用の島図` }),
      el("span", { class: "hint", text: `${b.total}台（1F ${b.f1}／BF ${b.bf}）・${b.file || "ファイル不明"}・控え ${(b.savedAt || "").slice(0, 16).replace("T", " ")}（${b.reason || ""}）` }),
      el("div", { class: "grow" }),
      el("button", { class: "btn sm", text: "この島図に戻す", onclick: async () => { if (await restoreBackup(b)) close(); } }),
    ])),
  ]);
  close = modal("島図の入替履歴", el("div", { class: "col" }, [
    el("p", { class: "hint", style: "margin:0", text: rows.length
      ? "取込のたびに記録されます。使われるのは最新（先頭行）の島図です。"
      : "まだ島図Excelを取り込んでいません。" }),
    el("div", { style: "overflow:auto;max-height:40vh" }, t),
    bk,
  ]), null);
}

// 島図Excelを取り込んで配置・設備・機種名を入れ替える。
export async function importIslandXlsx(file, onDone) {
  if (!file) return;
  const meta = await loadMeta();
  // 先に読む。読めないファイルに適用日を聞いても仕方がなく、台数を見せてから決めてもらいたい
  let parsed;
  try { parsed = await parseIslandXlsx(await file.arrayBuffer()); }
  catch (e) { errorToast(e); return; }
  const { layout: lay, fixtures: fx, models: mdl, warnings, counts } = parsed;
  const current = (await repo.select("layout_cell", { eq: { store_id: state.storeId } }).catch(() => [])).length;
  const effectiveFrom = await askEffectiveFrom(file.name, counts, current);
  if (!effectiveFrom) return; // キャンセル
  try {
    setSaveState("saving");
    await backupCurrent(`${file.name} を取り込む前`);
    const lc = lay.map((l) => ({ store_id: state.storeId, dai_no: l.dai_no, floor: l.floor, grid_row: l.grid_row, grid_col: l.grid_col }));
    // 適用開始日と入替履歴を保存（同じ適用日で取り直した場合は上書き）
    const entry = { effectiveFrom, importedAt: new Date().toISOString(), total: counts.total, f1: counts.f1, bf: counts.bf, file: file.name };
    const history = [...(meta.history || []).filter((h) => h.effectiveFrom !== effectiveFrom), entry]
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
    await writeIsland({ layout: lay, fixtures: fx, models: mdl, meta: { ...entry, history } });
    setSaveState("saved");
    toast(`${counts.total}台を配置（1F ${counts.f1} / BF ${counts.bf}）・${effectiveFrom}から適用${warnings.length ? "・警告" + warnings.length : ""}`, "ok");
    // 島図の見た目調整は台番の範囲で書いてあるため、配置が変わると黙ってずれる。
    // 取込のたびに照合して、合わなくなっていたらここで知らせる。
    const ruleWarn = checkIslandRules(lc);
    if (ruleWarn.length) {
      modal("島図の調整設定を見直してください", el("div", { class: "col", style: "gap:8px;min-width:min(460px,86vw)" }, [
        el("p", { class: "hint", style: "margin:0", text:
          "島図の見た目を整えるために、台番の範囲を指定した調整が入っています。新しい配置と合わなくなりました。" }),
        el("ul", { style: "margin:0;padding-left:1.2em;line-height:1.7" }, ruleWarn.map((w) => el("li", { text: w }))),
        // 範囲がまるごと無い指定が半分を超えるなら、調整がずれたのではなく台がそもそも足りない。
        // 実際には島図でない表を取り込んだときにこうなった。直す先を取り違えないよう書き分ける。
        ruleWarn.filter((w) => /この台番が島図にありません/.test(w)).length * 2 > ruleWarn.length
          ? el("p", { style: "margin:0;color:#e35d6a;font-weight:700", text:
            `多くの台番が見つかりません（読めたのは${counts.total}台）。取り込んだファイルが島図Excelでない可能性があります。正しい島図Excelを取り込み直してください。` })
          : el("p", { class: "hint", style: "margin:0;font-size:11.5px", text:
            "島図の表示は崩れますが、設定の投入や保存には影響しません。調整の台番を直してもらうよう伝えてください。" }),
      ]), el("div", { class: "row", style: "justify-content:flex-end;gap:8px;margin-top:12px" }, [
        el("button", { class: "btn", text: "取り込む前の島図に戻す", onclick: async () => { await restoreLatest(); onDone?.(); } }),
      ]));
    }
    await fillNewModels(Object.values(mdl));
    onDone?.();
  } catch (e) { errorToast(e); }
}

// 島図で新しく入った機種の出玉率を、出玉率表（PCのExcel）から自動で埋める。
// 入替のたびに出玉率タブで探し直す手間を無くすため。表に無い機種は一覧で知らせる（Excelに足してもらう）。
async function fillNewModels(models) {
  const status = el("div", { class: "hint", text: "新しい機種を確認しています…" });
  const body = el("div", { class: "col", style: "gap:8px;min-width:min(460px,86vw)" }, [status]);
  const close = modal("新しい機種の出玉率", body, null);
  try {
    const r = await autoFillModels(models, (msg) => { status.textContent = `出玉率表を探しています… ${msg}`; });
    if (!r.targets.length) { close(); return; }
    status.textContent = `新しい機種 ${r.targets.length}機種のうち、${r.file.length}機種を出玉率表から入れました。`;
    const list = (title, arr) => arr.length ? el("div", {}, [el("b", { text: `${title}（${arr.length}）` }),
      el("ul", { style: "margin:4px 0 0;padding-left:1.2em;line-height:1.6" }, arr.map((m) => el("li", { text: m })))]) : null;
    [list("出玉率表から", r.file), list("出玉率表に無い・名前が当たらない（Excelに足して保存すると、出玉率タブを開いたとき反映されます）", r.left)]
      .filter(Boolean).forEach((n) => body.appendChild(n));
    body.appendChild(el("div", { class: "row", style: "justify-content:flex-end;gap:8px;margin-top:6px" }, [
      el("button", { class: "btn ghost", text: "閉じる", onclick: () => close() }),
      el("button", { class: "btn primary", text: "出玉率タブで確認", onclick: () => { close(); location.hash = "payout"; } }),
    ]));
  } catch (e) { close(); errorToast(e); }
}

// ---------------------------------------------------------------- 控えと戻す
// 島図の取込は台のレイアウト（layout_cell・設備）と機種（island_models）を丸ごと置き換える。
// 以前は置き換える前の状態をどこにも残しておらず、島図でない表を取り込んだとき元に戻せなかった。
// 置き換える前に必ず控えを取り、取込の直後や入替履歴から「前の島図に戻す」ができるようにする。
const BACKUP_KEY = "island_backups";
const BACKUP_KEEP = 5; // 1回あたり台300ほどなので数件なら軽い。古いものから捨てる

async function loadBackups() {
  return (await repo.select("app_setting", { eq: { store_id: state.storeId, key: BACKUP_KEY } }))[0]?.value || [];
}

async function backupCurrent(reason) {
  const layout = await repo.select("layout_cell", { eq: { store_id: state.storeId } });
  if (!layout.length) return; // まだ島図が無ければ控えるものも無い
  const fixtures = await repo.select("fixture", { eq: { store_id: state.storeId } });
  const models = (await repo.select("app_setting", { eq: { store_id: state.storeId, key: "island_models" } }))[0]?.value || {};
  const meta = await loadMeta();
  const b = {
    savedAt: new Date().toISOString(), reason,
    effectiveFrom: meta.effectiveFrom || null, file: meta.file || null,
    total: layout.length, f1: layout.filter((c) => c.floor === "1F").length, bf: layout.filter((c) => c.floor === "BF").length,
    layout: layout.map(({ dai_no, floor, grid_row, grid_col }) => ({ dai_no, floor, grid_row, grid_col })),
    fixtures: fixtures.map(({ floor, grid_row, grid_col, row_span, col_span, kind, label }) => ({ floor, grid_row, grid_col, row_span, col_span, kind, label })),
    models, meta,
  };
  const list = [b, ...(await loadBackups())].slice(0, BACKUP_KEEP);
  await repo.upsert("app_setting", { store_id: state.storeId, key: BACKUP_KEY, value: list }, { onConflict: ["store_id", "key"] });
}

// 台のレイアウト・設備・機種・適用日をまとめて書く。取込と戻すで同じ道を通す
async function writeIsland({ layout, fixtures, models, meta }) {
  await repo.remove("layout_cell", { store_id: state.storeId });
  await repo.remove("fixture", { store_id: state.storeId });
  const lc = layout.map((l) => ({ store_id: state.storeId, dai_no: l.dai_no, floor: l.floor, grid_row: l.grid_row, grid_col: l.grid_col }));
  for (let i = 0; i < lc.length; i += 200) await repo.upsert("layout_cell", lc.slice(i, i + 200), { onConflict: ["store_id", "dai_no"] });
  const frows = fixtures.map((f) => ({ store_id: state.storeId, ...f }));
  if (frows.length) await repo.upsert("fixture", frows, { onConflict: ["id"] });
  await repo.upsert("app_setting", { store_id: state.storeId, key: "island_models", value: models }, { onConflict: ["store_id", "key"] });
  await repo.upsert("app_setting", { store_id: state.storeId, key: "island_meta", value: meta }, { onConflict: ["store_id", "key"] });
}

// 控えに戻す。戻す前の状態も控えに積むので、戻したこと自体も取り消せる
async function restoreBackup(b) {
  if (!confirm(`${b.effectiveFrom || "日付不明"}の島図（${b.total}台：1F ${b.f1}／BF ${b.bf}）に戻します。\n今の島図は控えに残ります。よろしいですか？`)) return false;
  try {
    setSaveState("saving");
    const rest = (await loadBackups()).filter((x) => x.savedAt !== b.savedAt);
    await repo.upsert("app_setting", { store_id: state.storeId, key: BACKUP_KEY, value: rest }, { onConflict: ["store_id", "key"] });
    await backupCurrent("戻す前");
    // 入替履歴は控えを取った時点のものに戻す（取り消した取込の記録は残さない）
    await writeIsland({ layout: b.layout, fixtures: b.fixtures, models: b.models, meta: b.meta || {} });
    setSaveState("saved");
    toast(`島図を戻しました（${b.total}台）`, "ok");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return true;
  } catch (e) { errorToast(e); return false; }
}

async function restoreLatest() {
  const [b] = await loadBackups();
  if (!b) { toast("戻せる控えがありません。正しい島図Excelを取り込み直してください", "err"); return; }
  await restoreBackup(b);
}

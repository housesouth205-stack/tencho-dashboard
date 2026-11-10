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
  modal("島図の入替履歴", el("div", { class: "col" }, [
    el("p", { class: "hint", style: "margin:0", text: rows.length
      ? "取込のたびに記録されます。使われるのは最新（先頭行）の島図です。"
      : "まだ島図Excelを取り込んでいません。" }),
    el("div", { style: "overflow:auto;max-height:60vh" }, t),
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
    await repo.remove("layout_cell", { store_id: state.storeId });
    await repo.remove("fixture", { store_id: state.storeId });
    const lc = lay.map((l) => ({ store_id: state.storeId, dai_no: l.dai_no, floor: l.floor, grid_row: l.grid_row, grid_col: l.grid_col }));
    for (let i = 0; i < lc.length; i += 200) await repo.upsert("layout_cell", lc.slice(i, i + 200), { onConflict: ["store_id", "dai_no"] });
    const frows = fx.map((f) => ({ store_id: state.storeId, ...f }));
    if (frows.length) await repo.upsert("fixture", frows, { onConflict: ["id"] });
    await repo.upsert("app_setting", { store_id: state.storeId, key: "island_models", value: mdl }, { onConflict: ["store_id", "key"] });
    // 適用開始日と入替履歴を保存（同じ適用日で取り直した場合は上書き）
    const entry = { effectiveFrom, importedAt: new Date().toISOString(), total: counts.total, f1: counts.f1, bf: counts.bf, file: file.name };
    const history = [...(meta.history || []).filter((h) => h.effectiveFrom !== effectiveFrom), entry]
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
    await repo.upsert("app_setting", { store_id: state.storeId, key: "island_meta", value: { ...entry, history } }, { onConflict: ["store_id", "key"] });
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
      ]), null);
    }
    await fillNewModels(Object.values(mdl));
    onDone?.();
  } catch (e) { errorToast(e); }
}

// 島図で新しく入った機種の出玉率を、機種DB→Webの順で自動で埋める。
// 入替のたびに出玉率タブで探し直す手間を無くすため。迷う機種は勝手に入れず一覧で知らせる。
async function fillNewModels(models) {
  const status = el("div", { class: "hint", text: "新しい機種を確認しています…" });
  const body = el("div", { class: "col", style: "gap:8px;min-width:min(460px,86vw)" }, [status]);
  const close = modal("新しい機種の出玉率", body, null);
  try {
    const r = await autoFillModels(models, (msg) => { status.textContent = `出玉率を探しています… ${msg}`; });
    if (!r.targets.length) { close(); return; }
    status.textContent = `新しい機種 ${r.targets.length}機種のうち、${r.file.length ? `出玉率表で ${r.file.length}機種・` : ""}機種DBで ${r.db.length}機種・Webで ${r.web.length}機種を自動で入れました。`;
    const list = (title, arr) => arr.length ? el("div", {}, [el("b", { text: `${title}（${arr.length}）` }),
      el("ul", { style: "margin:4px 0 0;padding-left:1.2em;line-height:1.6" }, arr.map((m) => el("li", { text: m })))]) : null;
    [list("出玉率表から", r.file), list("機種DBから", r.db), list("Webから", r.web), list("見つからなかった・名前が曖昧（出玉率タブで選んでください）", r.left)]
      .filter(Boolean).forEach((n) => body.appendChild(n));
    body.appendChild(el("div", { class: "row", style: "justify-content:flex-end;gap:8px;margin-top:6px" }, [
      el("button", { class: "btn ghost", text: "閉じる", onclick: () => close() }),
      el("button", { class: "btn primary", text: "出玉率タブで確認", onclick: () => { close(); location.hash = "payout"; } }),
    ]));
  } catch (e) { close(); errorToast(e); }
}

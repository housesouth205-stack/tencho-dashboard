// 月計画表の自動取込。PCの月計画表（例 \\PC名\Desktop\2026年月計画表.xlsx）を「参照するファイル」として覚え、
// 毎朝決まった時刻（9:00）に読み直して予実に入れる。
//
// ブラウザの中で動くので、ダッシュボードがそのPCのChrome/Edgeで開いている間しか読めない。
// そのため「その日の時刻を過ぎていて、今日まだ取り込んでいなければ取り込む」形にしてある。
// 9時前から開いていれば9時ちょうどに、9時を過ぎてから開いたら開いた時点で取り込む（取りこぼさない）。
// ファイルが前回から変わっていなければ書き込まない（同じ数字を毎日上書きしても意味が無い）。
//
// 自動のときは確認画面を出さずに書き込む。手動の「今すぐ取り込む」は従来どおり確認画面を出す。
// 設定（自動/手動・最後に取り込んだ時刻）はファイルの手がかりと同じくこの端末にだけ置く。
import { el } from "../../util/dom.js";
import { repo } from "../../core/repo.js";
import { state, loadSections } from "../../core/state.js";
import { toast, errorToast } from "../../core/errors.js";
import { hasPending } from "../../core/autosave.js";
import { linkSupported, linkedFile } from "../../core/linkedFile.js";
import { todayFiscalYear, localYmd } from "../../util/dates.js";
import { parseMonthlyPlan } from "../../import/monthlyPlanXlsx.js";
import { doImport, importMonthlyPlanFile } from "./importPlan.js";

export const AUTO_TIME = "09:00";
const LS = "tencho.planAuto";
const link = linkedFile("monthlyPlan", { pickerId: "monthly-plan", description: "月計画表（Excel）" });

export function loadCfg() {
  try { return { mode: "auto", ...JSON.parse(localStorage.getItem(LS) || "{}") }; } catch { return { mode: "auto" }; }
}
function saveCfg(patch) {
  const c = { ...loadCfg(), ...patch };
  try { localStorage.setItem(LS, JSON.stringify(c)); } catch { /* 覚えられなくても取込はできる */ }
  window.dispatchEvent(new CustomEvent("dash:planauto"));
  return c;
}
export const setMode = (mode) => saveCfg({ mode });

// 今日の取込時刻を過ぎていて、今日まだ試していなければ「その時」
function due(c, now = new Date()) {
  const [h, m] = AUTO_TIME.split(":").map(Number);
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
  return c.mode === "auto" && now >= at && c.lastRunDay !== localYmd(now);
}

let running = false;
/**
 * 覚えているファイルを読んで、確認なしで取り込む。
 * @param force ファイルが変わっていなくても取り込む（「許可する」を押した直後など）
 */
export async function runAuto({ force = false } = {}) {
  if (running) return;
  running = true;
  const at = new Date().toISOString();
  try {
    const r = await link.readLinked();
    if (r.state === "none") return;
    // 許可が切れている・ファイルが無いときは、今日はもう試さない（1分ごとに失敗を重ねない）。
    // 画面に理由を出して、ボタンで許可し直してもらう
    if (r.state !== "ok") { saveCfg({ lastRunDay: localYmd(), last: { at, status: r.state, file: r.name } }); return; }
    const c = loadCfg();
    if (!force && c.lastModified && r.file.lastModified === c.lastModified) {
      saveCfg({ lastRunDay: localYmd(), last: { ...(c.last || {}), checkedAt: at, status: c.last?.status === "ok" ? "ok" : "nochange", file: r.name } });
      return;
    }
    const sections = state.sections?.length ? state.sections : await loadSections();
    // 年度は今日の年度。画面の年度切替（過去の年度を見ているかもしれない）には合わせない
    const { rows, warnings } = await parseMonthlyPlan(await r.file.arrayBuffer(), { fy: todayFiscalYear(), sections });
    if (!rows.length) { saveCfg({ lastRunDay: localYmd(), last: { at, status: "empty", file: r.name, warnings } }); return; }
    await doImport(rows);
    saveCfg({ lastRunDay: localYmd(), lastModified: r.file.lastModified, last: { at, status: "ok", file: r.name, rows: rows.length, warnings } });
    toast(`月計画表（${r.name}）を自動で取り込みました（${rows.length}行）`, "ok");
    // 予実タブを見ているなら描き直す。日別入力の保存待ちがあるときは描き直さない（打っている途中を消さない）
    if ((location.hash.slice(1) || "yojitsu") === "yojitsu" && !hasPending()) window.dispatchEvent(new HashChangeEvent("hashchange"));
  } catch (e) {
    saveCfg({ lastRunDay: localYmd(), last: { at, status: "error", message: String(e?.message || e) } });
    errorToast(e);
  } finally { running = false; }
}

// アプリを開いたときに1回呼ぶ。以後1分ごと、画面に戻ってきたとき（スリープ明けなど）に時刻を見る
let started = false;
export function startPlanScheduler() {
  if (started || !linkSupported()) return;
  started = true;
  const tick = () => { if (due(loadCfg())) runAuto(); };
  setTimeout(tick, 3000); // 開いた直後は画面の描画を先に済ませる
  setInterval(tick, 60 * 1000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") tick(); });
}

const hm = (iso) => { if (!iso) return "—"; const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };

/**
 * 予実タブの上に置く1行。参照するファイル・自動/手動の切替・最後の取込・今すぐ取り込む。
 * @param onDone 手動で取り込んだあと画面を描き直す
 */
export async function planAutoBar(onDone) {
  // PCで毎朝動く取込（tools/plan-auto）の結果。ブラウザを開いていなくても入るので、こちらが本命
  const pc = await loadPcStatus();
  // iPhone等ではファイルを覚えられない。PCの取込の結果だけ出す（それも無ければ行ごと出さない）
  if (!linkSupported()) return pc ? el("div", { class: "card pa-bar" }, pcLine(pc)) : null;
  const box = el("div", { class: "card pa-bar" });
  const draw = async () => {
    const c = loadCfg();
    const rec = await link.getLinked();
    // PCの自動取込が動いているなら、この端末でファイルを選ばなくてよい。結果だけ出して終わる
    if (pc && !rec) { box.replaceChildren(...pcLine(pc)); return; }
    const pick = async () => {
      try { await link.pickAndLink(); saveCfg({ lastModified: null, lastRunDay: null }); await runAuto({ force: true }); }
      catch (e) { if (e?.name !== "AbortError") errorToast(e); }
      draw();
    };
    if (!rec) {
      box.replaceChildren(
        el("b", { text: "月計画表の自動取込" }),
        el("span", { class: "hint", text: `PCの月計画表を一度選んでおくと、毎朝${AUTO_TIME}に読み直して予実に入れます（このPCのChrome/Edgeで開いている間）` }),
        el("button", { class: "btn sm primary", text: "📁 月計画表を選ぶ", onclick: pick }),
      );
      return;
    }
    const seg = (m, label) => el("button", { class: "btn sm" + (c.mode === m ? " on" : ""), text: label, onclick: () => { setMode(m); draw(); } });
    const l = c.last;
    const lastText = !l ? "まだ取り込んでいません"
      : l.status === "ok" ? `最後の取込 ${hm(l.at)}（${l.rows}行）${l.checkedAt ? `・${hm(l.checkedAt)} 変更なし` : ""}`
      : l.status === "nochange" ? `${hm(l.checkedAt || l.at)} 確認・変更なし`
      : l.status === "prompt" || l.status === "denied" ? "読む許可が切れています。「許可して取り込む」を押してください"
      : l.status === "missing" ? "ファイルが見つかりません。移動・名前変更したなら選び直してください"
      : l.status === "empty" ? "読めた行がありませんでした（月計画表の形が変わっていないか確認してください）"
      : `取り込めませんでした：${l.message || ""}`;
    const bad = l && !["ok", "nochange"].includes(l.status);
    box.replaceChildren(
      el("b", { text: "📄 月計画表" }),
      el("span", { class: "pa-file", title: rec.name, text: rec.name }),
      el("span", { class: "pa-seg" }, [seg("auto", `自動（毎朝${AUTO_TIME}）`), seg("manual", "手動")]),
      el("span", { class: "hint", style: bad ? "color:var(--bad-fg)" : "", text: c.mode === "manual" ? "手動：自動では取り込みません" : lastText }),
      pc ? pcLine(pc)[1] : null,
      el("span", { class: "grow" }),
      bad && (l.status === "prompt" || l.status === "denied")
        ? el("button", { class: "btn sm primary", text: "許可して取り込む", onclick: async () => {
          const r = await link.readLinked({ interactive: true });
          if (r.state === "ok") await runAuto({ force: true }); else toast("読む許可が得られませんでした", "err");
          draw();
        } })
        : el("button", { class: "btn sm", text: "今すぐ取り込む", title: "確認画面を出してから取り込みます", onclick: async () => {
          try {
            const r = await link.readLinked({ interactive: true });
            if (r.state !== "ok") { toast(r.state === "missing" ? "ファイルが見つかりません。選び直してください" : "読む許可がありません", "err"); return; }
            const sections = state.sections?.length ? state.sections : await loadSections();
            await importMonthlyPlanFile(r.file, { fy: state.fy, sections, onDone: () => { saveCfg({ lastModified: r.file.lastModified }); onDone?.(); } });
          } catch (e) { errorToast(e); }
        } }),
      el("button", { class: "btn sm ghost", text: "ファイルを変更", onclick: pick }),
      el("button", { class: "btn sm ghost", text: "解除", title: "参照をやめる（自動取込も止まります）", onclick: async () => { await link.unlink(); saveCfg({ last: null, lastModified: null }); draw(); } }),
    );
  };
  await draw();
  // 裏で自動取込が走ったら表示を更新する
  // 画面を離れたら（box が外れたら）聞くのをやめる。予実タブを開くたびに足されて重なるため
  const onChange = () => { if (box.isConnected) draw(); else window.removeEventListener("dash:planauto", onChange); };
  window.addEventListener("dash:planauto", onChange);
  return box;
}

// ---- PCで毎朝動く取込（tools/plan-auto/run.mjs）の結果 ----
// 結果は app_setting の plan_auto_pc に書かれる。黙って止まると「入っていない」に気づけないので、
// 失敗と「今日まだ動いていない」をここで赤く出す。
async function loadPcStatus() {
  try { return (await repo.select("app_setting", { eq: { store_id: state.storeId, key: "plan_auto_pc" } }))[0]?.value || null; }
  catch { return null; }
}

function pcLine(pc) {
  const now = new Date();
  const [h, m] = AUTO_TIME.split(":").map(Number);
  // 9:00から1時間たっても今日の記録が無ければ、PCが切れているか予約が止まっている
  const late = now >= new Date(now.getFullYear(), now.getMonth(), now.getDate(), h + 1, m);
  const seen = pc.checkedAt && pc.checkedAt > pc.at ? pc.checkedAt : pc.at;
  const ranToday = seen && localYmd(new Date(seen)) === localYmd(now);
  const text = pc.status === "error" ? `PCの自動取込が失敗：${pc.message || ""}（${hm(pc.at)}）`
    : late && !ranToday ? `PCの自動取込が今日まだ動いていません（最後 ${hm(seen)}）。${pc.host || "PC"}が起動しているか確認してください`
    : `PCの自動取込：${hm(pc.at)} 取込${pc.checkedAt && pc.checkedAt > pc.at ? `・${hm(pc.checkedAt)} 変更なし` : ""}`;
  const bad = pc.status === "error" || (late && !ranToday);
  return [el("b", { text: "📄 月計画表" }), el("span", { class: "hint", style: bad ? "color:var(--bad-fg)" : "", title: pc.file || "", text })];
}

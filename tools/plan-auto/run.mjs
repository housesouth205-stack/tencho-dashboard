// 月計画表の自動取込（PCで毎朝動かす版）。
// ダッシュボードの中の自動取込（src/features/yojitsu/autoPlan.js）は、ブラウザでダッシュボードを
// 開いている間しか動かない。開き忘れた日は取り込まれず、店長から「毎朝入っていない」と言われた。
// そこでPCのタスクスケジューラから毎朝これを動かし、ブラウザ無しで同じ取込をする。
//
// 読み方と書き方はダッシュボードと同じ部品を使う（parseMonthlyPlan / planRecords）。
// ここで別の読み方を書くと、画面から入れた数字と自動で入った数字が食い違うため。
//
//   node run.mjs --file "\\PC名\Desktop\2026年月計画表.xlsx" [--dry] [--force]
//   パスワードは環境変数 TENCHO_PW（run.ps1 が暗号化した控えから渡す。ファイルに平文で置かない）
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// 画面では <script> で読む表計算の部品を、ここでは直接読んで同じ場所（window.XLSX）に置く
globalThis.window = { XLSX: require("../../src/lib/xlsx.full.min.js") };

const { SUPABASE_URL, SUPABASE_ANON_KEY, STORE_ID, AUTH_EMAIL } = await import("../../src/core/config.js");
const { todayFiscalYear } = await import("../../src/util/dates.js");
const { parseMonthlyPlan } = await import("../../src/import/monthlyPlanXlsx.js");
const { planRecords, PLAN_CONFLICT } = await import("../../src/import/monthlyPlanRecords.js");

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const file = arg("--file");
const dry = process.argv.includes("--dry");
const force = process.argv.includes("--force");
const STATUS_KEY = "plan_auto_pc"; // 最後に何が起きたか。予実タブの上の行に出す
const log = (...a) => console.log(new Date().toLocaleString("ja-JP"), ...a);

async function api(path, { token, method = "GET", body, prefer } = {}) {
  const res = await fetch(SUPABASE_URL + path, {
    method,
    headers: {
      apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token || SUPABASE_ANON_KEY}`, "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path.split("?")[0]} → ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function login() {
  const pw = process.env.TENCHO_PW;
  if (!pw) throw new Error("パスワードが渡されていません（setup.ps1 をもう一度実行してください）");
  const r = await api("/auth/v1/token?grant_type=password", { method: "POST", body: { email: AUTH_EMAIL, password: pw } });
  return r.access_token;
}

const upsert = (token, table, rows, onConflict) =>
  api(`/rest/v1/${table}?on_conflict=${onConflict.join(",")}`, { token, method: "POST", body: rows, prefer: "resolution=merge-duplicates,return=minimal" });

async function saveStatus(token, value) {
  await upsert(token, "app_setting", [{ store_id: STORE_ID, key: STATUS_KEY, value }], ["store_id", "key"]);
}

async function main() {
  if (!file) throw new Error("--file で月計画表のパスを指定してください");
  const stat = fs.statSync(file); // 見えないとここで止まる（共有フォルダの接続切れなど）
  const mtime = stat.mtimeMs;
  const token = dry ? null : await login();

  // 試し読み（--dry）はログインしないので区分をDBから読めない。読めるかの確認だけなので標準の3区分で代用する
  const sections = dry
    ? [{ id: "S20", key: "S20", label: "20スロ", rate: 21.75 }, { id: "S5", key: "S5", label: "5スロ", rate: 5.56 }, { id: "S2", key: "S2", label: "2スロ", rate: 2.22 }]
    : (await api(`/rest/v1/section_def?store_id=eq.${STORE_ID}&select=*&order=sort_order`, { token })).filter((s) => s.is_active !== false);
  if (!sections.length) throw new Error("区分（20スロなど）が読めませんでした");

  // ファイルが前回から変わっていなければ書かない（同じ数字を毎日上書きしても意味が無い）
  const prev = dry ? null : (await api(`/rest/v1/app_setting?store_id=eq.${STORE_ID}&key=eq.${STATUS_KEY}&select=value`, { token }))[0]?.value;
  const base = { at: new Date().toISOString(), host: os.hostname(), file, mtime: new Date(mtime).toISOString() };
  if (!force && !dry && prev?.mtime === base.mtime && prev?.status === "ok") {
    await saveStatus(token, { ...prev, checkedAt: base.at, note: "ファイルに変更なし" });
    log("変更なし", base.mtime);
    return;
  }

  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const fy = todayFiscalYear(); // 画面と同じく、今日の年度で読む
  const { rows, warnings } = await parseMonthlyPlan(ab, { fy, sections });
  if (!rows.length) throw new Error(warnings[0] || "取り込める行がありませんでした");
  const { machines, plans, actuals } = planRecords(rows, STORE_ID);
  const counts = { machines: machines.length, plans: plans.length, actuals: actuals.length };
  log(`${fy}年度`, counts, warnings.length ? `注意 ${warnings.length}件` : "");
  for (const w of warnings) log("注意:", w);
  if (dry) return;

  for (const [table, list] of [["machines_day", machines], ["plan_day", plans], ["actual_day", actuals]]) {
    for (let i = 0; i < list.length; i += 200) await upsert(token, table, list.slice(i, i + 200), PLAN_CONFLICT);
  }
  await saveStatus(token, { ...base, status: "ok", fy, counts, warnings: warnings.slice(0, 5) });
  log("取込完了");
}

try {
  await main();
} catch (e) {
  log("失敗:", e.message || e);
  // 失敗したことも画面に出す（黙って止まると、また「入っていない」に気づけない）
  try { if (!dry && process.env.TENCHO_PW) await saveStatus(await login(), { at: new Date().toISOString(), host: os.hostname(), file, status: "error", message: String(e.message || e) }); } catch { /* 通信自体が無理なら諦める */ }
  // process.exit() だと通信の後始末の途中で落ちる（Windowsで異常終了の表示が出た）ので終了コードだけ立てる
  process.exitCode = 1;
}

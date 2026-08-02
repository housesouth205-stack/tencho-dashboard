import { el } from "../../util/dom.js";
import { repo } from "../../core/repo.js";
import { STORE_NAME } from "../../core/config.js";
import { toast, errorToast } from "../../core/errors.js";
import { renderSectionEditor } from "./sections.js";

export async function mount(host) {
  host.appendChild(el("div", { class: "view-title" }, [
    el("h1", { text: "設定" }),
    el("small", { text: STORE_NAME }),
  ]));

  const backend = repo.isLocal()
    ? "ローカル保存（このブラウザ内）。Supabase未接続 — config.js に URL/anonキー を設定すると切替わります。"
    : "Supabase 接続中。";
  host.appendChild(el("div", { class: "card", html: `<b>データ保存先:</b> <span class="hint">${backend}</span>` }));

  const secCard = el("div", { class: "card col" }, el("h2", { text: "区分（レート）" }));
  host.appendChild(secCard);
  const secHost = el("div");
  secCard.appendChild(secHost);
  await renderSectionEditor(secHost);

  // バックアップ（全データのJSONエクスポート/インポート）
  const backup = el("div", { class: "card col" }, [
    el("h2", { text: "バックアップ" }),
    el("p", { class: "hint", style: "margin:0", text:
      "予実（計画・実績・台数・目標）／機種分析（取込スナップショット）／島図（配置・設備）／出玉率（機種×設定）／シミュレーター保存 の全データをJSONファイルに保存します。月に1回など定期的な取得をおすすめします。" }),
    el("div", { class: "row", style: "gap:8px;align-items:center;flex-wrap:wrap" }, [
      el("button", { class: "btn primary", text: "⬇ バックアップを保存(JSON)", onclick: exportJson }),
      el("label", { class: "btn ghost" }, [
        "⬆ バックアップから復元",
        el("input", { type: "file", accept: ".json", style: "display:none", onchange: importJson }),
      ]),
    ]),
    el("p", { class: "hint", style: "margin:0;font-size:11.5px", text:
      "※復元は同じキーのデータを上書きします（既存を消してから入れ直す動作ではありません）。" }),
  ]);
  host.appendChild(backup);
}

// 全データを対象にする（島図・機種分析・出玉率・シミュレーターも含む）。
// 復元時の重複判定キーはテーブルごとに異なるため個別に指定する。
const TABLES = [
  ["section_def", ["store_id", "key"]],
  ["machines_day", ["store_id", "ymd", "section_id"]],
  ["plan_day", ["store_id", "ymd", "section_id"]],
  ["actual_day", ["store_id", "ymd", "section_id"]],
  ["budget_year", ["store_id", "fy", "section_id"]],
  ["budget_month", ["store_id", "fy", "month", "section_id"]],
  ["snapshot_period", ["id"]],
  ["machine_snapshot", ["id"]],
  ["layout_cell", ["store_id", "dai_no"]],
  ["fixture", ["id"]],
  ["model_spec", ["model_name", "setting"]],
  ["sim_session", ["id"]],
  ["app_setting", ["store_id", "key"]],
];

async function exportJson() {
  try {
    toast("バックアップを作成中…", "ok");
    const dump = { _meta: { app: "tencho-dashboard", exportedAt: new Date().toISOString(), version: 2 } };
    let total = 0;
    for (const [t] of TABLES) {
      const rows = await repo.select(t, {});
      dump[t] = rows; total += rows.length;
    }
    const blob = new Blob([JSON.stringify(dump)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: `店長ダッシュボード_バックアップ_${new Date().toISOString().slice(0, 10)}.json` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(`エクスポート完了（${total.toLocaleString()}行）`, "ok");
  } catch (e) { errorToast(e); }
}

async function importJson(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = ""; // 同じファイルを選び直せるように
  if (!confirm("バックアップから復元します。\n同じキーの既存データは上書きされます。よろしいですか？")) return;
  try {
    const dump = JSON.parse(await file.text());
    const keyMap = new Map(TABLES);
    let total = 0;
    for (const [t, rows] of Object.entries(dump)) {
      if (t.startsWith("_") || !Array.isArray(rows) || !rows.length) continue;
      const onConflict = keyMap.get(t) || ["id"];
      for (let i = 0; i < rows.length; i += 200) {
        await repo.upsert(t, rows.slice(i, i + 200), { onConflict });
      }
      total += rows.length;
    }
    toast(`復元完了（${total.toLocaleString()}行）`, "ok");
    setTimeout(() => location.reload(), 1200);
  } catch (err) { errorToast(err); }
}

import { el, clear } from "../util/dom.js";
import { renderQuickImport } from "./quickImport.js";

// タブ定義。loadは遅延importでビューモジュールを読む（未実装は準備中表示）。
const TABS = [
  { id: "yojitsu", label: "予実", load: () => import("../features/yojitsu/view.js") },
  // 島図の閲覧は設定投入シミュレーターに統合した（島図Excelの取込・履歴は取込タブ）。
  // 旧 #island のブックマークからも開けるよう alias を持たせている。
  { id: "simulator", label: "島図・設定", alias: ["island"], load: () => import("../features/simulator/view.js") },
  { id: "analysis", label: "機種分析", load: () => import("../features/analysis/view.js") },
  { id: "payout", label: "出玉率", load: () => import("../features/payout/view.js") },
  { id: "shindai", label: "新台", load: () => import("../features/shindai/view.js") },
  { id: "expense", label: "経費", load: () => import("../features/expense/view.js") },
  { id: "import", label: "取込", load: () => import("../features/import/view.js") },
  { id: "settings", label: "設定", load: () => import("../features/settings/view.js") },
];

let navSeq = 0;

export function initRouter() {
  const nav = document.getElementById("tabs");
  for (const t of TABS) {
    nav.appendChild(el("button", {
      class: "tab", dataset: { id: t.id }, text: t.label,
      // hashを変えるだけ。実際の描画はhashchange経由の単一経路に統一（二重navigate防止）。
      onclick: () => { location.hash = t.id; },
    }));
  }
  window.addEventListener("hashchange", () => navigate(location.hash.slice(1) || "settings"));
  navigate(location.hash.slice(1) || "settings");
}

async function navigate(id) {
  const seq = ++navSeq;
  const tab = TABS.find((t) => t.id === id || (t.alias || []).includes(id)) || TABS[0];
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.id === tab.id));
  renderQuickImport(tab.id);
  const view = document.getElementById("view");

  // 読み込みや描画で失敗したら、何が起きたかを画面に出す。以前は失敗をすべて「準備中」と
  // 表示していたので、通信が切れただけなのか、コードの不具合なのかが画面から分からなかった。
  try {
    const mod = await tab.load();
    if (seq !== navSeq) return; // 後発のナビゲーションに追い越されたら破棄（二重描画防止）
    clear(view);
    await mod.mount(view);
  } catch (e) {
    console.error(e);
    if (seq !== navSeq) return;
    clear(view);
    const net = /fetch|network|Failed to|load failed|通信/i.test(String(e?.message || e));
    view.appendChild(el("div", { class: "placeholder" }, [
      el("div", { style: "font-weight:700;color:var(--fg)", text: `「${tab.label}」を表示できませんでした` }),
      el("div", { style: "margin-top:6px", text: net
        ? "通信に失敗しました。電波・Wi-Fiを確認して、もう一度開いてください。"
        : "画面の処理でエラーが起きました。下の内容を開発担当に伝えてください。" }),
      el("div", { class: "hint", style: "margin-top:6px;word-break:break-all", text: String(e?.message || e) }),
      el("div", { style: "margin-top:12px" }, el("button", { class: "btn sm primary", text: "もう一度開く", onclick: () => navigate(id) })),
    ]));
  }
}

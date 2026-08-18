import { el, clear } from "../util/dom.js";

// タブ定義。loadは遅延importでビューモジュールを読む（未実装は準備中表示）。
const TABS = [
  { id: "yojitsu", label: "予実", load: () => import("../features/yojitsu/view.js") },
  // 島図の閲覧は設定投入シミュレーターに統合した（島図Excelの取込・履歴は取込タブ）。
  // 旧 #island のブックマークからも開けるよう alias を持たせている。
  { id: "simulator", label: "島図・設定", alias: ["island"], load: () => import("../features/simulator/view.js") },
  { id: "analysis", label: "機種分析", load: () => import("../features/analysis/view.js") },
  { id: "payout", label: "出玉率", load: () => import("../features/payout/view.js") },
  { id: "expense", label: "経費", load: () => import("../features/expense/view.js") },
  { id: "capex", label: "増台計画", load: () => import("../features/capex/view.js") },
  { id: "import", label: "取込", load: () => import("../features/import/view.js") },
  { id: "settings", label: "設定", load: () => import("../features/settings/view.js") },
];

const PLACEHOLDER = {
  simulator: "設定投入シミュレーター（フェーズP5で実装）",
};

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
  const view = document.getElementById("view");

  let mod = null;
  try { mod = await tab.load(); } catch { mod = null; }
  if (seq !== navSeq) return; // 後発のナビゲーションに追い越されたら破棄（二重描画防止）

  clear(view);
  try {
    if (mod && typeof mod.mount === "function") { await mod.mount(view); return; }
    throw new Error("no mount");
  } catch {
    if (seq !== navSeq) return;
    clear(view);
    view.appendChild(el("div", { class: "placeholder", text: PLACEHOLDER[tab.id] || "準備中" }));
  }
}

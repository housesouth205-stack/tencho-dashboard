// 各タブの「取込」ボタン。タブ直下の行（鮮度表示の右）に、そのタブで使う資料の取込だけを出す。
// 取込タブまで移動しなくても、見ている画面のまま新しい資料を入れられるようにするため。
// 取込の中身は取込タブと同じ関数を呼ぶ（同じ資料を2通りの読み方で入れる道を作らない）。
import { el, clear, modal } from "../util/dom.js";
import { state, loadSections } from "./state.js";
import { errorToast } from "./errors.js";

// 取込の種類。どれも取込タブにあるものと同じ処理
const KINDS = {
  csv: { label: "台別CSV", accept: ".csv", multiple: true, title: "K-TACs 遊技台個別CSV（全レート1ファイル可）" },
  island: { label: "島図Excel", accept: ".xlsx", title: "島図Excel（島図＋設定表シート）" },
  meeting: { label: "会議資料", accept: ".pdf,.csv,.xlsx", title: "会議資料のPDF・月次会議サマリーのExcel・月次CSV" },
  plan: { label: "月計画表", title: "月計画表Excel（計画と実績）" },
};

// タブごとに、そのタブの数字の元になる資料だけを出す
const BY_TAB = {
  yojitsu: ["plan"],
  simulator: ["island", "csv"],
  island: ["island", "csv"], // 旧 #island のブックマーク（島図・設定タブの別名）
  analysis: ["csv"],
  payout: ["island", "csv"],
  expense: ["meeting"],
};

// 取り込んだら今のタブを描き直す（router は hashchange で描画する）
const rerender = () => window.dispatchEvent(new HashChangeEvent("hashchange"));

function resultModal(title) {
  const box = el("div", { class: "col", style: "gap:8px;min-width:min(520px,86vw)" }, [el("div", { class: "hint", text: "取り込み中…" })]);
  const close = modal(title, box, null);
  return { box, close };
}

async function run(kind, files) {
  if (!files.length) return;
  try {
    if (kind === "csv") {
      const { importKtacsFiles } = await import("../features/import/view.js");
      const { box } = resultModal("台別CSVの取込");
      clear(box);
      await importKtacsFiles(files, { result: box });
    } else if (kind === "island") {
      const { importIslandXlsx } = await import("../features/import/islandImport.js");
      await importIslandXlsx(files[0], () => {});
    } else if (kind === "meeting") {
      const { importPl } = await import("../features/import/view.js");
      const { box } = resultModal("会議資料の取込");
      await importPl(files[0], box);
    }
    rerender();
  } catch (e) { errorToast(e); }
}

async function pickPlan() {
  try {
    await loadSections();
    const { pickMonthlyPlan } = await import("../features/yojitsu/importPlan.js");
    pickMonthlyPlan({ fy: state.fy, sections: state.sections, onDone: rerender });
  } catch (e) { errorToast(e); }
}

export function renderQuickImport(tabId) {
  let slot = document.getElementById("quickImport");
  if (!slot) return;
  clear(slot);
  const kinds = BY_TAB[tabId] || [];
  if (!kinds.length) return;
  slot.appendChild(el("span", { class: "hint", text: "取込" }));
  for (const k of kinds) {
    const def = KINDS[k];
    if (k === "plan") {
      slot.appendChild(el("button", { class: "btn sm", title: def.title, text: def.label, onclick: pickPlan }));
      continue;
    }
    const input = el("input", { type: "file", accept: def.accept, multiple: def.multiple ? "" : null, style: "display:none",
      onchange: () => { const fs = [...input.files]; input.value = ""; run(k, fs); } });
    slot.append(input, el("button", { class: "btn sm", title: def.title, text: def.label, onclick: () => input.click() }));
  }
}

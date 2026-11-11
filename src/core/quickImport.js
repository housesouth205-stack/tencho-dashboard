// 各タブの「取込」ボタン。タブ直下の行（鮮度表示の右）に1つだけ置き、押すと取込タブと
// 同じ枠が窓で開く。取込タブまで移動しなくても、見ている画面のまま資料を入れられるように。
// もとは資料の種類ごとにボタンを並べていたが、どれに入れるか迷う・間違えるので1つにした。
// 種類は中身から判定する（features/import/anyImport.js）。
import { el, modal } from "../util/dom.js";
import { errorToast } from "./errors.js";

// 取り込んだら今のタブを描き直す（router は hashchange で描画する）
const rerender = () => window.dispatchEvent(new HashChangeEvent("hashchange"));

// 取込の窓を開く。files を渡すと、開いてすぐその資料を取り込む（画面へのドロップ用）。
async function openImport(files) {
  try {
    const [{ buildDropZone, importAnyFiles }, { importPlPaste }, { openPlManual }] = await Promise.all([
      import("../features/import/anyImport.js"),
      import("../features/import/view.js"),
      import("../features/import/plManual.js"),
    ]);
    const msg = el("div", { class: "col", style: "gap:4px" });
    // 取り込んだあと画面を描き直す。確認画面（単位の選択など）を経て保存される資料は、
    // 取込の処理が戻った後に書き込まれるので、書き込みの知らせ（dash:datachange）でも描き直す。
    let timer = null;
    const refreshSoon = () => { clearTimeout(timer); timer = setTimeout(rerender, 600); };
    const stopWatch = () => window.removeEventListener("dash:datachange", refreshSoon);
    const run = async (fs) => {
      if (!fs.length) return;
      msg.replaceChildren();
      window.addEventListener("dash:datachange", refreshSoon);
      setTimeout(stopWatch, 5 * 60 * 1000); // 確認画面を開いたまま放置しても、見張りを残さない
      await importAnyFiles(fs, { msgHost: msg, ktacsOpts: { result: msg }, onDone: refreshSoon });
      refreshSoon();
      // 取り込めたら窓は閉じる（結果は右下の通知と、描き直した画面で分かる）。
      // 読んでほしい注意や「取り込めませんでした」が出ているときだけ開いたままにする。
      if (!msg.querySelector("[data-keep-open]")) close();
    };
    const close = modal("資料の取込", el("div", { class: "col", style: "gap:10px;min-width:min(620px,100%)" }, [
      buildDropZone(run),
      msg,
      // ファイルが無いとき（紙の資料・文字起こしを貼る）の入口も同じ窓に置く
      el("div", { class: "row", style: "gap:8px;align-items:center;flex-wrap:wrap" }, [
        el("span", { class: "hint", text: "ファイル以外：月次の損益・経費を" }),
        el("button", { class: "btn sm ghost", text: "表を貼り付けて取込", onclick: () => importPlPaste(msg) }),
        el("button", { class: "btn sm ghost", text: "手入力", onclick: () => openPlManual(msg) }),
      ]),
    ]), null);
    if (files?.length) run(files);
  } catch (e) { errorToast(e); }
}

export function renderQuickImport(tabId) {
  const slot = document.getElementById("quickImport");
  if (!slot) return;
  slot.replaceChildren();
  // 取込タブは画面そのものが取込の枠なので出さない
  if (tabId === "import") return;
  slot.appendChild(el("button", { class: "btn sm primary", title: "台別データ・島図・月計画表・会議資料。どれでも中身を見て種類を判定します",
    text: "📂 取込", onclick: () => openImport() }));
}

// 画面のどこにファイルを落としても取り込めるようにする（取込の枠は自前で受けるので除く）。
// 資料をデスクトップから引きずってきたとき、どこに落とせばよいか探さなくて済むように。
let dropReady = false;
export function enableDropAnywhere() {
  if (dropReady) return;
  dropReady = true;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e) || e.defaultPrevented) return; // 取込の枠などが先に受けたものは触らない
    if (e.target.closest?.("input[type=file], .drop-any")) return;
    e.preventDefault();
    openImport([...e.dataTransfer.files]);
  });
}

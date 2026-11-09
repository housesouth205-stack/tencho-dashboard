// 手元のPCにある出玉率表を「参照するファイル」として覚えておき、出玉率タブを開くたびに
// 更新されていないか見て、更新されていれば読み直す。
//
// ブラウザは勝手にPCのファイル（D:\デスクトップ\…）を読めない。Chrome/Edge の
// File System Access API で一度だけファイルを選んでもらい、その「ファイルへの手がかり」を
// ブラウザ内（IndexedDB）にしまっておく。次からはそれで同じファイルを開ける。
// ・ファイルの場所はブラウザが覚えるので、パスを文字で打つ必要はない（打っても読めない）
// ・ブラウザを閉じると読む許可が切れることがある。そのときはボタン1回で許可し直す
//   （「このサイトに常に許可」を選べば以降は聞かれない）
// ・iPhone/Safari にはこの仕組みが無い。そこでは📂取込から入れてもらう
// 手がかりはこの端末のこのブラウザにしか無い（PCとスマホで共有されない）。

const DB = "tencho-dashboard", STORE = "handles", KEY = "payoutTable";

export const linkSupported = () => typeof window.showOpenFilePicker === "function" && typeof indexedDB !== "undefined";

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getLinked() {
  try { return (await idbDo("readonly", (s) => s.get(KEY))) || null; } catch { return null; }
}
export async function unlink() {
  try { await idbDo("readwrite", (s) => s.delete(KEY)); } catch { /* 消せなくても次に選び直せば上書きされる */ }
}

// ファイルを選んで覚える。ボタンを押した流れの中で呼ぶこと（ブラウザが選択画面を出せない）
export async function pickAndLink() {
  const [handle] = await window.showOpenFilePicker({
    id: "payout-table", startIn: "desktop", multiple: false,
    types: [{ description: "出玉率表（Excel・CSV）", accept: {
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx", ".xlsm"],
      "application/vnd.ms-excel": [".xls"], "text/csv": [".csv", ".tsv", ".txt"],
    } }],
  });
  await idbDo("readwrite", (s) => s.put({ handle, name: handle.name, linkedAt: new Date().toISOString() }, KEY));
  return handle;
}

/**
 * 覚えているファイルの状態。
 * @param interactive true のときだけ許可を求める（ボタンを押した流れの中でしか求められない）
 * @returns {{state: "none"|"denied"|"prompt"|"missing"|"ok", name?: string, file?: File}}
 */
export async function readLinked({ interactive = false } = {}) {
  const rec = await getLinked();
  if (!rec?.handle) return { state: "none" };
  const h = rec.handle;
  let perm = await h.queryPermission({ mode: "read" }).catch(() => "denied");
  if (perm !== "granted" && interactive) perm = await h.requestPermission({ mode: "read" }).catch(() => "denied");
  if (perm !== "granted") return { state: perm === "denied" ? "denied" : "prompt", name: rec.name };
  try { return { state: "ok", name: rec.name, file: await h.getFile() }; }
  // 移動・名前変更・削除されたファイルは開けない。選び直してもらう
  catch { return { state: "missing", name: rec.name }; }
}

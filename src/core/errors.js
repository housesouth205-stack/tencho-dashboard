// トースト通知・保存状態表示。
export function toast(msg, kind = "") {
  const box = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), kind === "err" ? 6000 : 3000);
}

export function errorToast(e) {
  console.error(e);
  toast(e?.message || String(e), "err");
}

export function setSaveState(state) {
  const el = document.getElementById("saveState");
  if (!el) return;
  el.className = "savestate " + state;
  el.textContent = state === "saving" ? "保存中…" : state === "saved" ? "保存済み" : "—";
  if (state === "saved") setTimeout(() => {
    if (el.textContent === "保存済み") { el.className = "savestate"; el.textContent = "—"; }
  }, 1500);
}

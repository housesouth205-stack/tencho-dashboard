// 要素生成ヘルパ（テンプレ文字列に頼らずXSS安全に構築）。
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

// 簡易モーダル。closeを返す。
export function modal(title, bodyNode, footerNode) {
  const bg = el("div", { class: "modal-bg" });
  const close = () => bg.remove();
  const head = el("h2", {}, [title, el("button", { class: "btn ghost sm close", onclick: close, text: "✕" })]);
  const box = el("div", { class: "modal" }, [head, bodyNode, footerNode].filter(Boolean));
  bg.appendChild(box);
  bg.addEventListener("click", (e) => { if (e.target === bg) close(); });
  document.body.appendChild(bg);
  return close;
}

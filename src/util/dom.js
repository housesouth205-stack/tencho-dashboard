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

// フロアの見出しバーと区切り。島図タブと設定投入シミュレーターで同じ見た目に揃える。
// 1FとBFを続けて並べるため、どこで階が変わるかが一目で分かる強さにしている。
// big=true はズーム表示（スマホ）用。縮小してもフロア名が読めるよう大きめにする。
export function floorBar(label, sub, big) {
  const fs = big ? 26 : 15;
  return el("div", {
    style: `display:flex;align-items:center;gap:10px;margin:0 0 8px;padding:${big ? 10 : 7}px ${big ? 18 : 14}px;` +
      `border-radius:8px;background:var(--accent);color:#fff;font-weight:800;font-size:${fs}px;` +
      "letter-spacing:.06em;box-shadow:0 1px 0 rgba(0,0,0,.08)",
  }, [
    el("span", { text: `${label} フロア` }),
    sub ? el("span", { style: `font-weight:600;font-size:${big ? 18 : 12}px;opacity:.92`, text: sub }) : null,
  ]);
}

// 階と階のあいだ。太い二重線＋広めの余白で切れ目をはっきりさせる。
export function floorSplit(big) {
  return el("div", { style: `margin:${big ? 40 : 26}px 0 ${big ? 28 : 18}px;border-top:${big ? 10 : 5}px double var(--accent-dim)` });
}

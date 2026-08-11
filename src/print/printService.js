// 印刷は非表示iframeに自己完結HTMLを書き出して行う。
// ・メインページの @media print / #app レイアウトに依存しないため白紙化しない
// ・window.openを使わないためポップアップブロックの影響を受けない
const VARS = `--panel:#fff;--panel-2:#eef2fa;--panel-3:#f7f9fd;--line:#e3e8f2;--fg:#2f3440;--fg-dim:#8a91a3;--accent:#e5484d;`;

// A4の紙に入る大きさ（96dpi換算のpx）。@page の margin と合わせること。
const MM = 96 / 25.4;
const PAPER = { portrait: { w: 210, h: 297 }, landscape: { w: 297, h: 210 } };

/**
 * 各ノードが1枚に収まるよう、必要なだけ縮小して包み直す。
 *
 * 島図のBFは紙の高さを20pxほど超えていて、はみ出したぶんが次のページに送られ、
 * 下が切れた3ページ目ができていた。中身は幅いっぱいに伸びる作りなので、
 * 縮小するぶん中を広く取り直して、縮小後にちょうど紙幅いっぱいになるようにする。
 *
 * 縮尺は全ノードで共通にする。階ごとに変えると1FとBFで台の大きさが変わってしまう。
 * @returns 包み直したノード（縮小が要らなければ元のノードをそのまま返す）
 */
export function fitToPages(nodes, { orientation = "portrait", margin = 8, safety = 0.98 } = {}) {
  const list = [].concat(nodes);
  const paper = PAPER[orientation] || PAPER.portrait;
  const maxW = (paper.w - margin * 2) * MM;
  // ぴったりだと丸め誤差で次ページに送られることがあるので少しだけ余らせる
  const maxH = (paper.h - margin * 2) * MM * safety;

  const probe = document.createElement("div");
  probe.style.cssText = `position:fixed;left:-10000px;top:0;visibility:hidden;width:${maxW}px`;
  document.body.appendChild(probe);
  const measure = (w) => {
    probe.style.width = `${w}px`;
    return list.map((n) => { probe.appendChild(n); const h = n.scrollHeight; probe.removeChild(n); return h; });
  };
  let heights = measure(maxW);
  let scale = Math.min(1, maxH / Math.max(1, ...heights));
  // 幅を広げると折り返しが変わって高さも変わるので、広げた状態で測り直す
  if (scale < 1) { heights = measure(maxW / scale); scale = Math.min(1, maxH / Math.max(1, ...heights)); }
  probe.remove();
  if (scale >= 1) return list;

  const innerW = maxW / scale;
  return list.map((n, i) => {
    const inner = document.createElement("div");
    inner.style.cssText = `width:${innerW.toFixed(1)}px;transform:scale(${scale.toFixed(4)});transform-origin:top left`;
    inner.appendChild(n);
    // 変形は見た目だけで場所を取らないため、外側に縮小後の大きさを持たせる
    const box = document.createElement("div");
    box.style.cssText = `width:${Math.floor(maxW)}px;height:${Math.ceil(heights[i] * scale)}px;overflow:hidden`;
    box.appendChild(inner);
    return box;
  });
}

export function printContent(nodes, { title = "印刷", orientation = "portrait" } = {}) {
  const inner = [].concat(nodes).map((n) => n.outerHTML).join("");
  const doc = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  @page { size: A4 ${orientation}; margin: 8mm; }
  :root{${VARS}}
  *{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  html,body{margin:0;padding:0;font-family:"Segoe UI","Hiragino Kaku Gothic ProN","Meiryo",sans-serif;color:#2f3440;}
  h2{font-size:15px;margin:0 0 8px;} h3{font-size:14px;margin:0 0 6px;}
  .page-break{break-before:page;} .floor{break-inside:avoid;}
  table{width:100%;border-collapse:collapse;font-size:11px;} th,td{border:1px solid #999;padding:3px 5px;}
</style></head><body>${title ? `<h2>${escapeHtml(title)}</h2>` : ""}${inner}</body></html>`;

  // 前回のiframeが残っていれば除去
  document.getElementById("print-frame")?.remove();
  const frame = document.createElement("iframe");
  frame.id = "print-frame";
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  document.body.appendChild(frame);
  const fd = frame.contentDocument;
  fd.open();
  fd.write(doc);
  fd.close();
  const go = () => {
    try {
      frame.contentWindow.onafterprint = () => frame.remove();
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch (_) {}
    setTimeout(() => frame.remove(), 120000); // 保険の後片付け
  };
  if (fd.readyState === "complete") setTimeout(go, 200);
  else frame.onload = () => setTimeout(go, 200);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

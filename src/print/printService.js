// 印刷は非表示iframeに自己完結HTMLを書き出して行う。
// ・メインページの @media print / #app レイアウトに依存しないため白紙化しない
// ・window.openを使わないためポップアップブロックの影響を受けない
const VARS = `--panel:#fff;--panel-2:#eef2fa;--panel-3:#f7f9fd;--line:#e3e8f2;--fg:#2f3440;--fg-dim:#8a91a3;--accent:#e5484d;`;

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

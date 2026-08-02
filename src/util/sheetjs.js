// SheetJS(XLSX) を同梱UMDから遅延読込。CDN非依存。
let _p = null;
export function getXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (_p) return _p;
  _p = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = new URL("../lib/xlsx.full.min.js", import.meta.url).href;
    s.onload = () => window.XLSX ? resolve(window.XLSX) : reject(new Error("SheetJS 読込失敗"));
    s.onerror = () => reject(new Error("SheetJS 読込失敗"));
    document.head.appendChild(s);
  });
  return _p;
}

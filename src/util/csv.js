// cp932(Shift_JIS)対応CSVパーサ。ArrayBuffer→行配列。
export function decodeCsv(arrayBuffer) {
  const text = new TextDecoder("shift_jis").decode(arrayBuffer);
  return parseCsv(text);
}

export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ヘッダ行から候補名のいずれかに一致する列indexを返す（前後空白除去）。
export function findCol(header, names) {
  const norm = header.map((h) => String(h).trim());
  for (const n of names) { const i = norm.indexOf(n); if (i >= 0) return i; }
  return -1;
}

// cp932(Shift_JIS)対応CSVパーサ。ArrayBuffer→行配列。
export function decodeCsv(arrayBuffer) {
  const text = new TextDecoder("shift_jis").decode(arrayBuffer);
  return parseCsv(text);
}

// 文字コードを見分けて文字列にする。K-TACsはcp932固定だが、こちらで作るCSVは
// Excelでも開けるようBOM付きUTF-8にしている。人が一度Excelで保存し直すと
// cp932に化けることがあるので、どちらでも読めるようにしておく。
export function decodeText(arrayBuffer) {
  const b = new Uint8Array(arrayBuffer);
  if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) {
    return new TextDecoder("utf-8").decode(arrayBuffer.slice(3));
  }
  // fatal:true にすると不正なバイト列で例外になる＝UTF-8でないと分かる。
  try { return new TextDecoder("utf-8", { fatal: true }).decode(arrayBuffer); }
  catch { return new TextDecoder("shift_jis").decode(arrayBuffer); }
}

export function parseCsv(text, delim = ",") {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(field); field = ""; }
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

// 区切り文字を見分ける。Excelの「テキスト（タブ区切り）」で保存したものや、
// 表をそのままコピーして貼ったもの（タブ区切りになる）も、CSVと同じ口で読めるようにする。
// 多くの行で同じ数だけ出てくる文字を区切りとみなす（1行だけ多いのは中身のカンマ等）。
export function sniffDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 30);
  let best = ",", bestScore = -1;
  for (const d of [",", "\t", ";"]) {
    const freq = new Map();
    for (const l of lines) { const n = l.split(d).length - 1; if (n > 0) freq.set(n, (freq.get(n) || 0) + 1); }
    const score = Math.max(0, ...freq.values());
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

// 台番の範囲テキスト（"1-144, 305-320"）の読み書き。
// 区分（レート）と台番の対応は入替で変わるので、コードに直書きせず設定に置く。
// 表計算に貼れる素直な書式にしておくと、店側が島の並びを見ながら直せる。

// "1-144, 305-320, 150" → [{from,to}...]。全角・波ダッシュ・空白は吸収する。
// 読めない断片は捨てずに errors に残す（黙って無視すると設定したつもりで漏れる）。
export function parseRanges(text) {
  const ranges = [], errors = [];
  const src = String(text || "")
    .replace(/[０-９]/g, (c) => "0123456789".charAt("０１２３４５６７８９".indexOf(c)))
    .replace(/[〜～–—]/g, "-")
    .replace(/[、，]/g, ",");
  for (const part of src.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) { errors.push(`「${part}」は台番として読めません`); continue; }
    const from = Number(m[1]), to = m[2] == null ? Number(m[1]) : Number(m[2]);
    if (from < 1 || to < 1) { errors.push(`「${part}」に0以下の台番があります`); continue; }
    if (to < from) { errors.push(`「${part}」は範囲が逆です`); continue; }
    ranges.push({ from, to });
  }
  ranges.sort((a, b) => a.from - b.from);
  // 同じ区分の中で重なっている指定（1-100, 50-120 など）は、台数が二重に数えられる
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].from <= ranges[i - 1].to) {
      errors.push(`${ranges[i - 1].from}-${ranges[i - 1].to} と ${ranges[i].from}-${ranges[i].to} が重なっています`);
    }
  }
  return { ranges, errors };
}

export const formatRanges = (ranges) =>
  ranges.map((r) => (r.from === r.to ? String(r.from) : `${r.from}-${r.to}`)).join(", ");

export const countOf = (ranges) => ranges.reduce((n, r) => n + (r.to - r.from + 1), 0);

export const inRanges = (dai, ranges) => ranges.some((r) => dai >= r.from && dai <= r.to);

// 台番の羅列 → 連番をまとめた範囲。取込済みの実績から初期値を作るのに使う。
export function compressToRanges(numbers) {
  const ns = [...new Set(numbers.map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  const out = [];
  for (const n of ns) {
    const last = out[out.length - 1];
    if (last && n === last.to + 1) last.to = n;
    else out.push({ from: n, to: n });
  }
  return out;
}

// {区分キー: "1-144"} をまとめて解析し、区分をまたいだ重複も見る。
// 重複は「どちらの区分に入れるか」が決まらないので、取込前に必ず気づける必要がある。
export function parseMap(map) {
  const parsed = {}, errors = [];
  for (const [key, text] of Object.entries(map || {})) {
    const r = parseRanges(text);
    parsed[key] = r.ranges;
    for (const e of r.errors) errors.push(`${key}: ${e}`);
  }
  const keys = Object.keys(parsed);
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const hit = [];
      for (const a of parsed[keys[i]]) {
        for (const b of parsed[keys[j]]) {
          const from = Math.max(a.from, b.from), to = Math.min(a.to, b.to);
          if (from <= to) hit.push(from === to ? String(from) : `${from}-${to}`);
        }
      }
      if (hit.length) errors.push(`${keys[i]} と ${keys[j]} が重複: ${hit.join(", ")}`);
    }
  }
  return { parsed, errors };
}

// 台番 → 区分キー。重複しているときは先に定義された区分を返す（設定側で警告を出す）。
export function sectionKeyOfDai(dai, parsedMap) {
  for (const [key, ranges] of Object.entries(parsedMap || {})) if (inRanges(dai, ranges)) return key;
  return null;
}

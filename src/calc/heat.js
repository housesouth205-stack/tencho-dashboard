// アウト/台売上/台粗利のヒートマップ 5段階（低い＝淡い黄 → 高い＝赤）。
export const HEAT5 = ["#fdf6c2", "#fce588", "#f9b234", "#ef6a1c", "#d62828"];

// 5段階レベル 0..4（淡黄→赤）。データ無しは -1。
export function heatLevel(v, min, max) {
  if (v == null || isNaN(v) || max <= min) return -1;
  const t = (v - min) / (max - min);
  return Math.min(4, Math.max(0, Math.floor(t * 5)));
}

// 列ごとの min/max で5段階に量子化して色を返す。
export function heatColor(v, min, max) {
  const lv = heatLevel(v, min, max);
  return lv < 0 ? "transparent" : HEAT5[lv];
}

// ヒートポイント（黄=1pt 〜 赤=5pt、データ無し=0）。
export function heatPoint(v, min, max) {
  const lv = heatLevel(v, min, max);
  return lv < 0 ? 0 : lv + 1;
}

// 配列から欠損を除いた min/max。
export function minMax(values) {
  const nums = values.filter((v) => v != null && !isNaN(v));
  return nums.length ? { min: Math.min(...nums), max: Math.max(...nums) } : { min: 0, max: 0 };
}

// ヒートセルの文字色（濃い赤背景では白寄り）。
export const heatText = (color) => (color === "#d62828" || color === "#ef6a1c" ? "#fff" : "#1a1a1d");

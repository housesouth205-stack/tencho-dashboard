// 区分ごとの識別色（バッジ・グラフで一貫使用）。
// 20スロ=赤 / 5スロ=黄 / 2スロ=青（並び順1/2/3）、以降は緑・紫・水色…
export const SECTION_PALETTE = ["#e5484d", "#eaa100", "#3b82f6", "#2fb884", "#a56cf0", "#14b8c4", "#ec6ba6"];
export const sectionColor = (sec) => SECTION_PALETTE[(((sec?.sort_order || 1) - 1) % SECTION_PALETTE.length + SECTION_PALETTE.length) % SECTION_PALETTE.length];

// 淡色（背景タイル用）。hex + 透明度。
export const tint = (hex, alpha = 0.14) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

// CSSの変数を読む。テーマで変わる色をJS側に直書きすると、
// 背景が黒に変わったときに目盛りの文字が背景に溶けて消える。
// DOMが無い環境や未定義の変数では既定値を返すので、呼び出し側は分岐しなくてよい。
export function cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

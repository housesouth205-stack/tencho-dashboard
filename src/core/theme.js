// 画面の見た目（通常 / ドラクエ風）の切替。
//
// 保存先が app_setting ではなく localStorage なのには理由がある。
// テーマは「最初の描画より前」に当てないと、一瞬だけ白い画面が出てから黒に変わる。
// app_setting はSupabaseへの問い合わせなので必ず描画に間に合わない。
// また画面の明るさの好みは端末ごとに違う（店の事務所のPCとスマホで同じにしたいとは限らない）。
// この2つの理由から、テーマだけは端末に持たせる。

const KEY = "tencho.theme";
const DEFAULT = "light";

export const THEMES = [
  { id: "light", label: "通常", desc: "白ベース。既定の見た目です。" },
  { id: "dq", label: "ドラクエ風", desc: "黒地にドット文字。数字は16pxに拡大されます。" },
];

const isValid = (id) => THEMES.some((t) => t.id === id);

export function currentTheme() {
  try {
    const v = localStorage.getItem(KEY);
    return isValid(v) ? v : DEFAULT;
  } catch {
    // プライベートモード等でlocalStorageが読めない端末でも、通常テーマで動けばよい
    return DEFAULT;
  }
}

// data-theme 属性の有無だけで切り替える。通常テーマは属性を付けない（＝既存CSSそのまま）。
export function applyTheme(id) {
  const t = isValid(id) ? id : DEFAULT;
  if (t === DEFAULT) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  return t;
}

const listeners = new Set();
export const onThemeChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));

export function setTheme(id) {
  const t = applyTheme(id);
  try { localStorage.setItem(KEY, t); } catch { /* 保存できなくても表示は変わる */ }
  listeners.forEach((fn) => fn(t));
  return t;
}

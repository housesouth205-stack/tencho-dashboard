// 機種ごとの「使ってよい最低設定」。
//
// 一部の機種は設定1にするとパネルが消灯し、外から設定1と分かってしまう。
// そういう機種は設定1を使わず最低でも設定2で運用するため、シミュレーターでも
// 設定1を割り当てないようにする。
//
// この情報は出玉率データ(model_spec)には含まれない（出玉率は数値だけで、
// パネルの挙動は持っていない）ため、店舗側で機種ごとに持つ設定として管理する。
// 既定値として運用で判明している機種を持ち、出玉率タブで追加・解除できる。
import { modelKey } from "../../util/format.js";

// 設定1でパネルが消灯する＝最低設定2で運用する機種（2026-08時点で判明分）。
// 表記ゆれは modelKey で吸収するが、正式名に副題が挟まる機種は部分一致では
// 拾えないため（例「ＴｏＬＯＶＥる－とらぶる－ダークネス」）副題入りも並べる。
export const DEFAULT_MIN2 = [
  "L主役は銭形",
  "LToLOVEるダークネス",
  "L ToLOVEる-とらぶる-ダークネス",
  "Lバンドリ",
];

export const MIN_CHOICES = [1, 2];

// 機種名の表記ゆれを吸収して引く。完全一致→部分一致（sameModelと同じ考え方）の順。
// 「Lバンドリ」の登録で「Lバンドリ！ ガールズバンドパーティ！」も拾えるようにする。
function lookup(map, model) {
  const k = modelKey(model);
  if (!k) return null;
  if (map.has(k)) return map.get(k);
  for (const [mk, v] of map) {
    if (mk && (k.includes(mk) || mk.includes(k))) return v;
  }
  return null;
}

// saved: app_setting "settei_min" の値 { 機種名: 最低設定 }。既定より優先する。
export function buildMinSetting(saved) {
  const base = new Map(DEFAULT_MIN2.map((m) => [modelKey(m), 2]));
  const user = new Map();
  for (const [model, v] of Object.entries(saved || {})) {
    const n = Number(v);
    if (modelKey(model) && n >= 1 && n <= 6) user.set(modelKey(model), n);
  }
  // 明示指定があればそれを使い、無ければ既定リストを見る（既定を1に戻すことも可能）
  const of = (model) => lookup(user, model) ?? lookup(base, model) ?? 1;
  return {
    of,
    // 設定1を使えない＝最低設定が2以上
    blocksOne: (model) => of(model) > 1,
    // 表示用: 既定リスト由来かどうか
    isDefault: (model) => lookup(user, model) == null && lookup(base, model) != null,
  };
}

// 割り当てたい設定を、その機種で使える範囲に丸める。
export const clampSetting = (setting, min) => Math.max(Number(setting) || 1, min || 1);

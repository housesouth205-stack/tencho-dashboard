// 台番 → 区分（レート）の対応。島図・シミュレーター・機種分析・取込が同じ定義を見る唯一の窓口。
//
// もとは config.js に直書きしていたが、コーナーの入替やレート変更のたびにコードを
// 直す必要があった。設定タブから編集できるよう app_setting に置く。
// 保存キーは区分の「キー(S20)」。UUIDで持つと、設定タブで区分を作り直したときに
// 黙って対応が切れる（同じ壊れ方を実績データで経験している）。
// 店舗IDは config から直接取る。state.js は起動時にこのモジュールを読むので、
// state を参照すると循環importになる（storeId は起動後に変わらないので config で足りる）。
import { repo } from "./repo.js";
import { RATE_RANGES, STORE_ID } from "./config.js";
import { parseMap, formatRanges, sectionKeyOfDai } from "../util/daiRange.js";

const KEY = "dai_ranges";

let text = null;      // { S20: "1-144, 305-320" }
let parsed = null;    // { S20: [{from,to}] }
let updatedAt = null;

// 設定が未保存の店では config.js の値を種にする（今までと同じ判定で立ち上がる）。
function seedText() {
  const by = {};
  for (const r of RATE_RANGES) (by[r.key] = by[r.key] || []).push({ from: r.from, to: r.to });
  return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, formatRanges(v)]));
}

function apply(map, at) {
  text = map;
  parsed = parseMap(map).parsed;
  updatedAt = at || null;
}

export async function loadDaiRanges() {
  try {
    const row = (await repo.select("app_setting", { eq: { store_id: STORE_ID, key: KEY } }))[0];
    const v = row?.value;
    // 旧い形（範囲だけのJSON）でも読めるようにしておく
    if (v && typeof v === "object" && v.map) apply(v.map, v.updated_at);
    else if (v && typeof v === "object" && Object.keys(v).length) apply(v, null);
    else apply(seedText(), null);
  } catch {
    apply(seedText(), null);
  }
  return text;
}

export async function saveDaiRanges(map) {
  const at = new Date().toISOString();
  await repo.upsert("app_setting", { store_id: STORE_ID, key: KEY, value: { map, updated_at: at } },
    { onConflict: ["store_id", "key"] });
  apply(map, at);
}

// 未読込のうちに呼ばれても種で答える（描画の途中で null になるより、従来の判定で出したほうが安全）。
const ensure = () => (parsed ? parsed : (apply(seedText(), null), parsed));

export const rateKeyOfDai = (dai) => sectionKeyOfDai(dai, ensure());
export const daiRangeText = () => ({ ...(text || seedText()) });
export const daiRangesUpdatedAt = () => updatedAt;
// 設定が保存済みか（＝店が自分で決めた値か、config.js の種か）。
export const daiRangesSaved = () => updatedAt != null;

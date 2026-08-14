// 同梱の機種データベース(src/data/payout-db.json)から出玉率を引く。
//
// Web取得(一撃/DMM)と違い、通信もEdge Functionも要らず、出典URLと信頼度が付いた
// 値をそのまま使える。pachislot-db 側で「範囲表記から設定2〜5を推測しない」
// 「情報源が食い違ったら要確認に落とす」というルールを通した結果なので、
// ここでは値をいじらずそのまま渡す。
//
// 返す形は dmm.js の検索結果に合わせてある（per6 / range / name / score / source）。
// 呼び出し側は payoutFromDmm() をそのまま使える。
import { normName, similarity } from "./dmm.js";

// 照合キー。当店の命名(先頭の丸数字＝区分マーカー、先頭の S/L/P＝機種種別)は
// 機種名の一部ではないので、DB側・店側の両方から同じ規則で落としてから比べる。
// 片側だけ落とすと「①スマスロ モンキーターンV」が「スマスロモンキーターンV」に
// 当たらなくなるため、必ず両側に同じ処理をかける。
function matchKey(s) {
  let t = String(s || "").replace(/^[①-⑳]+/, ""); // NFKCで数字になる前に落とす
  t = t.normalize("NFKC").replace(/^[\s/]*[SLP]\s*/i, "");
  return normName(t);
}

const URL_JSON = new URL("../../data/payout-db.json", import.meta.url).href;

let loading = null; // 読み込みは1回だけ。複数行から同時に呼ばれても共有する
let db = null; // { meta, list:[{name, per6, range, ...}], index:Map<normName, entry[]> }

async function load() {
  if (db) return db;
  if (!loading) {
    loading = (async () => {
      const res = await fetch(URL_JSON);
      if (!res.ok) throw new Error(`機種DBを読み込めませんでした(HTTP ${res.status})`);
      const json = await res.json();
      const list = json.machines.map(toEntry);
      const index = new Map();
      for (const e of list) {
        // 正規表記と別表記のどちらで引いても当たるようにする
        for (const key of e.keys) {
          const cur = index.get(key);
          if (cur) cur.push(e);
          else index.set(key, [e]);
        }
      }
      db = { meta: json._meta, list, index };
      return db;
    })().catch((e) => { loading = null; throw e; });
  }
  return loading;
}

function toEntry(m) {
  const rates = m["出率"] || [];
  // 粒度が「範囲」＝設定1と6しか実測が無い機種。dmm.js のレンジ結果と同じ形に寄せ、
  // 設定2〜5の補間はダッシュボード側のタイプ標準カーブに任せる（DBは推測を持たない）。
  const isRange = m["粒度"] === "範囲";
  const entry = {
    name: m["機種名"],
    source: "db",
    per6: isRange ? null : rates.map((v) => (v == null ? null : v)),
    range: isRange ? [rates[0], rates[5]] : null,
    // その機種に存在する設定。複数の情報源が一致したときだけ入る。
    // レンジから補間したあと、ここに無い設定を空欄に戻すのに使う
    // （設定1・2・5・6しか無い機種の設定3・4に数字を作らないため）。
    lineup: m["存在する設定"] || [],
    confidence: m["信頼度"] || "",
    condition: m["出率条件"] || "",
    urls: m["出典"] || [],
    type: m["タイプ"] || "",
    kikaku: m["規則区分"] || "",
    coinRef: m["参考コイン単価"] ?? null,
    coinRefCond: m["参考コイン単価条件"] || "",
  };
  // 店舗の遊技台CSVは機種名ではなく検定型式名で入っていることが多い
  // （店側「S/新ﾊﾅﾋﾞR/HA」＝型式名「S/新ハナビR/HA」）。
  // 型式名でしか名前が繋がらない機種もある
  // （機種名「ぱちスロ ギャグダー」＝型式名「SギャグラーKB」）ので、
  // 機種名・別表記と同じ土俵の照合キーとして型式名も index に入れる。
  const names = [m["機種名"], m["型式名"], ...(m["別表記"] || [])];
  entry.katashiki = m["型式名"] || "";
  entry.keys = [...new Set(names.filter(Boolean).map(matchKey).filter(Boolean))];
  return entry;
}

export async function dbMeta() {
  return (await load()).meta;
}

// 短い名前が長い名前に含まれるだけで高score(0.9)になるのを抑える。
// 「ゴジラ」は「ゴジラVSエヴァンゲリオン」に含まれるが別機種で、
// そのまま採ると片方の出玉率をもう片方に付けてしまう。
// 文字数が離れているほど確信を下げ、自動確定の閾値には届かないようにする。
function scoreOf(key, cand) {
  const raw = Math.max(...cand.keys.map((k) => similarity(key, k)));
  if (raw >= 0.999) return raw;
  const len = Math.max(...cand.keys.map((k) => k.length));
  const ratio = len ? Math.min(key.length, len) / Math.max(key.length, len) : 0;
  return raw * (0.5 + 0.5 * ratio);
}

// 機種名に一致する候補を score 降順で返す。
// 完全一致(正規化後)があればそれだけを返し、無ければ全件から類似度で拾う。
// score が 1 なのは正規化後の完全一致だけで、呼び出し側はそれだけを自動確定に使う。
export async function dbCandidates(model, limit = 6) {
  const { index, list } = await load();
  const key = matchKey(model);
  if (!key) return [];

  const exact = index.get(key);
  if (exact && exact.length) return exact.map((e) => ({ ...e, score: 1 }));

  return list
    .map((e) => ({ ...e, score: scoreOf(key, e) }))
    .filter((e) => e.score > 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

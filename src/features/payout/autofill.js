// 出玉率の自動補完。島図を取り込んで新しい機種が入ったとき、出玉率タブを開かなくても
// 店長の出玉率表（PCのExcel）から埋めて保存する。
// 以前は表に無い機種を機種DB→Web（一撃/DMM）でも埋めていたが、店長が確かめた表だけを使うことにした。
// 名前の似た別の機種の値が静かに入るより、「表に無い」と知らせてExcelに足してもらうほうが確か。
import { repo } from "../../core/repo.js";
import { state } from "../../core/state.js";
import { round1 } from "../simulator/economics.js";
import { fromSavedTable } from "./tableSource.js";

const AT_HINT = /ジャグラー|ハナビ|クレア|ゲッターマウス|パルサー|バーサス|ドンちゃん|ハッピー|マイジャグ|ファンキー|ゴーゴー|ミスター|沖ドキ|ディスクアップ|アイムジャグ|ジャグ/;
export const guessType = (m) => (AT_HINT.test(String(m).normalize("NFKC")) ? "Aタイプ" : "AT機");

// 1機種ぶん。表に無ければ null（出玉率タブでは「未登録」としてタイプの標準値で見える）。
async function findOne(model, type) {
  const t = await fromSavedTable(model).catch(() => null);
  if (!t) return null;
  return { type, payout: t.payout, sourceUrl: `${t.file}｜${t.name}` };
}

/**
 * 出玉率が未登録の機種だけを埋めて保存する。登録済みの機種（手で直した値を含む）には触らない。
 * @param {string[]} models 機種名の一覧（重複可）
 * @returns {{targets: string[], file: string[], left: string[]}}
 */
export async function autoFillModels(models, onProgress = () => {}) {
  const specs = await repo.select("model_spec", {});
  const registered = new Set(specs.filter((s) => s.payout_rate != null).map((s) => s.model_name));
  const targets = [...new Set(models.filter(Boolean))].filter((m) => !registered.has(m));
  const out = { targets, file: [], left: [] };
  if (!targets.length) return out;

  const get = async (key) => (await repo.select("app_setting", { eq: { store_id: state.storeId, key } }))[0]?.value || {};
  const types = await get("settei_types");
  const rows = [];
  for (let i = 0; i < targets.length; i++) {
    const m = targets[i];
    onProgress(`${i + 1}/${targets.length} ${m}`);
    const x = await findOne(m, types[m] || guessType(m));
    if (!x) { out.left.push(m); continue; }
    out.file.push(m);
    types[m] = x.type;
    for (let s = 0; s < 6; s++) {
      rows.push({ model_name: m, setting: s + 1, payout_rate: round1(x.payout[s]), source: "file", source_url: x.sourceUrl });
    }
  }
  for (let i = 0; i < rows.length; i += 200) await repo.upsert("model_spec", rows.slice(i, i + 200), { onConflict: ["model_name", "setting"] });
  if (out.file.length) {
    await repo.upsert("app_setting", { store_id: state.storeId, key: "settei_types", value: types }, { onConflict: ["store_id", "key"] });
  }
  return out;
}

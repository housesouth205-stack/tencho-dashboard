// 出玉率の自動補完。島図を取り込んで新しい機種が入ったとき、出玉率タブを開かなくても
// 機種DB→Web（一撃/DMM）の順で埋めて保存する。出玉率タブの一括ボタンと同じ基準で当てるため、
// 「結果から出玉率を作る」処理はここに置いて、タブ側もこれを使う（基準が2か所でずれないように）。
import { repo } from "../../core/repo.js";
import { state } from "../../core/state.js";
import { TYPES, payoutFromDmm, round1 } from "../simulator/economics.js";
import { dmmSearch, rankCandidates, searchKeyword } from "./dmm.js";
import { dbCandidates } from "./localdb.js";

const AT_HINT = /ジャグラー|ハナビ|クレア|ゲッターマウス|パルサー|バーサス|ドンちゃん|ハッピー|マイジャグ|ファンキー|ゴーゴー|ミスター|沖ドキ|ディスクアップ|アイムジャグ|ジャグ/;
export const guessType = (m) => (AT_HINT.test(String(m).normalize("NFKC")) ? "Aタイプ" : "AT機");
export const AUTO_SCORE = 0.55; // Web取得で自動確定する名前類似度の下限
// 機種DBで自動確定する名前類似度の下限。完全一致だけに絞ると候補選択の手数が多くなるため、
// この値まで自動で入れる。自動で入れたものは状態列に一致率を出し、後から見直せる。
export const DB_AUTO_SCORE = 0.3;

/**
 * 候補（機種DB または Web）から、出玉率の行に入れる値を作る。作れなければ null。
 * @returns {{type, payout, source, note, matchScore, sourceUrl, dmmId}|null}
 */
export function resultToSpec(res, type) {
  // 機種DBはタイプも出典付きで持っているので、先にタイプを合わせてから出玉率を作る。
  // レンジからの補間はタイプ標準カーブを使うため、順番を逆にすると違うカーブで補間される。
  const t = res.source === "db" && res.type && TYPES[res.type] ? res.type : type;
  const pay = payoutFromDmm(res, t);
  if (!pay) return null;
  // レンジ補間は設定1〜6を必ず埋めるが、設定1・2・5・6しか無い機種がある。
  // 機種DBが「存在する設定」を持っていれば、そこに無い設定は空欄に戻す。
  // 空欄はシミュレーターへの「この設定は入れない」という指示でもある。
  if (res.source === "db" && res.lineup && res.lineup.length) {
    for (let s = 1; s <= 6; s++) if (!res.lineup.includes(s)) pay[s - 1] = null;
  }
  const per6 = !!(res.per6 && res.per6.filter((v) => v != null).length >= 3);
  const source = res.source === "db" ? (per6 ? "db-per6" : "db-range") : (per6 ? "dmm-per6" : "dmm-range");
  // 完全一致でないときは、どの機種名に当てたかと一致率を残す。
  // 一致率30%でも自動で入るので、後から見直せる手掛かりが要る。
  const who = res.katashiki && res.katashiki !== res.name ? `${res.name}（型式名 ${res.katashiki}）` : res.name;
  const matched = res.score != null && res.score < 1 ? `\n照合: 「${who}」に一致率${Math.round(res.score * 100)}%で適用` : "";
  return {
    type: t, payout: pay, source,
    note: res.source === "db" ? `機種DB（信頼度 ${res.confidence || "—"}／条件 ${res.condition || "—"}）${matched}\n出典: ${(res.urls || []).join("\n")}` : null,
    matchScore: res.source === "db" ? (res.score ?? null) : null,
    sourceUrl: res.source === "db" ? (res.urls || [])[0] || null : null,
    dmmId: res.source !== "db" && res.id ? { id: res.id, source: res.source || "dmm" } : null,
  };
}

// 1機種ぶん。迷う候補しか無ければ null（勝手に入れず、出玉率タブで選んでもらう）。
async function findOne(model, type) {
  const list = await dbCandidates(model).catch(() => []);
  if (list.length && list[0].score >= DB_AUTO_SCORE) {
    const x = resultToSpec(list[0], type);
    if (x) return { ...x, via: "db" };
  }
  const kw = searchKeyword(model);
  if (!kw) return null;
  const { candidates = [] } = await dmmSearch(kw, 4).catch(() => ({ candidates: [] }));
  const ranked = rankCandidates(kw, candidates).filter((c) => c.range || c.per6);
  if (ranked[0] && ranked[0].score >= AUTO_SCORE) {
    const x = resultToSpec(ranked[0], type);
    if (x) return { ...x, via: "web" };
  }
  return null;
}

/**
 * 出玉率が未登録の機種だけを埋めて保存する。登録済みの機種（手で直した値を含む）には触らない。
 * @param {string[]} models 機種名の一覧（重複可）
 * @returns {{targets: string[], db: string[], web: string[], left: string[]}}
 */
export async function autoFillModels(models, onProgress = () => {}) {
  const specs = await repo.select("model_spec", {});
  const registered = new Set(specs.filter((s) => s.payout_rate != null).map((s) => s.model_name));
  const targets = [...new Set(models.filter(Boolean))].filter((m) => !registered.has(m));
  const out = { targets, db: [], web: [], left: [] };
  if (!targets.length) return out;

  const get = async (key) => (await repo.select("app_setting", { eq: { store_id: state.storeId, key } }))[0]?.value || {};
  const types = await get("settei_types");
  const dmmMap = await get("dmm_map");
  const rows = [];
  for (let i = 0; i < targets.length; i++) {
    const m = targets[i];
    onProgress(`${i + 1}/${targets.length} ${m}`);
    const x = await findOne(m, types[m] || guessType(m));
    if (!x) { out.left.push(m); continue; }
    out[x.via].push(m);
    types[m] = x.type;
    if (x.dmmId) dmmMap[m] = x.dmmId;
    const src = x.via === "db" ? "db" : "web";
    for (let s = 0; s < 6; s++) {
      rows.push({ model_name: m, setting: s + 1, payout_rate: round1(x.payout[s]), source: src, source_url: src === "db" ? x.sourceUrl : null });
    }
  }
  for (let i = 0; i < rows.length; i += 200) await repo.upsert("model_spec", rows.slice(i, i + 200), { onConflict: ["model_name", "setting"] });
  if (out.db.length || out.web.length) {
    await repo.upsert("app_setting", { store_id: state.storeId, key: "settei_types", value: types }, { onConflict: ["store_id", "key"] });
    await repo.upsert("app_setting", { store_id: state.storeId, key: "dmm_map", value: dmmMap }, { onConflict: ["store_id", "key"] });
  }
  return out;
}

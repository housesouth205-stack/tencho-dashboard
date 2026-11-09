// 店長の出玉率表（Excel/CSV）を出玉率タブに反映する。
//
// 出玉率は 機種DB（同梱）→ Web（一撃/DMM）の順で埋めてきたが、店長が自分で確かめて作った表が
// いちばん確か。表を取り込んだら、その表を「出典の1つ」として保存しておき、
// 今ある機種に名前で当てて model_spec に入れる。表そのものも残すのは、島図の入替で
// 新しい機種が入ったときに、表から先に埋めるため（autofill.js）。
//
// 店の機種名は検定型式名（「S/新ﾊﾅﾋﾞR/HA」）、表の機種名は通称（「新ハナビ」）のことが多く、
// そのままでは名前が当たらない。機種DBが型式名と通称の対応を持っているので、
// 店の名前を一度機種DBに当て、DB側の通称・別表記でも表を引く。
import { el, modal } from "../../util/dom.js";
import { repo } from "../../core/repo.js";
import { state } from "../../core/state.js";
import { toast, errorToast, setSaveState } from "../../core/errors.js";
import { loadCurrentPeriod, loadSnapshotRows } from "../snapshotData.js";
import { dbCandidates, matchKey, scoreOf } from "./localdb.js";
import { fmt1 } from "../simulator/economics.js";

const KEY = "payout_table";
// これ以上なら聞かずに当てる。表の名前は通称なので機種DBより揺れが小さく、
// 機種DBの自動確定（30%）より高めにして取り違えを防ぐ
export const TABLE_AUTO_SCORE = 0.85;

// 末尾の作品番号（2・3、V・Ⅵ）。「マイジャグラーⅥ」と「マイジャグラーV」、「ゴーゴージャグラー3」と
// 「…2」は名前がほぼ同じでも別の機種で、出玉率も違う。番号が食い違うときは自動で当てない。
// 番号の後ろの短い英字（店内コード「MW」など）は番号の一部とみなさない。
const ROMAN = { I: 1, V: 5, X: 10 };
function seriesNo(key) {
  const m = key.match(/(\d+|[IVX]+)[A-Z]{0,3}$/);
  if (!m) return null;
  if (/^\d+$/.test(m[1])) return Number(m[1]);
  let n = 0;
  for (let i = 0; i < m[1].length; i++) {
    const v = ROMAN[m[1][i]], next = ROMAN[m[1][i + 1]] || 0;
    n += v < next ? -v : v;
  }
  return n;
}
function scoreKeys(keys, entryKeys) {
  let best = 0;
  for (const k of keys) {
    let sc = scoreOf(k, { keys: entryKeys });
    if (sc < 0.999) {
      const a = seriesNo(k), b = Math.max(...entryKeys.map((x) => seriesNo(x) ?? -1));
      if (a != null && b >= 0 && a !== b) sc = Math.min(sc, 0.5);
    }
    best = Math.max(best, sc);
  }
  return best;
}

export async function loadTable() {
  return (await repo.select("app_setting", { eq: { store_id: state.storeId, key: KEY } }))[0]?.value || null;
}

async function saveTable(value) {
  await repo.upsert("app_setting", { store_id: state.storeId, key: KEY, value }, { onConflict: ["store_id", "key"] });
}

// 今の店の機種一覧（出玉率タブと同じ：島図を優先、無ければ台別データ）
export async function loadStoreModels() {
  const island = (await repo.select("app_setting", { eq: { store_id: state.storeId, key: "island_models" } }))[0]?.value || {};
  let names = Object.values(island);
  if (!names.length) {
    const period = await loadCurrentPeriod();
    names = period ? (await loadSnapshotRows(period.id)).map((r) => r.model_name) : [];
  }
  const count = new Map();
  for (const n of names) if (n) count.set(n, (count.get(n) || 0) + 1);
  return [...count].map(([model, n]) => ({ model, count: n }));
}

// 1機種ぶんの照合キー。店の名前そのものと、機種DBで完全一致した機種の通称・別表記・型式名。
async function keysOf(model) {
  const keys = new Set([matchKey(model)]);
  const db = await dbCandidates(model, 1).catch(() => []);
  if (db[0] && db[0].score >= 0.999) for (const k of db[0].keys) keys.add(k);
  return [...keys].filter(Boolean);
}

/**
 * 店の機種ごとに、表の候補を一致率の高い順に並べる。
 * @returns {{model, count, cands: {entry, score}[], pick: number}[]} pick は採用する候補の番号（-1＝使わない）
 */
export async function matchTable(models, entries) {
  const prepared = entries.map((e) => ({ entry: e, keys: [matchKey(e.name)].filter(Boolean) }));
  const out = [];
  for (const m of models) {
    const keys = await keysOf(m.model);
    const cands = prepared
      .map((p) => ({ entry: p.entry, score: scoreKeys(keys, p.keys) }))
      .filter((c) => c.score > 0.35)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    // 完全一致でないときは、2番手と差がはっきりあるときだけ自動で当てる（似た名前の機種が並ぶため）
    const [c0, c1] = cands;
    const sure = c0 && (c0.score >= 0.999 || (c0.score >= TABLE_AUTO_SCORE && (!c1 || c0.score - c1.score >= 0.1)));
    out.push({ ...m, cands, pick: sure ? 0 : -1 });
  }
  return out;
}

// 選んだ対応を model_spec に書く。空欄の設定は null で書く（＝その設定は無い）。
// 表に無い機種、「使わない」にした機種には触らない。
async function applyMatches(matched, file) {
  const rows = [];
  for (const m of matched) {
    if (m.pick < 0) continue;
    const e = m.cands[m.pick].entry;
    for (let s = 0; s < 6; s++) {
      rows.push({ model_name: m.model, setting: s + 1, payout_rate: e.per6[s], source: "file", source_url: `${file}｜${e.name}` });
    }
  }
  for (let i = 0; i < rows.length; i += 200) await repo.upsert("model_spec", rows.slice(i, i + 200), { onConflict: ["model_name", "setting"] });
  return rows.length / 6;
}

/**
 * 表を保存し、店の機種に当てて確認画面を出す。silent のときは、聞かずに当てられる分だけ反映する
 * （手元のファイルが更新されていたときの自動反映用）。
 * @returns {Promise<{applied: number, ask: number, miss: number} | null>}
 */
export async function importPayoutTable({ entries, file, lastModified = null, silent = false, onDone }) {
  setSaveState("saving");
  await saveTable({ file, lastModified, importedAt: new Date().toISOString(), entries });
  setSaveState("saved");
  const models = await loadStoreModels();
  if (!models.length) {
    toast(`出玉率表（${entries.length}機種）を保存しました。島図か台別データを取り込むと、機種に当てて反映します`, "ok");
    return { applied: 0, ask: 0, miss: 0 };
  }
  const matched = await matchTable(models, entries);
  const sum = () => ({ applied: matched.filter((m) => m.pick >= 0).length, ask: matched.filter((m) => m.pick < 0 && m.cands.length).length, miss: matched.filter((m) => !m.cands.length).length });
  if (silent) {
    const n = await applyMatches(matched, file);
    const s = sum();
    toast(`出玉率表（${file}）から ${n}機種を反映しました${s.ask ? `／要確認 ${s.ask}機種は出玉率タブの「出玉率表」から` : ""}`, "ok");
    onDone?.();
    return s;
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const counts = el("div", { class: "hint" });
    const drawCounts = () => {
      const s = sum();
      counts.textContent = `当店 ${matched.length}機種：反映する ${s.applied}／要確認（候補あり・未選択） ${s.ask}／表に見当たらない ${s.miss}`;
    };
    const tb = el("tbody");
    // 要確認を上に出す。自動で当たった機種より、目で見てほしい機種のほうが少なく大事
    const order = [...matched].sort((a, b) => rank(a) - rank(b));
    function rank(m) { return m.pick < 0 && m.cands.length ? 0 : m.pick >= 0 && m.cands[m.pick].score < 1 ? 1 : m.pick >= 0 ? 2 : 3; }
    for (const m of order) {
      const vals = el("td", { class: "mono", style: "white-space:nowrap" });
      const drawVals = () => {
        vals.textContent = m.pick < 0 ? "—" : m.cands[m.pick].entry.per6.map((v) => (v == null ? "・" : fmt1(v))).join(" / ");
      };
      const sel = el("select", { class: "inp", style: "max-width:300px", onchange: (e) => { m.pick = Number(e.target.value); drawVals(); drawCounts(); paint(); } }, [
        el("option", { value: -1, text: m.cands.length ? "（使わない）" : "（表に見当たらない）" }),
        ...m.cands.map((c, i) => el("option", { value: i, text: `${c.entry.name}（一致${Math.round(c.score * 100)}%）` })),
      ]);
      sel.value = String(m.pick);
      const tr = el("tr", {}, [el("td", { class: "txt", style: "white-space:nowrap", text: m.model }), el("td", { text: String(m.count) }), el("td", {}, sel), vals]);
      const paint = () => {
        const sc = m.pick >= 0 ? m.cands[m.pick].score : null;
        tr.style.background = m.pick < 0 && m.cands.length ? "var(--pastel-red)" : sc != null && sc < 1 ? "rgba(224,165,46,.12)" : "";
      };
      drawVals(); paint();
      tb.appendChild(tr);
    }
    drawCounts();
    const close = modal("出玉率表を機種に当てる", el("div", { class: "col", style: "gap:8px;min-width:min(860px,100%)" }, [
      el("p", { class: "hint", style: "margin:0", text: `${file}（${entries.length}機種）を、今の店の機種に名前で当てました。一致率${Math.round(TABLE_AUTO_SCORE * 100)}%以上は自動で選んであります。赤い行は候補から選ぶか「使わない」のままにしてください。` }),
      el("p", { class: "hint", style: "margin:0", text: "反映すると、選んだ機種の設定1〜6は表の値で上書きされます。表で空欄の設定は「その設定は無い」として空欄になります。" }),
      counts,
      el("div", { class: "table-wrap", style: "max-height:55vh;overflow:auto" }, el("table", { class: "grid compact" }, [
        el("thead", {}, el("tr", {}, ["当店の機種", "台数", "出玉率表の機種", "設定1〜6"].map((h, i) => el("th", { class: i === 0 || i === 2 ? "txt" : "", text: h })))), tb,
      ])),
    ]), el("div", { class: "row", style: "justify-content:flex-end;gap:8px;margin-top:12px" }, [
      el("button", { class: "btn ghost", text: "やめる（表だけ保存）", onclick: () => close() }),
      el("button", { class: "btn primary", text: "この内容で反映", onclick: async () => {
        try {
          setSaveState("saving");
          const n = await applyMatches(matched, file);
          setSaveState("saved");
          toast(`出玉率表から ${n}機種を反映しました`, "ok");
          finish(sum());
          close();
          onDone?.();
        } catch (e) { errorToast(e); }
      } }),
    ]), { onClose: () => finish(null) });
  });
}

// 島図の入替で入った新しい機種向け。表に一致率の高い機種があればその値を返す（無ければ null）。
export async function fromSavedTable(model) {
  const t = await loadTable().catch(() => null);
  if (!t?.entries?.length) return null;
  const [m] = await matchTable([{ model, count: 0 }], t.entries);
  if (m.pick < 0) return null;
  const c = m.cands[m.pick];
  return { payout: [...c.entry.per6], name: c.entry.name, score: c.score, file: t.file };
}

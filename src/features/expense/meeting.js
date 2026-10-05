// 月次会議サマリー（Excel）の取込と、経費タブでの表示。
// 会議で配るサマリー表と同じ並び・同じ見方（予算比・前年比・信号色・所見）で見られるようにしている。
// 紙とアプリで数字の置き場所が違うと、会議中に探す手間が出るため。
import { el, clear } from "../../util/dom.js";
import { repo } from "../../core/repo.js";
import { state } from "../../core/state.js";
import { toast, setSaveState } from "../../core/errors.js";
import { getXLSX } from "../../util/sheetjs.js";
import { parseMeetingXlsx } from "../../import/meetingXlsx.js";

export const KEY_PREFIX = "meeting:";

// ---------------------------------------------------------------- 取込
export async function importMeetingFile(file) {
  const XLSX = await getXLSX();
  const { ym, summary, plRows, warnings } = parseMeetingXlsx(XLSX, await file.arrayBuffer(), file.name);
  setSaveState("saving");
  await repo.upsert("app_setting", { store_id: state.storeId, key: KEY_PREFIX + ym.slice(0, 7), value: summary }, { onConflict: ["store_id", "key"] });
  // 月次の推移グラフは pl_month を見るので、実績（当月・前年同月）と予算もそこへ入れる。
  // pl_month が未作成の環境でもサマリー自体は見られるよう、ここの失敗は警告に留める。
  try {
    const recs = plRows.map((r) => ({ ...r, store_id: state.storeId }));
    if (recs.length) await repo.upsert("pl_month", recs, { onConflict: ["store_id", "ym", "kind"] });
  } catch (e) { warnings.push("月次の推移への反映に失敗しました：" + (e.message || e)); }
  await repo.upsert("import_log", { store_id: state.storeId, kind: "meeting_xlsx", filename: file.name, row_count: plRows.length,
    status: warnings.length ? "warn" : "ok", message: summary.title }, { onConflict: ["id"] }).catch(() => {});
  setSaveState("saved");
  toast(`${ym.slice(0, 7).replace("-", "年")}月度の会議サマリーを取り込みました`, "ok");
  return { ym, summary, warnings };
}

export async function loadMeetings() {
  const rows = await repo.select("app_setting", { eq: { store_id: state.storeId } });
  return rows.filter((r) => String(r.key).startsWith(KEY_PREFIX) && r.value)
    .map((r) => r.value).sort((a, b) => (a.ym < b.ym ? 1 : -1));
}

// ---------------------------------------------------------------- 書式
const k = (v) => (v == null ? "" : (v < 0 ? "▲" : "") + Math.abs(Math.round(v)).toLocaleString("ja-JP"));
const pct = (v, d = 1) => (v == null || !isFinite(v) ? "" : (v * 100).toFixed(d) + "%");
const ratio = (a, b) => (a == null || b == null || b <= 0 || a < 0 ? null : a / b);
// 会議資料と同じ信号色：100%以上＝緑、95〜100%＝黄、95%未満＝赤。経費は逆向き（少ないほど良い）
function signal(r, lowerBetter) {
  if (r == null) return "";
  const g = lowerBetter ? 2 - r : r;
  return g >= 1 ? "mt-ok" : g >= 0.95 ? "mt-warn" : "mt-bad";
}
function bar(r, lowerBetter) {
  if (r == null) return el("td");
  const w = Math.min(r, 1.25) / 1.25 * 100;
  return el("td", { class: "mt-barcell" }, el("div", { class: "mt-bar" }, [
    el("i", { class: signal(r, lowerBetter), style: `width:${w}%` }),
    el("b", { style: `left:${100 / 1.25}%`, title: "100%" }),
  ]));
}
const td = (text, cls = "") => el("td", { class: cls, text: text ?? "" });
const th = (text, cls = "") => el("th", { class: cls, text });
const table = (head, rows, cls = "") => el("div", { class: "table-wrap" }, el("table", { class: "grid compact mt-table " + cls }, [
  el("thead", {}, el("tr", {}, head)), el("tbody", {}, rows)]));
const card = (title, children, cls = "") => el("section", { class: "card mt-card " + cls }, [el("h3", { class: "mt-h", text: title }), ...children]);

// ---------------------------------------------------------------- 表示
export function renderMeeting(host, S) {
  clear(host);
  host.appendChild(el("div", { class: "card mt-head" }, [
    el("div", { class: "mt-title", text: S.title }),
    el("div", { class: "row", style: "gap:10px;flex-wrap:wrap;align-items:center" }, [
      S.note ? el("span", { class: "hint", text: S.note }) : null,
      S.check ? el("span", { class: "mt-badge " + (/OK/.test(S.check) ? "mt-ok" : "mt-warn"), text: S.check }) : null,
      el("span", { class: "hint", text: `取込: ${S.file || ""}` }),
    ]),
  ]));

  const grid = el("div", { class: "mt-grid" });
  const left = el("div", { class: "col mt-col" }), right = el("div", { class: "col mt-col" });
  grid.append(left, right);
  host.appendChild(grid);
  const store = S.pl?.store || "";
  const mo = Number(S.ym.slice(5, 7));

  if (S.pl) {
    left.appendChild(card(`① ${mo}月度 損益（千円・税抜）`, [
      plTable(S.pl.month, ["総売上高", "売上総利益", "一般管理費", "営業利益", "経常利益", "売上対人件費"]),
      el("div", { class: "mt-sub", text: "累計" }),
      plTable(S.pl.cum, ["総売上高", "売上総利益", "一般管理費", "経常利益"]),
    ]));
  }
  if (S.progress) left.appendChild(card(S.progressTitle || "② 途中経過", [progressTable(S.progress)]));
  if (S.rates?.length) left.appendChild(card(S.ratesTitle || "③ レート別", S.rates.map((b) => genericTable(b))));
  if (S.sga?.length) right.appendChild(card(`⑤ 一般管理費 明細（${mo}月・千円）`, sgaBlock(S.sga)));
  // ④は小さい表なので、⑤の下に置いて左右の列の高さをそろえる（片側だけ長いと下が空く）
  if (S.machines) right.appendChild(card("④ 機械入替", [genericTable(S.machines)]));
  // 所見は文章が長く縦に伸びるので、表の列に入れると隣が大きく空く。表の下に全幅で置き、
  // 中を2段組みにして縦の長さを抑える
  if (S.notes?.length) host.appendChild(card(`所見・改善案${store ? `（${store}）` : ""}`, [el("div", { class: "mt-cols2" }, notesBlock(S.notes))]));
  if (S.stores) host.appendChild(card("4店比較", [storesTable(S.stores)]));
  if (S.storeNotes?.length) host.appendChild(card("所見・改善案（4店）", [el("div", { class: "mt-cols2" }, notesBlock(S.storeNotes))]));
}

// ① 損益：予算・実績・予算比・達成バー・前年・前年比・前年差
function plTable(list, items) {
  const rows = [];
  for (const name of items) {
    const x = list.find((r) => r.item === name);
    if (!x) continue;
    const isRate = name === "売上対人件費";
    const lower = name === "一般管理費" || isRate;
    const rb = ratio(x.actual, x.budget), ry = ratio(x.actual, x.prev);
    const f = (v) => (isRate ? pct(v, 2) : k(v));
    const diff = x.actual != null && x.prev != null ? x.actual - x.prev : null;
    rows.push(el("tr", {}, [
      td(name, "txt"), td(f(x.budget)), td(f(x.actual), "mt-strong" + (x.actual != null && x.actual < 0 ? " mt-neg" : "")),
      td(rb == null ? "---" : pct(rb), signal(rb, lower)), bar(rb, lower),
      td(f(x.prev)), td(ry == null ? "---" : pct(ry), signal(ry, lower)),
      // 前年差は良し悪しの向きで色を付ける（経費・人件費率は減ったほうが良い）
      td(isRate ? (diff == null ? "" : (diff >= 0 ? "+" : "") + (diff * 100).toFixed(2) + "pt") : k(diff),
        diff == null || diff === 0 ? "" : (lower ? diff > 0 : diff < 0) ? "mt-neg" : ""),
    ]));
  }
  return table([th("項目", "txt"), th("予算"), th("実績"), th("予算比"), th("予算達成"), th("前年"), th("前年比"), th("前年差")], rows);
}

// ② 途中経過：進捗率を「今日の位置」と並べたバーで見せる
function progressTable(b) {
  const cols = b.header.map((h, i) => ({ h, i })).filter((c) => !/バー/.test(c.h));
  const iRate = b.header.findIndex((h) => /進捗率/.test(h));
  const noteRow = b.rows.find((r) => r.slice(1).every((v) => v == null));
  const m = noteRow ? String(noteRow[0]).match(/(\d+)\s*／\s*(\d+)\s*日/) : null;
  const elapsed = m ? Number(m[1]) / Number(m[2]) : null;
  const rows = b.rows.filter((r) => r !== noteRow).map((r) => el("tr", {}, [
    ...cols.map(({ h, i }) => {
      const v = r[i];
      if (i === 0) return td(v, "txt");
      if (typeof v === "number") return /率/.test(h) ? td(pct(v), signal(v >= 1 ? 1 : v / (elapsed || 1), false)) : td(k(v));
      return td(v, /超え/.test(String(v)) ? "mt-ok" : /未達|不足/.test(String(v)) ? "mt-bad" : "");
    }),
    iRate >= 0 ? el("td", { class: "mt-barcell" }, el("div", { class: "mt-bar" }, [
      el("i", { class: signal(elapsed ? r[iRate] / elapsed : null, false), style: `width:${Math.min(r[iRate] || 0, 1) * 100}%` }),
      elapsed ? el("b", { style: `left:${elapsed * 100}%`, title: "今日" }) : null,
    ])) : null,
  ]));
  return el("div", {}, [
    table([...cols.map(({ h, i }) => th(h, i === 0 ? "txt" : "")), iRate >= 0 ? th("進捗（|＝今日）") : null].filter(Boolean), rows),
    noteRow ? el("div", { class: "hint", style: "margin-top:4px", text: noteRow[0] }) : null,
  ]);
}

// ③④：見出しの言葉で書式を決める（率・稼働は%、割数は小数2桁、それ以外は整数）
function genericTable(b) {
  const fmt = (h, v) => {
    if (typeof v !== "number") return v ?? "";
    if (/率|稼働/.test(h)) return pct(v);
    if (/割数/.test(h)) return v.toFixed(2);
    return k(v);
  };
  const rows = b.rows.map((r) => el("tr", { class: /合計/.test(String(r[0])) ? "mt-total" : "" },
    r.map((v, i) => td(fmt(b.header[i], v), i === 0 ? "txt" : ""))));
  return table(b.header.map((h, i) => th(h, i === 0 ? "txt" : "")), rows);
}

// ⑤ 一般管理費：予算差が大きい科目を先に名指しし、表は区分ごとに小計を太字で
function sgaBlock(sga) {
  const live = sga.filter((r) => r.kind !== "明細" || [r.budget, r.actual, r.prev].some((v) => v));
  const over = sga.filter((r) => r.kind === "明細" && r.actual != null && r.budget != null && r.actual - r.budget > 0)
    .sort((a, b) => (b.actual - b.budget) - (a.actual - a.budget)).slice(0, 3);
  const maxDiff = Math.max(1, ...live.filter((r) => r.kind === "明細").map((r) => Math.abs((r.actual ?? 0) - (r.budget ?? 0))));
  const rows = live.map((r) => {
    const diff = (r.actual ?? 0) - (r.budget ?? 0);
    const cumDiff = (r.actualCum ?? 0) - (r.budgetCum ?? 0);
    const prevDiff = (r.actual ?? 0) - (r.prev ?? 0);
    const sub = r.kind !== "明細";
    const label = r.kind === "小計" ? r.group + " 計" : r.kind === "合計" ? "一般管理費 合計" : "　" + r.name;
    const w = sub ? 0 : Math.abs(diff) / maxDiff * 100;
    return el("tr", { class: r.kind === "合計" ? "mt-total" : sub ? "mt-subtotal" : "" }, [
      td(label, "txt"), td(k(r.budget)), td(k(r.actual), "mt-strong"),
      // 経費なので予算より多い＝赤、少ない＝緑
      td((diff > 0 ? "+" : "") + k(diff), diff > 0 ? "mt-bad" : diff < 0 ? "mt-ok" : ""),
      el("td", { class: "mt-barcell" }, w ? el("div", { class: "mt-diffbar" }, el("i", { class: diff > 0 ? "mt-bad" : "mt-ok", style: `width:${w}%` })) : null),
      td(k(r.prev)), td((prevDiff > 0 ? "+" : "") + k(prevDiff), prevDiff > 0 ? "mt-bad" : prevDiff < 0 ? "mt-ok" : ""),
      td((cumDiff > 0 ? "+" : "") + k(cumDiff), cumDiff > 0 ? "mt-bad" : cumDiff < 0 ? "mt-ok" : ""),
    ]);
  });
  return [
    over.length ? el("div", { class: "mt-callout" }, [el("b", { text: "予算超過が大きい科目：" }),
      ...over.map((r) => el("span", { class: "mt-chip mt-bad", text: `${r.name} +${k(r.actual - r.budget)}` }))]) : null,
    table([th("科目", "txt"), th("予算"), th("実績"), th("予算差"), th("超過/不足"), th("前年"), th("前年差"), th("累計予算差")], rows),
    el("div", { class: "hint", style: "margin-top:4px", text: "予算差・前年差がプラス（使い過ぎ）は赤、マイナスは緑。バーは予算差の大きさ。" }),
  ].filter(Boolean);
}

function storesTable(b) {
  const fmt = (label, v) => {
    if (typeof v !== "number") return v ?? "";
    if (/率/.test(label)) return pct(v);
    if (/1台当たり/.test(label)) return v.toFixed(1);
    return k(v);
  };
  const rows = b.rows.map((r) => {
    const label = String(r[0] ?? "");
    if (r.slice(1).every((v) => v == null)) return el("tr", { class: "mt-group" }, el("td", { class: "txt", colspan: b.header.length, text: label }));
    const neg = (v) => typeof v === "number" && v < 0 && !/率/.test(label);
    return el("tr", {}, r.map((v, i) => {
      const t = td(fmt(label, v), i === 0 ? "txt" : neg(v) ? "mt-neg" : "");
      // 達成率の行は信号色（売上・粗利と同じ基準）
      if (i > 0 && /達成率/.test(label) && typeof v === "number") t.className = signal(v, false);
      return t;
    }));
  });
  return table(b.header.map((h, i) => th(h, i === 0 ? "txt" : "")), rows);
}

const VIEW_CLS = { 総括: "v-sum", 経営者: "v-owner", 店長: "v-mgr", お客様: "v-cust", 改善案: "v-plan" };
function notesBlock(sections) {
  return sections.map((sec) => el("div", { class: "mt-notesec" }, [
    sec.title ? el("div", { class: "mt-sub", text: sec.title }) : null,
    ...sec.items.map((it) => el("div", { class: "mt-note" }, [
      el("span", { class: "mt-view " + (VIEW_CLS[it.view] || ""), text: it.view }),
      el("span", { class: "mt-comment", text: it.comment }),
      it.conf && /^[A-D]$/.test(it.conf) ? el("span", { class: "mt-conf c-" + it.conf, title: "信頼度", text: it.conf }) : null,
    ])),
  ]));
}

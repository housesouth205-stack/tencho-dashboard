// 新台タブ：周辺店の新台入替（旧PCアプリ「新台入替トラッカー」の統合版）。
// データは Edge Function「shindai-fetch」が毎週月曜に自動取得して shindai_snapshot に保存する。
// 画面は 全店舗の新台（導入日ごと）/ 店舗別 / 新台カレンダー / 店舗の設定 の4つ。
import { el, clear } from "../../util/dom.js";
import { toast, errorToast } from "../../core/errors.js";
import { compute, shopHistory, allHistory, baseline, MODES } from "./diff.js";
import { callFetch, loadShops, saveShops, removeShop, loadSnapshots, loadCalendar } from "./data.js";
import { importLocalFolder } from "./importLocal.js";

const SUBS = [["all", "全店舗の新台"], ["shop", "店舗別"], ["cal", "新台カレンダー"], ["settings", "店舗の設定"]];
const LS = (k, v) => { try { if (v === undefined) return localStorage.getItem("shindai:" + k); localStorage.setItem("shindai:" + k, v); } catch { return null; } };

let sub = LS("sub") || "all";
let selShop = LS("shop") || null;
let mode = "auto";
let query = "";
let D = null; // { shops, byShop, names, calendar }

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const shortName = (n) => (n || "").replace(/[（(][^）)]*[）)]\s*$/, "").trim() || n;
const WD = ["日", "月", "火", "水", "木", "金", "土"];
const wd = (d) => { const x = new Date(d + "T00:00:00"); return isNaN(x) ? "" : `(${WD[x.getDay()]})`; };
const ymd = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
const ttag = (t) => `<span class="sd-tt ${t === "スロット" ? "s" : "p"}">${t === "スロット" ? "スロ" : "パチ"}</span>`;
const norm = (s) => String(s || "").normalize("NFKC").toLowerCase();
const fmtTs = (iso) => { if (!iso) return "—"; const d = new Date(iso); return isNaN(d) ? String(iso) : `${d.getMonth() + 1}/${d.getDate()}${wd(ymd(d))} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const TYPES = [["パチンコ", "p"], ["スロット", "s"]];

export async function mount(host) {
  clear(host);
  host.appendChild(el("div", { class: "view-title" }, [el("h1", { text: "新台" }), el("small", { text: "周辺店の新台入替（DMMぱちタウン・毎週月曜に自動取得）" })]));
  const bar = el("div", { class: "sd-bar" });
  const body = el("div", { class: "sd-body" }, [el("div", { class: "hint", text: "読み込み中…" })]);
  host.append(bar, body);

  const drawBar = () => {
    clear(bar);
    for (const [id, label] of SUBS) {
      bar.appendChild(el("button", { class: "sd-seg" + (sub === id ? " on" : ""), text: label, onclick: () => { sub = id; LS("sub", id); drawBar(); render(body); } }));
    }
    bar.appendChild(el("div", { class: "grow" }));
    bar.appendChild(el("span", { class: "hint", text: "最終取得 " + fmtTs(lastFetched()) }));
    const btn = el("button", { class: "btn sm primary", text: "今すぐ更新", onclick: async () => {
      btn.disabled = true; btn.textContent = "取得中…（30秒ほど）";
      try {
        const r = await callFetch({ action: "refresh" });
        const ng = (r.results || []).filter((x) => !x.ok);
        toast(`更新しました（成功 ${(r.results || []).length - ng.length} / 失敗 ${ng.length}）`, ng.length ? "err" : "ok");
        if (ng.length) console.warn("取得失敗", ng);
        await reload(); drawBar(); render(body);
      } catch (e) { errorToast(e); }
      btn.disabled = false; btn.textContent = "今すぐ更新";
    } });
    bar.appendChild(btn);
  };

  try { await reload(); } catch (e) { clear(body); body.appendChild(el("div", { class: "placeholder", text: "読み込みに失敗しました：" + (e.message || e) + "（初期設定のSQLが未実行の可能性）" })); return; }
  drawBar();
  render(body);
}

async function reload() {
  const [shops, byShop, calendar] = await Promise.all([loadShops(), loadSnapshots(), loadCalendar()]);
  const names = new Map(shops.map((s) => [s.key, s.name || s.key]));
  for (const [k, arr] of byShop) if (!names.has(k) && arr.length) names.set(k, arr[arr.length - 1].name || k);
  // 表示は登録店舗（有効）の並び順。削除済み店舗の記録は出さない
  const active = new Map();
  for (const s of shops) if (s.enabled !== false && byShop.has(s.key)) active.set(s.key, byShop.get(s.key));
  D = { shops, byShop: active, allSnaps: byShop, names, calendar, order: new Map(shops.map((s, i) => [s.key, i])) };
  if (!selShop || !shops.some((s) => s.key === selShop)) selShop = shops[0]?.key || null;
}

function lastFetched() {
  let t = "";
  for (const arr of D?.byShop?.values() || []) { const f = arr[arr.length - 1]?.fetched_at || ""; if (f > t) t = f; }
  return t;
}

function render(body) {
  clear(body);
  if (sub === "shop") return renderShop(body);
  if (sub === "cal") return renderCal(body);
  if (sub === "settings") return renderSettings(body);
  return renderAll(body);
}

// ---------------------------------------------------------------- 全店舗の新台（導入日ごと）
function renderAll(body) {
  if (!D.byShop.size) { body.appendChild(el("div", { class: "placeholder", html: "まだ記録がありません。「今すぐ更新」で取得するか、「店舗の設定」からPCアプリの記録を取り込んでください。" })); return; }
  const search = el("input", { type: "text", value: query, placeholder: "機種名で絞り込み", class: "sd-search" });
  const list = el("div");
  body.append(el("div", { class: "sd-row" }, [search, el("span", { class: "hint", text: "新しい導入日が上。増台・減台は各日の一番下にまとめています。" })]), list);
  const draw = () => {
    const q = norm(query);
    let ents = allHistory(D.byShop, D.names);
    if (q) {
      ents = ents.map((e) => ({ ...e, new: e.new.filter((x) => norm(x.name).includes(q)), up: e.up.filter((x) => norm(x.name).includes(q)), removed: e.removed.filter((x) => norm(x.name).includes(q)), moved: e.moved.filter((x) => norm(x.name).includes(q)) }))
        .filter((e) => e.new.length || e.up.length || e.removed.length || e.moved.length)
        .map((e) => ({ ...e, summary: resum(e) }));
    }
    if (!ents.length) { list.innerHTML = `<div class="hint" style="padding:12px">${q ? "該当する機種はありません。" : "まだ入替の記録がありません（2回目の取得から差分が出ます）。"}</div>`; return; }
    const firstNew = Math.max(0, ents.findIndex((e) => e.new.length));
    list.innerHTML = ents.map((e, i) => dateEntryHtml(e, q ? true : i === firstNew, true)).join("");
  };
  search.addEventListener("input", (e) => { query = e.target.value; draw(); });
  draw();
}

function resum(e) {
  const s = (l, k) => l.reduce((a, x) => a + (x[k] || 0), 0);
  return { new: e.new.length, new_dai: s(e.new, "count"), up_dai: s(e.up, "dai"), removed_dai: s(e.removed, "dai"), move_dai: s(e.moved, "dai") };
}

const oi = (k) => (D.order.has(k) ? D.order.get(k) : 9999);

// 1導入日分。multi=true は全店舗（機種ごとにどの店に何台）、false は1店舗分
function dateEntryHtml(e, open, multi) {
  const s = e.summary || {};
  const map = new Map();
  for (const x of e.new) {
    const m = map.get(x.name) || { name: x.name, type: x.type, total: 0, minIdx: 9999, rows: [] };
    m.total += x.count; m.minIdx = Math.min(m.minIdx, oi(x.store_key)); m.rows.push(x);
    map.set(x.name, m);
  }
  const arr = [...map.values()].sort((a, b) => b.total - a.total || a.minIdx - b.minIdx);
  let body = "";
  for (const [t, dot] of TYPES) {
    const sub = arr.filter((m) => m.type === t);
    if (!sub.length) continue;
    body += `<div class="sd-type"><span class="sd-dot ${dot}"></span>${t}<span class="hint">${sub.length}機種・${sub.reduce((a, m) => a + m.total, 0)}台</span></div>`
      + sub.map((m) => {
        m.rows.sort((a, b) => oi(a.store_key) - oi(b.store_key));
        const chips = multi ? `<div class="sd-chips">${m.rows.map((r) => `<span class="sd-chip">${esc(shortName(r.store))}<b>${r.count}台</b>${r.rate ? `<i>${esc(r.rate)}</i>` : ""}</span>`).join("")}</div>`
          : (m.rows[0].rate ? `<div class="sd-chips"><span class="sd-chip"><i>${esc(m.rows[0].rate)}</i></span></div>` : "");
        return `<div class="sd-mrow"><div class="sd-mhd">${ttag(m.type)}<b>${esc(m.name)}</b><span class="sd-n new">${m.total}台</span></div>${chips}</div>`;
      }).join("");
  }
  if (!body) body = `<div class="hint" style="padding:6px 0">この日は新台なし（増台・減台のみ）</div>`;
  body += changesHtml(e, multi);
  const stores = new Set(e.new.map((x) => x.store_key)).size;
  const head = e.new.length
    ? `<span class="sd-newbadge">新台 ${arr.length}機種・${s.new_dai || 0}台</span>${multi ? `<span class="hint sd-right">${stores}店舗に導入</span>` : ""}`
    : `<span class="hint">新台なし</span>`;
  return `<details class="sd-day${e.new.length ? "" : " quiet"}"${open ? " open" : ""}><summary><span class="sd-date">${esc(e.date)} ${wd(e.date)}</span>${head}</summary><div class="sd-daybody">${body}</div></details>`;
}

// 増台・減台・レート移動（重要度低：一番下に折りたたみ）
function changesHtml(e, multi) {
  const up = e.up || [], rm = e.removed || [], mv = e.moved || [];
  if (!up.length && !rm.length && !mv.length) return "";
  const s = e.summary || {};
  const st = (x) => (multi ? `<span class="hint">${esc(shortName(x.store || ""))}</span>` : "");
  const li = (x, val) => `<li><span>${ttag(x.type)} ${esc(x.name)}${x.rate ? ` <span class="hint">${esc(x.rate)}</span>` : ""} ${st(x)}</span>${val}</li>`;
  const lst = (arr, label, cls, fmt) => (arr.length ? `<div class="sd-chgcat"><span class="sd-tag ${cls}">${label}</span><ul class="sd-list">${arr.map((x) => li(x, fmt(x))).join("")}</ul></div>` : "");
  return `<details class="sd-chg"><summary>増台・減台<span class="sd-tag up">増台 +${s.up_dai || 0}</span><span class="sd-tag rm">減台 -${s.removed_dai || 0}</span>${mv.length ? `<span class="sd-tag mv">レート移動 ${s.move_dai || 0}台</span>` : ""}</summary>`
    + lst(up, "増台", "up", (x) => `<span class="sd-n up">+${x.dai}台</span>`)
    + lst(rm, "減台", "rm", (x) => `<span class="sd-n rm">-${x.dai}台${x.full ? "（全撤去）" : ""}</span>`)
    + lst(mv, "レート移動", "mv", (x) => `<span class="sd-n mv">${esc(x.from_rate)} → ${esc(x.to_rate)}（${x.dai}台）</span>`)
    + `</details>`;
}

// ---------------------------------------------------------------- 店舗別
function renderShop(body) {
  const shops = D.shops.filter((s) => s.enabled !== false);
  if (!shops.length) { body.appendChild(el("div", { class: "placeholder", text: "店舗が登録されていません。「店舗の設定」から追加してください。" })); return; }
  const pick = el("div", { class: "sd-row sd-wrap" });
  for (const s of shops) {
    pick.appendChild(el("button", { class: "sd-seg sm" + (s.key === selShop ? " on" : ""), text: shortName(s.name || s.key), onclick: () => { selShop = s.key; LS("shop", s.key); render(body); } }));
  }
  body.appendChild(pick);
  const snaps = D.byShop.get(selShop) || [];
  const shop = shops.find((s) => s.key === selShop);
  const cur = snaps[snaps.length - 1];
  const head = el("div", { class: "card sd-shophead", html: `<b>${esc(shop?.name || selShop)}</b>`
    + (cur ? ` <span class="hint">最終取得 ${fmtTs(cur.fetched_at)}・総台数 ${cur.total}台・${cur.unique_count}機種${cur.dmm_updated ? `・DMM更新日 ${esc(cur.dmm_updated.slice(5).replace("-", "/"))}` : ""}</span>` : ` <span class="hint">未取得</span>`)
    + ` <a href="${esc(shop?.url || "")}" target="_blank" class="hint">DMMで見る</a>` });
  body.appendChild(head);
  if (!cur) return;

  const modes = el("div", { class: "sd-row sd-wrap" });
  for (const [m, label] of MODES) modes.appendChild(el("button", { class: "sd-seg sm" + (m === mode ? " on" : ""), text: label, onclick: () => { mode = m; render(body); } }));
  body.appendChild(modes);

  const base = baseline(snaps, mode);
  if (!base) { body.appendChild(el("div", { class: "card hint", text: "初回取得を保存しました。次回の取得から新台・増台・減台を表示します。" })); }
  else {
    const df = compute(cur, base);
    const sm = df.summary;
    body.appendChild(el("div", { class: "hint", style: "margin:2px 0 8px", text: `比較: ${base.day} ${wd(base.day)}${base.source === "auto" ? " 自動更新" : ""} → ${cur.day} ${wd(cur.day)}` }));
    body.appendChild(el("div", { class: "sd-tiles", html:
      `<div class="sd-tile new"><small>新台</small><b>${sm.new_dai}</b>台</div>`
      + `<div class="sd-tile"><small>増台</small><b class="up">+${sm.up_dai}</b>台</div>`
      + `<div class="sd-tile"><small>減台</small><b class="rm">-${sm.removed_dai}</b>台</div>`
      + `<div class="sd-tile"><small>レート移動</small><b class="mv">${sm.move_dai}</b>台</div>`
      + `<div class="sd-tile"><small>総台数</small><b>${sm.prev_total}→${sm.total}</b></div>` }));
    const e = { date: cur.day, ...df, new: df.new.map((x) => ({ ...x, store_key: selShop })) };
    const card = el("div", { class: "card", html: `<h3>新台 <span class="hint">${df.new.length}機種・${sm.new_dai}台</span></h3>`
      + (df.new.length ? newByRateHtml(df.new) : `<div class="hint">新台はありません</div>`) + changesHtml(e, false) });
    body.appendChild(card);
  }

  const hist = shopHistory(snaps);
  body.appendChild(el("h3", { text: "入替履歴（導入日ごと）", style: "margin:16px 0 8px" }));
  const hb = el("div");
  hb.innerHTML = hist.length ? hist.map((e) => dateEntryHtml({ ...e, new: e.new.map((x) => ({ ...x, store_key: selShop })) }, false, false)).join("") : `<div class="hint">まだ履歴がありません。</div>`;
  body.appendChild(hb);
  body.appendChild(lineupEl(cur));
}

function newByRateHtml(items) {
  let h = "";
  for (const [t, dot] of TYPES) {
    const sub = items.filter((x) => x.type === t);
    if (!sub.length) continue;
    const rates = {};
    for (const x of sub) (rates[x.rate || "その他"] ||= []).push(x);
    h += `<div class="sd-type"><span class="sd-dot ${dot}"></span>${t}<span class="hint">${sub.length}機種</span></div>`;
    for (const r of Object.keys(rates).sort((a, b) => (parseInt(b) || 0) - (parseInt(a) || 0))) {
      h += `<div class="sd-rate">${esc(r)}</div><ul class="sd-list">${rates[r].map((x) => `<li><span>${esc(x.name)}</span><span class="sd-n new">${x.count}台</span></li>`).join("")}</ul>`;
    }
  }
  return h;
}

function lineupEl(cur) {
  const ms = Object.values(cur.machines || {});
  let h = "";
  for (const [t, dot] of TYPES) {
    const sub = ms.filter((m) => m.type === t);
    if (!sub.length) continue;
    const rates = {};
    for (const m of sub) (rates[m.rate] ||= []).push(m);
    h += `<div class="sd-lcol"><div class="sd-type"><span class="sd-dot ${dot}"></span>${t}</div>`;
    for (const r of Object.keys(rates).sort((a, b) => (parseInt(b) || 0) - (parseInt(a) || 0))) {
      const l = rates[r].sort((a, b) => b.count - a.count);
      h += `<div class="sd-rate">${esc(r)} <span class="hint">${l.length}機種・${l.reduce((a, m) => a + m.count, 0)}台</span></div><ul class="sd-list">${l.map((m) => `<li><span>${esc(m.name)}</span><span class="sd-n">${m.count}台</span></li>`).join("")}</ul>`;
    }
    h += `</div>`;
  }
  const d = el("details", { class: "sd-day", style: "margin-top:14px" });
  d.innerHTML = `<summary><span class="sd-date">現在の機種一覧</span><span class="hint">${ms.length}件</span></summary><div class="sd-daybody sd-lineup">${h}</div>`;
  return d;
}

// ---------------------------------------------------------------- 新台カレンダー
function renderCal(body) {
  const cal = D.calendar || { machines: [] };
  const today = ymd(new Date());
  const ago = new Date(); ago.setMonth(ago.getMonth() - 1);
  const from = ymd(ago);
  const ms = (cal.machines || []).filter((m) => m.date && m.date >= from);
  body.appendChild(el("div", { class: "hint", style: "margin-bottom:8px", text: `業界の新台スケジュール（過去1ヶ月＋今後の予定）・取得元: ${cal.source || "P-WORLD"}・最終取得 ${cal.fetched_at ? fmtTs(cal.fetched_at) : "—"}` }));
  if (!ms.length) { body.appendChild(el("div", { class: "placeholder", text: "未取得です。「今すぐ更新」で取得します。" })); return; }
  const future = ms.filter((m) => m.date >= today).map((m) => m.date).sort();
  const next = future[0] || "";
  const box = el("div");
  let h = "";
  if (next) {
    const nm = ms.filter((m) => m.date === next);
    const dd = Math.round((new Date(next + "T00:00:00") - new Date(today + "T00:00:00")) / 86400000);
    h += `<div class="sd-next"><div><small>次の新台入替</small> <b>${esc(next)} ${wd(next)}</b> <span class="sd-when">${dd === 0 ? "本日" : dd === 1 ? "明日" : `あと${dd}日`}</span> <span class="sd-right">${nm.length}機種</span></div>`
      + nm.map((m) => `<div class="sd-nrow">${ttag(m.type)} <b>${esc(m.name)}</b>${m.stores ? `<span class="hint sd-right">導入予定 ${m.stores}店舗</span>` : ""}</div>`).join("") + `</div>`;
  }
  const byMonth = {};
  for (const m of ms) (byMonth[m.date.slice(0, 7)] ||= []).push(m);
  for (const mo of Object.keys(byMonth).sort()) {
    const [y, mm] = mo.split("-");
    h += `<h3 class="sd-month">${y}年${parseInt(mm, 10)}月 <span class="hint">${byMonth[mo].length}機種</span></h3>`;
    const byDay = {};
    for (const m of byMonth[mo]) (byDay[m.date] ||= []).push(m);
    for (const dt of Object.keys(byDay).sort()) {
      const cls = dt < today ? " past" : dt === next ? " next" : "";
      h += `<div class="sd-calday${cls}"><div class="sd-calcol">${parseInt(dt.slice(8), 10)}日<small>${wd(dt)}</small>${dt < today ? `<i>導入済</i>` : dt === next ? `<i class="nx">次回</i>` : ""}</div><div>`
        + byDay[dt].map((m) => `<div>${ttag(m.type)} ${esc(m.name)}${m.stores ? ` <span class="hint">${m.stores}店舗</span>` : ""}</div>`).join("") + `</div></div>`;
    }
  }
  box.innerHTML = h;
  body.appendChild(box);
}

// ---------------------------------------------------------------- 店舗の設定
function renderSettings(body) {
  const shops = D.shops.map((s) => ({ ...s }));
  const card = el("div", { class: "card" });
  body.appendChild(card);
  const draw = () => {
    clear(card);
    card.appendChild(el("h3", { text: "追跡する店舗（上から順に表示）" }));
    const tbl = el("table", { class: "grid" });
    tbl.appendChild(el("thead", {}, [el("tr", {}, ["", "店舗名", "最終取得", "表示", ""].map((t) => el("th", { class: "txt", text: t })))]));
    const tb = el("tbody");
    shops.forEach((s, i) => {
      const last = (D.allSnaps.get(s.key) || []).slice(-1)[0];
      let armed = false;
      const del = el("button", { class: "btn sm danger", text: "削除", onclick: async () => {
        if (!armed) { armed = true; del.textContent = "もう一度押すと削除"; setTimeout(() => { armed = false; del.textContent = "削除"; }, 3000); return; }
        try { await removeShop(s.key); shops.splice(i, 1); await reload(); draw(); toast("削除しました（過去の記録は残ります）", "ok"); } catch (e) { errorToast(e); }
      } });
      const move = (d) => async () => { const j = i + d; if (j < 0 || j >= shops.length) return; [shops[i], shops[j]] = [shops[j], shops[i]]; await persist(); };
      tb.appendChild(el("tr", {}, [
        el("td", { class: "txt", style: "white-space:nowrap" }, [el("button", { class: "btn sm ghost", text: "▲", onclick: move(-1) }), el("button", { class: "btn sm ghost", text: "▼", onclick: move(1) })]),
        el("td", { class: "txt" }, [el("a", { href: s.url, target: "_blank", text: s.name || s.key })]),
        el("td", { class: "txt hint", text: last ? fmtTs(last.fetched_at) : "未取得" }),
        el("td", { class: "txt" }, [el("input", { type: "checkbox", checked: s.enabled !== false ? "checked" : null, onchange: async (e) => { s.enabled = e.target.checked; await persist(); } })]),
        el("td", { class: "txt" }, [del]),
      ]));
    });
    tbl.appendChild(tb);
    card.appendChild(tbl);

    // 追加（DMMの店舗ページURL or 都道府県/ID）
    const inp = el("input", { type: "text", placeholder: "DMMぱちタウンの店舗ページURL（例：https://p-town.dmm.com/shops/tokyo/467）", style: "flex:1" });
    const add = el("button", { class: "btn sm primary", text: "店舗を追加", onclick: async () => {
      const m = inp.value.trim().match(/(?:shops\/)?([a-z]+)\/(\d+)/);
      if (!m) { toast("DMMぱちタウンの店舗ページのURLを入れてください", "err"); return; }
      const key = `${m[1]}/${m[2]}`;
      if (shops.some((s) => s.key === key)) { toast("すでに登録されています", "err"); return; }
      add.disabled = true; add.textContent = "確認中…";
      try {
        const info = await callFetch({ action: "shop_info", key });
        shops.push({ key, name: info.name || key, url: `https://p-town.dmm.com/shops/${key}`, enabled: true });
        await persist();
        toast(`「${info.name}」を追加しました（${info.machines}機種・${info.total}台）。次の更新から記録します`, "ok");
      } catch (e) { errorToast(e); }
      add.disabled = false; add.textContent = "店舗を追加";
    } });
    card.appendChild(el("div", { class: "sd-row", style: "margin-top:12px" }, [inp, add]));
    card.appendChild(el("div", { class: "hint", style: "margin-top:4px", text: "店舗は DMMぱちタウン（p-town.dmm.com）で検索し、その店舗ページのURLを貼ってください。" }));
  };
  const persist = async () => {
    try { await saveShops(shops); await reload(); draw(); } catch (e) { errorToast(e); }
  };
  draw();

  body.appendChild(el("div", { class: "card", style: "margin-top:12px", html:
    "<h3>自動取得について</h3><div class='hint' style='line-height:1.8'>毎週月曜の10:10から18:40まで、30分おきにネット上で自動取得します（PCを付けておく必要はありません）。<br>"
    + "1回目で全店舗を取得し、DMM側の情報がまだ今日付けになっていない店舗だけ、その後も取り直します。<br>"
    + "臨時で確認したいときは右上の「今すぐ更新」を押してください。</div>" }));

  // PCアプリの記録の取り込み（初回の移行用）
  const imp = el("div", { class: "card", style: "margin-top:12px" });
  const file = el("input", { type: "file", webkitdirectory: "", multiple: "", style: "display:none" });
  const status = el("div", { class: "hint", style: "margin-top:6px" });
  file.addEventListener("change", async () => {
    if (!file.files.length) return;
    status.textContent = "取り込み中…";
    try {
      const r = await importLocalFolder([...file.files], (msg) => { status.textContent = msg; });
      status.textContent = `取り込み完了：記録 ${r.snapshots}件（既にあった ${r.skipped}件は上書きせず）・新台カレンダー ${r.calendar}件`;
      await reload(); toast("PCアプリの記録を取り込みました", "ok");
    } catch (e) { status.textContent = ""; errorToast(e); }
    file.value = "";
  });
  imp.append(
    el("h3", { text: "PCアプリ（新台入替トラッカー）の記録を取り込む" }),
    el("div", { class: "hint", style: "line-height:1.8", html: "これまでPCアプリに貯めた過去の入替記録をこちらへ移します（最初に1回だけ）。<br>ボタンを押して、フォルダ <b>C:\\Users\\user\\AppData\\Local\\ShindaiTracker</b> を選んでください（アドレス欄に <b>%LOCALAPPDATA%\\ShindaiTracker</b> と入力すると開けます）。" }),
    el("button", { class: "btn sm", style: "margin-top:8px", text: "フォルダを選んで取り込む", onclick: () => file.click() }),
    file, status,
  );
  body.appendChild(imp);
}

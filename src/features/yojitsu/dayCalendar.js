import { el, clear } from "../../util/dom.js";
import { state } from "../../core/state.js";
import { queueUpsert } from "../../core/autosave.js";
import { daysInMonth, ymd } from "../../util/dates.js";
import { dayKind, holidayName, isWeekend } from "../../util/holiday.js";
import { planCalc } from "../../calc/planCalc.js";
import { actualCalc } from "../../calc/actualCalc.js";
import { num as fnum, pct } from "../../util/format.js";
import { loadMonthMaps } from "./monthData.js";

const CONFLICT = ["store_id", "ymd", "section_id"];
const KIND_JP = { weekday: "", sat: "土", sun: "日", holiday: "祝" };

// 日別入力カレンダー。fy/month の全区分データを読み、区分タブで切替えながら入力。
export async function renderDayCalendar(host, { fy, month, sections, onChanged }) {
  const maps = await loadMonthMaps(fy, month);
  const cy = maps.cy;

  let secIdx = 0;
  const wrap = el("div", { class: "col" });
  host.appendChild(wrap);

  // Undo（Ctrl+Z）: 直前のセル編集を元に戻す
  const undoStack = [];
  let undoing = false;
  let bulkMode = false;
  const rec = (fn) => { if (!undoing) undoStack.push(fn); };
  const afterEdit = () => { onChanged?.(); if (!bulkMode) draw(); };
  const onKey = (e) => {
    if (!host.isConnected) { document.removeEventListener("keydown", onKey); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      const fn = undoStack.pop();
      if (!fn) return;
      undoing = true; fn(); undoing = false; draw();
    }
  };
  document.addEventListener("keydown", onKey);

  draw();

  function draw() {
    clear(wrap);
    const sec = sections[secIdx];
    // 区分タブ
    const tabs = el("div", { class: "row", style: "flex-wrap:wrap;gap:6px" },
      sections.map((s, i) => el("button", {
        class: "btn sm " + (i === secIdx ? "primary" : "ghost"),
        text: s.label, onclick: () => { secIdx = i; draw(); },
      })));
    wrap.appendChild(tabs);
    wrap.appendChild(bulkBar(sec));
    wrap.appendChild(table(sec));
  }

  function rowObj(sec, d) {
    const k = `${ymd(cy, month, d)}|${sec.id}`;
    return {
      k, ymd: ymd(cy, month, d),
      m: maps.machines.get(k), p: maps.plan.get(k), a: maps.actual.get(k),
    };
  }
  function ensure(table, k, sec, d) {
    let row = maps[table].get(k);
    if (!row) { row = { store_id: state.storeId, ymd: ymd(cy, month, d), section_id: sec.id }; maps[table].set(k, row); }
    return row;
  }
  function saveM(sec, d, count) {
    const k = `${ymd(cy, month, d)}|${sec.id}`; const r = ensure("machines", k, sec, d);
    rec(() => saveM(sec, d, r.count == null ? "" : r.count));
    r.count = count === "" ? null : Number(count); queueUpsert("machines_day", r, CONFLICT); afterEdit();
  }
  function saveP(sec, d, patch) {
    const k = `${ymd(cy, month, d)}|${sec.id}`; const r = ensure("plan", k, sec, d);
    const prev = {}; for (const key of Object.keys(patch)) prev[key] = r[key] ?? null;
    rec(() => saveP(sec, d, prev));
    Object.assign(r, patch); queueUpsert("plan_day", r, CONFLICT); afterEdit();
  }
  function saveA(sec, d, patch) {
    const k = `${ymd(cy, month, d)}|${sec.id}`; const r = ensure("actual", k, sec, d);
    const prev = {}; for (const key of Object.keys(patch)) prev[key] = r[key] ?? null;
    rec(() => saveA(sec, d, prev));
    Object.assign(r, patch, { source: "manual" }); queueUpsert("actual_day", r, CONFLICT); afterEdit();
  }

  function inp(value, onchange, opts = {}) {
    return el("input", {
      type: "number", step: opts.step || "any", value: value ?? "",
      style: "width:" + (opts.w || 72) + "px;text-align:right;padding:3px 5px",
      onchange: (e) => onchange(e.target.value),
    });
  }

  function table(sec) {
    const isP = sec.ptype === "P";
    const pl = isP ? "玉単" : "単価";
    const t = el("table", { class: "grid mono", style: "margin-top:8px" });
    const head = ["日", "台数",
      "計ｱｳﾄ", "計売上", "計粗利", "計" + pl, "計率%", ...(isP ? ["計ｽﾀｰﾄ", "計ﾍﾞｰｽ"] : []),
      "実ｱｳﾄ", "実売上", "実粗利", "実" + pl, "実率%", ...(isP ? ["実ｽﾀｰﾄ", "実ﾍﾞｰｽ"] : [])];
    t.appendChild(el("thead", {}, el("tr", {}, head.map((h, i) =>
      el("th", { class: i === 0 ? "txt" : "", text: h })))));
    const body = el("tbody");
    const days = daysInMonth(cy, month);
    for (let d = 1; d <= days; d++) {
      const kind = dayKind(cy, month, d);
      const { m, p, a } = rowObj(sec, d);
      const count = m?.count;
      const pc = planCalc(p, count);
      const ac = actualCalc(a, count);
      const color = kind === "sun" || kind === "holiday" ? "var(--accent-hi)" : kind === "sat" ? "var(--blue)" : "var(--fg)";
      const dayCell = el("td", { class: "txt", style: `color:${color}`, title: holidayName(cy, month, d) || "" },
        `${d}${KIND_JP[kind] ? " " + KIND_JP[kind] : ""}`);
      const cells = [
        dayCell,
        el("td", {}, inp(count, (v) => saveM(sec, d, v), { step: "1", w: 58 })),
        // 計画: アウト(入力)/売上(自動)/粗利(自動)/単価(入力)/粗利率(入力)
        el("td", {}, inp(p?.out_per_unit, (v) => saveP(sec, d, { out_per_unit: v === "" ? null : Number(v) }))),
        el("td", { text: pc.sales ? fnum(pc.sales) : "—" }),
        el("td", { text: pc.gross ? fnum(pc.gross) : "—" }),
        el("td", {}, inp(p?.unit_price, (v) => saveP(sec, d, { unit_price: v === "" ? null : Number(v) }))),
        el("td", {}, inp(pctVal(p?.gross_rate), (v) => saveP(sec, d, { gross_rate: v === "" ? null : Number(v) / 100 }), { w: 60 })),
        ...(isP ? [
          el("td", {}, inp(p?.start_val, (v) => saveP(sec, d, { start_val: v === "" ? null : Number(v) }), { w: 56 })),
          el("td", {}, inp(p?.base_val, (v) => saveP(sec, d, { base_val: v === "" ? null : Number(v) }), { w: 56 })),
        ] : []),
        // 実績: アウト(入力)/売上(入力)/粗利(入力)/単価(自動)/粗利率(自動)
        el("td", {}, inp(a?.out_per_unit, (v) => saveA(sec, d, { out_per_unit: v === "" ? null : Number(v) }))),
        el("td", {}, inp(a?.sales, (v) => saveA(sec, d, { sales: v === "" ? null : Number(v) }), { w: 84 })),
        el("td", {}, inp(a?.gross, (v) => saveA(sec, d, { gross: v === "" ? null : Number(v) }), { w: 84 })),
        el("td", { text: ac.unitPrice ? ac.unitPrice.toFixed(2) : "—" }),
        el("td", { text: ac.grossRate ? (ac.grossRate * 100).toFixed(1) : "—" }),
        ...(isP ? [
          el("td", {}, inp(a?.start_val, (v) => saveA(sec, d, { start_val: v === "" ? null : Number(v) }), { w: 56 })),
          el("td", {}, inp(a?.base_val, (v) => saveA(sec, d, { base_val: v === "" ? null : Number(v) }), { w: 56 })),
        ] : []),
      ];
      const tr = el("tr", {}, cells);
      if (kind === "sat") tr.style.background = "var(--pastel-blue)";
      else if (kind === "sun" || kind === "holiday") tr.style.background = "var(--pastel-red)";
      body.appendChild(tr);
    }
    t.appendChild(body);
    const scroller = el("div", { class: "table-wrap" }, t);
    return scroller;
  }

  function bulkBar(sec) {
    const vals = { count: "", out: "", price: "", rate: "" };
    const mk = (ph, key, w) => el("input", {
      type: "number", step: "any", placeholder: ph, style: `width:${w}px;text-align:right;padding:4px 6px`,
      onchange: (e) => (vals[key] = e.target.value),
    });
    const apply = (which) => {
      bulkMode = true;
      const days = daysInMonth(cy, month);
      for (let d = 1; d <= days; d++) {
        const kind = dayKind(cy, month, d);
        const match = which === "all" || (which === "weekend" ? isWeekend(kind) : !isWeekend(kind));
        if (!match) continue;
        if (vals.count !== "") saveM(sec, d, vals.count);
        const patch = {};
        if (vals.out !== "") patch.out_per_unit = Number(vals.out);
        if (vals.price !== "") patch.unit_price = Number(vals.price);
        if (vals.rate !== "") patch.gross_rate = Number(vals.rate) / 100;
        if (Object.keys(patch).length) saveP(sec, d, patch);
      }
      bulkMode = false;
      draw();
    };
    return el("div", { class: "card row", style: "align-items:flex-end;flex-wrap:wrap;gap:8px;padding:10px" }, [
      el("div", {}, [el("label", { class: "lbl", text: "一括: 台数" }), mk("台数", "count", 58)]),
      el("div", {}, [el("label", { class: "lbl", text: "アウト" }), mk("アウト", "out", 72)]),
      el("div", {}, [el("label", { class: "lbl", text: sec.ptype === "P" ? "玉単価" : "単価" }), mk("単価", "price", 72)]),
      el("div", {}, [el("label", { class: "lbl", text: "粗利率%" }), mk("率%", "rate", 60)]),
      el("button", { class: "btn sm", text: "平日に適用", onclick: () => apply("weekday") }),
      el("button", { class: "btn sm", text: "土日祝に適用", onclick: () => apply("weekend") }),
      el("button", { class: "btn sm primary", text: "全日に適用", onclick: () => apply("all") }),
    ]);
  }
}

const pctVal = (r) => (r == null ? "" : +(r * 100).toFixed(2));
const achieveColor = (r) => (r == null ? "" : "color:" + (r >= 1 ? "var(--ok)" : r >= 0.9 ? "var(--warn)" : "var(--bad)"));

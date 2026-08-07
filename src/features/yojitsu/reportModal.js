// 日報テキストのモーダル。用途（本部報告 / 振り返り）と日付を選び、そのままコピーする。
import { el, modal } from "../../util/dom.js";
import { toast, errorToast } from "../../core/errors.js";
import { calendarYear, daysInMonth } from "../../util/dates.js";
import { STORE_NAME } from "../../core/config.js";
import { loadMonthMaps } from "./monthData.js";
import { loadBudgetTotals } from "./budgetInput.js";
import { buildDailyReport, latestActualDay } from "./dailyReport.js";

const MODES = [["report", "本部・上司へ"], ["review", "自分の振り返り"]];
let mode = "report";

export async function openDailyReport({ fy, month, sections }) {
  const year = calendarYear(fy, month);
  const body = el("div", { class: "col", style: "gap:8px;min-width:min(560px,86vw)" });
  const area = el("textarea", {
    readonly: "readonly",
    style: "width:100%;height:46vh;box-sizing:border-box;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;" +
      "font-size:12px;line-height:1.5;white-space:pre;overflow:auto;padding:8px;" +
      "border:1px solid var(--line);border-radius:8px;background:var(--panel-2);color:var(--fg)",
  });
  const daySel = el("select", { class: "inp", style: "width:80px" });
  const modeBtns = MODES.map(([k, label]) => el("button", {
    class: "btn sm", text: label, onclick: () => { mode = k; render(); },
  }));
  const bar = el("div", { class: "row", style: "gap:6px;align-items:center;flex-wrap:wrap" }, [
    ...modeBtns, el("span", { style: "width:8px" }),
    el("label", { class: "lbl", text: "日" }), daySel,
  ]);

  // 選択してコピーする従来方式。クリップボードAPIが使えない場面の受け皿。
  const selectAndCopy = () => {
    area.removeAttribute("readonly");
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    area.setAttribute("readonly", "readonly");
    return ok;
  };
  const copyBtn = el("button", {
    class: "btn primary", text: "コピー",
    onclick: async () => {
      // clipboard APIは非セキュアコンテキストや未フォーカス時に失敗するため、
      // 失敗しても諦めず選択方式で再試行する（エラーだけ出て何も起きない状態を避ける）。
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(area.value);
        else if (!selectAndCopy()) throw new Error("copy failed");
        toast("日報をコピーしました", "ok");
      } catch {
        if (selectAndCopy()) toast("日報をコピーしました", "ok");
        else toast("コピーできませんでした。本文を選択して手動でコピーしてください", "err");
      }
    },
  });
  const close = modal("日報", body,
    el("div", { class: "row", style: "justify-content:flex-end;gap:8px;margin-top:10px" }, [
      el("button", { class: "btn ghost", text: "閉じる", onclick: () => close() }), copyBtn,
    ]));
  body.appendChild(bar);
  body.appendChild(area);
  area.value = "読み込み中…";

  let maps = null, budget = null;
  try {
    [maps, budget] = await Promise.all([
      loadMonthMaps(fy, month),
      loadBudgetTotals({ mode: "month", fy, month }).catch(() => null),
    ]);
  } catch (e) { area.value = "データを取得できませんでした。"; errorToast(e); return; }

  // 既定は実績が入っている最新日。未入力の当日を選んで空の日報が出るのを防ぐ。
  const last = latestActualDay(sections, year, month, maps) || daysInMonth(year, month);
  for (let d = 1; d <= daysInMonth(year, month); d++) {
    daySel.appendChild(el("option", { value: d, text: `${d}日`, selected: d === last ? "selected" : null }));
  }
  daySel.addEventListener("change", render);

  function render() {
    modeBtns.forEach((b, i) => {
      b.classList.toggle("primary", MODES[i][0] === mode);
      b.classList.toggle("ghost", MODES[i][0] !== mode);
    });
    area.value = buildDailyReport({
      mode, sections, year, month, day: Number(daySel.value), maps,
      storeName: STORE_NAME, monthBudgetGross: budget?.gross || null,
    });
  }
  render();
}

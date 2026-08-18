// 月次の損益・経費の手入力。
//
// 会議資料が「紙をスキャンしたPDF」で来ると文字が入っていないため機械では読めない。
// これまではその月だけCSVを作っていたが、表計算を開かずにここで入れられるようにする。
// 入力は資料と同じ千円のままにして、保存のときに円へ直す（頭の中で桁を数えさせない）。
import { el, clear, modal } from "../../util/dom.js";
import { repo } from "../../core/repo.js";
import { state } from "../../core/state.js";
import { setSaveState, toast, errorToast } from "../../core/errors.js";
import { yen, num } from "../../util/format.js";
import { COLS } from "../../import/plCsv.js";

const LABEL = Object.fromEntries(COLS.map(([k, names]) => [k, names[0]]));
const GROUPS = [
  { title: "損益", keys: ["sales", "cogs", "gross", "sga", "op", "ordinary"] },
  { title: "一般管理費の内訳", keys: ["jinken", "hanbai", "tatemono", "koukyou", "shokeihi", "genka"] },
  { title: "主な明細", keys: ["kyuyo", "kigu", "suidou", "yachin", "hoshu", "shuzen"] },
];
const PARTS = GROUPS[1].keys;

const toNum = (v) => {
  const t = String(v ?? "").normalize("NFKC").replace(/[\s,￥¥円]/g, "");
  if (!t) return null;
  const n = Number(t.replace(/^[△▲]/, "-"));
  return isFinite(n) ? n : null;
};
const ymOfMonth = (m) => (m ? `${m}-01` : null);

export async function openPlManual(msgHost, onDone) {
  let existing = [];
  try { existing = await repo.select("pl_month", { eq: { store_id: state.storeId, kind: "actual" }, order: "ym" }); }
  catch { /* 読めなくても入力はできる */ }
  const byYm = new Map(existing.map((r) => [String(r.ym).slice(0, 7), r]));

  // 既定の月度は「いちばん新しい月の翌月」。毎月続けて入れる作業なので当てにできる。
  const last = existing.length ? String(existing[existing.length - 1].ym).slice(0, 7) : null;
  const nextOf = (ym) => {
    const [y, m] = ym.split("-").map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  };
  const today = new Date();
  const defYm = last ? nextOf(last) : `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;

  const monthInp = el("input", { type: "month", value: defYm, style: "width:158px" });
  const unitSel = el("select", { class: "inp", style: "width:110px" }, [
    el("option", { value: "1000", text: "千円" }), el("option", { value: "1", text: "円" }),
  ]);
  const note = el("div", { class: "hint" });
  const check = el("div", { class: "col", style: "gap:2px" });
  const inputs = {};

  const unit = () => Number(unitSel.value);
  // 前月の値。資料と見比べながら入れるとき、桁を1つ間違えたのがここで分かる。
  const prevRow = () => byYm.get(((m) => (m ? (() => { const [y, mo] = m.split("-").map(Number); return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`; })() : null))(monthInp.value));

  const grid = el("div", { style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:14px" });
  for (const g of GROUPS) {
    const col = el("div", { class: "col", style: "gap:6px" }, [el("div", { style: "font-weight:700;font-size:13px", text: g.title })]);
    for (const k of g.keys) {
      // 前月の値は入力欄の中に薄く出す。横に並べると3列が紙にも画面にも収まらない。
      const i = el("input", { type: "text", inputmode: "numeric", style: "width:116px;text-align:right" });
      inputs[k] = i;
      i.addEventListener("input", refresh);
      col.appendChild(el("div", { class: "row", style: "gap:6px;align-items:center;justify-content:space-between" }, [
        el("span", { style: "font-size:12.5px;white-space:nowrap", text: LABEL[k] }), i,
      ]));
    }
    grid.appendChild(col);
  }

  function fillFrom(ym) {
    const row = byYm.get(ym);
    for (const [k, i] of Object.entries(inputs)) {
      i.value = row && row[k] != null ? String(Math.round(row[k] / unit())) : "";
    }
    note.textContent = row
      ? `${ym} は既に入っています（${row.label || ""}）。書き換えると上書きします。`
      : `${ym} は未入力です。`;
    refresh();
  }

  // 入れながら検算する。合わないまま保存すると、経費タブのグラフが黙って狂う。
  function refresh() {
    const u = unit();
    const v = (k) => toNum(inputs[k].value);
    const prev = prevRow();
    for (const [k, i] of Object.entries(inputs)) {
      const p = prev && prev[k] != null ? Math.round(prev[k] / u) : null;
      i.placeholder = p == null ? "" : `前月 ${num(p)}`;
    }
    clear(check);
    const line = (ok, text) => el("div", { style: `font-size:12px;color:${ok ? "var(--fg-dim)" : "#e35d6a"};font-weight:${ok ? 400 : 700}`, text: (ok ? "✓ " : "⚠ ") + text });
    const sga = v("sga");
    if (sga != null && PARTS.every((k) => v(k) != null)) {
      const sum = PARTS.reduce((a, k) => a + v(k), 0);
      check.appendChild(line(sum === sga, `内訳の合計 ${num(sum)} ／ 一般管理費 ${num(sga)}`));
    }
    if (v("sales") != null && v("cogs") != null && v("gross") != null) {
      check.appendChild(line(v("sales") - v("cogs") === v("gross"), `総売上高 − 売上原価 = ${num(v("sales") - v("cogs"))} ／ 売上総利益 ${num(v("gross"))}`));
    }
    if (v("gross") != null && sga != null && v("op") != null) {
      check.appendChild(line(v("gross") - sga === v("op"), `売上総利益 − 一般管理費 = ${num(v("gross") - sga)} ／ 営業利益 ${num(v("op"))}`));
    }
    const total = v("sales");
    check.appendChild(el("div", { class: "hint", text: total == null ? "総売上高を入れると、保存される金額（円）が出ます" : `保存される総売上高: ${yen(total * u)}` }));
  }

  monthInp.addEventListener("change", () => fillFrom(monthInp.value));
  unitSel.addEventListener("change", () => fillFrom(monthInp.value));
  fillFrom(defYm);

  const body = el("div", { class: "col", style: "gap:12px;min-width:min(690px,100%)" }, [
    el("p", { class: "hint", style: "margin:0", text: "会議資料を見ながら入れてください。空欄はそのまま（前に入れた値を消しません）。" }),
    el("div", { class: "row", style: "gap:12px;align-items:flex-end;flex-wrap:wrap" }, [
      el("div", {}, [el("label", { class: "lbl", text: "月度" }), monthInp]),
      el("div", {}, [el("label", { class: "lbl", text: "資料の単位" }), unitSel]),
      el("div", { class: "grow" }, note),
    ]),
    grid,
    check,
  ]);

  const close = modal("月次の損益・経費を手入力", body,
    el("div", { class: "row", style: "justify-content:flex-end;gap:8px;margin-top:12px" }, [
      el("button", { class: "btn ghost", text: "やめる", onclick: () => close() }),
      el("button", { class: "btn primary", text: "保存", onclick: async () => {
        const ym = ymOfMonth(monthInp.value);
        if (!ym) { toast("月度を入れてください", "err"); return; }
        const u = unit();
        // 空欄は書かない。nullで上書きすると、前に入れた値が消える。
        const rec = { store_id: state.storeId, ym, kind: "actual", label: waLabel(ym), src: "手入力" };
        let any = false;
        for (const [k] of COLS) {
          const v = toNum(inputs[k].value);
          if (v == null) continue;
          rec[k] = Math.round(v * u);
          any = true;
        }
        if (!any) { toast("金額が1つも入っていません", "err"); return; }
        try {
          setSaveState("saving");
          await repo.upsert("pl_month", rec, { onConflict: ["store_id", "ym", "kind"] });
          await repo.upsert("import_log", { store_id: state.storeId, kind: "pl_manual", filename: "（手入力）",
            row_count: 1, status: "ok", message: rec.label }, { onConflict: ["id"] });
          setSaveState("saved");
          close();
          clear(msgHost);
          msgHost.appendChild(el("div", { class: "hint", text: `${rec.label} を保存しました` }));
          toast(`${rec.label} を保存しました`, "ok");
          onDone?.();
        } catch (e) { errorToast(e); }
      } }),
    ]));
}

// 会議資料と同じ「R7.01」の書き方にそろえる（CSVで入れた月と並べたときに揃う）。
function waLabel(ym) {
  const [y, m] = String(ym).slice(0, 7).split("-").map(Number);
  return `R${y - 2018}.${String(m).padStart(2, "0")}`;
}

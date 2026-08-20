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
import { COLS, parseMonthLabel } from "../../import/plCsv.js";

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

// 表記ゆれを吸収した照合キー。全角半角・空白・記号を落とす。
const key = (s) => String(s || "").normalize("NFKC").replace(/[\s　・（）()［］\[\]「」【】:：]/g, "").replace(/合計$/, "");

// 貼り付けた文字から「費目の行」を拾う。
// スキャンした資料はGoogleドライブやiPhoneの文字認識で文字に起こせるので、
// その結果をそのまま貼ってもらう。1行に数字がいくつも並ぶ（予算・実績・前年…）ので、
// 何番目を使うかは画面で選んでもらう（こちらで決め打ちすると静かに予算が入る）。
// 「小計」の行は費目名が書かれていない。資料では 人件費→販売費→建物管理費→公共料金→
// 一般諸経費 の順に並ぶので、出てきた順で当てる。当て推量なので、画面には
// 「小計(2つ目) → 販売費」と出して直せるようにしておく。
const SUBTOTALS = ["jinken", "hanbai", "tatemono", "koukyou", "shokeihi"];

export function parsePlText(text) {
  const lines = [];
  let sub = 0;
  let pending = null; // 費目名だけの行。数字が次の行に来る文字起こしがある
  const push = (label, field, nums, guess) => {
    lines.push({ label, field, nums, guess });
    if (guess) sub++;
  };
  for (const raw of String(text || "").split(/\r?\n/)) {
    const t = raw.normalize("NFKC").trim();
    if (!t) continue;
    // 「12.3%」「31日」は値ではない。先に消しておかないと番号がずれる
    const cleaned = t.replace(/[△▲-]?[\d,]+(?:\.\d+)?\s*[%％]/g, " ").replace(/\d+\s*日/g, " ");
    const label = cleaned.replace(/[\d,.\s△▲()%-]+/g, " ").trim().split(/\s+/)[0] || "";
    const k = key(label);
    const isSub = k === "小計" || k === "小";
    const col = isSub ? null : COLS.find(([, names]) => names.some((n) => k === key(n) || k.startsWith(key(n))));
    const nums = [...cleaned.matchAll(/(^|[\s(])([△▲-]?[\d][\d,]*)(?=[\s)]|$)/g)]
      .map((m) => Number(m[2].replace(/,/g, "").replace(/^[△▲]/, "-")))
      .filter((n) => isFinite(n));

    if (col || isSub) {
      // 費目は分かったが数字が無い行。次に数字だけの行が来たらその組で拾う
      if (!nums.length) { pending = { label, field: isSub ? SUBTOTALS[sub] : col[0], guess: isSub }; continue; }
      if (isSub) { if (SUBTOTALS[sub]) push(`小計(${sub + 1}つ目)`, SUBTOTALS[sub], nums, true); }
      else push(label, col[0], nums, false);
      pending = null;
      continue;
    }
    if (pending && nums.length && !k) {
      if (pending.field) push(pending.guess ? `小計(${sub + 1}つ目)` : pending.label, pending.field, nums, pending.guess);
      pending = null;
    }
  }
  const m = String(text || "").normalize("NFKC")
    .match(/(?:令和|[Rr])\s*\d{1,2}\s*[年.\-/]\s*\d{1,2}|\d{4}\s*[年.\-/]\s*\d{1,2}/);
  const got = new Set(lines.map((l) => l.field));
  return { lines, ym: m ? parseMonthLabel(m[0].replace(/\s+/g, "")) : null,
    missing: COLS.map(([k2]) => k2).filter((k2) => !got.has(k2)) };
}

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

  // 月次はほとんどの費目が前月と同じ（地代家賃・減価償却費・保守料…）。
  // 前月をひな形にして、動いた費目だけ直すほうが早く、打ち間違いも減る。
  const copyBtn = el("button", { class: "btn sm ghost", text: "前月の値を入れる", onclick: () => {
    const prev = prevRow();
    if (!prev) { toast("前月のデータがありません", "err"); return; }
    const u = unit();
    let n = 0;
    for (const [k, i] of Object.entries(inputs)) {
      if (prev[k] == null) continue;
      i.value = String(Math.round(prev[k] / u));
      n++;
    }
    refresh();
    toast(`前月の${n}項目を入れました。変わったところだけ直してください`, "ok");
  } });

  const pasteBtn = el("button", { class: "btn sm ghost", text: "文字を貼り付けて埋める",
    onclick: () => openPaste((vals, ym) => {
      if (ym && !byYm.has(ym.slice(0, 7))) { monthInp.value = ym.slice(0, 7); note.textContent = `${ym.slice(0, 7)} は未入力です。`; }
      for (const [k, v] of Object.entries(vals)) if (inputs[k]) inputs[k].value = String(v);
      refresh();
    }) });

  const body = el("div", { class: "col", style: "gap:12px;min-width:min(690px,100%)" }, [
    el("p", { class: "hint", style: "margin:0", text: "会議資料を見ながら入れてください。空欄はそのまま（前に入れた値を消しません）。" }),
    el("div", { class: "row", style: "gap:12px;align-items:flex-end;flex-wrap:wrap" }, [
      el("div", {}, [el("label", { class: "lbl", text: "月度" }), monthInp]),
      el("div", {}, [el("label", { class: "lbl", text: "資料の単位" }), unitSel]),
      el("div", {}, pasteBtn),
      el("div", {}, copyBtn),
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

// 文字認識の結果を貼って、入力欄に流し込む。
// 1行に予算・実績・前年…と数字が並ぶので「何番目を使うか」を選んでもらう。
// こちらで決め打ちすると、静かに予算を実績として入れてしまう。
function openPaste(onFill) {
  const ta = el("textarea", { rows: "8", placeholder: "ここに貼り付け（GoogleドライブでPDFをGoogleドキュメントとして開くと文字にできます）",
    style: "width:100%;box-sizing:border-box;font-size:12px;line-height:1.5" });
  const idx = el("select", { class: "inp", style: "width:120px" },
    [1, 2, 3, 4, 5, 6].map((n) => el("option", { value: String(n), text: `${n}番目`, selected: n === 2 ? "selected" : null })));
  const out = el("div", { class: "col", style: "gap:4px" });
  let parsed = { lines: [], ym: null, missing: [] };

  const draw = () => {
    clear(out);
    const n = Number(idx.value);
    if (!parsed.lines.length) {
      out.appendChild(el("div", { class: "hint", text: "貼り付けると、拾えた費目がここに出ます。" }));
      return;
    }
    if (parsed.ym) out.appendChild(el("div", { class: "hint", text: `月度らしきもの: ${parsed.ym.slice(0, 7)}` }));
    // 拾えなかった費目は必ず出す。黙って抜けると、そのまま空欄で保存されて後から気づけない
    if (parsed.missing.length) {
      out.appendChild(el("div", { class: "hint", style: "color:#c77700",
        text: `拾えなかった費目（手で入れてください）: ${parsed.missing.map((k) => LABEL[k]).join("・")}` }));
    }
    const t = el("table", { class: "grid mono compact" });
    t.appendChild(el("thead", {}, el("tr", {}, [el("th", { class: "txt", text: "費目" }),
      el("th", { class: "txt", text: "行にあった数字" }), el("th", { text: "使う値" })])));
    const tb = el("tbody");
    for (const ln of parsed.lines) tb.appendChild(el("tr", {}, [
      el("td", { class: "txt", style: ln.guess ? "color:#c77700" : "",
        text: `${ln.label} → ${LABEL[ln.field]}${ln.guess ? "（並び順から推定）" : ""}` }),
      // map(num) だと配列の添字が num の桁数引数に入って「114,535.0」になる
      el("td", { class: "txt", style: "font-size:11.5px", text: ln.nums.map((v) => num(v)).join("  ") }),
      el("td", { style: "font-weight:700", text: ln.nums[n - 1] == null ? "—" : num(ln.nums[n - 1]) }),
    ]));
    t.appendChild(tb);
    out.appendChild(el("div", { class: "table-wrap", style: "max-height:40vh;overflow:auto" }, t));
  };
  const reparse = () => { parsed = parsePlText(ta.value); draw(); };
  ta.addEventListener("input", reparse);
  idx.addEventListener("change", draw);
  draw();

  const close = modal("文字を貼り付けて埋める", el("div", { class: "col", style: "gap:10px;min-width:min(660px,100%)" }, [
    el("p", { class: "hint", style: "margin:0", text:
      "紙をスキャンしたPDFは、GoogleドライブにPDFを入れて「Googleドキュメントで開く」と文字に起こせます（iPhoneの写真の文字認識でも可）。その文字をここに貼ってください。" }),
    ta,
    el("div", { class: "row", style: "gap:8px;align-items:center;flex-wrap:wrap" }, [
      el("label", { class: "lbl", style: "margin:0", text: "1行の中で使う数字" }), idx,
      el("span", { class: "hint", text: "予算・実績・前年…と並ぶので、実績の位置を選びます" }),
    ]),
    out,
  ]), el("div", { class: "row", style: "justify-content:flex-end;gap:8px;margin-top:12px" }, [
    el("button", { class: "btn ghost", text: "やめる", onclick: () => close() }),
    el("button", { class: "btn primary", text: "入力欄に入れる", onclick: () => {
      const n = Number(idx.value);
      const vals = {};
      for (const ln of parsed.lines) if (ln.nums[n - 1] != null && vals[ln.field] == null) vals[ln.field] = ln.nums[n - 1];
      if (!Object.keys(vals).length) { toast("拾えた費目がありません", "err"); return; }
      onFill(vals, parsed.ym);
      close();
      toast(`${Object.keys(vals).length}項目を入れました。数字を確かめてください`, "ok");
    } }),
  ]));
  setTimeout(() => ta.focus(), 50);
}

// 会議資料と同じ「R7.01」の書き方にそろえる（CSVで入れた月と並べたときに揃う）。
function waLabel(ym) {
  const [y, m] = String(ym).slice(0, 7).split("-").map(Number);
  return `R${y - 2018}.${String(m).padStart(2, "0")}`;
}

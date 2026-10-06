import { el, clear, modal } from "../../util/dom.js";
import { repo } from "../../core/repo.js";
import { state, loadSections } from "../../core/state.js";
import { toast, errorToast, setSaveState } from "../../core/errors.js";
import { parseKtacsRows, KTACS_FIELDS } from "../../import/ktacsCsv.js";
import { readAnyFile, sniffFormat, FORMAT_LABEL } from "../../import/anyTable.js";
import { askColumnMap, rememberedMap } from "./columnMap.js";
import { rateKeyOfDai } from "../../core/daiSection.js";
import { compressToRanges, formatRanges } from "../../util/daiRange.js";
import { yen } from "../../util/format.js";
import { parsePlCsv, parsePlTable, COLS as PL_COLS } from "../../import/plCsv.js";
import { importMeetingFile } from "../expense/meeting.js";
import { parsePlPdf } from "../../import/plPdf.js";
import { importIslandXlsx, showIslandHistory } from "./islandImport.js";
import { openPlManual } from "./plManual.js";

const toDate = (s) => (s ? String(s).replace(/\//g, "-") : null);

export async function mount(host) {
  await loadSections();
  clear(host);
  host.appendChild(el("div", { class: "view-title" }, [
    el("h1", { text: "データ取込" }),
    el("small", { text: "台別データ・島図・月計画表・会議資料。CSV・Excel・PDFのどれでも、中身を見て種類を判定します" }),
  ]));

  // どの資料もここに落とせばよい。種類と形式は中身から決める（anyImport.js）。
  // 下の資料ごとのボタンは、判定に頼らず種類を指定して入れたいとき用に残す。
  const zone = el("div", { class: "placeholder drop-any", style: "cursor:pointer;padding:28px 16px" }, [
    el("div", { style: "font-weight:700;font-size:15px;color:var(--fg)", text: "ファイルをここにドラッグ＆ドロップ、またはクリックして選択" }),
    el("div", { style: "margin-top:6px", text: "台別データ（K-TACs等）・島図Excel・月計画表・会議資料（PDF/Excel）・損益のCSV。複数まとめても可" }),
    el("div", { style: "margin-top:2px;font-size:12px", text: "見出しの言い方が違う表は、列を選び直せば読めます（選んだ対応は次回から自動）" }),
  ]);
  const input = el("input", { type: "file", accept: ".csv,.tsv,.txt,.xlsx,.xlsm,.xls,.ods,.pdf", multiple: true, style: "display:none",
    onchange: () => { const fs = [...input.files]; input.value = ""; handle(fs); } });
  zone.appendChild(input);
  zone.addEventListener("click", (e) => { if (e.target !== input) input.click(); });
  ["dragover", "dragenter"].forEach((e) => zone.addEventListener(e, (ev) => { ev.preventDefault(); zone.style.borderColor = "var(--accent)"; }));
  ["dragleave", "drop"].forEach((e) => zone.addEventListener(e, () => (zone.style.borderColor = "")));
  zone.addEventListener("drop", (ev) => { ev.preventDefault(); handle([...ev.dataTransfer.files]); });
  host.appendChild(zone);

  const anyMsg = el("div", { class: "col", style: "margin-top:8px;gap:2px" });
  host.appendChild(anyMsg);
  const result = el("div", { class: "col", style: "margin-top:14px" });
  host.appendChild(result);

  // 台別データ（種類を指定して入れる口）
  const csvInput = el("input", { type: "file", accept: ".csv,.tsv,.txt,.xlsx,.xls,.xlsm,.ods", multiple: true, style: "display:none",
    onchange: () => { const fs = [...csvInput.files]; csvInput.value = ""; importKtacsFiles(fs, { result, history }); } });
  host.appendChild(el("div", { class: "card", style: "margin-top:18px;padding:10px 12px" }, [
    el("div", { class: "row", style: "gap:8px;align-items:center;flex-wrap:wrap" }, [
      el("div", { style: "font-weight:700", text: "台別データ" }),
      el("span", { class: "hint", text: "K-TACs 遊技台個別CSV（全レート1ファイルでも、レート別でも可）。Excelに保存し直したものも可" }),
      el("div", { class: "grow" }),
      csvInput,
      el("button", { class: "btn sm", text: "台別データを取込", onclick: () => csvInput.click() }),
    ]),
  ]));

  // 島図Excel（配置図）の取込。もとは島図タブにあったが、閲覧をシミュレーターへ
  // 統合したため、取込・履歴という管理作業はこの取込タブにまとめる。
  const islandInput = el("input", { type: "file", accept: ".xlsx", style: "display:none",
    onchange: () => importIslandXlsx(islandInput.files[0], () => { islandInput.value = ""; mount(host); }) });
  host.appendChild(el("div", { class: "card", style: "margin-top:10px;padding:10px 12px" }, [
    el("div", { class: "row", style: "gap:8px;align-items:center;flex-wrap:wrap" }, [
      el("div", { style: "font-weight:700", text: "島図（配置図）" }),
      el("span", { class: "hint", text: "島図Excel（島図＋設定表シート）。入替で配置が変わったときに取り込みます" }),
      el("div", { class: "grow" }),
      islandInput,
      el("button", { class: "btn sm", text: "島図Excelを取込", onclick: () => islandInput.click() }),
      el("button", { class: "btn sm ghost", text: "📅 入替履歴", onclick: showIslandHistory }),
    ]),
  ]));

  // 月次の損益・経費。会議資料は月1回・PDFで出るので、PDFのまま入れられるようにする。
  // 読み取ったCSVも今までどおり受ける（PDFの作りが変わって読めないときの逃げ道）。
  const plMsg = el("div", { class: "col", style: "margin-top:6px" });
  const plInput = el("input", {
    type: "file", accept: ".pdf,.csv,.tsv,.txt,.xlsx,.xls,.xlsm,.ods", style: "display:none",
    onchange: () => importPl(plInput.files[0], plMsg).finally(() => { plInput.value = ""; }),
  });
  host.appendChild(el("div", { class: "card", style: "margin-top:14px;padding:10px 12px" }, [
    el("div", { class: "row", style: "gap:8px;align-items:center;flex-wrap:wrap" }, [
      el("div", { style: "font-weight:700", text: "月次の損益・経費" }),
      el("span", { class: "hint", text: "会議資料のPDF・月次会議サマリーのExcel・損益の表（Excel/CSV、月が縦でも横でも可）。月1回、資料をもらったときに入れます" }),
      el("div", { class: "grow" }),
      plInput,
      el("button", { class: "btn sm", text: "会議資料を取込", onclick: () => plInput.click() }),
      // NotebookLM等でPDFをCSVに起こしたとき、ファイルに保存しなくても入れられるように。
      // スマホだとファイルを作るほうが手間なので、貼り付けの口を用意しておく。
      el("button", { class: "btn sm ghost", text: "CSVを貼り付けて取込", onclick: () => importPlPaste(plMsg) }),
      // 資料が紙のスキャンだと機械では読めない。そのときの入り口をここに置く。
      el("button", { class: "btn sm ghost", text: "手入力", onclick: () => openPlManual(plMsg) }),
      el("button", { class: "btn sm ghost", text: "経費タブを見る", onclick: () => { location.hash = "expense"; } }),
    ]),
    plMsg,
  ]));

  // 月計画表。予実タブにも同じボタンがあるが、資料の取込をここで一通り済ませられるように置く
  host.appendChild(el("div", { class: "card", style: "margin-top:10px;padding:10px 12px" }, [
    el("div", { class: "row", style: "gap:8px;align-items:center;flex-wrap:wrap" }, [
      el("div", { style: "font-weight:700", text: "月計画表" }),
      el("span", { class: "hint", text: `月計画表Excel（日別の計画と実績）。取込先は ${state.fy}年度（ヘッダーの年度）です` }),
      el("div", { class: "grow" }),
      el("button", { class: "btn sm", text: "月計画表を取込", onclick: async () => {
        const { pickMonthlyPlan } = await import("../yojitsu/importPlan.js");
        pickMonthlyPlan({ fy: state.fy, sections: state.sections, onDone: () => {} });
      } }),
    ]),
  ]));

  const history = el("div", { class: "col", style: "margin-top:20px" });
  host.appendChild(history);
  renderHistory(history);

  async function handle(files) {
    clear(anyMsg);
    const { importAnyFiles } = await import("./anyImport.js");
    await importAnyFiles(files, { msgHost: anyMsg, ktacsOpts: { result, history }, onDone: () => renderHistory(history) });
  }
}

// 台別CSVの取込本体。取込タブのほか、各タブの「取込」ボタンからも呼ぶ。
// result: 結果を出す場所 / history: 取込履歴の表（無ければ更新しない）
export async function importKtacsFiles(files, { result, history } = {}) {
  await loadSections();
  if (!files.length) return;
  try {
    const secByKey = new Map(state.sections.map((s) => [s.key, s]));
    const parsed = [];
    for (const f of files) {
      const p = await readKtacs(f);
      if (!p) return; // 列の選び直しをやめた
      parsed.push({ name: f.name, ...p });
    }
    if (!parsed.some((p) => p.rows.length)) {
      toast(parsed.flatMap((p) => p.warnings)[0] || "取り込める台がありませんでした", "err");
      return;
    }
    let period = parsed.find((p) => p.period?.start)?.period;
    // 期間が書かれていない表（Excelで作り直したもの等）は聞く。黙って今日の日付にすると
    // どの期間のデータか分からないまま「最新」に切り替わり、機種分析の数字が入れ替わる。
    if (!period) {
      period = await askPeriod(files.map((f) => f.name).join("、"));
      if (!period) return;
    }
    const label = `${period.start}〜${period.end}`;

    // 区分は台番から決める。ホールコンの出力は全レート1ファイルになり、
    // ファイル冒頭のレート表記（20円など）が付かないことがあるため。
    // 表記がある古いファイルは、台番で決まらなかった台の受け皿として使う。
    const assign = [];      // { row, sec, byDai }
    const unassigned = [];  // どの区分にも入らない台番
    const mismatch = [];    // 台番判定とファイルのレート表記が食い違う台番
    for (const p of parsed) {
      const fileSec = p.sectionKey ? secByKey.get(p.sectionKey) : null;
      for (const r of p.rows) {
        const key = rateKeyOfDai(r.dai_no);
        const sec = (key && secByKey.get(key)) || fileSec;
        if (!sec) { unassigned.push(r.dai_no); continue; }
        if (fileSec && key && sec.id !== fileSec.id) mismatch.push(r.dai_no);
        assign.push({ row: r, sec });
      }
    }
    // 未割当は「捨てて取り込む」と後で数が合わない事故になる。書き込む前に止める。
    if (unassigned.length) {
      renderUnassigned(result, unassigned, label);
      toast(`どの区分にも入らない台が ${unassigned.length}台 あります`, "err");
      return;
    }
    if (!assign.length) { toast("取り込める台がありませんでした", "err"); return; }

    setSaveState("saving");
    // 既存 is_current を解除
    const currents = await repo.select("snapshot_period", { eq: { store_id: state.storeId, is_current: true } });
    for (const c of currents) await repo.upsert("snapshot_period", { ...c, is_current: false }, { onConflict: ["id"] });
    // 新規スナップショット期間
    const [periodRow] = await repo.upsert("snapshot_period", {
      store_id: state.storeId, label, start_date: toDate(period.start), end_date: toDate(period.end), is_current: true,
    }, { onConflict: ["id"] });

    const snaps = assign.map(({ row: r, sec }) => ({
      period_id: periodRow.id, dai_no: r.dai_no, store_id: state.storeId, section_id: sec.id,
      model_name: r.model, out_val: r.out, sa_val: r.sa, payout: r.payout, big_count: r.big, sales: r.sales, gross: r.gross,
    }));
    // 結果は区分ごとにまとめる（1ファイルに全レートが入るので、ファイル単位では意味がない）
    const byLabel = new Map();
    for (const a of assign) byLabel.set(a.sec.label, (byLabel.get(a.sec.label) || 0) + 1);
    const summary = [...byLabel].map(([lbl, dai]) => ({ label: lbl, dai }));
    const warnings = parsed.flatMap((p) => p.warnings || []);
    if (mismatch.length) {
      warnings.push(`ファイルのレート表記と台番の設定が食い違う台が ${mismatch.length}台 あります（${mismatch.slice(0, 8).join(", ")}${mismatch.length > 8 ? " ほか" : ""}）。台番の設定を優先しました。`);
    }
    if (warnings.length) summary.push({ label: "注意", dai: "", warnings });
    for (const p of parsed) {
      await repo.upsert("import_log", { store_id: state.storeId, kind: "ktacs_csv", filename: p.name, row_count: p.rows.length, status: "ok", message: label }, { onConflict: ["id"] });
    }
    for (let i = 0; i < snaps.length; i += 200) await repo.upsert("machine_snapshot", snaps.slice(i, i + 200), { onConflict: ["period_id", "dai_no"] });
    setSaveState("saved");
    renderResult(result, label, summary, snaps.length);
    if (history) renderHistory(history);
    toast(`${snaps.length}台を取込みました`, "ok");
  } catch (e) { errorToast(e); }
}

// 台別データの期間を聞く。既定は先月1日〜末日（月初に先月ぶんを入れることが多いため）。
function askPeriod(name) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1), last = new Date(now.getFullYear(), now.getMonth(), 0);
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const from = el("input", { type: "date", class: "inp", value: iso(first) });
    const to = el("input", { type: "date", class: "inp", value: iso(last) });
    const err = el("div", { class: "hint", style: "color:#e35d6a" });
    const close = modal("集計期間を入力してください", el("div", { class: "col", style: "gap:10px;min-width:min(420px,100%)" }, [
      el("p", { class: "hint", style: "margin:0", text: `${name} には集計期間が書かれていませんでした。いつからいつまでのデータか入れてください。` }),
      el("div", { class: "row", style: "gap:8px;align-items:center;flex-wrap:wrap" }, [from, el("span", { text: "〜" }), to]),
      err,
    ]), el("div", { class: "row", style: "justify-content:flex-end;gap:8px;margin-top:12px" }, [
      el("button", { class: "btn ghost", text: "やめる", onclick: () => close() }),
      el("button", { class: "btn primary", text: "この期間で取り込む", onclick: () => {
        if (!from.value || !to.value || from.value > to.value) { err.textContent = "開始日と終了日を正しく入れてください"; return; }
        finish({ start: from.value.replace(/-/g, "/"), end: to.value.replace(/-/g, "/") });
        close();
      } }),
    ]), { onClose: () => finish(null) });
  });
}

// 台別データを1ファイル読む。CSV（cp932/UTF-8）・Excelのどれでも同じ読み方を通す。
// 見出しで列が決まらなければ、前に選んだ対応→画面で選んでもらう、の順に試す。
async function readKtacs(file) {
  const { format, sheets } = await readAnyFile(file);
  if (format === "pdf" || format === "unknown") {
    return { rows: [], warnings: [`${file.name}: ${FORMAT_LABEL[format]}の台別データは読めません（CSVかExcelで出力してください）`] };
  }
  // Excelはシートが複数あることがある。台番号と投入がそろうシートを使う
  let best = null;
  for (const sh of sheets) {
    const p = parseKtacsRows(sh.rows, file.name);
    if (!best || p.rows.length > best.p.rows.length) best = { sh, p };
  }
  if (!best) return { rows: [], warnings: [`${file.name}: 中身が空です`] };
  if (best.p.rows.length) return best.p;
  const rows = best.sh.rows;
  const known = rememberedMap("ktacs", rows);
  if (known) {
    const p = parseKtacsRows(rows, file.name, { colMap: known });
    if (p.rows.length) return p;
  }
  const map = await askColumnMap({ kind: "ktacs", title: `台別データの列を選ぶ（${file.name}）`, rows, fields: KTACS_FIELDS });
  if (!map) return null;
  return parseKtacsRows(rows, file.name, { colMap: map });
}

// 会議資料（月次の損益）の取込。形式を問わず受ける。
//   PDF → 文字の位置から表を組み直す（plPdf.js）
//   Excel → 月次会議サマリーならサマリーとして、それ以外は損益の表として読む
//   CSV・タブ区切り → 損益の表として読む（月が縦でも横でもよい）
export async function importPl(file, msgHost) {
  if (!file) return;
  clear(msgHost);
  // PDFは読むのが重いので、表にそろえる前に振り分ける（2回読まない）
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (sniffFormat(file.name, head) === "pdf") return importPlPdf(file, await file.arrayBuffer(), msgHost);
  let read;
  try { read = await readAnyFile(file); } catch (e) { errorToast(e); return; }
  if (read.format === "unknown") {
    msgHost.appendChild(el("div", { class: "hint", style: "color:var(--accent)", text: `${file.name}: 読めない形式です（PDF・Excel・CSVに対応）` }));
    return;
  }
  if (read.format === "excel" && read.sheets.some((sh) => sh.rows.slice(0, 10).flat().some((c) => /月次会議サマリー/.test(c)))) {
    return importMeetingXlsx(file, msgHost);
  }
  return importPlTable(file, read.sheets, msgHost);
}

// CSV・Excelの損益表。いちばん多く月が読めたシートを使う。
// 単位は確認画面で選んでもらう（ここでは資料の数字のまま読む）。
async function importPlTable(file, sheets, msgHost) {
  let best = null;
  for (const sh of sheets) {
    const r = parsePlTable(sh.rows, sheets.length > 1 ? `${file.name}「${sh.name}」` : file.name, { unit: 1 });
    if (!best || r.rows.length > best.rows.length) best = { ...r, sheet: sh };
  }
  if (!best?.rows.length) {
    msgHost.appendChild(el("div", { class: "hint", style: "color:var(--accent)", text: best?.warnings[0] || "取り込める月が見つかりませんでした" }));
    return;
  }
  const sheetNote = sheets.length > 1 ? `「${best.sheet.name}」シート` : "";
  confirmPl(file, best.rows, best.warnings, msgHost, /\.csv$|\.tsv$|\.txt$/i.test(file.name) ? "pl_csv" : "pl_xlsx", { note: sheetNote });
}

// pl_month への書き込み。CSVもPDFも最後はここを通る。
async function savePlRows(rows, warnings, file, kind, msgHost) {
  setSaveState("saving");
  const recs = rows.map((r) => ({ ...r, store_id: state.storeId }));
  for (let i = 0; i < recs.length; i += 200) {
    await repo.upsert("pl_month", recs.slice(i, i + 200), { onConflict: ["store_id", "ym", "kind"] });
  }
  await repo.upsert("import_log", {
    store_id: state.storeId, kind, filename: file.name,
    row_count: recs.length, status: warnings.length ? "warn" : "ok",
    message: `${rows[0].label}〜${rows[rows.length - 1].label}`,
  }, { onConflict: ["id"] });
  setSaveState("saved");
  clear(msgHost);
  msgHost.appendChild(el("div", { class: "hint", text: `${rows.length}か月ぶんを取込みました（${rows[0].label}〜${rows[rows.length - 1].label}）` }));
  for (const w of warnings) msgHost.appendChild(el("div", { class: "hint", style: "color:var(--warn,#c77700)", text: "⚠ " + w }));
  toast(`${rows.length}か月ぶんを取込みました`, "ok");
}

// CSVの文字を貼って取り込む。中身はファイル版とまったく同じパーサを通す。
async function importPlPaste(msgHost) {
  const ta = el("textarea", { rows: "8", spellcheck: "false",
    placeholder: "月度,総売上高,売上原価,…\nR8.07,114535,95667,…",
    style: "width:100%;box-sizing:border-box;font-size:12px;line-height:1.5;font-family:monospace" });
  const out = el("div", { class: "col", style: "gap:6px" });
  let parsed = { rows: [], warnings: [] };

  const draw = () => {
    clear(out);
    if (!ta.value.trim()) { out.appendChild(el("div", { class: "hint", text: "貼り付けると、読めた月がここに出ます。" })); return; }
    if (!parsed.rows.length) {
      out.appendChild(el("div", { class: "hint", style: "color:#e35d6a", text: parsed.warnings[0] || "読める行がありません" }));
      return;
    }
    const use = PL_COLS.filter(([k]) => parsed.rows.some((r) => r[k] != null));
    const t = el("table", { class: "grid mono compact" });
    t.appendChild(el("thead", {}, el("tr", {}, [el("th", { class: "txt", text: "月度" }),
      ...use.map(([, names]) => el("th", { text: names[0] }))])));
    const tb = el("tbody");
    for (const r of parsed.rows) tb.appendChild(el("tr", {}, [
      el("td", { class: "txt", style: "white-space:nowrap", text: `${r.label}（${r.ym.slice(0, 7)}）` }),
      ...use.map(([k]) => el("td", { text: r[k] == null ? "—" : yen(r[k]) })),
    ]));
    t.appendChild(tb);
    out.appendChild(el("div", { class: "table-wrap", style: "max-height:40vh;overflow:auto" }, t));
    for (const w of parsed.warnings) out.appendChild(el("div", { class: "hint", style: "color:var(--warn,#c77700)", text: "⚠ " + w }));
  };
  const reparse = () => {
    // ファイル版と同じ道を通す（千円→円の換算も検算もそのまま効く）
    parsed = ta.value.trim() ? parsePlCsv(new TextEncoder().encode(ta.value).buffer, "貼り付け") : { rows: [], warnings: [] };
    draw();
  };
  ta.addEventListener("input", reparse);
  draw();

  const close = modal("CSVを貼り付けて取込", el("div", { class: "col", style: "gap:10px;min-width:min(760px,100%)" }, [
    el("p", { class: "hint", style: "margin:0", text:
      "1行目が「月度,総売上高,…」の見出し、2行目から中身。金額は資料と同じ千円で。NotebookLMなどで作ったCSVのほか、"
      + "Excelの表をそのままコピーして貼っても読めます（月が横に並んだ表でも可）。" }),
    ta, out,
  ]), el("div", { class: "row", style: "justify-content:flex-end;gap:8px;margin-top:12px" }, [
    el("button", { class: "btn ghost", text: "やめる", onclick: () => close() }),
    el("button", { class: "btn primary", text: "この内容で取込む", onclick: async () => {
      if (!parsed.rows.length) { toast("読める行がありません", "err"); return; }
      close();
      try { await savePlRows(parsed.rows, parsed.warnings, { name: "（貼り付け）" }, "pl_paste", msgHost); }
      catch (e) { errorToast(e); }
    } }),
  ]));
  setTimeout(() => ta.focus(), 50);
}

// 会議資料のPDF。読めなかったときは「読めた中身」を出して、手入力へ誘導する。
async function importPlPdf(file, buffer, msgHost) {
  clear(msgHost);
  msgHost.appendChild(el("div", { class: "hint", text: "PDFを読んでいます…" }));
  let parsed;
  try { parsed = await parsePlPdf(buffer, file.name); }
  catch (e) { clear(msgHost); errorToast(e); return; }
  clear(msgHost);
  const { rows, warnings, sheets } = parsed;
  if (!rows.length) { showPdfMiss(file, warnings, sheets, msgHost); return; }
  confirmPl(file, rows, warnings, msgHost, "pl_pdf", { showRaw: () => showPdfMiss(file, warnings, sheets, msgHost) });
}

// 読めた月次の損益を確認してから保存する。読み違いが月次の数字に混ざると後から
// 気づけないので、PDFでもExcelでも必ずここを通す。単位（千円/円）もここで決める。
// rows の金額は資料に書かれた数字のまま。
function confirmPl(file, rows, warnings, msgHost, logKind, { showRaw, note } = {}) {
  const unitSel = el("select", { class: "inp", style: "width:110px" }, [
    el("option", { value: "1000", text: "千円" }), el("option", { value: "1", text: "円" }),
  ]);
  const table = el("div", { class: "table-wrap" });
  const draw = () => {
    clear(table);
    const unit = Number(unitSel.value);
    const use = PL_COLS.filter(([k]) => rows.some((r) => r[k] != null));
    const t = el("table", { class: "grid mono compact" });
    t.appendChild(el("thead", {}, el("tr", {}, [el("th", { class: "txt", text: "月度" }),
      ...use.map(([, names]) => el("th", { text: names[0] }))])));
    const tb = el("tbody");
    for (const r of rows) tb.appendChild(el("tr", {}, [
      el("td", { class: "txt", style: "white-space:nowrap", text: `${r.label}（${r.ym.slice(0, 7)}）` }),
      ...use.map(([k]) => el("td", { text: r[k] == null ? "—" : yen(r[k] * unit) })),
    ]));
    t.appendChild(tb);
    table.appendChild(t);
  };
  unitSel.addEventListener("change", draw);
  draw();

  const body = el("div", { class: "col", style: "gap:10px;min-width:min(760px,100%)" }, [
    el("p", { class: "hint", style: "margin:0", text: `${file.name}${note ? " の" + note : ""} から ${rows.length}か月ぶんを読みました。金額が資料と合っているか確かめてから取り込んでください。` }),
    el("div", { class: "row", style: "gap:8px;align-items:center" }, [
      el("label", { class: "lbl", style: "margin:0", text: "資料の単位" }), unitSel,
      el("span", { class: "hint", text: "店舗別営業実績表はふつう千円です" }),
    ]),
    table,
    ...warnings.map((w) => el("div", { class: "hint", style: "color:var(--warn,#c77700)", text: "⚠ " + w })),
  ]);
  const close = modal("読み取り結果の確認", body,
    el("div", { class: "row", style: "justify-content:flex-end;gap:8px;margin-top:12px" }, [
      showRaw ? el("button", { class: "btn ghost", text: "読めた中身を見る", onclick: () => { close(); showRaw(); } }) : null,
      el("button", { class: "btn ghost", text: "やめる", onclick: () => close() }),
      el("button", { class: "btn primary", text: "この内容で取込む", onclick: async () => {
        const unit = Number(unitSel.value);
        // 読めなかった費目は列ごと入れない。nullで書くと、前に入れた値を
        // 消してしまう（同じ月を読み直しただけで数字が消えるのは事故になる）。
        const recs = rows.map((r) => {
          const o = { ym: r.ym, kind: r.kind, label: r.label, src: r.src ?? file.name };
          for (const [k] of PL_COLS) if (r[k] != null) o[k] = Math.round(r[k] * unit);
          return o;
        });
        close();
        try { await savePlRows(recs, warnings, file, logKind, msgHost); } catch (e) { errorToast(e); }
      } }),
    ].filter(Boolean)));
}

// 読めなかったとき（または中身を見たいとき）。抽出した行をそのまま出す。
// 件数だけ出しても直せないので、資料の作りが分かるところまで見せる。
function showPdfMiss(file, warnings, sheets, msgHost) {
  const NL = String.fromCharCode(10);
  let close = () => {};
  const pre = el("pre", { style: "white-space:pre-wrap;font-size:11px;line-height:1.5;max-height:52vh;overflow:auto;background:var(--panel-3);padding:10px;border-radius:6px",
    text: sheets.map((s) => `--- ${s.page}ページ（月度: ${s.months.join(", ") || "見つからず"} / 拾えた行 ${s.hits}）` + NL + s.lines.join(NL)).join(NL + NL) || "（文字が取り出せませんでした）" });
  close = modal("PDFから読めた中身", el("div", { class: "col", style: "gap:8px;min-width:min(760px,100%)" }, [
    el("p", { class: "hint", style: "margin:0", text: `${file.name}。ここに資料の文字が出ていれば、費目の呼び方を足せば読めるようになります。` }),
    ...warnings.map((w) => el("div", { class: "hint", style: "color:var(--warn,#c77700)", text: "⚠ " + w })),
    !sheets.some((s) => s.lines.length)
      ? el("div", { class: "col", style: "gap:6px" }, [
        el("div", { class: "hint", style: "color:#e35d6a", text:
          "文字が1つも入っていません。紙をスキャンしたPDFなので、機械では数字を読めません。" }),
        el("div", { class: "hint", text:
          "本部にデータ（Excel・CSV）か、印刷せずに書き出したPDFをもらえるか聞いてみてください。それまでは手入力が早いです。" }),
        el("div", {}, el("button", { class: "btn sm primary", text: "手入力で入れる",
          onclick: () => { close(); openPlManual(msgHost); } })),
      ])
      : null,
    pre,
  ].filter(Boolean)), null);
  clear(msgHost);
  msgHost.appendChild(el("div", { class: "hint", style: "color:var(--accent)", text: warnings[0] || "取り込める月度が見つかりませんでした" }));
}

// 台番がどの区分にも入っていないとき。取り込まずに、直す場所と番号を出す。
// 件数だけ出しても直せないので、番号の範囲まで見せる。
function renderUnassigned(host, dai, label) {
  clear(host);
  host.appendChild(el("div", { class: "card col", style: "border-left:3px solid #e35d6a" }, [
    el("h2", { text: "取り込めませんでした" }),
    el("div", { style: "font-weight:700", text: `どの区分にも入らない台番が ${dai.length}台 あります（${formatRanges(compressToRanges(dai))}）` }),
    el("p", { class: "hint", style: "margin:0", text:
      `期間 ${label} のファイルです。設定タブの「台番」に、この番号を含む区分を足してから取り込み直してください。`
      + "取込は行っていないので、前回のスナップショットはそのまま残っています。" }),
    el("div", {}, el("button", { class: "btn primary sm", text: "設定タブを開く", onclick: () => { location.hash = "settings"; } })),
  ]));
}

function renderResult(host, label, summary, total) {
  clear(host);
  const card = el("div", { class: "card col" }, [
    el("h2", { text: "取込結果" }),
    el("p", { class: "hint", text: `期間 ${label} / 合計 ${total}台` }),
  ]);
  for (const s of summary) {
    if (s.dai !== "") card.appendChild(el("div", { text: `・${s.label}: ${s.dai}台` }));
    for (const w of s.warnings || []) card.appendChild(el("div", { class: "hint", style: "color:var(--warn)", text: "⚠ " + w }));
  }
  card.appendChild(el("p", { class: "hint", text: "「機種分析」「島図」タブに反映されます（最新スナップショット）。" }));
  host.appendChild(card);
}

async function renderHistory(host) {
  clear(host);
  const periods = await repo.select("snapshot_period", { eq: { store_id: state.storeId }, order: ["created_at", "desc"] });
  if (!periods.length) return;
  host.appendChild(el("h2", { text: "取込済みスナップショット" }));
  const t = el("table", { class: "grid" });
  t.appendChild(el("thead", {}, el("tr", {}, ["期間", "状態", ""].map((h, i) => el("th", { class: i === 0 ? "txt" : "", text: h })))));
  const tb = el("tbody");
  for (const p of periods) {
    tb.appendChild(el("tr", {}, [
      el("td", { class: "txt", text: p.label }),
      el("td", { text: p.is_current ? "最新" : "" }),
      el("td", {}, p.is_current ? null : el("button", { class: "btn sm ghost", text: "最新にする", onclick: () => setCurrent(p, host) })),
    ]));
  }
  t.appendChild(tb);
  host.appendChild(el("div", { class: "table-wrap" }, t));
}

async function setCurrent(p, host) {
  const currents = await repo.select("snapshot_period", { eq: { store_id: state.storeId, is_current: true } });
  for (const c of currents) await repo.upsert("snapshot_period", { ...c, is_current: false }, { onConflict: ["id"] });
  await repo.upsert("snapshot_period", { ...p, is_current: true }, { onConflict: ["id"] });
  toast("最新スナップショットを変更しました", "ok");
  renderHistory(host);
}

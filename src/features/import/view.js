import { el, clear } from "../../util/dom.js";
import { repo } from "../../core/repo.js";
import { state, loadSections } from "../../core/state.js";
import { toast, errorToast, setSaveState } from "../../core/errors.js";
import { parseKtacsKoben } from "../../import/ktacsCsv.js";
import { rateKeyOfDai } from "../../core/daiSection.js";
import { compressToRanges, formatRanges } from "../../util/daiRange.js";
import { parsePlCsv } from "../../import/plCsv.js";
import { importIslandXlsx, showIslandHistory } from "./islandImport.js";

const toDate = (s) => (s ? String(s).replace(/\//g, "-") : null);

export async function mount(host) {
  await loadSections();
  clear(host);
  host.appendChild(el("div", { class: "view-title" }, [
    el("h1", { text: "データ取込" }),
    el("small", { text: "K-TACs 遊技台個別CSV（全レート1ファイル可）・島図Excel・月次の損益/経費CSV" }),
  ]));

  const zone = el("div", {
    class: "placeholder",
    style: "cursor:pointer",
    text: "遊技台個別CSVをここにドラッグ＆ドロップ、またはクリックして選択（全レート1ファイルでも、レート別でも可）",
  });
  const input = el("input", { type: "file", accept: ".csv", multiple: true, style: "display:none", onchange: () => handle([...input.files]) });
  zone.appendChild(input);
  zone.addEventListener("click", () => input.click());
  ["dragover", "dragenter"].forEach((e) => zone.addEventListener(e, (ev) => { ev.preventDefault(); zone.style.borderColor = "var(--accent)"; }));
  ["dragleave", "drop"].forEach((e) => zone.addEventListener(e, () => (zone.style.borderColor = "")));
  zone.addEventListener("drop", (ev) => { ev.preventDefault(); handle([...ev.dataTransfer.files]); });
  host.appendChild(zone);

  const result = el("div", { class: "col", style: "margin-top:14px" });
  host.appendChild(result);

  // 島図Excel（配置図）の取込。もとは島図タブにあったが、閲覧をシミュレーターへ
  // 統合したため、取込・履歴という管理作業はこの取込タブにまとめる。
  const islandInput = el("input", { type: "file", accept: ".xlsx", style: "display:none",
    onchange: () => importIslandXlsx(islandInput.files[0], () => { islandInput.value = ""; mount(host); }) });
  host.appendChild(el("div", { class: "card", style: "margin-top:18px;padding:10px 12px" }, [
    el("div", { class: "row", style: "gap:8px;align-items:center;flex-wrap:wrap" }, [
      el("div", { style: "font-weight:700", text: "島図（配置図）" }),
      el("span", { class: "hint", text: "島図Excel（島図＋設定表シート）。入替で配置が変わったときに取り込みます" }),
      el("div", { class: "grow" }),
      islandInput,
      el("button", { class: "btn sm", text: "島図Excelを取込", onclick: () => islandInput.click() }),
      el("button", { class: "btn sm ghost", text: "📅 入替履歴", onclick: showIslandHistory }),
    ]),
  ]));

  // 月次の損益・経費。会議資料は月1回・紙(PDF)でしか出ないので、読み取ったCSVを
  // ここから入れる。日次のデータと違って月に一度きりの作業。
  const plMsg = el("div", { class: "col", style: "margin-top:6px" });
  const plInput = el("input", {
    type: "file", accept: ".csv", style: "display:none",
    onchange: () => importPlCsv(plInput.files[0], plMsg).finally(() => { plInput.value = ""; }),
  });
  host.appendChild(el("div", { class: "card", style: "margin-top:14px;padding:10px 12px" }, [
    el("div", { class: "row", style: "gap:8px;align-items:center;flex-wrap:wrap" }, [
      el("div", { style: "font-weight:700", text: "月次の損益・経費" }),
      el("span", { class: "hint", text: "会議資料から作ったCSV。月1回、資料をもらったときに入れます" }),
      el("div", { class: "grow" }),
      plInput,
      el("button", { class: "btn sm", text: "月次CSVを取込", onclick: () => plInput.click() }),
      el("button", { class: "btn sm ghost", text: "経費タブを見る", onclick: () => { location.hash = "expense"; } }),
    ]),
    plMsg,
  ]));

  const history = el("div", { class: "col", style: "margin-top:20px" });
  host.appendChild(history);
  renderHistory(history);

  async function handle(files) {
    files = files.filter((f) => /\.csv$/i.test(f.name));
    if (!files.length) return;
    try {
      const secByKey = new Map(state.sections.map((s) => [s.key, s]));
      const parsed = [];
      for (const f of files) {
        const p = parseKtacsKoben(await f.arrayBuffer(), f.name);
        parsed.push({ name: f.name, ...p });
      }
      const period = parsed.find((p) => p.period?.start)?.period || { start: null, end: null };
      const label = period.start ? `${period.start}〜${period.end}` : new Date().toLocaleDateString("ja-JP");

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
      renderHistory(history);
      toast(`${snaps.length}台を取込みました`, "ok");
    } catch (e) { errorToast(e); }
  }
}

// 月次の損益・経費CSVを取り込む。同じ月度が既にあれば上書きする（読み直しても増えない）。
async function importPlCsv(file, msgHost) {
  if (!file) return;
  clear(msgHost);
  try {
    const { rows, warnings } = parsePlCsv(await file.arrayBuffer(), file.name);
    if (!rows.length) {
      msgHost.appendChild(el("div", { class: "hint", style: "color:var(--accent)", text: warnings[0] || "取り込める行がありませんでした" }));
      return;
    }
    setSaveState("saving");
    const recs = rows.map((r) => ({ ...r, store_id: state.storeId }));
    for (let i = 0; i < recs.length; i += 200) {
      await repo.upsert("pl_month", recs.slice(i, i + 200), { onConflict: ["store_id", "ym", "kind"] });
    }
    await repo.upsert("import_log", {
      store_id: state.storeId, kind: "pl_csv", filename: file.name,
      row_count: recs.length, status: warnings.length ? "warn" : "ok",
      message: `${recs[0].label}〜${recs[recs.length - 1].label}`,
    }, { onConflict: ["id"] });
    setSaveState("saved");

    const span = `${rows[0].label}〜${rows[rows.length - 1].label}`;
    msgHost.appendChild(el("div", { class: "hint", text: `${rows.length}か月ぶんを取込みました（${span}）` }));
    for (const w of warnings) msgHost.appendChild(el("div", { class: "hint", style: "color:var(--warn,#c77700)", text: "⚠ " + w }));
    toast(`${rows.length}か月ぶんを取込みました`, "ok");
  } catch (e) { errorToast(e); }
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

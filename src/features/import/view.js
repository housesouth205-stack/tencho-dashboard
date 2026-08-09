import { el, clear } from "../../util/dom.js";
import { repo } from "../../core/repo.js";
import { state, loadSections } from "../../core/state.js";
import { toast, errorToast, setSaveState } from "../../core/errors.js";
import { num } from "../../util/format.js";
import { parseKtacsKoben } from "../../import/ktacsCsv.js";
import { importIslandXlsx, showIslandHistory } from "./islandImport.js";

const toDate = (s) => (s ? String(s).replace(/\//g, "-") : null);

export async function mount(host) {
  await loadSections();
  clear(host);
  host.appendChild(el("div", { class: "view-title" }, [
    el("h1", { text: "データ取込" }),
    el("small", { text: "K-TACs 遊技台個別CSV（20円/5円/2円）" }),
  ]));

  const zone = el("div", {
    class: "placeholder",
    style: "cursor:pointer",
    text: "遊技台個別CSV（3レート分）をここにドラッグ＆ドロップ、またはクリックして選択",
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

      setSaveState("saving");
      // 既存 is_current を解除
      const currents = await repo.select("snapshot_period", { eq: { store_id: state.storeId, is_current: true } });
      for (const c of currents) await repo.upsert("snapshot_period", { ...c, is_current: false }, { onConflict: ["id"] });
      // 新規スナップショット期間
      const [periodRow] = await repo.upsert("snapshot_period", {
        store_id: state.storeId, label, start_date: toDate(period.start), end_date: toDate(period.end), is_current: true,
      }, { onConflict: ["id"] });

      const snaps = [];
      const summary = [];
      for (const p of parsed) {
        const sec = secByKey.get(p.sectionKey);
        if (!sec) { toast(`レート ${p.denom}円 に対応する区分がありません`, "err"); continue; }
        for (const r of p.rows) snaps.push({
          period_id: periodRow.id, dai_no: r.dai_no, store_id: state.storeId, section_id: sec.id,
          model_name: r.model, out_val: r.out, sa_val: r.sa, payout: r.payout, big_count: r.big, sales: r.sales, gross: r.gross,
        });
        summary.push({ label: sec.label, dai: p.rows.length, warnings: p.warnings });
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

function renderResult(host, label, summary, total) {
  clear(host);
  const card = el("div", { class: "card col" }, [
    el("h2", { text: "取込結果" }),
    el("p", { class: "hint", text: `期間 ${label} / 合計 ${total}台` }),
  ]);
  for (const s of summary) {
    card.appendChild(el("div", { text: `・${s.label}: ${s.dai}台` }));
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
  host.appendChild(t);
}

async function setCurrent(p, host) {
  const currents = await repo.select("snapshot_period", { eq: { store_id: state.storeId, is_current: true } });
  for (const c of currents) await repo.upsert("snapshot_period", { ...c, is_current: false }, { onConflict: ["id"] });
  await repo.upsert("snapshot_period", { ...p, is_current: true }, { onConflict: ["id"] });
  toast("最新スナップショットを変更しました", "ok");
  renderHistory(host);
}

// 「なんでも取込」。どの資料でも同じ口に落とせば、中身を見て種類を判定して取り込む。
//
// 取込の口が資料ごとに分かれていると、どのボタンに何を入れるかを覚えておく必要があり、
// 形式（CSVかExcelか）を間違えると「読めません」で止まる。ここでは形式も種類も中身から決め、
// 確信が持てないときだけ画面で選んでもらう。取込そのものは各資料の既存の処理を呼ぶ
// （同じ資料を2通りの読み方で入れる道を作らない）。
import { el, clear, modal } from "../../util/dom.js";
import { state, loadSections } from "../../core/state.js";
import { errorToast, toast } from "../../core/errors.js";
import { readAnyFile, sniffFormat, FORMAT_LABEL } from "../../import/anyTable.js";
import { detectKinds, KINDS } from "../../import/detect.js";

// 1位がこの点数以上で、2位と差が開いていれば聞かずに進める
const SURE = 6, GAP = 4;

/**
 * @param files File[]
 * @param msgHost 結果を出す場所
 * @param ktacsOpts 台別データの取込に渡すもの（{ result, history }）
 * @param onDone 何か1つでも取り込んだら呼ぶ
 */
export async function importAnyFiles(files, { msgHost, ktacsOpts = {}, onDone } = {}) {
  if (!files.length) return;
  await loadSections();
  const ktacs = []; // 台別データは全レートまとめて1回で入れる（期間・最新の切替が1回で済む）
  let any = false;
  for (const file of files) {
    try {
      const kind = await decideKind(file, msgHost);
      if (!kind) continue;
      any = true;
      if (kind === "ktacs") { ktacs.push(file); continue; }
      await runKind(kind, file, msgHost, onDone);
    } catch (e) { errorToast(e); }
  }
  if (ktacs.length) {
    const { importKtacsFiles } = await import("./view.js");
    await importKtacsFiles(ktacs, ktacsOpts);
  }
  if (any && ktacs.length) onDone?.();
}

async function runKind(kind, file, msgHost, onDone) {
  if (kind === "pl" || kind === "meeting") {
    const { importPl } = await import("./view.js");
    const host = msgHost || el("div");
    await importPl(file, host);
    onDone?.();
  } else if (kind === "island") {
    const { importIslandXlsx } = await import("./islandImport.js");
    await importIslandXlsx(file, onDone);
  } else if (kind === "plan") {
    const { importMonthlyPlanFile } = await import("../yojitsu/importPlan.js");
    await importMonthlyPlanFile(file, { fy: state.fy, sections: state.sections, onDone });
  }
}

// 種類を決める。分かりきっているときは聞かない。
async function decideKind(file, msgHost) {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const format = sniffFormat(file.name, head);
  // PDFで読めるのは会議資料（損益）だけ。中身を2回読まないよう、ここでは開かない
  if (format === "pdf") return "pl";
  if (format === "unknown") {
    note(msgHost, `${file.name}: 読めない形式です（CSV・Excel・PDFに対応しています）`, true);
    return null;
  }
  const read = await readAnyFile(file);
  const cands = detectKinds(read);
  const [a, b] = cands;
  if (a && a.score >= SURE && (!b || a.score - b.score >= GAP)) {
    note(msgHost, `${file.name}: ${KINDS[a.kind].label}として読みました（${a.reason}）`);
    return a.kind;
  }
  return askKind(file, read, cands);
}

function note(host, text, bad) {
  if (host) host.appendChild(el("div", { class: "hint", style: bad ? "color:var(--accent)" : "", text: (bad ? "⚠ " : "") + text }));
  else if (bad) toast(text, "err");
}

// 判定に自信が無いとき。候補を上に、理由を添えて並べ、中身の先頭も見せる。
function askKind(file, read, cands) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const score = new Map(cands.map((c) => [c.kind, c]));
    const order = [...cands.map((c) => c.kind), ...Object.keys(KINDS).filter((k) => !score.has(k))];
    let chosen = cands[0]?.kind || null;
    const list = el("div", { class: "col", style: "gap:6px" });
    const ok = el("button", { class: "btn primary", text: "この種類で取り込む" });
    const draw = () => {
      clear(list);
      for (const k of order) {
        const def = KINDS[k];
        const can = def.formats.includes(read.format);
        const c = score.get(k);
        const radio = el("input", { type: "radio", name: "anykind", value: k, disabled: can ? null : "", checked: k === chosen ? "" : null,
          onchange: () => { chosen = k; ok.disabled = false; } });
        list.appendChild(el("label", { class: "card", style: `display:flex;gap:10px;align-items:flex-start;padding:8px 10px;margin:0;cursor:${can ? "pointer" : "not-allowed"};opacity:${can ? 1 : 0.5}` }, [
          radio,
          el("div", { class: "col", style: "gap:2px" }, [
            el("div", { style: "font-weight:700", text: def.label + (c ? `　候補（${c.reason}）` : "") }),
            el("div", { class: "hint", text: can ? def.hint : `${FORMAT_LABEL[read.format]}では取り込めません（${def.formats.map((f) => FORMAT_LABEL[f]).join("・")}）` }),
          ]),
        ]));
      }
      ok.disabled = !chosen;
    };
    draw();

    // 中身の先頭。種類を選ぶ手がかりになる（どのシートに何があるか）
    const sh = read.sheets.find((s) => s.rows.length) || { name: "", rows: [] };
    const peek = el("table", { class: "grid compact mono" }, el("tbody", {}, sh.rows.slice(0, 8).map((r) =>
      el("tr", {}, r.slice(0, 10).map((c) => el("td", { class: "txt", style: "white-space:nowrap", text: String(c).slice(0, 24) }))))));

    ok.addEventListener("click", () => { finish(chosen); close(); });
    const close = modal("資料の種類を選んでください", el("div", { class: "col", style: "gap:10px;min-width:min(640px,100%)" }, [
      el("p", { class: "hint", style: "margin:0", text: cands.length
        ? `${file.name}（${FORMAT_LABEL[read.format]}）。中身から種類を決めきれませんでした。いちばん近いものを上に出しています。`
        : `${file.name}（${FORMAT_LABEL[read.format]}）。中身からは種類が分かりませんでした。どの資料か選んでください。列は次の画面で選び直せます。` }),
      list,
      el("div", { class: "hint", text: `中身の先頭${read.sheets.length > 1 ? `（「${sh.name}」シート／全${read.sheets.length}シート）` : ""}` }),
      el("div", { class: "table-wrap", style: "max-height:28vh;overflow:auto" }, peek),
    ]), el("div", { class: "row", style: "justify-content:flex-end;gap:8px;margin-top:12px" }, [
      el("button", { class: "btn ghost", text: "やめる", onclick: () => close() }), ok,
    ]), { onClose: () => finish(null) });
  });
}

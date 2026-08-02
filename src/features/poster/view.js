import { el, clear } from "../../util/dom.js";
import { STORE_NAME } from "../../core/config.js";
import { toast } from "../../core/errors.js";
import { drawPoster } from "./layoutEngine.js";

const EXPORT_W = 3000; // B1相当(約120dpi)
const RATIO = 1030 / 728;

export async function mount(host) {
  clear(host);
  const data = {
    template: "black", headline: "新装開店", subtitle: "", store: STORE_NAME,
    date: "", time: "10:00", badges: [],
    machines: [{ name: "", count: "" }, { name: "", count: "" }, { name: "", count: "" }],
    image: null,
  };

  host.appendChild(el("div", { class: "view-title" }, [el("h1", { text: "ポスター自動生成" }), el("small", { text: "新装開店 B1相当 PNG/JPG" })]));

  const wrap = el("div", { class: "row stack-md", style: "gap:18px;align-items:flex-start" });
  host.appendChild(wrap);

  // ---- 左: フォーム ----
  const form = el("div", { class: "col", style: "flex:1;min-width:300px;max-width:440px;gap:12px" });
  wrap.appendChild(form);

  // テンプレ
  const tplChips = ["black", "white"].map((t) => el("button", {
    class: "btn sm " + (data.template === t ? "primary" : "ghost"), text: t === "black" ? "黒地ヒーロー" : "白地キャラ",
    onclick: () => { data.template = t; tplChips.forEach((c, i) => c.className = "btn sm " + (["black", "white"][i] === t ? "primary" : "ghost")); redraw(); },
  }));
  form.appendChild(field("テンプレート", el("div", { class: "row", style: "gap:6px" }, tplChips)));

  form.appendChild(field("見出し（大）", inp(data.headline, (v) => { data.headline = v; redraw(); }, "text", "新装開店 / 増台!! など")));
  form.appendChild(field("サブ見出し（シリーズ名等・任意）", inp(data.subtitle, (v) => { data.subtitle = v; redraw(); }, "text", "モンスターハンター など")));
  form.appendChild(field("店名", inp(data.store, (v) => { data.store = v; redraw(); })));
  form.appendChild(el("div", { class: "row", style: "gap:10px" }, [
    field("導入日", inp(data.date, (v) => { data.date = v; redraw(); }, "date")),
    field("時刻", inp(data.time, (v) => { data.time = v; redraw(); }, "time")),
  ]));
  form.appendChild(field("バッジ（カンマ区切り・任意）", inp("", (v) => { data.badges = v.split(/[,、]/).map((s) => s.trim()).filter(Boolean); redraw(); }, "text", "甘デジ, 遊タイム")));

  // 画像アップ
  const drop = el("div", { class: "placeholder", style: "padding:18px;cursor:pointer", text: "キャラ/キービジュアル画像をドロップ、またはクリックで選択" });
  const imgInput = el("input", { type: "file", accept: "image/*", style: "display:none", onchange: () => loadImage(imgInput.files[0]) });
  drop.appendChild(imgInput);
  drop.addEventListener("click", () => imgInput.click());
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.style.borderColor = "var(--accent)"; });
  drop.addEventListener("dragleave", () => (drop.style.borderColor = ""));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.style.borderColor = ""; loadImage(e.dataTransfer.files[0]); });
  form.appendChild(field("キャラ画像", drop));

  // 機種リスト
  const mHost = el("div", { class: "col", style: "gap:6px" });
  form.appendChild(field("導入機種（機種名・台数）", mHost));
  const addBtn = el("button", { class: "btn sm ghost", text: "＋ 行を追加", onclick: () => { data.machines.push({ name: "", count: "" }); drawMachineRows(); } });
  form.appendChild(addBtn);

  function drawMachineRows() {
    clear(mHost);
    data.machines.forEach((m, i) => {
      const name = el("input", { type: "text", value: m.name, placeholder: "機種名", style: "flex:1", onchange: (e) => { m.name = e.target.value; redraw(); } });
      const cnt = el("input", { type: "number", value: m.count, placeholder: "台", style: "width:64px", onchange: (e) => { m.count = e.target.value; redraw(); } });
      const del = el("button", { class: "btn sm danger", text: "✕", onclick: () => { data.machines.splice(i, 1); drawMachineRows(); redraw(); } });
      mHost.appendChild(el("div", { class: "row", style: "gap:6px", html: "" }, [name, cnt, del]));
    });
  }
  drawMachineRows();

  // 出力
  form.appendChild(el("div", { class: "row", style: "gap:8px;margin-top:6px" }, [
    el("button", { class: "btn primary", text: "PNGで書き出し", onclick: () => exportImg("png") }),
    el("button", { class: "btn", text: "JPGで書き出し", onclick: () => exportImg("jpeg") }),
  ]));

  // ---- 右: プレビュー ----
  const prevW = 380, prevH = Math.round(prevW * RATIO);
  const canvas = el("canvas", { width: prevW, height: prevH, style: `width:${prevW}px;height:${prevH}px;border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow)` });
  wrap.appendChild(el("div", {}, [el("div", { class: "hint", style: "margin-bottom:6px", text: "プレビュー" }), canvas]));

  function redraw() { drawPoster(canvas, data); }
  function loadImage(file) {
    if (!file || !/^image\//.test(file.type)) return;
    const img = new Image();
    img.onload = () => { data.image = img; drop.textContent = "画像を読み込みました（クリックで変更）"; drop.appendChild(imgInput); redraw(); };
    img.src = URL.createObjectURL(file);
  }
  function exportImg(type) {
    const c = document.createElement("canvas");
    c.width = EXPORT_W; c.height = Math.round(EXPORT_W * RATIO);
    drawPoster(c, data);
    c.toBlob((b) => {
      if (!b) { toast("書き出しに失敗しました", "err"); return; }
      const a = el("a", { href: URL.createObjectURL(b), download: `poster_${data.date || "shinso"}.${type === "jpeg" ? "jpg" : "png"}` });
      a.click(); URL.revokeObjectURL(a.href);
      toast("書き出しました", "ok");
    }, type === "jpeg" ? "image/jpeg" : "image/png", type === "jpeg" ? 0.92 : undefined);
  }

  redraw();
}

function field(label, node) {
  return el("div", {}, [el("label", { class: "lbl", text: label }), node]);
}
function inp(value, onchange, type = "text", ph = "") {
  return el("input", { type, value: value ?? "", placeholder: ph, oninput: (e) => onchange(e.target.value) });
}

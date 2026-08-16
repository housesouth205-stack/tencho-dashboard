// 設定投入の島図（コンパクト）モジュール。画面（クリック編集可）・印刷共用。
import { el, floorBar, floorSplit } from "../../util/dom.js";
import { heatText } from "../../calc/heat.js";
import { tweakCell, settingSideOfDai } from "../../core/config.js";
import { rateKeyOfDai } from "../../core/daiSection.js";
import { num } from "../../util/format.js";

export const SET_COLORS = { 1: "#eef1f6", 2: "#e9d8c8", 3: "#dfe4ec", 4: "#ffe08a", 5: "#ffc46b", 6: "#e9c8ff" };

// マスの寸法。台番＋機種名は正方形、設定はその半分。
// 設定を上下に置く台は縦に「正方形＋半分」、左右に置く台は横に同じだけ使うので、
// 行の高さと横置きの列の幅は同じ値になる。描画と幅計算で必ずこれを使うこと
// （以前は同じ計算を2か所に書いていて、片方が古いまま通路が広がっていた）。
export function cellGeom(cellW) {
  const head = cellW ? parseFloat(cellW) : 34;
  const set = Math.round(head / 2);
  return { head, set, span: head + 1 + set };
}

// 台のある行・列だけ残し、間の空きは細い通路に圧縮（島図ビューと同方式）。
// content / gap は関数も受け付ける（列ごとに通路幅を変えるため）。
function pack(sorted, content, gap) {
  const map = new Map(); const tpl = []; let prev = null;
  for (const o of sorted) {
    if (prev !== null && o - prev !== 1) tpl.push(typeof gap === "function" ? gap(prev, o) : gap);
    map.set(o, tpl.length);
    tpl.push(typeof content === "function" ? content(o) : content);
    prev = o;
  }
  return { map, tpl };
}

// 凡例（設定別台数）
export function buildLegend(placement) {
  const counts = {};
  for (const p of placement) counts[p.setting] = (counts[p.setting] || 0) + 1;
  return el("div", { class: "row", style: "display:flex;gap:12px;flex-wrap:wrap;font-size:12px;align-items:center" },
    [1, 2, 3, 4, 5, 6].filter((s) => counts[s]).map((s) => el("span", { style: "display:inline-flex;gap:4px;align-items:center" }, [
      el("span", { style: `display:inline-block;width:14px;height:14px;border-radius:3px;border:1px solid var(--line);background:${SET_COLORS[s]}` }),
      el("span", { text: `設定${s} ${num(counts[s])}台` }),
    ])));
}

// 1フロア分の島図グリッド。全台を描画。
// opts.editable(dai)=trueの台はクリック可（onCellClick(dai)を呼ぶ）。編集不可の台は薄表示。
export function buildPlacementFloor(layout, placement, floor, opts = {}) {
  const { onCellClick, editable, cellW } = opts;
  const pmap = new Map(placement.map((p) => [p.dai, p]));
  const all = layout.map(tweakCell);
  const cells = all.filter((l) => l.floor === floor);
  // 台番＋機種名のブロックは正方形、設定ブロックはその半分。
  // 設定を上下に置く台は「正方形＋半分」の高さ、左右に置く台はその幅になる。
  const geom = cellGeom(cellW);
  const headSize = geom.head, setSize = geom.set;
  const rowH = opts.rowH || geom.span + "px";
  // レートの変わり目（2スロ／5スロ）は通路を1マスぶん取って区切りを分かりやすくする
  const rateGap = opts.rateGap || (cellW ? "44px" : "28px");

  // レート判定はその階の台だけで持つ。全フロアぶんで持つと1F(20スロ)とBF(2/5スロ)が
  // 同じ列番号を共有したときに境目と誤判定し、関係ない場所に広い通路が入ってしまう。
  // 両側に台がある列どうしでレートが違うときだけ広げる。
  const rateOfCol = new Map();
  for (const c of cells) if (!rateOfCol.has(c.grid_col)) rateOfCol.set(c.grid_col, rateKeyOfDai(c.dai_no));
  const colGap = (prev, next) => {
    const a = rateOfCol.get(prev), b = rateOfCol.get(next);
    const base = a && b && a !== b ? rateGap : "6px";
    // 幅をそろえる指定があるときは通路を伸縮させ、余りをここで吸収する
    return opts.targetW && cellW ? `minmax(${base},1fr)` : base;
  };

  {
    const gc = cells;
    // 列はその階で使っているぶんだけ。1Fの列まで共有すると、BFでは空の列が
    // 何本も挿入されて2スロと5スロが離れすぎた。
    // 代わりに全体の幅を階でそろえ、余った幅は通路（伸びるトラック）に吸わせる。
    // これで左右の端がぴったり揃い、通路の広さも自然に決まる。
    const cols = [...new Set(gc.map((c) => c.grid_col))].sort((a, b) => a - b);
    const targetW = cellW ? opts.targetW : null;
    // 設定を左右に置く台がいる列は、そのぶん列を広げる
    const hCols = new Set(gc.filter((c) => /^(left|right)$/.test(settingSideOfDai(c.dai_no) || "")).map((c) => c.grid_col));
    const colW = (col) => (hCols.has(col)
      ? (cellW ? geom.span + "px" : "minmax(0,2.3fr)")
      : (cellW || "minmax(0,1fr)"));
    // 端の台が画面の縁に触れて見づらい・押しにくいので、まわりに1マスぶん余白を取る
    const pad = opts.pad || (cellW ? "44px" : "0px");
    // cellW を指定すると固定幅＋横スクロール（スマホ用）。既定は画面幅にフィット。
    const R = pack([...new Set(gc.map((c) => c.grid_row))].sort((a, b) => a - b), rowH, "8px");
    const C = pack(cols, colW, colGap);
    const grid = el("div", { style: `display:grid;gap:2px;grid-template-columns:${C.tpl.join(" ")};grid-template-rows:${R.tpl.join(" ")};` +
      `padding:${pad};box-sizing:content-box;width:${targetW ? targetW + "px" : cellW ? "max-content" : "100%"}` });
  // 設定ブロックは通路側。島ごとの指定（config の SETTING_SIDES）が最優先で、
  // 指定がなければ同じ列の真上・真下に台があるかで自動判定する。
  // 「行が隣にあるか」で見ると島どうしが隣接する場所で誤るため列で見る。
  const occupied = new Set(gc.map((c) => c.grid_row + ":" + c.grid_col));
  const sideOf = (c) => settingSideOfDai(c.dai_no) ||
    (occupied.has(c.grid_row + 1 + ":" + c.grid_col) && !occupied.has(c.grid_row - 1 + ":" + c.grid_col) ? "top" : "bottom");
  const UPC = "#d63c43", DNC = "#1f6feb";

  // 縦向きの島は行の高さ（通常の台の分だけ高い）より低いので、そのままだと
  // 台と台の間が広く空く。縦に連なっているぶんを1つの枠にまとめて入れ、
  // 中では通常と同じ2pxで詰めて並べる（枠自体は縦中央に置く）。
  const runOfRow = new Map(); // "列:行" → その台が属する縦の連なり
  for (const col of hCols) {
    const rows = gc.filter((c) => c.grid_col === col && sideOf(c) !== "top" && sideOf(c) !== "bottom")
      .map((c) => c.grid_row).sort((a, b) => a - b);
    let run = [];
    const push = () => { if (run.length) for (const r of run) runOfRow.set(col + ":" + r, run); };
    for (const r of rows) { if (run.length && r - run[run.length - 1] !== 1) { push(); run = []; } run.push(r); }
    push();
  }
  const hBoxes = new Map();
  const ordered = [...gc].sort((a, b) => a.grid_row - b.grid_row || a.grid_col - b.grid_col);

  for (const c of ordered) {
    const p = pmap.get(c.dai_no);
    const canEdit = !!(p && editable && editable(c.dai_no));
    const up = p && p.changed && p.setting > p.prevSetting;
    const arrow = p && p.changed ? (up ? "▲" : "▼") : "";
    // 据え置きで最低設定の台は主張させない（投入中の台を目立たせるため）
    const quiet = p && !p.changed && p.setting <= (p.minSetting || 1);
    // ヒート表示中は背景色に合わせた文字色。濃い赤の上に濃紺の数字だと読めないため。
    const ink = p && p.heat ? heatText(p.heat) : null;

    // 上段＝台番と機種名。実績ヒートはこちらの背景に出す。
    const headBg = p && p.heat ? p.heat : "#fff";
    const headInk = ink || (p && p.dim ? "#6b7382" : "#1b2130");
    const side = sideOf(c);
    const horiz = side === "left" || side === "right";
    // 台番＋機種名は正方形。機種名は2行まで入るので、以前より読める。
    const head = el("div", {
      style: (horiz ? `width:${headSize}px;height:${headSize}px;flex:none;` : "flex:1;min-width:0;min-height:0;") +
        `box-sizing:border-box;background:${headBg};border-radius:3px;padding:1px;overflow:hidden;` +
        `border:1px solid ${p && p.heat ? "transparent" : "var(--line)"};` +
        "display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1",
    }, [
      // 据え置き台は台番の前に鍵を出す。一括操作で飛ばされる台がどこか、
      // 島図を見たまま分かるようにする（別の一覧を開かずに済ませたい）。
      el("div", { style: `font-size:11px;font-weight:800;line-height:1.1;color:${headInk}`,
        text: (p && p.held ? "🔒" : "") + String(c.dai_no) }),
      p ? el("div", { style: `font-size:8px;font-weight:600;line-height:1.05;color:${ink || (p.dim ? "#6b7382" : "#2a3140")};` +
        "overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-all;" +
        "max-width:100%;text-align:center", text: p.model }) : null,
    ]);

    // 設定だけの小さいブロック。台番ブロックの半分の大きさ。
    // 塗りは上げ・下げ・据え置きとも設定色で統一する（下げを青で塗ると濃すぎた）。
    // 変わったことは枠の色と▲▼で示す。
    let setBg, setBorder;
    if (!p) { setBg = "var(--panel-3)"; setBorder = "1px solid var(--line)"; }
    else if (p.changed) { setBg = SET_COLORS[p.setting]; setBorder = "2px solid " + (up ? UPC : DNC); }
    else { setBg = SET_COLORS[p.setting]; setBorder = "1px solid " + (p.setting >= 4 ? (p.color || "#b9a45e") : "var(--line)"); }
    const setBlk = el("div", {
      style: (horiz ? `width:${setSize}px;height:${headSize}px;` : `height:${setSize}px;`) + "flex:none;box-sizing:border-box;" +
        `background:${setBg};border:${setBorder};border-radius:3px;` +
        // 縦向きの島は横幅が狭いので▲▼と数字を縦に並べる
        `display:flex;flex-direction:${horiz ? "column" : "row"};align-items:center;justify-content:center;` +
        "gap:1px;line-height:1;overflow:hidden",
    }, p ? [
      // 前日の数字は出さない。上げたか下げたかだけ分かればよい。
      p.changed ? el("span", { style: `font-size:8px;font-weight:900;color:${up ? UPC : DNC}`, text: arrow }) : null,
      // 今日の設定（主役）
      el("span", {
        style: `font-size:${quiet ? 10 : 12}px;font-weight:900;letter-spacing:-.02em;` +
          `color:${quiet ? "#9aa2b1" : p.changed ? (up ? "#a3282e" : "#12437a") : "#333a46"}`,
        text: String(p.setting),
      }),
    ] : null);

    const first = side === "top" || side === "left";
    const cell = el("div", {
      title: p ? `台${c.dai_no} ${p.model}${p.secLabel ? `（${p.secLabel}）` : ""}\n設定${p.setting}${p.tip ? "\n" + p.tip : ""}${canEdit ? "\nクリックで選択中の設定を投入" : ""}` : `台${c.dai_no}（対象外）`,
      style: (horiz ? `height:${headSize}px;` // 位置はまとめ枠が持つ
        : `grid-column:${C.map.get(c.grid_col) + 1};grid-row:${R.map.get(c.grid_row) + 1};`) +
        `display:flex;flex-direction:${horiz ? "row" : "column"};gap:1px;border-radius:3px;` +
        `${p ? (canEdit ? "cursor:pointer;" : (p.dim ? "" : "opacity:.55;")) : "opacity:.35;"}` +
        // 変更台は台全体を囲って遠目でも分かるようにする
        (p && p.changed ? `box-shadow:0 0 0 2px ${up ? "#f3b0b4" : "#a8c8ff"};` : ""),
      onclick: canEdit && onCellClick ? () => onCellClick(c.dai_no) : null,
    }, first ? [setBlk, head] : [head, setBlk]);
    if (!horiz) { grid.appendChild(cell); continue; }
    // 縦の連なりごとのまとめ枠に入れる。枠は連なる行ぶんを占め、中は2pxで詰める。
    const run = runOfRow.get(c.grid_col + ":" + c.grid_row) || [c.grid_row];
    const key = c.grid_col + ":" + run[0];
    let box = hBoxes.get(key);
    if (!box) {
      box = el("div", { style: `grid-column:${C.map.get(c.grid_col) + 1};grid-row:${R.map.get(run[0]) + 1} / span ${run.length};` +
        "display:flex;flex-direction:column;gap:2px;align-items:center;justify-content:center" });
      hBoxes.set(key, box);
      grid.appendChild(box);
    }
    box.appendChild(cell);
  }
  return opts.cellW ? grid
    : el("div", { style: "border:1px solid var(--line);border-radius:8px;padding:6px;background:var(--panel)" }, grid);
  }
}

// 画面表示: 凡例＋全フロア（1F/BF両方、全台表示）
// opts.cellW 指定時はズーム対象としてまとめた中身だけを返す（枠は呼び出し側が付ける）。
export function buildPlacementMap(layout, placement, opts = {}) {
  const floors = [...new Set(layout.map((l) => l.floor))];
  const zoomed = !!opts.cellW;
  // スマホ（固定幅）では階ごとに列数が違うと左右の端がそろわない。
  // いちばん広い階の幅に合わせ、足りないぶんは通路が伸びて吸収する。
  if (zoomed) {
    const all = layout.map(tweakCell);
    const geom = cellGeom(opts.cellW);
    const W = geom.head;
    const widthOf = (fl) => {
      const mine = all.filter((l) => l.floor === fl);
      const cs = [...new Set(mine.map((l) => l.grid_col))].sort((a, b) => a - b);
      // 設定を左右に置く台がいる列は広い
      const hCols = new Set(mine.filter((l) => /^(left|right)$/.test(settingSideOfDai(l.dai_no) || "")).map((l) => l.grid_col));
      let w = Math.max(0, cs.length - 1) * 2;
      for (let i = 0; i < cs.length; i++) {
        w += hCols.has(cs[i]) ? geom.span : W;
        if (i && cs[i] - cs[i - 1] !== 1) w += 6;
      }
      return w;
    };
    opts = { ...opts, targetW: Math.max(...floors.map(widthOf)) };
  }
  const wrap = el("div", { class: zoomed ? "placement-all" : "col", style: zoomed ? "width:max-content" : "gap:8px" });
  if (!zoomed) wrap.appendChild(buildLegend(placement));
  // 1FとBFを続けて並べるので、階の変わり目がはっきり分かるようにする
  floors.forEach((fl, i) => {
    // ズーム表示(スマホ)では縮小されるため見出し・区切りを大きめにする
    if (i) wrap.appendChild(floorSplit(zoomed));
    wrap.appendChild(floorBar(fl, `${layout.filter((l) => l.floor === fl).length}台`, zoomed));
    wrap.appendChild(buildPlacementFloor(layout, placement, fl, opts));
  });
  return wrap;
}

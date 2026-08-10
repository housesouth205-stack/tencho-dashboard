// 設定投入の島図（コンパクト）モジュール。画面（クリック編集可）・印刷共用。
import { el, floorBar, floorSplit } from "../../util/dom.js";
import { heatText } from "../../calc/heat.js";
import { rateKeyOfDai, tweakCell } from "../../core/config.js";
import { num } from "../../util/format.js";

export const SET_COLORS = { 1: "#eef1f6", 2: "#e9d8c8", 3: "#dfe4ec", 4: "#ffe08a", 5: "#ffc46b", 6: "#e9c8ff" };

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
  // 島図Excelのマスは 44px幅 × 43px高（ほぼ正方形）。以前は 46 × 56 で縦が3割長く、
  // 全体が間延びして見えていたので、Excelと同じ比率にそろえる。
  // 台数の少ない行だけ低くしていたことがあるが、212・217のマスだけ縦に縮んで
  // 見た目が揃わなかったのでやめた。全部の行を同じ高さにする。
  const rowH = opts.rowH || "43px";
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
    // 端の台が画面の縁に触れて見づらい・押しにくいので、まわりに1マスぶん余白を取る
    const pad = opts.pad || (cellW ? "44px" : "0px");
    // cellW を指定すると固定幅＋横スクロール（スマホ用）。既定は画面幅にフィット。
    const R = pack([...new Set(gc.map((c) => c.grid_row))].sort((a, b) => a - b), rowH, "8px");
    const C = pack(cols, cellW || "minmax(0,1fr)", colGap);
    const grid = el("div", { style: `display:grid;gap:2px;grid-template-columns:${C.tpl.join(" ")};grid-template-rows:${R.tpl.join(" ")};` +
      `padding:${pad};box-sizing:content-box;width:${targetW ? targetW + "px" : cellW ? "max-content" : "100%"}` });
  for (const c of gc) {
    const p = pmap.get(c.dai_no);
    const canEdit = !!(p && editable && editable(c.dai_no));
    // 前日比較モード: dim=据え置き(白で目立たなくする) / changed=変更台(色付き・太枠・▲▼)
    let bg, border, extra = "";
    if (!p) { bg = "var(--panel-3)"; border = "1px solid var(--line)"; }
    else if (p.heat) {
      // 実績ヒート表示中は背景をヒート色にし、設定の変化は枠と数字で表す
      bg = p.heat;
      const up = p.changed && p.setting > p.prevSetting;
      border = p.changed ? "3px solid " + (up ? "#d63c43" : "#1f6feb")
        : (p.setting > 1 ? "2px solid #333a46" : "1px solid var(--line)");
      if (p.changed) extra = "box-shadow:0 0 0 2px " + (up ? "#f3b0b4" : "#a8c8ff") + ";";
    }
    else if (p.dim) { bg = "#fff"; border = "1px solid var(--line)"; }
    else if (p.changed) {
      // 変更台は遠目でも分かるようにする。特に「下げて設定1」は設定色がほぼ白で
      // 据え置きと見分けが付かなかったため、下げは青系で塗りつぶす。
      const up = p.setting > p.prevSetting;
      bg = up ? SET_COLORS[p.setting] : "#bcd8ff";
      border = "3px solid " + (up ? "#d63c43" : "#1f6feb");
      extra = "box-shadow:0 0 0 2px " + (up ? "#f3b0b4" : "#a8c8ff") + ";";
    } else {
      bg = SET_COLORS[p.setting]; border = "1px solid " + (p.color || "var(--line)");
      if (p.setting >= 4) extra = "box-shadow:0 0 0 1px " + (p.color || "var(--line)") + ";";
    }
    // ヒート表示中は背景色に合わせた文字色。濃い赤の上に濃紺の数字だと読めないため。
    const ink = p && p.heat ? heatText(p.heat) : null;
    // 数字は「今日の設定」が主役。前日は小さく添えるだけにする。
    // 同じ大きさで並べると、どちらを打ち換えるのか一瞬で判断できなかった。
    const up = p && p.changed && p.setting > p.prevSetting;
    const arrow = p && p.changed ? (up ? "▲" : "▼") : "";
    // 据え置きで最低設定の台は主張させない（投入中の台を目立たせるため）
    const quiet = p && !p.changed && p.setting <= (p.minSetting || 1);
    const todaySize = p && p.changed ? 17 : quiet ? 11 : 15;
    const cell = el("div", {
      title: p ? `台${c.dai_no} ${p.model}${p.secLabel ? `（${p.secLabel}）` : ""}\n設定${p.setting}${p.tip ? "\n" + p.tip : ""}${canEdit ? "\nクリックで選択中の設定を投入" : ""}` : `台${c.dai_no}（対象外）`,
      style: `grid-column:${C.map.get(c.grid_col) + 1};grid-row:${R.map.get(c.grid_row) + 1};overflow:hidden;` +
        `background:${bg};color:#333a46;border:${border};border-radius:3px;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1;padding:1px;` +
        `${p ? (canEdit ? "cursor:pointer;" : (p.dim ? "" : "opacity:.55;")) : "opacity:.35;"}` + extra,
      onclick: canEdit && onCellClick ? () => onCellClick(c.dai_no) : null,
    }, [
      // 台番・機種名は薄いと読めないので濃さと大きさを上げる（据え置き台も判別できる程度に）。
      // ヒート表示中は背景が濃くなるため、背景に合わせて文字色を反転させる。
      el("div", { style: `font-size:11px;font-weight:800;line-height:1.1;color:${ink || (p && p.dim ? "#6b7382" : "#1b2130")}`, text: String(c.dai_no) }),
      // Excelと同じ正方形のマスに収めるため機種名は1行。低くした行では省く。
      p ? el("div", { style: "font-size:8px;line-height:1.05;overflow:hidden;display:-webkit-box;-webkit-line-clamp:1;" +
        `-webkit-box-orient:vertical;word-break:break-all;color:${ink || (p.dim ? "#6b7382" : "#2a3140")};font-weight:600;text-align:center`, text: p.model }) : null,
      p ? el("div", { style: "display:flex;align-items:baseline;justify-content:center;gap:1px;line-height:1" }, [
        // 前日の設定（小さく・薄く）。打ち換え前の数字がどれかを添えるだけ。
        p.changed ? el("span", {
          style: `font-size:9px;font-weight:700;opacity:.7;text-decoration:line-through;` +
            `color:${ink || (up ? "#a3282e" : "#12437a")}`,
          text: String(p.prevSetting),
        }) : null,
        p.changed ? el("span", { style: `font-size:9px;font-weight:900;color:${ink || (up ? "#d63c43" : "#1f6feb")}`, text: arrow }) : null,
        // 今日の設定（主役）
        el("span", {
          style: `font-size:${todaySize}px;font-weight:900;letter-spacing:-.02em;` +
            `color:${ink || (quiet ? "#9aa2b1" : p.changed ? (up ? "#a3282e" : "#12437a") : "#333a46")}`,
          text: String(p.setting),
        }),
      ]) : null,
    ]);
    grid.appendChild(cell);
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
    const W = parseFloat(opts.cellW) || 44;
    const widthOf = (fl) => {
      const cs = [...new Set(all.filter((l) => l.floor === fl).map((l) => l.grid_col))].sort((a, b) => a - b);
      let w = cs.length * W + Math.max(0, cs.length - 1) * 2;
      for (let i = 1; i < cs.length; i++) if (cs[i] - cs[i - 1] !== 1) w += 6;
      return w;
    };
    opts = { ...opts, targetW: Math.max(...floors.map(widthOf)) };
  }
  const wrap = el("div", { class: zoomed ? "placement-all" : "col", style: zoomed ? "width:max-content" : "gap:8px" });
  if (!zoomed) wrap.appendChild(buildLegend(placement));
  // 1FとBFを続けて並べるので、階の変わり目がはっきり分かるようにする（島図タブと同じ見た目）
  // opts.betweenFloors を渡すと階の間に差し込む（設定パレットを両フロアの近くに置くため）
  floors.forEach((fl, i) => {
    // ズーム表示(スマホ)では縮小されるため見出し・区切りを大きめにする
    if (i) {
      wrap.appendChild(floorSplit(zoomed));
      if (opts.betweenFloors) wrap.appendChild(opts.betweenFloors);
    }
    wrap.appendChild(floorBar(fl, `${layout.filter((l) => l.floor === fl).length}台`, zoomed));
    wrap.appendChild(buildPlacementFloor(layout, placement, fl, opts));
  });
  return wrap;
}

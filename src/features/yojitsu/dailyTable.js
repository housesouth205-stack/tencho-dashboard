// 日別の実績（アウト・売上・粗利）を表とグラフで見る。
//
// 月サマリーは区分別・累計で「今月どうか」を見るためのもので、
// 「どの日が良くてどの日が落ちたか」は分からなかった。ここはその補完。
//
// 区分は合計を含めたチップで切り替える。列に全区分を並べると
// アウト×計画実績で20列を超えて、横スクロールしないと1日ぶんも読めなくなる。
import { el, clear } from "../../util/dom.js";
import { yen, num, pct } from "../../util/format.js";
import { sectionColor, tint } from "../../util/colors.js";
import { dayKind, holidayName } from "../../util/holiday.js";
import { monthDailyDetail } from "../../calc/aggregate.js";
import { dailyBars } from "./charts.js";

const MC = { sales: "#4f8ff7", gross: "#2fb888" };
const GC = { plan: "#6b7f9e", actual: "#1f9d70", prev: "#8a91a3" };
const KIND_JP = { weekday: "", sat: "土", sun: "日", holiday: "祝" };
const WD = ["日", "月", "火", "水", "木", "金", "土"];

const narrow = () => window.matchMedia("(max-width: 700px)").matches;
const achieveHex = (r) => (r == null ? "#8a91a3" : r >= 1 ? "#43b483" : r >= 0.9 ? "#e0a52e" : "#e35d6a");

// 土日祝の行色。曜日で数字が動くので、色が無いと良し悪しを読み違える
const kindStyle = (kind) => (kind === "sun" || kind === "holiday" ? "background:rgba(227,93,106,.06)"
  : kind === "sat" ? "background:rgba(79,143,247,.06)" : "");

export function renderDailyDetail(host, { fy, month, sections, maps, prevMaps }) {
  const rows = monthDailyDetail(sections, maps.cy, month, maps);
  // 昨年の同じ月。日付合わせ（8/14は昨年の8/14）で並べるので、日にちで引けるよう同じ形で持つ。
  const prevRows = prevMaps ? monthDailyDetail(sections, prevMaps.cy, month, prevMaps) : null;
  const hasPrev = !!prevRows && prevRows.some((r) => r.bySection.get("total")?.actual);
  const tabs = [{ id: "total", label: "合計", color: "#2f3440" },
    ...sections.map((s) => ({ id: s.id, label: s.label, color: sectionColor(s), section: s }))];
  let cur = "total";
  let cmp = "plan"; // 比べる相手: plan=計画 / prev=昨年の同じ日

  const wrap = el("div", { class: "col", style: "gap:10px;margin-top:18px" });
  host.appendChild(wrap);
  wrap.appendChild(el("h2", { style: "font-size:15px;margin:0", text: "日別の実績" }));

  const bar = el("div", { class: "row", style: "gap:14px;flex-wrap:wrap;align-items:center" });
  wrap.appendChild(bar);
  const chips = el("div", { class: "row", style: "gap:6px;flex-wrap:wrap" });
  bar.appendChild(chips);
  // 比較する相手の切替。同じ表を計画と昨年で使い回すほうが、表を2つ並べるより読み比べやすい。
  const cmpChips = el("div", { class: "row", style: "gap:6px;flex-wrap:wrap;align-items:center" },
    el("span", { class: "hint", text: "比較" }));
  bar.appendChild(cmpChips);
  const body = el("div", { class: "col", style: "gap:12px" });
  wrap.appendChild(body);

  function pick(r) { return r.bySection.get(cur) || { count: 0, plan: {}, actual: null }; }
  // 昨年の同じ日にち。2月など日数が違う月は昨年に無い日が出るので null を許す。
  function pickPrev(i) { return prevRows && prevRows[i] ? prevRows[i].bySection.get(cur) || null : null; }

  // 比べる相手の見出し・色・列ラベルと、1日ぶんから相手の数字を取り出す関数。
  // 表・グラフ・カードで同じ定義を使い回す（切替のたびに3か所直すのを避ける）。
  const cmpInfo = () => (cmp === "prev"
    ? { head: `📅 昨年（${prevMaps ? prevMaps.cy : ""}年）`, short: "昨年", color: GC.prev, diff: "粗利差", rate: "前年比",
      of: (d) => d.prev, count: (d) => d.prevCount }
    : { head: "📋 計画", short: "計画", color: GC.plan, diff: "粗利差", rate: "達成率",
      of: (d) => d.plan, count: (d) => d.planCount });

  function draw() {
    chips.querySelectorAll("button").forEach((b) => {
      const on = b.dataset.id === cur;
      b.className = "btn sm " + (on ? "primary" : "ghost");
    });
    cmpChips.querySelectorAll("button").forEach((b) => {
      b.className = "btn sm " + (b.dataset.cmp === cmp ? "primary" : "ghost");
    });
    clear(body);

    const series = rows.map((r, i) => {
      const d = pick(r);
      const kind = dayKind(maps.cy, month, r.day);
      // 平均アウトの分母。合計タブは数字の入っている区分ぶんだけを aggregate から受け取る。
      // 区分タブはその区分の台数だが、計画も実績も無い日は分母に入れない。
      const cnt = (e, g) => (e[g + "Count"] != null ? e[g + "Count"] : (g === "plan" ? (e.plan.outTotal ? e.count : 0) : (e.actual ? e.count : 0)));
      const pd = pickPrev(i);
      return {
        day: r.day, date: r.date, kind, count: d.count,
        planCount: cnt(d, "plan"), actualCount: cnt(d, "actual"),
        plan: d.plan, actual: d.actual,
        // 昨年は「その日の実績」を相手にする（昨年の計画と比べても意味がない）
        prev: pd ? pd.actual : null, prevCount: pd ? cnt(pd, "actual") : 0,
      };
    });
    const hasAny = series.some((d) => d.actual);
    if (!hasAny) {
      body.appendChild(el("div", { class: "placeholder", text: "この区分の実績がまだありません。「日別入力」から入れると表とグラフが出ます。" }));
      return;
    }

    const C = cmpInfo();
    const toBar = (kind) => series.map((d) => ({
      label: String(d.day), kind: d.kind,
      plan: (C.of(d) || {})[kind] || 0, actual: d.actual ? d.actual[kind] : null,
    }));
    body.appendChild(el("div", { class: "row", style: "gap:12px;flex-wrap:wrap" }, [
      dailyBars(toBar("sales"), { title: `日別 売上（棒＝実績／横線＝${C.short}）`, color: MC.sales, unit: "円", baseLabel: C.short }),
      dailyBars(toBar("gross"), { title: `日別 粗利（棒＝実績／横線＝${C.short}）`, color: MC.gross, unit: "円", baseLabel: C.short }),
    ]));

    body.appendChild(narrow() ? cards(series, C) : table(series, C));
    body.appendChild(el("p", { class: "hint", style: "margin:0",
      text: "アウトは台あたりの平均（総アウト÷台数）。台数の増減で数字が動かないので日ごとに比べられる。実績が未入力の日は空欄。"
        + (cmp === "prev"
          ? `前年比は粗利の今年÷昨年。${prevMaps ? prevMaps.cy : ""}年${month}月の同じ日にちと比べている（休業や未入力で昨年に無い日は空欄）。`
            + "計の行の昨年は、今年の実績がある日にちだけを足した額（月ぶん全部と比べると前年比が半分に見えるため）。日数欄の「昨n日」がその日数。"
          : "達成率は粗利の実績÷計画。計の行だけは、計画列は月ぶん全部・達成率と粗利差は実績のある日の計画と比べた値（残り日数ぶんの計画で未達に見えるのを避けるため）。")
        + "アウトの計は足し上げではなく、日ごとの台数で重みづけした平均。" }));
  }

  function table(series, C) {
    const gBg = (c) => `background:${tint(c, 0.08)}`;
    const t = el("table", { class: "grid mono" });
    t.appendChild(el("thead", {}, [
      el("tr", {}, [
        el("th", { class: "txt", rowspan: 2, text: "日" }),
        el("th", { rowspan: 2, text: "曜" }),
        el("th", { colspan: 3, style: `${gBg(C.color)};color:${C.color};text-align:center`, text: C.head }),
        el("th", { colspan: 3, style: `${gBg(GC.actual)};color:${GC.actual};text-align:center`, text: "✅ 実績" }),
        el("th", { rowspan: 2, text: C.diff }),
        el("th", { rowspan: 2, text: C.rate }),
      ]),
      el("tr", {}, [
        el("th", { style: gBg(C.color), text: "アウト/台" }),
        el("th", { style: `${gBg(C.color)};color:${MC.sales}`, text: "売上" }),
        el("th", { style: `${gBg(C.color)};color:${MC.gross}`, text: "粗利" }),
        el("th", { style: gBg(GC.actual), text: "アウト/台" }),
        el("th", { style: `${gBg(GC.actual)};color:${MC.sales}`, text: "売上" }),
        el("th", { style: `${gBg(GC.actual)};color:${MC.gross}`, text: "粗利" }),
      ]),
    ]));

    const tb = el("tbody");
    // 計画は月ぶん全部、実績は入力済みの日だけ。合計行でこの2つを割ると
    // 「20日ぶんの実績 ÷ 31日ぶんの計画」になって未達に見えるので、
    // 達成率と差額は実績のある日の計画（pe）と突き合わせる。
    // アウトだけは平均で見せるので、計の行も足し上げではなく
    // 総アウト ÷ 台数（日ごとの台数を足したもの）で出す。
    const sum = {
      p: { outTotal: 0, sales: 0, gross: 0 }, pCount: 0, baseDays: 0,
      pe: { gross: 0 },
      a: { outTotal: 0, sales: 0, gross: 0 }, aCount: 0, days: 0,
    };
    for (const d of series) {
      const a = d.actual;
      const b = C.of(d) || {};
      const ach = a && b.gross ? a.gross / b.gross : null;
      // 相手の数字が無い日は差も出さない（昨年が休業の日に「+全額」と出るのを防ぐ）
      const diff = a && b.gross != null ? a.gross - (b.gross || 0) : null;
      // 計画は月ぶん全部を足す（残り日数ぶんも含めて月の計画額を見たいため）。
      // 昨年は今年の実績がある日にちだけ足す。月ぶん全部と14日ぶんを並べると前年比が半分に見える。
      if (cmp === "plan" || a) {
        sum.p.outTotal += b.outTotal || 0; sum.p.sales += b.sales || 0; sum.p.gross += b.gross || 0;
        sum.pCount += C.count(d);
        if (a && C.of(d)) sum.baseDays++;
      }
      if (a) {
        sum.a.outTotal += a.outTotal; sum.a.sales += a.sales; sum.a.gross += a.gross; sum.days++;
        sum.aCount += d.actualCount;
        sum.pe.gross += b.gross || 0;
      }
      const jp = KIND_JP[d.kind] || WD[new Date(maps.cy, month - 1, d.day).getDay()];
      tb.appendChild(el("tr", { style: kindStyle(d.kind) }, [
        el("td", { class: "txt", text: String(d.day) }),
        el("td", { title: holidayName(maps.cy, month, d.day) || null, text: jp }),
        el("td", { style: gBg(C.color), text: b.outAvg ? num(Math.round(b.outAvg)) : "—" }),
        el("td", { style: gBg(C.color), text: b.sales ? yen(b.sales) : "—" }),
        el("td", { style: gBg(C.color), text: b.gross ? yen(b.gross) : "—" }),
        el("td", { style: gBg(GC.actual), text: a && a.outAvg ? num(Math.round(a.outAvg)) : "" }),
        el("td", { style: gBg(GC.actual), text: a ? yen(a.sales) : "" }),
        el("td", { style: gBg(GC.actual), text: a ? yen(a.gross) : "" }),
        el("td", { style: diff == null ? "" : `color:${diff >= 0 ? "#43b483" : "#e35d6a"};font-weight:600`,
          text: diff == null ? "" : (diff >= 0 ? "+" : "−") + yen(Math.abs(diff)) }),
        achCell(ach),
      ]));
    }
    const totAch = sum.pe.gross ? sum.a.gross / sum.pe.gross : null;
    const totDiff = sum.days ? sum.a.gross - sum.pe.gross : null;
    const avg = (total, count) => (count ? num(Math.round(total / count)) : "—");
    tb.appendChild(el("tr", { style: "font-weight:700;border-top:2px solid var(--line)" }, [
      el("td", { class: "txt", text: "計" }),
      // 昨年に休業日があると日数がそろわない。前年比の読み違いを防ぐため両方出す
      el("td", { class: "hint", text: cmp === "prev" ? `${sum.days}日/昨${sum.baseDays}日` : `${sum.days}日` }),
      el("td", { style: gBg(C.color), text: avg(sum.p.outTotal, sum.pCount) }),
      el("td", { style: gBg(C.color), text: yen(sum.p.sales) }),
      el("td", { style: gBg(C.color), text: yen(sum.p.gross) }),
      el("td", { style: gBg(GC.actual), text: avg(sum.a.outTotal, sum.aCount) }),
      el("td", { style: gBg(GC.actual), text: yen(sum.a.sales) }),
      el("td", { style: gBg(GC.actual), text: yen(sum.a.gross) }),
      el("td", { style: totDiff == null ? "" : `color:${totDiff >= 0 ? "#43b483" : "#e35d6a"}`,
        text: totDiff == null ? "" : (totDiff >= 0 ? "+" : "−") + yen(Math.abs(totDiff)) }),
      achCell(totAch),
    ]));
    t.appendChild(tb);
    // 10列あるので表の中だけ横スクロールさせる（他の表と揃える）
    return el("div", { class: "table-wrap" }, t);
  }

  function achCell(r) {
    if (r == null) return el("td", { text: "" });
    const hex = achieveHex(r);
    return el("td", { style: `background:${tint(hex, 0.16)};color:${hex};font-weight:700`, text: pct(r) });
  }

  // スマホは10列が収まらないので、実績のある日だけカードで縦に並べる
  function cards(series, C) {
    const box = el("div", { class: "col", style: "gap:6px" });
    for (const d of series) {
      if (!d.actual) continue;
      const a = d.actual;
      const b = C.of(d) || {};
      const ach = b.gross ? a.gross / b.gross : null;
      const hex = achieveHex(ach);
      box.appendChild(el("div", { class: "card", style: `padding:8px 10px;${kindStyle(d.kind)}` }, [
        el("div", { class: "row", style: "align-items:baseline;gap:6px" }, [
          el("b", { text: `${month}/${d.day}` }),
          el("span", { class: "hint", title: holidayName(maps.cy, month, d.day) || null,
            text: KIND_JP[d.kind] || WD[new Date(maps.cy, month - 1, d.day).getDay()] }),
          el("span", { class: "grow" }),
          ach == null ? null : el("span", { style: `color:${hex};font-weight:700`, text: pct(ach) }),
        ]),
        el("div", { class: "row", style: "gap:12px;flex-wrap:wrap;margin-top:4px;font-size:12px" }, [
          kv("アウト/台", a.outAvg ? num(Math.round(a.outAvg)) : "—", b.outAvg ? num(Math.round(b.outAvg)) : null, null, C.short),
          kv("売上", yen(a.sales), b.sales ? yen(b.sales) : null, MC.sales, C.short),
          kv("粗利", yen(a.gross), b.gross ? yen(b.gross) : null, MC.gross, C.short),
        ]),
      ]));
    }
    return box;
  }

  const kv = (label, actual, base, color, baseLabel = "計画") => el("div", { style: "min-width:96px" }, [
    el("div", { class: "hint", text: label }),
    el("div", { style: `font-weight:700${color ? `;color:${color}` : ""}`, text: actual }),
    base ? el("div", { class: "hint", style: "font-size:10.5px", text: `${baseLabel} ${base}` }) : null,
  ]);

  for (const t of tabs) {
    chips.appendChild(el("button", {
      class: "btn sm ghost", "data-id": t.id, text: t.label,
      onclick: () => { cur = t.id; draw(); },
    }));
  }
  for (const c of [{ id: "plan", label: "計画" }, { id: "prev", label: "昨年" }]) {
    // 昨年のデータが無いときは押せてもすべて空欄になるだけなので、理由を出して止める
    const off = c.id === "prev" && !hasPrev;
    cmpChips.appendChild(el("button", {
      class: "btn sm ghost", "data-cmp": c.id, text: c.label,
      disabled: off ? "disabled" : null,
      title: off ? `昨年（${prevMaps ? prevMaps.cy : ""}年${month}月）の実績がありません` : null,
      onclick: () => { cmp = c.id; draw(); },
    }));
  }
  draw();
}

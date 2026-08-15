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
import { daysInMonth } from "../../util/dates.js";
import { monthDailyDetail } from "../../calc/aggregate.js";
import { dailyBars, cumCompare } from "./charts.js";

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
  // 前年比は売上で見る。粗利は出玉の波と釘・設定の判断がそのまま出るので年をまたぐと
  // ぶれが大きく、「去年より客が入ったか」を見るには売上のほうが素直。
  // 計画との比較は粗利が目標なので従来どおり粗利で出す。
  const cmpInfo = () => (cmp === "prev"
    ? { head: `📅 昨年（${prevMaps ? prevMaps.cy : ""}年）`, short: "昨年", color: GC.prev,
      metric: "sales", diff: "売上差", rate: "前年比(売上)", of: (d) => d.prev, count: (d) => d.prevCount }
    : { head: "📋 計画", short: "計画", color: GC.plan,
      metric: "gross", diff: "粗利差", rate: "達成率", of: (d) => d.plan, count: (d) => d.planCount });

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
    if (cmp === "prev" && !hasPrev) {
      body.appendChild(noPrevNote());
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
    // 昨年と比べるときは累計も出す。日別の棒は曜日で上下するので、
    // 「月を通して去年を上回っているのか」は累計でないと読み取れない。
    if (cmp === "prev") {
      body.appendChild(cumCompare(series.map((d) => ({
        label: String(d.day), cur: d.actual ? d.actual.sales : null, base: d.prev ? d.prev.sales : null,
      })), { title: "売上の累計 今年vs昨年（同じ日にちで比較）", color: MC.sales, unit: "円" }));
    }

    body.appendChild(narrow() ? cards(series, C) : table(series, C));
    body.appendChild(el("p", { class: "hint", style: "margin:0",
      text: "アウトは台あたりの平均（総アウト÷台数）。台数の増減で数字が動かないので日ごとに比べられる。実績が未入力の日は空欄。"
        + (cmp === "prev"
          ? `前年比は売上の今年÷昨年（粗利は年をまたぐとぶれが大きいため）。${prevMaps ? prevMaps.cy : ""}年${month}月の同じ日にちと比べている（休業や未入力で昨年に無い日は空欄）。`
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
    const M = C.metric; // 比べる指標: 昨年=売上 / 計画=粗利
    const sum = {
      p: { outTotal: 0, sales: 0, gross: 0 }, pCount: 0, baseDays: 0,
      pe: { sales: 0, gross: 0 },
      a: { outTotal: 0, sales: 0, gross: 0 }, aCount: 0, days: 0,
    };
    for (const d of series) {
      const a = d.actual;
      const b = C.of(d) || {};
      const ach = a && b[M] ? a[M] / b[M] : null;
      // 相手の数字が無い日は差も出さない（昨年が休業の日に「+全額」と出るのを防ぐ）
      const diff = a && b[M] != null ? a[M] - (b[M] || 0) : null;
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
        sum.pe.sales += b.sales || 0; sum.pe.gross += b.gross || 0;
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
    const totAch = sum.pe[M] ? sum.a[M] / sum.pe[M] : null;
    const totDiff = sum.days ? sum.a[M] - sum.pe[M] : null;
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

  // 「昨年」を押したのに出せないときの説明。何を探して見つからなかったのかまで書く。
  // 「データがありません」だけだと、入れ忘れなのか照合が外れているのか区別できず、
  // 店側でも直せない（実際にどちらなのかが分からず時間を使った）。
  function noPrevNote() {
    const cy = prevMaps ? prevMaps.cy : null;
    const mm = String(month).padStart(2, "0");
    const last = daysInMonth(cy, month);
    // その月の行そのものはあるか。行はあるのに出せないなら、区分（section）の
    // 照合が外れている＝区分を作り直したときに起きる。
    const rowsInMonth = prevMaps ? prevMaps.actual.size : 0;
    const lines = rowsInMonth
      ? [`昨年（${cy}年${month}月）の実績は ${rowsInMonth}件 入っていますが、いまの区分（${sections.map((s) => s.label).join("・")}）と結びついていません。`,
        "設定タブで区分を作り直すと、前の区分で入れた実績は照合できなくなります。この場合は昨年度ぶんを取り込み直すと直ります。"]
      : [`昨年（${cy}年${month}月）の実績が入っていません。`,
        `探した範囲は ${cy}-${mm}-01 〜 ${cy}-${mm}-${last} です。`,
        `年度セレクタを「${cy}年度」にすると、その年に実績が入っているかを確認できます。無ければ「月計画表を取込」で昨年度のファイルを取り込むと比較できます。`];
    return el("div", { class: "card", style: `border-left:3px solid ${GC.prev};padding:12px 14px` },
      el("div", { class: "col", style: "gap:6px" }, lines.map((t, i) =>
        el("div", { class: i ? "hint" : null, style: i ? "" : "font-weight:700", text: t }))));
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
      const ach = b[C.metric] ? a[C.metric] / b[C.metric] : null;
      const hex = achieveHex(ach);
      box.appendChild(el("div", { class: "card", style: `padding:8px 10px;${kindStyle(d.kind)}` }, [
        el("div", { class: "row", style: "align-items:baseline;gap:6px" }, [
          el("b", { text: `${month}/${d.day}` }),
          el("span", { class: "hint", title: holidayName(maps.cy, month, d.day) || null,
            text: KIND_JP[d.kind] || WD[new Date(maps.cy, month - 1, d.day).getDay()] }),
          el("span", { class: "grow" }),
          // 何の%かは切替で変わる。数字だけだと達成率と前年比を取り違える
          ach == null ? null : el("span", { class: "hint", style: "font-size:10.5px", text: C.rate }),
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
    // 昨年のデータが無くても押せるままにする。押せないボタンは、スマホだと理由を出す
    // 場所（ツールチップ）が無くて「壊れている」ようにしか見えない。押したら理由を出す。
    cmpChips.appendChild(el("button", {
      class: "btn sm ghost", "data-cmp": c.id, text: c.label,
      onclick: () => { cmp = c.id; draw(); },
    }));
  }
  draw();
}

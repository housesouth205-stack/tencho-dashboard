// 経費タブ。会議資料からの月次データ（pl_month）を見る画面。
// 「経費のどこが動いているか」と「その結果いくら残ったか」の2点に絞っている。
import { el, clear } from "../../util/dom.js";
import { repo } from "../../core/repo.js";
import { state } from "../../core/state.js";
import { waMonthLabel as monthLabel } from "../../util/dates.js";
import { stackedSga, kiguVsOp, k, kf } from "./charts.js";

const narrow = () => window.matchMedia("(max-width: 700px)").matches;
const pct = (v) => (v == null || !isFinite(v) ? "—" : (v * 100).toFixed(1) + "%");
const wa = (ym) => { const [y, m] = ym.split("-").map(Number); return { wy: y - 2018, month: m }; };

// 表示する費目の定義。ラベルはこの1か所だけ見ればよいようにまとめてある。
const SUB = [
  { key: "jinken", label: "人件費" },
  { key: "hanbai", label: "販売費" },
  { key: "tatemono", label: "建物管理費" },
  { key: "koukyou", label: "公共料金" },
  { key: "shokeihi", label: "一般諸経費" },
  { key: "genka", label: "減価償却費" },
];
const ITEM = [
  { key: "kigu", label: "入替代（消耗器具費）" },
  { key: "kyuyo", label: "給与" },
  { key: "yachin", label: "地代家賃" },
  { key: "suidou", label: "水道光熱費" },
  { key: "hoshu", label: "保守料" },
];

let range = "12"; // "12" = 直近12か月 / "all" = 全期間

export async function mount(host) {
  clear(host);
  host.appendChild(el("div", { class: "view-title" }, [
    el("h1", { text: "経費" }),
    el("small", { text: "会議資料（店舗別営業実績表）の月次データ" }),
  ]));

  let rows;
  try {
    rows = await repo.select("pl_month", { eq: { store_id: state.storeId, kind: "actual" }, order: "ym" });
  } catch (e) {
    host.appendChild(el("div", { class: "placeholder", text: "データを読めませんでした。通信を確認してください。" }));
    return;
  }
  rows = rows.filter((r) => r.ym).map((r) => ({ ...r, ym: String(r.ym).slice(0, 10) }));
  if (!rows.length) {
    host.appendChild(el("div", { class: "placeholder" }, [
      el("div", { text: "まだ月次のデータがありません。" }),
      el("div", { class: "hint", style: "margin-top:6px", text: "会議資料から作ったCSVを「取込」タブで読み込むとここに出ます。" }),
      el("div", { style: "margin-top:10px" }, el("button", { class: "btn sm", text: "取込タブへ", onclick: () => { location.hash = "import"; } })),
    ]));
    return;
  }

  const body = el("div", { class: "col" });
  const ctrl = el("div", { class: "row", style: "gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px" });
  const chip = (key, label) => el("button", {
    class: "btn sm " + (range === key ? "primary" : "ghost"), text: label,
    onclick: () => { range = key; drawChips(); render(); },
  });
  const drawChips = () => {
    clear(ctrl);
    ctrl.appendChild(chip("12", "直近12か月"));
    ctrl.appendChild(chip("all", `全期間（${rows.length}か月）`));
  };
  drawChips();
  host.appendChild(ctrl);
  host.appendChild(body);

  function render() {
    clear(body);
    const items = buildMonths(rows, range === "12" ? 12 : 0);
    const shown = items.filter((it) => it.row).map((it) => it.row);
    const nw = narrow();
    body.appendChild(kpiCard(rows));
    body.appendChild(stackedSga(items, { title: "一般管理費の中身（下から 地代家賃・人件費・入替代・その他）", narrow: nw }));
    body.appendChild(kiguVsOp(items, { title: "入替代と営業利益", narrow: nw }));
    body.appendChild(findings(shown));
    body.appendChild(varianceTable(shown));
    body.appendChild(monthTable(items));
  }
  render();
}

// 月の並びを作る。資料の無い月は row=null のまま残して、抜けを抜けとして見せる。
function buildMonths(rows, lastN) {
  const byYm = new Map(rows.map((r) => [r.ym, r]));
  const last = rows[rows.length - 1].ym;
  const [ly, lm] = last.split("-").map(Number);
  let [sy, sm] = rows[0].ym.split("-").map(Number);
  if (lastN) {
    const back = new Date(ly, lm - 1 - (lastN - 1), 1);
    if (back > new Date(sy, sm - 1, 1)) { sy = back.getFullYear(); sm = back.getMonth() + 1; }
  }
  const out = [];
  for (let y = sy, m = sm; y < ly || (y === ly && m <= lm);) {
    const ym = `${y}-${String(m).padStart(2, "0")}-01`;
    out.push({ ym, ...wa(ym), row: byYm.get(ym) || null });
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

// 最新月の要点。前年同月がデータにあれば増減も出す。
function kpiCard(rows) {
  const cur = rows[rows.length - 1];
  const [y, m] = cur.ym.split("-").map(Number);
  const prev = rows.find((r) => r.ym === `${y - 1}-${String(m).padStart(2, "0")}-01`);

  const cell = (label, val, opt = {}) => {
    const diff = prev && opt.key && prev[opt.key] != null && val != null ? val - prev[opt.key] : null;
    // 経費は減ったほうが良い。利益は増えたほうが良い。良し悪しの向きを費目ごとに変える。
    const good = diff == null ? null : (opt.lowerIsBetter ? diff < 0 : diff > 0);
    return el("div", { style: "min-width:120px" }, [
      el("div", { class: "hint", text: label }),
      el("div", { style: `font-size:${opt.big ? 26 : 20}px;font-weight:800;line-height:1.25;` + (opt.color ? `color:${opt.color}` : ""),
        text: kf(val) }),
      el("div", { class: "hint", style: "font-size:11px" }, [
        el("span", { text: "千円" }),
        diff == null ? null : el("span", {
          style: `margin-left:8px;font-weight:700;color:${good ? "#2a78d6" : "#e34948"}`,
          text: `前年同月 ${diff >= 0 ? "+" : "−"}${Math.abs(k(diff)).toLocaleString("ja-JP")}`,
        }),
      ]),
    ]);
  };
  const opColor = cur.op == null ? null : cur.op < 0 ? "#e34948" : "#2a78d6";
  return el("div", { class: "card" }, [
    el("div", { class: "row", style: "align-items:baseline;gap:10px;flex-wrap:wrap" }, [
      el("div", { style: "font-weight:800;font-size:16px", text: `令和${y - 2018}年${m}月度` }),
      el("span", { class: "hint", text: prev ? "（前年同月と比較）" : "（前年同月のデータなし）" }),
    ]),
    el("div", { class: "row", style: "gap:22px;flex-wrap:wrap;margin-top:10px" }, [
      cell("営業利益", cur.op, { key: "op", big: true, color: opColor }),
      cell("売上総利益", cur.gross, { key: "gross" }),
      cell("一般管理費", cur.sga, { key: "sga", lowerIsBetter: true }),
      cell("うち入替代", cur.kigu, { key: "kigu", lowerIsBetter: true }),
      el("div", { style: "min-width:120px" }, [
        el("div", { class: "hint", text: "損益分岐の粗利率" }),
        el("div", { style: "font-size:20px;font-weight:800;line-height:1.25", text: pct(cur.sales ? cur.sga / cur.sales : null) }),
        el("div", { class: "hint", style: "font-size:11px", text: `実際の粗利率 ${pct(cur.sales ? cur.gross / cur.sales : null)}` }),
      ]),
    ]),
  ]);
}

// 期間の数字から自動で気づきを出す。文章を固定で書くと、月が進んだとき嘘になる。
function findings(rows) {
  const box = el("div", { class: "card col", style: "gap:6px" });
  box.appendChild(el("div", { style: "font-weight:700", text: "この期間で言えること" }));
  if (rows.length < 2) {
    box.appendChild(el("div", { class: "hint", text: "月が2つ以上そろうと、動いている費目を出します。" }));
    return box;
  }
  const rangeOf = (key) => {
    const v = rows.map((r) => r[key]).filter((x) => x != null);
    return v.length ? { min: Math.min(...v), max: Math.max(...v), width: Math.max(...v) - Math.min(...v) } : null;
  };
  const line = (t) => box.appendChild(el("div", { style: "font-size:13px" }, t));

  const sga = rangeOf("sga");
  const worst = SUB.map((s) => ({ ...s, r: rangeOf(s.key) })).filter((s) => s.r).sort((a, b) => b.r.width - a.r.width)[0];
  if (sga && worst) {
    line(`一般管理費は ${kf(sga.min)}〜${kf(sga.max)}千円（幅 ${kf(sga.width)}）で動いていて、いちばん動いた区分は「${worst.label}」（幅 ${kf(worst.r.width)}千円）です。`);
  }
  const kigu = rangeOf("kigu");
  if (kigu && sga && sga.width > 0) {
    line(`入替代だけで幅 ${kf(kigu.width)}千円。一般管理費の振れ幅の ${Math.round((kigu.width / sga.width) * 100)}% を占めます。`);
  }
  const yachin = rangeOf("yachin");
  if (yachin && yachin.width === 0) line(`地代家賃は毎月 ${kf(yachin.min)}千円で固定。ここは動かせません。`);

  const red = rows.filter((r) => r.op != null && r.op < 0);
  if (red.length) {
    const names = red.map((r) => monthLabel(r.ym)).join("・");
    const avgG = rows.reduce((a, r) => a + (r.gross || 0), 0) / rows.length;
    const lowGross = red.filter((r) => (r.gross || 0) < avgG).length;
    line(`営業赤字は ${red.length}か月（${names}）。うち ${lowGross}か月は粗利が期間平均を下回っています。`);
  } else {
    line("この期間に営業赤字の月はありません。");
  }
  return box;
}

// 費目ごとの月平均と振れ幅。「どこを見ればいいか」を先に出す表。
function varianceTable(rows) {
  const stat = (key) => {
    const v = rows.map((r) => r[key]).filter((x) => x != null);
    if (!v.length) return null;
    const avg = v.reduce((a, b) => a + b, 0) / v.length;
    return { avg, min: Math.min(...v), max: Math.max(...v), width: Math.max(...v) - Math.min(...v) };
  };
  const totAvg = stat("sga")?.avg || 0;
  // スマホは横スクロールさせたくないので、最小・最大を落として4列にする。
  // 判断に効くのは「平均」と「振れ幅」なので、削るならこの2つ。
  const slim = narrow();
  const t = el("table", { class: "grid compact" });
  const head = [el("th", { class: "txt", text: "費目" }), el("th", { text: "月平均" })];
  if (!slim) head.push(el("th", { text: "最小" }), el("th", { text: "最大" }));
  head.push(el("th", { text: "振れ幅" }), el("th", { text: "構成比" }));
  t.appendChild(el("thead", {}, el("tr", {}, head)));
  const tb = el("tbody");
  const put = (label, st, bold) => {
    if (!st) return;
    const tds = [
      el("td", { class: "txt", style: bold ? "font-weight:700" : "", text: label }),
      el("td", { style: bold ? "font-weight:700" : "", text: kf(st.avg) }),
    ];
    if (!slim) tds.push(el("td", { text: kf(st.min) }), el("td", { text: kf(st.max) }));
    tds.push(el("td", { style: "font-weight:700", text: kf(st.width) }),
             el("td", { text: totAvg ? pct(st.avg / totAvg) : "—" }));
    tb.appendChild(el("tr", {}, tds));
  };
  for (const s of SUB) put(s.label, stat(s.key));
  put("一般管理費 合計", stat("sga"), true);
  tb.appendChild(el("tr", {}, el("td", { colspan: head.length, class: "txt hint", style: "background:var(--panel-2)", text: "内訳（上の区分の内数）" })));
  for (const i of ITEM) put(i.label, stat(i.key));
  t.appendChild(tb);
  return el("div", { class: "card col", style: "gap:8px" }, [
    el("div", { style: "font-weight:700", text: "費目ごとの月平均と振れ幅（千円）" }),
    el("div", { class: "hint", text: "振れ幅が大きい費目ほど、月ごとの利益を左右します。" }),
    el("div", { class: "table-wrap" }, t),
  ]);
}

// 月ごとの数字。会議資料の紙とそのまま突き合わせられるよう千円のまま出す。
function monthTable(items) {
  const t = el("table", { class: "grid compact" });
  const cols = narrow()
    ? [["月度", "txt"], ["粗利", ""], ["経費", ""], ["入替代", ""], ["営業利益", ""]]
    : [["月度", "txt"], ["総売上高", ""], ["売上総利益", ""], ["一般管理費", ""], ["うち入替代", ""], ["営業利益", ""], ["粗利率", ""], ["損益分岐粗利率", ""]];
  t.appendChild(el("thead", {}, el("tr", {}, cols.map(([h, c]) => el("th", { class: c, text: h })))));
  const tb = el("tbody");
  for (const it of items) {
    const r = it.row;
    if (!r) {
      tb.appendChild(el("tr", {}, [
        el("td", { class: "txt", text: monthLabel(it.ym) }),
        el("td", { colspan: cols.length - 1, class: "txt hint", text: "資料なし" }),
      ]));
      continue;
    }
    const opCell = el("td", { style: r.op != null && r.op < 0 ? "color:#e34948;font-weight:700" : "", text: kf(r.op) });
    tb.appendChild(el("tr", {}, narrow()
      ? [el("td", { class: "txt", text: monthLabel(it.ym) }), el("td", { text: kf(r.gross) }), el("td", { text: kf(r.sga) }), el("td", { text: kf(r.kigu) }), opCell]
      : [el("td", { class: "txt", text: monthLabel(it.ym) }), el("td", { text: kf(r.sales) }), el("td", { text: kf(r.gross) }),
         el("td", { text: kf(r.sga) }), el("td", { text: kf(r.kigu) }), opCell,
         el("td", { text: pct(r.sales ? r.gross / r.sales : null) }), el("td", { text: pct(r.sales ? r.sga / r.sales : null) })]));
  }
  t.appendChild(tb);
  return el("div", { class: "card col", style: "gap:8px" }, [
    el("div", { style: "font-weight:700", text: "月ごとの数字（千円）" }),
    el("div", { class: "hint", text: "会議資料と同じ千円表示。損益分岐粗利率＝一般管理費÷総売上高で、粗利率がこれを下回った月が営業赤字です。" }),
    el("div", { class: "table-wrap" }, t),
  ]);
}

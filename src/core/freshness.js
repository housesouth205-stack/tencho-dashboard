// データが古くなっていないかを見張って、開いた瞬間に気づける場所（タブの直下）に出す。
// 自動で取り込む仕組みは作らない。「サボると画面が言ってくる」だけにして、
// 仕組み自体が壊れて気づけなくなる状態を避ける。
import { repo } from "./repo.js";
import { state } from "./state.js";
import { el } from "../util/dom.js";

// 経過日数のしきい値。超えたら注意(warn)・警告(bad)。運用に合わせてここだけ触ればよい。
const RULES = {
  actual: { warn: 2, bad: 4, label: "日次実績", tab: "yojitsu", hint: "予実タブで入力" },
  snapshot: { warn: 14, bad: 21, label: "台別CSV", tab: "import", hint: "取込タブでCSVを取込" },
};

const DAY = 86400000;
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// 日付だけで差を取る（時刻やタイムゾーンで1日ずれないようローカル日付に丸める）。
function daysAgo(dateLike) {
  if (!dateLike) return null;
  const s = String(dateLike).slice(0, 10);
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  const then = new Date(y, m - 1, d);
  const today = new Date();
  return Math.floor((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - then) / DAY);
}

const levelOf = (lag, rule) => (lag == null ? "none" : lag >= rule.bad ? "bad" : lag >= rule.warn ? "warn" : "ok");

export async function loadFreshness() {
  const eq = { store_id: state.storeId };
  // 取得に失敗したらここで投げる。空配列で代用すると「未取込」と表示され、
  // 実際は接続できていないだけなのに一度も取り込んでいないように見えてしまう。
  const [periods, actuals] = await Promise.all([
    repo.select("snapshot_period", { eq, order: ["created_at", "desc"], limit: 1 }),
    repo.select("actual_day", { eq, order: ["ymd", "desc"], limit: 1 }),
  ]);
  const items = [
    { key: "actual", date: actuals[0]?.ymd || null },
    { key: "snapshot", date: periods[0]?.created_at || null },
  ];
  return items.map((it) => {
    const rule = RULES[it.key];
    const lag = daysAgo(it.date);
    return { ...it, rule, lag, level: levelOf(lag, rule) };
  });
}

function chip(item) {
  const { rule, lag, level, date } = item;
  const COLOR = { ok: "var(--fg-dim)", warn: "#c77700", bad: "var(--accent)", none: "var(--fg-dim)" };
  const mark = { ok: "", warn: "⚠ ", bad: "⚠ ", none: "" }[level];
  const text = lag == null
    ? `${rule.label}: 未取込`
    : `${rule.label}: ${String(date).slice(5, 10).replace("-", "/")}（${lag === 0 ? "今日" : lag + "日前"}）`;
  return el("button", {
    class: "btn sm ghost",
    style: `color:${COLOR[level]};${level === "bad" ? "border-color:var(--accent);font-weight:700" : ""}`,
    title: `${rule.hint}（${rule.warn}日で注意 / ${rule.bad}日で警告）`,
    text: mark + text,
    onclick: () => { location.hash = rule.tab; },
  });
}

// タブとビューの間に差し込む。問題が無いときは目立たないよう淡色1行で出す。
export async function mountFreshnessBar(host) {
  const bar = el("div", {
    id: "freshnessBar", class: "row",
    style: "gap:6px;align-items:center;flex-wrap:wrap;padding:4px 12px;font-size:12px",
  });
  host.appendChild(bar);
  try {
    const items = await loadFreshness();
    for (const it of items) bar.appendChild(chip(it));
    const worst = items.some((i) => i.level === "bad") ? "bad"
      : items.some((i) => i.level === "warn") ? "warn" : "ok";
    if (worst !== "ok") {
      bar.appendChild(el("span", {
        style: "color:var(--fg-dim)",
        text: worst === "bad" ? "データが古いままです" : "そろそろ更新を",
      }));
    }
  } catch {
    bar.remove(); // 鮮度表示のためにアプリ全体を止めない
  }
  return bar;
}

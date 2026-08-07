// 入替効果の測定。2つのスナップショット期間を台番で突き合わせ、機種が変わった台
// （入替台）と変わっていない台（据置台）に分けて、前後の変化を比べる。
//
// 単純に「入替台の粗利が増えた」だけでは判断できない。全体が上向きの月なら
// 何を入れても増えるため、同じ期間の据置台の変化を差し引いた「正味効果」で見る。
//   正味効果 = 入替台の平均変化 − 据置台の平均変化
// 水準がレートごとに違うので、比較は必ず同じレートの中で行う。
import { sameModel } from "../util/format.js";
import { rateKeyOfDai } from "../core/config.js";

export const METRICS = [["out_val", "アウト"], ["sales", "台売上"], ["gross", "台粗利"]];

const val = (r, m) => {
  const v = r?.[m];
  return v == null || isNaN(v) ? null : Number(v);
};

// 前後の期間に共通して存在する台だけを対象にする（増台・撤去台は効果測定の対象外）。
export function splitSwaps(prevRows, curRows) {
  const prev = new Map(prevRows.map((r) => [r.dai_no, r]));
  const swapped = [], kept = [];
  for (const cur of curRows) {
    const p = prev.get(cur.dai_no);
    if (!p || !p.model_name || !cur.model_name) continue;
    const pair = { dai_no: cur.dai_no, rate: rateKeyOfDai(cur.dai_no), prev: p, cur };
    (sameModel(p.model_name, cur.model_name) ? kept : swapped).push(pair);
  }
  return { swapped, kept };
}

// 指標ごとの平均変化。前後どちらかが欠けている台はその指標から除く。
function meanDelta(pairs, metric) {
  const ds = [];
  for (const p of pairs) {
    const a = val(p.prev, metric), b = val(p.cur, metric);
    if (a == null || b == null) continue;
    ds.push(b - a);
  }
  return ds.length ? { mean: ds.reduce((x, y) => x + y, 0) / ds.length, n: ds.length } : { mean: null, n: 0 };
}

// レート単位の集計。据置台の変化をベースラインにして正味効果を出す。
export function summarize(swapped, kept) {
  const rates = [...new Set([...swapped, ...kept].map((p) => p.rate).filter(Boolean))];
  const byRate = new Map();
  for (const rate of rates) {
    const sw = swapped.filter((p) => p.rate === rate);
    const kp = kept.filter((p) => p.rate === rate);
    const m = {};
    for (const [key] of METRICS) {
      const s = meanDelta(sw, key), k = meanDelta(kp, key);
      m[key] = {
        swap: s.mean, kept: k.mean,
        net: s.mean == null || k.mean == null ? null : s.mean - k.mean,
      };
    }
    byRate.set(rate, { rate, swapCount: sw.length, keptCount: kp.length, metrics: m });
  }
  return byRate;
}

// 台ごとの正味効果（同じレートの据置台の平均変化を差し引いた値）。
export function netByDai(swapped, byRate, metric = "gross") {
  return swapped.map((p) => {
    const a = val(p.prev, metric), b = val(p.cur, metric);
    const base = byRate.get(p.rate)?.metrics[metric]?.kept;
    const delta = a == null || b == null ? null : b - a;
    return {
      ...p,
      prevModel: p.prev.model_name, curModel: p.cur.model_name,
      prevVal: a, curVal: b, delta,
      net: delta == null || base == null ? null : delta - base,
    };
  });
}

// 入替後の機種ごとにまとめる（同じ機種を複数台入れた場合の総合評価）。
export function byNewModel(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = r.curModel;
    if (!map.has(key)) map.set(key, { model: key, rate: r.rate, dai: [], nets: [], curs: [] });
    const g = map.get(key);
    g.dai.push(r.dai_no);
    if (r.net != null) g.nets.push(r.net);
    if (r.curVal != null) g.curs.push(r.curVal);
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return [...map.values()]
    .map((g) => ({ ...g, count: g.dai.length, netAvg: avg(g.nets), curAvg: avg(g.curs) }))
    .sort((a, b) => (b.netAvg ?? -Infinity) - (a.netAvg ?? -Infinity));
}

// 島図の階の並び順。
//
// もとは各画面が [...new Set(layout.map((l) => l.floor))] で階を拾っていた。
// これは「データが返ってきた順」であって、順番をどこでも決めていない。
// layout_cell の読み込みには order を付けていないので、並びはデータベース任せ。
// 島図を取り込み直すと「全削除→入れ直し」で行の物理順が変わるため、
// 同じ店なのに1FとBFが入れ替わって表示された（実際に起きた）。
//
// 建物と同じで上の階から下に並べる。1F → BF。地下が複数あれば深いほうが下。
const RANK = (label) => {
  const s = String(label || "").trim().toUpperCase();
  const b = s.match(/^B(\d*)F?$/);           // BF / B1F / B2F
  if (b) return -(Number(b[1] || 1));
  const a = s.match(/^(\d+)F$/);             // 1F / 2F
  if (a) return Number(a[1]);
  return 0;                                   // 読めない表記は地上と地下の間に置く
};

export const floorRank = RANK;

// layout から階を取り出して「上から下」に並べる。同じ順位のものは元の順を保つ。
export function floorsOf(layout) {
  const seen = [...new Set((layout || []).map((l) => l.floor))];
  return seen
    .map((fl, i) => ({ fl, i, rank: RANK(fl) }))
    .sort((x, y) => y.rank - x.rank || x.i - y.i)
    .map((o) => o.fl);
}

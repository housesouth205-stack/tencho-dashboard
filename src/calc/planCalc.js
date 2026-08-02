// 計画: 入力=台あたりアウト・単価(コイン/玉)・粗利率 → 総アウト・売上・粗利を算出。
export function planCalc(plan, count) {
  const out = num(plan?.out_per_unit), price = num(plan?.unit_price), rate = num(plan?.gross_rate), c = num(count);
  const outTotal = out * c;
  const sales = outTotal * price;
  const gross = sales * rate;
  return { outTotal, sales, gross };
}
const num = (v) => (v == null || v === "" || isNaN(v) ? 0 : Number(v));

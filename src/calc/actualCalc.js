// 実績: 入力=売上・粗利・台あたりアウト → 総アウト・単価・粗利率を逆算。
export function actualCalc(actual, count) {
  const sales = num(actual?.sales), gross = num(actual?.gross), out = num(actual?.out_per_unit), c = num(count);
  const outTotal = out * c;
  const unitPrice = outTotal ? sales / outTotal : 0;
  const grossRate = sales ? gross / sales : 0;
  return { outTotal, sales, gross, unitPrice, grossRate };
}
const num = (v) => (v == null || v === "" || isNaN(v) ? 0 : Number(v));

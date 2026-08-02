// ポスター描画エンジン。画像を全面に敷き、極太アウトライン見出し＋下部に日付/機種を重ねる。B1縦(728:1030)。
const WD = ["日", "月", "火", "水", "木", "金", "土"];
const FONT = '"Hiragino Kaku Gothic ProN","Meiryo","MS PGothic",sans-serif';

function fmtDate(dstr, time) {
  if (!dstr) return "";
  const d = new Date(dstr);
  if (isNaN(d)) return dstr;
  return `${d.getMonth() + 1}.${d.getDate()}(${WD[d.getDay()]})` + (time ? ` ${time}` : "");
}
function fitFont(ctx, text, maxW, startPx, weight = 900) {
  let px = startPx;
  do { ctx.font = `${weight} ${px}px ${FONT}`; if (!text || ctx.measureText(text).width <= maxW) break; px -= Math.max(2, px * 0.04); } while (px > 8);
  return px;
}
function drawCover(ctx, img, x, y, w, h) {
  const ir = img.width / img.height, r = w / h;
  let sw, sh, sx, sy;
  if (ir > r) { sh = img.height; sw = sh * r; sx = (img.width - sw) / 2; sy = 0; }
  else { sw = img.width; sh = sw / r; sx = 0; sy = (img.height - sh) / 2; }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
// 縁取り文字（極太アウトライン）
function outline(ctx, text, x, y, px, fill, stroke, lwRatio = 0.14, weight = 900) {
  ctx.font = `${weight} ${px}px ${FONT}`; ctx.lineJoin = "round"; ctx.miterLimit = 2;
  ctx.strokeStyle = stroke; ctx.lineWidth = px * lwRatio; ctx.strokeText(text, x, y);
  ctx.fillStyle = fill; ctx.fillText(text, x, y);
}
function drawMachines(ctx, machines, x, y, w, maxH, color, sub) {
  const rows = machines.filter((m) => m.name);
  if (!rows.length) return;
  const lh = maxH / rows.length;
  let px = Math.max(13, Math.min(w * 0.045, lh * 0.62));
  ctx.textBaseline = "middle";
  rows.forEach((m, i) => {
    const cy = y + lh * (i + 0.5);
    ctx.font = `700 ${px}px ${FONT}`; ctx.fillStyle = color; ctx.textAlign = "left";
    let name = m.name;
    while (ctx.measureText(name).width > w * 0.78 && name.length > 4) name = name.slice(0, -1);
    if (name !== m.name) name += "…";
    ctx.fillText(name, x, cy);
    ctx.textAlign = "right"; ctx.fillStyle = sub; ctx.font = `800 ${px}px ${FONT}`;
    ctx.fillText(`${m.count ?? ""}台`, x + w, cy);
  });
}

export function drawPoster(canvas, data) {
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  const M = W * 0.05;
  const dateStr = fmtDate(data.date, data.time);
  const headline = data.headline || "新装開店";
  const white = data.template === "white";

  // 背景（全面画像）
  ctx.fillStyle = white ? "#f7f2e8" : "#0a0a0d";
  ctx.fillRect(0, 0, W, H);
  if (data.image) drawCover(ctx, data.image, 0, 0, W, H);
  else if (!white) { const g = ctx.createRadialGradient(W / 2, H * 0.42, 0, W / 2, H * 0.42, W * 0.8); g.addColorStop(0, "rgba(60,80,120,.4)"); g.addColorStop(1, "rgba(10,10,13,0)"); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); }

  if (white) {
    // 白系: 上下に白帯を敷いて文字を載せる
    ctx.fillStyle = "rgba(255,255,255,.78)"; ctx.fillRect(0, 0, W, H * 0.2);
    ctx.fillStyle = "rgba(255,255,255,.9)"; ctx.fillRect(0, H * 0.7, W, H * 0.3);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    // 新装開店 帯
    const bh = H * 0.08;
    ctx.fillStyle = "#111"; roundRect(ctx, M, H * 0.03, W - 2 * M, bh, bh * 0.16); ctx.fill();
    ctx.strokeStyle = "#e3b23c"; ctx.lineWidth = W * 0.006; roundRect(ctx, M + 6, H * 0.03 + 6, W - 2 * M - 12, bh - 12, bh * 0.14); ctx.stroke();
    outline(ctx, headline, W / 2, H * 0.03 + bh / 2, bh * 0.6, "#fff", "#000", 0.05);
    if (data.subtitle) { ctx.fillStyle = "#333"; ctx.font = `800 ${fitFont(ctx, data.subtitle, W * 0.8, H * 0.036, 800)}px ${FONT}`; ctx.fillText(data.subtitle, W / 2, H * 0.16); }
    if (dateStr) outline(ctx, dateStr + " 導入", W / 2, H * 0.75, fitFont(ctx, dateStr + " 導入", W * 0.85, H * 0.05, 900), "#e5121b", "#fff", 0.08);
    badges(ctx, data.badges, M, H * 0.63, W);
    ctx.fillStyle = "#333"; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; ctx.font = `800 ${H * 0.022}px ${FONT}`; ctx.fillText("導入機種", M, H * 0.81);
    drawMachines(ctx, data.machines || [], M, H * 0.815, W - 2 * M, H * 0.16, "#1a1a1a", "#e5121b");
    return;
  }

  // 黒系(全面ヒーロー): 上下スクリム
  let sg = ctx.createLinearGradient(0, 0, 0, H * 0.36); sg.addColorStop(0, "rgba(0,0,0,.82)"); sg.addColorStop(1, "rgba(0,0,0,0)"); ctx.fillStyle = sg; ctx.fillRect(0, 0, W, H * 0.36);
  sg = ctx.createLinearGradient(0, H * 0.5, 0, H); sg.addColorStop(0, "rgba(0,0,0,0)"); sg.addColorStop(0.55, "rgba(0,0,0,.75)"); sg.addColorStop(1, "rgba(0,0,0,.95)"); ctx.fillStyle = sg; ctx.fillRect(0, H * 0.5, W, H * 0.5);

  ctx.textAlign = "center";
  // 店名
  if (data.store) { ctx.textBaseline = "top"; ctx.fillStyle = "#dcdcdc"; ctx.font = `700 ${H * 0.02}px ${FONT}`; ctx.fillText(data.store, W / 2, H * 0.028); }
  // サブ見出し（シリーズ名等）
  ctx.textBaseline = "alphabetic";
  if (data.subtitle) outline(ctx, data.subtitle, W / 2, H * 0.1, fitFont(ctx, data.subtitle, W * 0.86, H * 0.05, 800), "#fff", "#000", 0.08, 800);
  // 見出し（極太・全面）
  const hlPx = fitFont(ctx, headline, W * 0.92, H * 0.14, 900);
  outline(ctx, headline, W / 2, H * 0.1 + (data.subtitle ? H * 0.05 : 0) + hlPx * 0.9, hlPx, "#fff", "#0a0a0d", 0.16);

  // 日付（下部・大・赤下線）
  if (dateStr) {
    const dy = H * 0.85;
    const dPx = fitFont(ctx, dateStr, W * 0.7, H * 0.06, 900);
    outline(ctx, dateStr, W / 2, dy, dPx, "#fff", "#000", 0.1);
    ctx.textBaseline = "middle";
    outline(ctx, "新装開店", W / 2, dy + dPx * 0.75, dPx * 0.7, "#ffd24a", "#7a1c00", 0.12, 900);
    ctx.fillStyle = "#e5121b"; ctx.fillRect(W / 2 - W * 0.18, dy + dPx * 0.16, W * 0.36, H * 0.004);
  }
  // 機種リスト（最下部）
  ctx.textBaseline = "alphabetic"; ctx.textAlign = "left"; ctx.fillStyle = "#f5b301"; ctx.font = `800 ${H * 0.02}px ${FONT}`;
  ctx.fillText("導入機種", M, H * 0.905);
  drawMachines(ctx, data.machines || [], M, H * 0.91, W - 2 * M, H * 0.075, "#ffe8a3", "#fff");
}

function badges(ctx, list, x, y, W) {
  (list || []).slice(0, 3).forEach((b, i) => {
    const r = W * 0.075, bx = x + r + i * (r * 2.3), by = y;
    ctx.beginPath(); ctx.arc(bx, by, r, 0, 7); ctx.fillStyle = ["#e5121b", "#2f7d32", "#1565c0"][i % 3]; ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = r * 0.08; ctx.stroke();
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#fff";
    ctx.font = `900 ${fitFont(ctx, b, r * 1.5, r * 0.5, 900)}px ${FONT}`; ctx.fillText(b, bx, by);
  });
}

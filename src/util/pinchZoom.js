import { el } from "./dom.js";

// スマホ向けのピンチズーム＋ドラッグ移動。
//
// 位置合わせは transform（translate + scale）だけで行う。以前はスクロール位置を
// 補正する方式だったが、コンテナのpadding分のずれやiOSのジェスチャ中のスクロール
// 制御と噛み合わず、指の位置ではなく左上を基準に拡大しているように見えていた。
// transformなら焦点の計算がそのまま画面座標になるため、指の間を中心に正確に拡大できる。
//
// container: 表示枠（overflow:hidden にする）。content: 実寸のまま置いた中身。
export function attachPinchZoom(container, content, opts = {}) {
  const min = opts.min ?? 0.5;
  const max = opts.max ?? 4;
  // transform の影響を受けない実寸（offsetサイズ）を基準にする
  const natW = content.offsetWidth;
  const natH = content.offsetHeight;

  const cs0 = getComputedStyle(container);
  const px = (v) => parseFloat(v) || 0;
  const padT = px(cs0.paddingTop), padL = px(cs0.paddingLeft);
  const padY = padT + px(cs0.paddingBottom), padX = padL + px(cs0.paddingRight);
  const bordT = px(cs0.borderTopWidth), bordL = px(cs0.borderLeftWidth);
  const bordY = bordT + px(cs0.borderBottomWidth);
  const borderBox = cs0.boxSizing === "border-box";

  // 移動・拡大を担当するラッパ。content自体には触らない。
  // 枠の余白のぶん内側から始める。top:0 にすると余白を飛び越えて枠線に張り付き、
  // 一番上の行が丸角で欠けて見えていた。
  const pane = document.createElement("div");
  pane.style.cssText = `position:absolute;top:${padT}px;left:${padL}px;transform-origin:0 0;will-change:transform`;
  container.insertBefore(pane, content);
  pane.appendChild(content);
  if (cs0.position === "static") container.style.position = "relative";
  container.style.overflow = "hidden";
  container.style.touchAction = "none"; // 実際の値は apply() が倍率に応じて決める
  container.style.overscrollBehavior = "contain";

  // autoHeight: 枠の高さを中身に合わせる。固定高だと縮小したとき地図の下に
  // 空きスペースが残るため。拡大時は初期の高さ（64vh など）を上限にする。
  // 高さは「中身の高さ」で扱い、余白ぶんは setContentH の中で足す。
  const maxContentH = container.clientHeight - padY;
  const setContentH = (h) => { container.style.height = (borderBox ? h + padY + bordY : h) + "px"; };

  let scale = 1, tx = 0, ty = 0;
  const viewW = () => container.clientWidth - padX;
  const viewH = () => container.clientHeight - padY;
  const fitScale = () => viewW() / natW;
  // いちばん縮めた状態＝横幅にぴったり合う倍率。これより小さくしても余白が
  // 増えるだけで読みにくくなるため、下限をここに置く。
  const lowest = () => Math.min(1, fitScale());

  // はみ出さない範囲に位置を収める。収まるときは中央（縦は上詰め）に置く。
  function clampPos() {
    const w = natW * scale, h = natH * scale;
    tx = w <= viewW() ? (viewW() - w) / 2 : Math.min(0, Math.max(viewW() - w, tx));
    ty = h <= viewH() ? 0 : Math.min(0, Math.max(viewH() - h, ty));
  }
  // その向きに動かす余地があるか。全体表示のように中身が収まっているときは無い。
  const canPanX = () => natW * scale > viewW() + 1;
  const canPanY = () => natH * scale > viewH() + 1;

  function apply() {
    // 高さを先に決めてから位置を収める（clampPos が枠の高さを見るため）
    // fullHeight: 高さを打ち切らず中身のぶんだけ伸ばす。縦に長い表はこちらにすると
    // 枠の中で動かすのではなく、ページをそのまま縦スクロールして読める。
    if (opts.autoHeight) setContentH(opts.fullHeight ? Math.ceil(natH * scale) : Math.min(maxContentH, Math.ceil(natH * scale)));
    clampPos();
    pane.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    // 動かせない向きはブラウザに返す。そうしないと島図の上が「触っても何も
    // 起きない領域」になり、全体表示のときページのスクロールまで止まっていた。
    const x = canPanX(), y = canPanY();
    container.style.touchAction = x && y ? "none" : x ? "pan-y" : y ? "pan-x" : "auto";
    opts.onChange?.(scale);
    opts.onMove?.(tx, ty); // 再描画をまたいで見ている位置を保つために外へ渡す
  }

  // 焦点(コンテナ内の座標)を動かさずに拡大率を変える
  function zoomAt(next, fx, fy) {
    const s = Math.min(max, Math.max(lowest(), next));
    const cx = (fx - tx) / scale, cy = (fy - ty) / scale; // 焦点のコンテンツ座標
    scale = s;
    tx = fx - cx * scale; ty = fy - cy * scale;
    apply();
  }
  const centerZoom = (next) => zoomAt(next, viewW() / 2, viewH() / 2);
  // 枠の左上（余白の内側）を原点にした座標。ラッパの位置と揃える必要がある。
  const local = (x, y) => {
    const r = container.getBoundingClientRect();
    return [x - r.left - bordL - padL, y - r.top - bordT - padT];
  };

  // ---- タッチ操作: 1本指=移動 / 2本指=拡大縮小＋移動 ----
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const mid = (t) => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2];
  let drag = null, pinch = null;

  container.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) { drag = { x: e.touches[0].clientX, y: e.touches[0].clientY }; pinch = null; }
    else if (e.touches.length >= 2) { drag = null; pinch = { d: dist(e.touches) || 1, s: scale, m: mid(e.touches) }; }
  }, { passive: true });

  container.addEventListener("touchmove", (e) => {
    if (pinch && e.touches.length >= 2) {
      e.preventDefault();
      const [mx, my] = mid(e.touches);
      const [fx, fy] = local(mx, my);
      // 指の中心の移動ぶんも一緒に動かす（つまんだまま運べるように）
      const [pmx, pmy] = local(pinch.m[0], pinch.m[1]);
      tx += fx - pmx; ty += fy - pmy;
      pinch.m = [mx, my];
      zoomAt(pinch.s * (dist(e.touches) / pinch.d), fx, fy);
    } else if (drag && e.touches.length === 1) {
      const t = e.touches[0];
      const dx = t.clientX - drag.x, dy = t.clientY - drag.y;
      // 動かす向きに余地がなければ横取りしない（ページのスクロールに任せる）
      const x = canPanX(), y = canPanY();
      if (Math.abs(dy) > Math.abs(dx) ? !y : !x) { drag = null; return; }
      e.preventDefault();
      tx += x ? dx : 0; ty += y ? dy : 0;
      drag = { x: t.clientX, y: t.clientY };
      apply();
    }
  }, { passive: false });

  const endTouch = (e) => {
    if (e.touches.length === 0) { drag = null; pinch = null; }
    else if (e.touches.length === 1) { pinch = null; drag = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }
  };
  container.addEventListener("touchend", endTouch);
  container.addEventListener("touchcancel", endTouch);

  // iOS Safari対策: WebKit独自のgestureイベントを止めないと、ピンチがブラウザ側に
  // 取られてページ全体のズームや「タブ一覧」（ピンチインで発動）になってしまう。
  // 拡大処理そのものは上のtouchmoveで行うため、ここでは打ち消すだけにする。
  const killGesture = (e) => e.preventDefault();
  container.addEventListener("gesturestart", killGesture, { passive: false });
  container.addEventListener("gesturechange", killGesture, { passive: false });
  container.addEventListener("gestureend", killGesture, { passive: false });

  // PC（と検証時）用: Ctrl+ホイールはポインタ位置を中心に拡大
  container.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const [fx, fy] = local(e.clientX, e.clientY);
    zoomAt(scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1), fx, fy);
  }, { passive: false });

  // initial: "fit" で全体が収まる倍率から開始する
  scale = opts.initial === "fit" || opts.initial == null ? fitScale() : opts.initial;
  scale = Math.min(max, Math.max(lowest(), scale));
  // offset: 前回見ていた位置。設定を1台入れるたびに島図を作り直すので、
  // これがないと毎回左上（中央）へ戻ってしまう。
  if (opts.offset) { tx = opts.offset.x; ty = opts.offset.y; }
  apply();

  return {
    get scale() { return scale; },
    get natural() { return { w: natW, h: natH }; },
    get min() { return lowest(); },
    get max() { return max; },
    get offset() { return { x: tx, y: ty }; },
    zoomBy: (f) => centerZoom(scale * f),
    setScale: (s) => centerZoom(s),
    fitWidth: () => { scale = Math.min(max, Math.max(lowest(), fitScale())); ty = 0; apply(); },
    reset: () => centerZoom(1),
  };
}

// 操作バー（− スライダー ＋ 全体 倍率）付きでピンチズームを付ける。
// 島図タブと設定投入シミュレーターで同じ操作感にするための共通UI。
// container は既にDOMに入っていること（実寸を測るため）。バーは barHost に追加する。
export function mountZoomBar(barHost, container, content, opts = {}) {
  const label = el("span", { style: "min-width:40px;text-align:right;color:var(--fg-dim);font-size:12px" });
  const slider = el("input", { type: "range", min: 0, max: 1000, value: 0, style: "flex:1;min-width:80px" });
  const ref = { z: null };
  const toScale = (v) => ref.z.min * Math.pow(ref.z.max / ref.z.min, v / 1000);
  const toSlider = (s) => Math.round(1000 * Math.log(s / ref.z.min) / Math.log(ref.z.max / ref.z.min));
  slider.oninput = () => ref.z && ref.z.setScale(toScale(+slider.value));
  const btn = (t, fn) => el("button", { class: "btn sm ghost", style: "min-width:36px", text: t, onclick: () => ref.z && fn(ref.z) });

  barHost.appendChild(el("div", { class: "row", style: "gap:6px;align-items:center;margin-bottom:4px" }, [
    btn("−", (z) => z.zoomBy(1 / 1.25)), slider, btn("＋", (z) => z.zoomBy(1.25)),
    btn("全体", (z) => z.fitWidth()), label,
  ]));
  barHost.appendChild(el("div", { style: "font-size:11px;color:var(--fg-dim);margin-bottom:6px",
    text: opts.hint || "2本指でつまんだ位置を中心に拡大縮小・1本指で移動" }));

  ref.z = attachPinchZoom(container, content, {
    min: opts.min ?? 0.4, max: opts.max ?? 5, initial: opts.initial ?? "fit", autoHeight: opts.autoHeight ?? true,
    offset: opts.offset, onMove: opts.onMove, fullHeight: opts.fullHeight,
    onChange: (s) => {
      label.textContent = `${Math.round(s * 100)}%`;
      if (ref.z) slider.value = toSlider(s);
      opts.onChange?.(s);
    },
  });
  slider.value = toSlider(ref.z.scale);
  return ref.z;
}

import { el } from "./dom.js";

// スマホの2本指ピンチで中身を拡大縮小する。1本指のパンはブラウザ標準のスクロールに任せる。
// 実寸レイアウトは変えず transform: scale で見た目だけ拡大し、スクロール範囲は同倍率の
// sizer で確保する（グリッドを組み直さないので描画が崩れず、文字も滲まない）。
// container は overflow:auto、content はその直下の実体（呼び出し時に sizer で包む）。
export function attachPinchZoom(container, content, opts = {}) {
  const min = opts.min ?? 0.5;
  const max = opts.max ?? 4;
  // transform の影響を受けない実寸（offsetサイズ）を基準にする
  const natW = content.offsetWidth;
  const natH = content.offsetHeight;

  const sizer = document.createElement("div");
  container.insertBefore(sizer, content);
  sizer.appendChild(content);
  content.style.transformOrigin = "0 0";
  container.style.touchAction = "pan-x pan-y"; // 2本指ジェスチャは自前処理に回す
  container.style.overscrollBehavior = "contain";

  let scale = 1;

  // 横幅いっぱいに全体を収める倍率。広いフロアでは min より小さくなるので下限もここまで許す。
  const fitScale = () => (container.clientWidth - 16) / natW;

  // fx/fy = 画面座標の焦点。拡大前後で焦点が同じ台を指し続けるようスクロールを補正する。
  function set(next, fx, fy) {
    const s = Math.min(max, Math.max(Math.min(min, fitScale()), next));
    const r = container.getBoundingClientRect();
    const px = fx == null ? r.width / 2 : fx - r.left;
    const py = fy == null ? r.height / 2 : fy - r.top;
    const cx = (container.scrollLeft + px) / scale;
    const cy = (container.scrollTop + py) / scale;
    scale = s;
    content.style.transform = `scale(${s})`;
    sizer.style.width = `${natW * s}px`;
    sizer.style.height = `${natH * s}px`;
    container.scrollLeft = cx * s - px;
    container.scrollTop = cy * s - py;
    opts.onChange?.(s);
  }

  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  let base = null;   // touchイベント方式（Android/Chrome）
  let gbase = null;  // gestureイベント方式（iOS Safari）

  container.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) base = { d: dist(e.touches) || 1, s: scale };
  }, { passive: true });

  container.addEventListener("touchmove", (e) => {
    if (e.touches.length !== 2 || !base) return;
    e.preventDefault(); // 2本指のときだけページズーム/スクロールを止める
    if (gbase) return;  // iOSではgesturechange側で処理する（二重適用を避ける）
    const t = e.touches;
    set(base.s * (dist(t) / base.d), (t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2);
  }, { passive: false });

  const end = (e) => { if (e.touches.length < 2) base = null; };
  container.addEventListener("touchend", end);
  container.addEventListener("touchcancel", end);

  // iOS Safari対策: WebKit独自のgestureイベントを止めないと、ピンチがブラウザ側に
  // 取られてページ全体のズームや「タブ一覧」（ピンチインで発動）になってしまう。
  // touch-actionやtouchmoveのpreventDefaultだけでは防げないため、ここで明示的に潰す。
  container.addEventListener("gesturestart", (e) => {
    e.preventDefault();
    gbase = { s: scale };
  }, { passive: false });
  container.addEventListener("gesturechange", (e) => {
    e.preventDefault();
    if (gbase) set(gbase.s * e.scale, e.clientX, e.clientY);
  }, { passive: false });
  const gend = (e) => { e.preventDefault(); gbase = null; };
  container.addEventListener("gestureend", gend, { passive: false });

  // PC（と検証時）用: Ctrl+ホイールでも同じ操作ができる
  container.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    set(scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX, e.clientY);
  }, { passive: false });

  // initial: "fit" でフロア全体が収まる倍率から開始する
  set(opts.initial === "fit" || opts.initial == null ? fitScale() : opts.initial);

  return {
    get scale() { return scale; },
    get natural() { return { w: natW, h: natH }; },
    get min() { return Math.min(min, fitScale()); },
    get max() { return max; },
    zoomBy: (f) => set(scale * f),
    setScale: (s, fx, fy) => set(s, fx, fy),
    fitWidth: () => set(fitScale()),
    reset: () => set(1),
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
    text: opts.hint || "スライダー／2本指で拡大縮小・1本指で移動" }));

  ref.z = attachPinchZoom(container, content, {
    min: opts.min ?? 0.4, max: opts.max ?? 5, initial: opts.initial ?? "fit",
    onChange: (s) => {
      label.textContent = `${Math.round(s * 100)}%`;
      if (ref.z) slider.value = toSlider(s);
      opts.onChange?.(s);
    },
  });
  slider.value = toSlider(ref.z.scale);
  return ref.z;
}

import { initRouter } from "./core/router.js";
import { state } from "./core/state.js";
import { todayFiscalYear } from "./util/dates.js";
import { el } from "./util/dom.js";
import { currentSession, signIn, signOut, authErrorMessage } from "./core/auth.js";
import { mountFreshnessBar } from "./core/freshness.js";
import { authRequired, AUTH_EMAIL, STORE_NAME } from "./core/config.js";

function initFySelector() {
  const sel = document.getElementById("fySelect");
  if (sel.options.length) return; // 二重初期化防止
  const now = todayFiscalYear();
  for (let y = now + 1; y >= now - 3; y--) {
    sel.appendChild(el("option", { value: y, text: `${y}年度`, selected: y === state.fy ? "selected" : null }));
  }
  sel.addEventListener("change", (e) => {
    state.fy = Number(e.target.value);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

// ヘッダーにログアウトボタンを設置。
function addLogoutButton() {
  const bar = document.querySelector(".appbar");
  if (!bar || document.getElementById("logoutBtn")) return;
  bar.appendChild(el("button", {
    id: "logoutBtn", class: "btn ghost sm", text: "ログアウト", style: "margin-left:8px",
    onclick: async () => { try { await signOut(); } finally { location.reload(); } },
  }));
}

let appStarted = false;
function startApp() {
  if (appStarted) return;
  appStarted = true;
  document.getElementById("app").style.display = "";
  initFySelector();
  initRouter();
  if (authRequired()) addLogoutButton();
  // データが古いままになっていないかをタブ直下に常時表示（描画は待たない）
  const nav = document.getElementById("tabs");
  mountFreshnessBar(nav.parentNode.insertBefore(el("div"), nav.nextSibling));
}

// ログイン画面（パスワードのみ）。成功で onOk を呼ぶ。
function showLogin(onOk) {
  document.getElementById("app").style.display = "none";
  const existing = document.getElementById("loginBg");
  if (existing) existing.remove();

  const pw = el("input", {
    type: "password", placeholder: "パスワード", autocomplete: "current-password",
    style: "width:100%;padding:10px 12px;font-size:15px;border:1px solid var(--line);border-radius:8px;box-sizing:border-box",
  });
  const err = el("div", { style: "color:var(--bad,#e35d6a);font-size:13px;min-height:18px;margin-top:2px" });
  const btn = el("button", { class: "btn primary", style: "width:100%;padding:10px;font-size:15px", text: "ログイン" });

  const submit = async () => {
    if (!pw.value) { err.textContent = "パスワードを入力してください。"; return; }
    btn.disabled = true; btn.textContent = "ログイン中…"; err.textContent = "";
    try {
      await signIn(pw.value);
      bg.remove();
      onOk();
    } catch (e) {
      err.textContent = authErrorMessage(e);
      btn.disabled = false; btn.textContent = "ログイン";
      pw.select();
    }
  };
  btn.addEventListener("click", submit);
  pw.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

  const card = el("div", { style: "background:var(--panel,#fff);border:1px solid var(--line);border-radius:14px;padding:26px;width:min(360px,92vw);box-shadow:0 10px 40px rgba(20,24,33,.18)" }, [
    el("div", { style: "font-weight:800;font-size:18px", text: STORE_NAME + " 店長ダッシュボード" }),
    el("div", { class: "hint", style: "margin:4px 0 16px", text: "続けるにはログインしてください" }),
    el("label", { class: "lbl", text: "メール" }),
    el("div", { style: "font-size:13px;color:var(--fg-dim,#8a91a3);margin-bottom:12px", text: AUTH_EMAIL }),
    el("label", { class: "lbl", text: "パスワード" }),
    pw, err,
    el("div", { style: "height:12px" }),
    btn,
  ]);
  const bg = el("div", { id: "loginBg", style: "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:var(--bg,#f5f7fb);z-index:2000" }, card);
  document.body.appendChild(bg);
  setTimeout(() => pw.focus(), 50);
}

async function boot() {
  if (!authRequired()) { startApp(); return; }
  try {
    const s = await currentSession();
    if (s.ok) startApp();
    else showLogin(startApp);
  } catch {
    // Supabase接続不能などでも最低限ログイン画面を出す
    showLogin(startApp);
  }
}

boot();

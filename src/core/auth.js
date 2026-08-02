// 認証（フェーズB）: 1つの共有アカウントでログイン。RLSと合わせてデータを保護する。
import { getClient } from "./supabaseClient.js";
import { AUTH_EMAIL, authRequired } from "./config.js";

// 現在ログイン中か。認証不要構成なら常にok。
export async function currentSession() {
  if (!authRequired()) return { ok: true, bypass: true };
  const sb = await getClient();
  const { data } = await sb.auth.getSession();
  return { ok: !!data.session, session: data.session || null };
}

// パスワードのみでサインイン（メールは固定）。
export async function signIn(password) {
  const sb = await getClient();
  const { data, error } = await sb.auth.signInWithPassword({ email: AUTH_EMAIL, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const sb = await getClient();
  await sb.auth.signOut();
}

// エラーを日本語の分かりやすい文言へ。
export function authErrorMessage(e) {
  const m = String(e?.message || e || "");
  if (/Invalid login credentials/i.test(m)) return "パスワードが違います。";
  if (/Email not confirmed/i.test(m)) return "アカウントのメール確認が未完了です（Supabaseでユーザー作成時に確認済みにしてください）。";
  if (/network|fetch/i.test(m)) return "通信エラー。ネットワークを確認してください。";
  return "ログインに失敗しました：" + m;
}

// Supabase接続設定。空のままだとローカル保存(localStorage)で動作する。
// 本番: プロジェクト作成後に URL と anonキー を設定すると Supabase 接続に切替わる。
export const SUPABASE_URL = "https://ohnhtordgdjzdrhaeukz.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_RIuBFHINXFLzCkUB9yZcbg_Hm2yagYW";

// 単一店舗の固定ID（多店舗化まではこの値を全レコードに付与）。
export const STORE_ID = "toho-ikebukuro";
export const STORE_NAME = "TOHO池袋店";

export const FISCAL_START_MONTH = 4; // 会計年度の開始月

export const hasSupabase = () => !!(SUPABASE_URL && SUPABASE_ANON_KEY);

// ----- 認証（フェーズB）-----
// 公開配信ではanonキーが露出するため、1つの共有アカウントでログイン必須にする。
// 画面ではパスワードのみ入力（メールはこの固定値を使用）。
// 有効化前に Supabase の Authentication→Users で AUTH_EMAIL のアカウントを作成し、
// 0002_auth_rls.sql を実行して RLS を認証必須へ切替えること。
// 2026-08-02: 共有アカウント作成＋0002_auth_rls.sql実行済み → 認証を有効化。
// RLSフェーズB適用済みのため、falseに戻すとデータを読めなくなる点に注意。
export const AUTH_ENABLED = true;
// メールは分割保持（公開ソースに素のアドレスを残さないための軽い難読化）
export const AUTH_EMAIL = ["housesouth205", "gmail.com"].join("@");
export const authRequired = () => AUTH_ENABLED && hasSupabase();

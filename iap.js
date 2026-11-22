const path = require('path');
const fs = require('fs');
const {
  SignedDataVerifier,
  Environment,
  VerificationException,
  VerificationStatus,
} = require('@apple/app-store-server-library');
const db = require('./db');

// Xcodeの Signing & Capabilities で確認できるBundle ID（auth.jsと同じ値）。
const BUNDLE_ID = process.env.APPLE_BUNDLE_ID;

// App Store Connect の「App情報」に載っている数値のApple ID。
// FIX: Production環境の検証には必須（ライブラリ側もこれが無いとProduction検証で
// appAppleIdの不一致チェックが正しく行えない）。本番運用前に必ず.envへ設定すること。
const APP_APPLE_ID = process.env.APP_STORE_APP_ID ? Number(process.env.APP_STORE_APP_ID) : undefined;

// IAP_ENVIRONMENT: 'xcode' | 'live'
// - xcode: XcodeのStoreKit Configuration File(.storekit)でのローカルテスト専用。
//          このときだけApple証明書を使わずに検証をスキップする。
// - live : 実機での動作（Sandboxテスター購入 / TestFlight / 審査 / 本番の実購入）。
//          FIX: 以前は 'sandbox' か 'production' のどちらか一方だけを見る作りだった。
//          しかしAppleの公式ライブラリは「Productionに設定していたらSandbox取引を拒否」
//          「Sandboxに設定していたらProduction取引を拒否」という厳格な仕様のため、
//          固定でどちらかに決め打ちすると、
//            ・production固定 → 審査担当者のSandbox購入テストを弾く
//            ・sandbox固定    → 本番の実課金（一番大事なもの）を全部弾く
//          という致命的な問題が起きる。'live'のときは常にまずProductionとして検証し、
//          環境不一致(INVALID_ENVIRONMENT)エラーが返ってきた場合だけSandboxとして
//          再検証するフォールバック方式にする。
function resolveEnvironment() {
  return process.env.IAP_ENVIRONMENT === 'xcode' ? Environment.XCODE : 'live';
}
const CONFIGURED_ENVIRONMENT = resolveEnvironment();

// App Store Connectで作成した商品IDと必ず一致させること（Swift側 StoreManager.swift と同じ値）。
// FIX: 以前のデフォルト値 'com.yourteam.goalpace.monthly' はクライアントの
// 'com.uuto.GoalPace.monthly' と食い違っており、このままだと購入検証が
// 必ず UNKNOWN_PRODUCT_ID で失敗する。本番では必ず環境変数で明示的に上書きすること。
const MONTHLY_PRODUCT_ID = process.env.IAP_MONTHLY_PRODUCT_ID || 'com.uuto.GoalPace.monthly';
// NEW: 年額サブスクリプションを追加。デフォルト値はクライアント(StoreManager.swift)の
// yearlyProductID と合わせてある。App Store Connect側のProduct IDが違う場合は
// 必ず .env の IAP_YEARLY_PRODUCT_ID で上書きすること（合っていないとMONTHLYと同様に
// UNKNOWN_PRODUCT_ID で購入検証が全部失敗する）。
const YEARLY_PRODUCT_ID = process.env.IAP_YEARLY_PRODUCT_ID || 'com.uuto.GoalPace.yearly';
const LIFETIME_PRODUCT_ID = process.env.IAP_LIFETIME_PRODUCT_ID || 'com.uuto.GoalPace.lifetime';

// 月額・年額はどちらも「有効期限のある自動更新サブスクリプション」という点で
// 判定ロジックが完全に同一なので、この配列にまとめて「サブスク系のproductIdか」を判定する。
const SUBSCRIPTION_PRODUCT_IDS = [MONTHLY_PRODUCT_ID, YEARLY_PRODUCT_ID];

// Appleのルート証明書(.cer)をこのディレクトリに置く。
// 取得元: https://www.apple.com/certificateauthority/
// 「Apple Root CA - G3 Root」をダウンロードして server/certs/AppleRootCA-G3.cer として保存する。
// NOTE: Railway等にデプロイする場合、このファイルが.gitignoreされていないか、
// リポジトリにコミットされているか必ず確認すること（無いとサーバー起動のたびにエラーになる）。
const CERTS_DIR = path.join(__dirname, 'certs');

function loadRootCertificates() {
  if (!fs.existsSync(CERTS_DIR)) return [];
  return fs
    .readdirSync(CERTS_DIR)
    .filter((f) => f.endsWith('.cer'))
    .map((f) => fs.readFileSync(path.join(CERTS_DIR, f)));
}

// FIX: 以前は verifier を1個だけキャッシュしていたため、Production/Sandboxの
// 両方を同時に使い分けるフォールバック方式にできなかった。環境ごとに別々にキャッシュする。
const verifierCache = {};

function getVerifier(environment) {
  if (verifierCache[environment]) return verifierCache[environment];
  if (!BUNDLE_ID) throw new Error('APPLE_BUNDLE_ID is not set');

  const rootCerts = loadRootCertificates();
  if (rootCerts.length === 0 && environment !== Environment.XCODE) {
    throw new Error(
      'Apple root certificates not found in server/certs/*.cer. ' +
        'https://www.apple.com/certificateauthority/ から Apple Root CA - G3 を取得して配置してください。'
    );
  }
  if (environment === Environment.PRODUCTION && !APP_APPLE_ID) {
    throw new Error(
      'APP_STORE_APP_ID is not set. Production環境の検証にはApp Store Connectの数値App IDが必須です。'
    );
  }

  const verifier = new SignedDataVerifier(rootCerts, true, environment, BUNDLE_ID, APP_APPLE_ID);
  verifierCache[environment] = verifier;
  return verifier;
}

// FIX: 本体のフォールバックロジック。
// xcodeモードのときはそのまま、liveモードのときは
// 「Productionとして検証 → 環境不一致ならSandboxとして再検証」の順で試す。
async function verifyWithFallback(fn) {
  if (CONFIGURED_ENVIRONMENT === Environment.XCODE) {
    return fn(getVerifier(Environment.XCODE));
  }

  try {
    return await fn(getVerifier(Environment.PRODUCTION));
  } catch (err) {
    const isEnvironmentMismatch =
      err instanceof VerificationException && err.status === VerificationStatus.INVALID_ENVIRONMENT;
    if (!isEnvironmentMismatch) throw err;

    // Production側では「環境が違う」と言われただけなので、Sandboxとして再検証する。
    // ここでも失敗したら、それは正真正銘の検証エラーとしてそのまま呼び出し元に投げる。
    return fn(getVerifier(Environment.SANDBOX));
  }
}

// クライアント(StoreKit 2)から送られてきた signedTransactionInfo (JWS文字列) を
// Appleの署名チェーンで検証し、デコード済みのtransaction情報を返す。
// ここが「本当に課金したか」の照合の実体。
async function verifyTransaction(signedTransactionInfo) {
  return verifyWithFallback((v) => v.verifyAndDecodeTransaction(signedTransactionInfo));
}

// App Store Server Notifications V2 の signedPayload を検証してデコードする。
async function verifyNotification(signedPayload) {
  return verifyWithFallback((v) => v.verifyAndDecodeNotification(signedPayload));
}

// デコード済みtransactionの中身をもとに users テーブルを更新する共通処理。
// 戻り値はクライアントにそのまま返せる形。
async function applyTransactionToUser(userId, decodedTransaction) {
  const productId = decodedTransaction.productId;
  const originalTransactionId = decodedTransaction.originalTransactionId;

  if (![...SUBSCRIPTION_PRODUCT_IDS, LIFETIME_PRODUCT_ID].includes(productId)) {
    throw new Error('UNKNOWN_PRODUCT_ID: ' + productId);
  }
  if (!originalTransactionId) throw new Error('Transaction is missing originalTransactionId');

  await db.linkOriginalTransaction(userId, originalTransactionId);

  if (productId === LIFETIME_PRODUCT_ID) {
    // 返金(revocationDate)されていたら買い切りとして扱わない
    if (decodedTransaction.revocationDate) {
      return { isSubscribed: false, isLifetime: false, expiresDate: null };
    }
    await db.setLifetimeStatus(userId, productId);
    return { isSubscribed: false, isLifetime: true, expiresDate: null };
  }

  // NEW: 月額・年額をまとめて扱う。判定ロジック（有効期限・返金チェック）は
  // 期間の長さに関係なく同一のため、productId自体はDBにlatest_product_idとして
  // 保存しつつ、isSubscribedの判定は共通化する。
  if (SUBSCRIPTION_PRODUCT_IDS.includes(productId)) {
    const expirationMillis = Number(decodedTransaction.expiresDate);
    if (!Number.isFinite(expirationMillis) || expirationMillis <= 0) {
      throw new Error('Subscription transaction is missing a valid expiration date');
    }
    const isActive =
      !decodedTransaction.revocationDate &&
      expirationMillis > Date.now();
    const expiresAt = new Date(expirationMillis);
    await db.setSubscriptionStatus(userId, isActive, expiresAt, productId);
    return { isSubscribed: isActive, isLifetime: false, expiresDate: expiresAt ? expiresAt.toISOString() : null };
  }

  throw new Error('UNKNOWN_PRODUCT_ID: ' + productId);
}

module.exports = {
  verifyTransaction,
  verifyNotification,
  applyTransactionToUser,
  MONTHLY_PRODUCT_ID,
  YEARLY_PRODUCT_ID,
  LIFETIME_PRODUCT_ID,
};

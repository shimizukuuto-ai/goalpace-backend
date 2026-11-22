const { Pool } = require('pg');

// Railway/Render等が発行する DATABASE_URL をそのまま使う想定。
// ローカル開発では .env に DATABASE_URL=postgres://... を書くか、
// DATABASE_URL が無ければ DB機能自体を無効化してモックのまま動かす。
const DATABASE_URL = process.env.DATABASE_URL;

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    })
  : null;

const DB_ENABLED = !!pool;

async function initDb() {
  if (!DB_ENABLED) {
    console.warn('WARNING: DATABASE_URL is not set. Auth/billing features are disabled (dev mode).');
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      apple_user_id TEXT UNIQUE NOT NULL,
      is_subscribed BOOLEAN NOT NULL DEFAULT FALSE,
      subscription_expires_at TIMESTAMPTZ,
      is_lifetime BOOLEAN NOT NULL DEFAULT FALSE,
      original_transaction_id TEXT,
      latest_product_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // 既存DBへの追記用マイグレーション（新規作成時はCREATE TABLEで既に入っているのでno-op）
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_lifetime BOOLEAN NOT NULL DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS original_transaction_id TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS latest_product_id TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_original_transaction_id ON users (original_transaction_id);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      endpoint TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // NEW: SNSシェアによる本日の利用上限ボーナス。
  // (user_id, bonus_date) を主キーにすることで「1ユーザー・1日1回」を
  // DBレベルで保証する（ON CONFLICT DO NOTHINGで2回目以降の付与を防ぐ）。
  // bonus_date は「サーバーのタイムゾーンでの今日の日付」。usage_eventsの
  // today_count はローリング24時間窓だが、シェア特典は素朴に「暦日で1回」とした
  // （ユーザーから見て「今日もう一回シェアできる/できない」がわかりやすいため）。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS share_bonuses (
      user_id INTEGER NOT NULL REFERENCES users(id),
      bonus_date DATE NOT NULL DEFAULT CURRENT_DATE,
      amount INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, bonus_date)
    );
  `);

  console.log('DB initialized (users, usage_events, share_bonuses tables ready).');
}

// 過去24時間・過去30日の利用回数を数える。
async function getUsageCounts(userId) {
  const { rows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE created_at > now() - interval '1 day') AS today_count,
       count(*) FILTER (WHERE created_at > now() - interval '30 days') AS month_count
     FROM usage_events WHERE user_id = $1`,
    [userId]
  );
  return {
    todayCount: parseInt(rows[0].today_count, 10),
    monthCount: parseInt(rows[0].month_count, 10),
  };
}

async function recordUsage(userId, endpoint) {
  await pool.query('INSERT INTO usage_events (user_id, endpoint) VALUES ($1, $2)', [userId, endpoint]);
}

async function findOrCreateUser(appleUserId) {
  const existing = await pool.query('SELECT * FROM users WHERE apple_user_id = $1', [appleUserId]);
  if (existing.rows.length > 0) return existing.rows[0];

  const inserted = await pool.query(
    'INSERT INTO users (apple_user_id) VALUES ($1) RETURNING *',
    [appleUserId]
  );
  return inserted.rows[0];
}

async function getUserById(userId) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  return rows[0] || null;
}

// サブスクの状態を更新する（月額プラン用）。
async function setSubscriptionStatus(userId, isSubscribed, expiresAt, productId = null) {
  await pool.query(
    `UPDATE users
     SET is_subscribed = $1,
         subscription_expires_at = $2,
         latest_product_id = COALESCE($4, latest_product_id)
     WHERE id = $3`,
    [isSubscribed, expiresAt, userId, productId]
  );
}

// 買い切り(非消耗型)を有効化する。一度trueになったら以後は変わらない想定。
async function setLifetimeStatus(userId, productId) {
  await pool.query(
    'UPDATE users SET is_lifetime = TRUE, latest_product_id = $2 WHERE id = $1',
    [userId, productId]
  );
}

// Apple側のoriginalTransactionIdをユーザーに紐付ける。
// これによりサーバー間通知(Webhook)が来たときに「誰の課金か」を特定できる。
async function linkOriginalTransaction(userId, originalTransactionId) {
  await pool.query(
    'UPDATE users SET original_transaction_id = $2 WHERE id = $1',
    [userId, originalTransactionId]
  );
}

async function getUserByOriginalTransactionId(originalTransactionId) {
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE original_transaction_id = $1',
    [originalTransactionId]
  );
  return rows[0] || null;
}

// NEW: 今日すでに付与済みのシェアボーナス量を返す（未付与なら0）。
async function getShareBonusToday(userId) {
  const { rows } = await pool.query(
    'SELECT amount FROM share_bonuses WHERE user_id = $1 AND bonus_date = CURRENT_DATE',
    [userId]
  );
  return rows[0] ? parseInt(rows[0].amount, 10) : 0;
}

// NEW: 今日分のシェアボーナスを付与する。同じユーザー・同じ日には
// (user_id, bonus_date) の主キー制約により2回目以降は何も起きない
// （呼び出し側は事前に getShareBonusToday で0であることを確認してから呼ぶ想定）。
async function grantShareBonus(userId, amount) {
  await pool.query(
    `INSERT INTO share_bonuses (user_id, bonus_date, amount)
     VALUES ($1, CURRENT_DATE, $2)
     ON CONFLICT (user_id, bonus_date) DO NOTHING`,
    [userId, amount]
  );
}

module.exports = {
  DB_ENABLED,
  initDb,
  getUsageCounts,
  recordUsage,
  findOrCreateUser,
  getUserById,
  setSubscriptionStatus,
  setLifetimeStatus,
  linkOriginalTransaction,
  getUserByOriginalTransactionId,
  getShareBonusToday,
  grantShareBonus,
};

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
      display_name TEXT,
      account_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // 既存DBへの追記用マイグレーション（新規作成時はCREATE TABLEで既に入っているのでno-op）
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_lifetime BOOLEAN NOT NULL DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS original_transaction_id TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS latest_product_id TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS account_data JSONB NOT NULL DEFAULT '{}'::jsonb;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_original_transaction_id ON users (original_transaction_id);`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_original_transaction_id_unique ON users (original_transaction_id) WHERE original_transaction_id IS NOT NULL;`);

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_category_scores (
      client_user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      category_name TEXT NOT NULL,
      score_date DATE NOT NULL,
      completion_percent SMALLINT NOT NULL CHECK (completion_percent BETWEEN 0 AND 100),
      completed_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
      target_count INTEGER NOT NULL DEFAULT 0 CHECK (target_count >= 0),
      points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (client_user_id, category_name, score_date)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_daily_category_scores_rank ON daily_category_scores (score_date, category_name, completion_percent DESC, points DESC);`);

  console.log('DB initialized (users, usage_events, share_bonuses, leaderboard tables ready).');
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
  const inserted = await pool.query(
    `INSERT INTO users (apple_user_id) VALUES ($1)
     ON CONFLICT (apple_user_id) DO UPDATE SET apple_user_id = EXCLUDED.apple_user_id
     RETURNING *`,
    [appleUserId]
  );
  return inserted.rows[0];
}

async function getUserById(userId) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  return rows[0] || null;
}

async function saveAccountData(userId, accountData, displayName) {
  const { rows } = await pool.query(
    `UPDATE users SET account_data = $2::jsonb,
       display_name = COALESCE($3, display_name)
     WHERE id = $1
     RETURNING id, display_name, account_data, is_subscribed, is_lifetime, subscription_expires_at`,
    [userId, JSON.stringify(accountData), displayName || null]
  );
  return rows[0] || null;
}

async function updateDisplayName(userId, displayName) {
  const { rows } = await pool.query(
    'UPDATE users SET display_name = $2 WHERE id = $1 RETURNING id, display_name',
    [userId, displayName || null]
  );
  return rows[0] || null;
}

async function deleteAccount(userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = String(userId);
    await client.query('DELETE FROM usage_events WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM share_bonuses WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM daily_category_scores WHERE client_user_id = $1', [id]);
    await client.query('DELETE FROM users WHERE id = $1', [userId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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

async function upsertDailyCategoryScores(clientUserId, displayName, scoreDate, categories) {
  if (!DB_ENABLED) throw new Error('Leaderboard database is unavailable');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const category of categories) {
      await client.query(
        `INSERT INTO daily_category_scores
          (client_user_id, display_name, category_name, score_date, completion_percent, completed_count, target_count, points, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
         ON CONFLICT (client_user_id, category_name, score_date) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          completion_percent = EXCLUDED.completion_percent,
          completed_count = EXCLUDED.completed_count,
          target_count = EXCLUDED.target_count,
          points = EXCLUDED.points,
          updated_at = now()`,
        [clientUserId, displayName, category.name, scoreDate, category.progress, category.completed, category.target, category.points]
      );
    }
    const names = categories.map(category => category.name);
    if (names.length) {
      await client.query(
        'DELETE FROM daily_category_scores WHERE client_user_id = $1 AND score_date = $2 AND NOT (category_name = ANY($3::text[]))',
        [clientUserId, scoreDate, names]
      );
    } else {
      await client.query('DELETE FROM daily_category_scores WHERE client_user_id = $1 AND score_date = $2', [clientUserId, scoreDate]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getDailyCategoryLeaderboard(scoreDate, categoryName) {
  if (!DB_ENABLED) throw new Error('Leaderboard database is unavailable');
  const { rows } = await pool.query(
    `SELECT display_name AS name, category_name AS category, completion_percent AS progress,
            completed_count AS completed, target_count AS target, points,
            row_number() OVER (ORDER BY completion_percent DESC, points DESC, updated_at ASC) AS rank
     FROM daily_category_scores
     WHERE score_date = $1 AND category_name = $2
     ORDER BY completion_percent DESC, points DESC, updated_at ASC
     LIMIT 50`,
    [scoreDate, categoryName]
  );
  return rows;
}

module.exports = {
  DB_ENABLED,
  initDb,
  getUsageCounts,
  recordUsage,
  findOrCreateUser,
  getUserById,
  saveAccountData,
  updateDisplayName,
  deleteAccount,
  setSubscriptionStatus,
  setLifetimeStatus,
  linkOriginalTransaction,
  getUserByOriginalTransactionId,
  getShareBonusToday,
  grantShareBonus,
  upsertDailyCategoryScores,
  getDailyCategoryLeaderboard,
};

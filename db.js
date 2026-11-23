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

  // NEW: SNSシェアによる今週の利用上限ボーナス。
  // (user_id, bonus_date) を主キーにすることで「1ユーザー・1週1回」を
  // DBレベルで保証する（ON CONFLICT DO NOTHINGで2回目以降の付与を防ぐ）。
  // bonus_date は「今週の月曜の日付」（getWeekWindow の weekDate）。
  // 週が変わると月曜の日付が変わるので、翌週はまた1回もらえる。
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
  // ランキング指標の追加（既存DBにも安全に追記）
  await pool.query(`ALTER TABLE daily_category_scores ADD COLUMN IF NOT EXISTS pomodoro_count INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE daily_category_scores ADD COLUMN IF NOT EXISTS work_minutes INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE daily_category_scores ADD COLUMN IF NOT EXISTS memorized_count INTEGER NOT NULL DEFAULT 0;`);

  // 公開デッキ（ユーザーが明示的に公開したものだけ）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shared_decks (
      id BIGSERIAL PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      title TEXT NOT NULL,
      category_name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      cards JSONB NOT NULL,
      card_count INTEGER NOT NULL DEFAULT 0,
      report_count INTEGER NOT NULL DEFAULT 0,
      hidden BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_shared_decks_list ON shared_decks (hidden, category_name, created_at DESC);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shared_deck_imports (
      deck_id BIGINT NOT NULL REFERENCES shared_decks(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (deck_id, user_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shared_deck_reports (
      deck_id BIGINT NOT NULL REFERENCES shared_decks(id) ON DELETE CASCADE,
      reporter_user_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (deck_id, reporter_user_id)
    );
  `);

  // ---- 週次AI利用枠(v2) ----
  // cost: 機能ごとの消費量 / source: 'weekly'(週の枠) か 'bonus'(ボーナス残高) のどちらから引いたか
  await pool.query(`ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS cost INTEGER NOT NULL DEFAULT 1;`);
  await pool.query(`ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'weekly';`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_usage_events_user_time ON usage_events (user_id, created_at);`);
  // 招待・シェア特典で貯まるボーナス残高（週リセットされない。使った分だけ減る）
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_credits INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by INTEGER REFERENCES users(id);`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users (referral_code) WHERE referral_code IS NOT NULL;`);

  // ---- デバイス単位の週次AI利用枠（Iteration 4・班B） ----
  // 認証オフ（REQUIRE_AUTH=false）のとき、AI枠はアカウントではなく端末で数える。
  // device_id はクライアントが AsyncStorage に永続化した匿名ID（認証ではない）。
  // 1行＝1端末×1週。first_seen はその端末の最初の利用週の記録時刻で、
  // お試し期間（初回利用から7日間は週50回）の判定に使う。週が変わると
  // 新しい行が作られ used は 0 から始まる（週リセット）。
  // bonus_credits は将来のデバイス向け特典用の枠で、現状は常に 0
  // （シェア・招待特典はアカウント紐づけのため認証オン時のみ）。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS device_ai_usage (
      device_id TEXT NOT NULL,
      week_date DATE NOT NULL,
      used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
      bonus_credits INTEGER NOT NULL DEFAULT 0 CHECK (bonus_credits >= 0),
      first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (device_id, week_date)
    );
  `);

  console.log('DB initialized (users, usage_events, share_bonuses, leaderboard tables ready).');
}

// ==========================================================================
// 週次AI利用枠
// 週は「月曜 0:00 (日本時間)」で切り替わる。ユーザーに「毎週月曜にリセット」と説明できる固定ルール。
// ==========================================================================
const WEEK_TZ = 'Asia/Tokyo';

// 今週の開始時刻(timestamptz) と 次のリセット時刻、今週の開始日(DATE) をDBの時計で返す
async function getWeekWindow() {
  const { rows } = await pool.query(
    `SELECT
       (date_trunc('week', now() AT TIME ZONE $1) AT TIME ZONE $1) AS week_start,
       ((date_trunc('week', now() AT TIME ZONE $1) + interval '7 days') AT TIME ZONE $1) AS next_reset,
       to_char(date_trunc('week', now() AT TIME ZONE $1), 'YYYY-MM-DD') AS week_date`,
    [WEEK_TZ]
  );
  return { weekStart: rows[0].week_start, nextReset: rows[0].next_reset, weekDate: rows[0].week_date };
}

// 今週「週の枠」から消費した量
async function getWeeklyUsed(userId) {
  const { weekStart } = await getWeekWindow();
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(cost), 0)::int AS used
     FROM usage_events
     WHERE user_id = $1 AND source = 'weekly' AND created_at >= $2`,
    [userId, weekStart]
  );
  return rows[0].used;
}

// 今週のシェア特典（付与済みならその量、未付与なら0）
async function getShareBonusThisWeek(userId) {
  const { weekDate } = await getWeekWindow();
  const { rows } = await pool.query(
    'SELECT amount FROM share_bonuses WHERE user_id = $1 AND bonus_date = $2',
    [userId, weekDate]
  );
  return rows[0] ? parseInt(rows[0].amount, 10) : 0;
}

// 今週分のシェア特典を付与する。(user_id, bonus_date)の主キーで「1人・1週1回」をDBが保証する。
// 付与できたら true、すでに付与済みなら false。
async function grantShareBonusThisWeek(userId, amount) {
  const { weekDate } = await getWeekWindow();
  const { rowCount } = await pool.query(
    `INSERT INTO share_bonuses (user_id, bonus_date, amount)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, bonus_date) DO NOTHING`,
    [userId, weekDate, amount]
  );
  return rowCount > 0;
}

// AI利用を1回分「予約」する。成功したら { eventId, source } を返し、枠が足りなければ null。
// 1文のSQLでチェックと記録を行い、同時リクエストでも上限を超えないようにする。
//  1. 週の枠に空きがあれば source='weekly' で記録
//  2. なければボーナス残高から引いて source='bonus' で記録
async function reserveUsage(userId, endpoint, cost, weeklyLimit) {
  const { weekStart } = await getWeekWindow();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 同一ユーザーの同時リクエストを直列化（ユーザー行をロック）
    const u = await client.query('SELECT bonus_credits FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!u.rows[0]) { await client.query('ROLLBACK'); return null; }
    const used = await client.query(
      `SELECT COALESCE(SUM(cost), 0)::int AS used FROM usage_events
       WHERE user_id = $1 AND source = 'weekly' AND created_at >= $2`,
      [userId, weekStart]
    );
    let source = null;
    if (cost === 0) {
      source = 'weekly';
    } else if (used.rows[0].used + cost <= weeklyLimit) {
      source = 'weekly';
    } else if (u.rows[0].bonus_credits >= cost) {
      await client.query('UPDATE users SET bonus_credits = bonus_credits - $2 WHERE id = $1', [userId, cost]);
      source = 'bonus';
    }
    if (!source) { await client.query('ROLLBACK'); return null; }
    const ins = await client.query(
      'INSERT INTO usage_events (user_id, endpoint, cost, source) VALUES ($1,$2,$3,$4) RETURNING id',
      [userId, endpoint, cost, source]
    );
    await client.query('COMMIT');
    return { eventId: ins.rows[0].id, source };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// AIが失敗したとき、予約した分を返す（ユーザーに失敗の分を払わせない）
async function refundUsage(eventId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('DELETE FROM usage_events WHERE id = $1 RETURNING user_id, cost, source', [eventId]);
    if (rows[0] && rows[0].source === 'bonus') {
      await client.query('UPDATE users SET bonus_credits = bonus_credits + $2 WHERE id = $1', [rows[0].user_id, rows[0].cost]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ==========================================================================
// デバイス単位の週次AI利用枠（Iteration 4・班B。認証オフ時専用）
// users テーブルは触らない。アカウント側の reserveUsage / refundUsage と
// 同じ契約：成功したら { weekDate, source }、枠が足りなければ null。
// ==========================================================================

// 今週のデバイス利用状況。行が無ければ「未使用」（used=0, firstSeen=null）。
async function getDeviceUsage(deviceId) {
  const { weekStart, nextReset, weekDate } = await getWeekWindow();
  const { rows } = await pool.query(
    `SELECT used, bonus_credits,
            (SELECT MIN(first_seen) FROM device_ai_usage WHERE device_id = $1) AS first_seen
     FROM device_ai_usage WHERE device_id = $1 AND week_date = $2`,
    [deviceId, weekDate]
  );
  return {
    used: rows[0] ? rows[0].used : 0,
    bonusCredits: rows[0] ? rows[0].bonus_credits : 0,
    firstSeen: rows[0] && rows[0].first_seen ? new Date(rows[0].first_seen).toISOString() : null,
    weekStart,
    nextReset,
    weekDate,
  };
}

// デバイスの AI利用を cost 回分「予約」する。reserveUsage のデバイス版。
async function reserveDeviceUsage(deviceId, cost, weeklyLimit) {
  const { weekDate } = await getWeekWindow();
  if (cost === 0) return { weekDate, source: 'weekly' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      'SELECT used, bonus_credits FROM device_ai_usage WHERE device_id = $1 AND week_date = $2 FOR UPDATE',
      [deviceId, weekDate]
    );
    const used = cur.rows[0] ? cur.rows[0].used : 0;
    const bonus = cur.rows[0] ? cur.rows[0].bonus_credits : 0;
    let source = null;
    if (used + cost <= weeklyLimit) {
      source = 'weekly';
    } else if (bonus >= cost) {
      source = 'bonus';
    }
    if (!source) { await client.query('ROLLBACK'); return null; }
    if (cur.rows[0]) {
      if (source === 'weekly') {
        await client.query(
          'UPDATE device_ai_usage SET used = used + $3, updated_at = now() WHERE device_id = $1 AND week_date = $2',
          [deviceId, weekDate, cost]
        );
      } else {
        await client.query(
          'UPDATE device_ai_usage SET bonus_credits = bonus_credits - $3, updated_at = now() WHERE device_id = $1 AND week_date = $2',
          [deviceId, weekDate, cost]
        );
      }
    } else {
      // 初回利用：この行の first_seen がお試し期間の起点になる
      await client.query(
        'INSERT INTO device_ai_usage (device_id, week_date, used, bonus_credits) VALUES ($1, $2, $3, 0)',
        [deviceId, weekDate, source === 'weekly' ? cost : 0]
      );
      if (source === 'bonus') {
        // 行が無かったのに bonus 経由はあり得ない（bonus=0のため）が、念のため
        await client.query('ROLLBACK');
        return null;
      }
    }
    await client.query('COMMIT');
    return { weekDate, source };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// デバイスの予約分を返す（AI失敗時）。refundUsage のデバイス版。
async function refundDeviceUsage(deviceId, weekDate, cost, source) {
  if (!cost) return;
  if (source === 'weekly') {
    await pool.query(
      'UPDATE device_ai_usage SET used = GREATEST(0, used - $3), updated_at = now() WHERE device_id = $1 AND week_date = $2',
      [deviceId, weekDate, cost]
    );
  } else if (source === 'bonus') {
    await pool.query(
      'UPDATE device_ai_usage SET bonus_credits = bonus_credits + $3, updated_at = now() WHERE device_id = $1 AND week_date = $2',
      [deviceId, weekDate, cost]
    );
  }
}

async function addBonusCredits(userId, amount) {
  await pool.query('UPDATE users SET bonus_credits = bonus_credits + $2 WHERE id = $1', [userId, amount]);
}

// ---- 招待コード ----
const REFERRAL_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 紛らわしい文字(0/O, 1/I/L)を除外
function randomReferralCode() {
  let out = '';
  for (let i = 0; i < 8; i++) out += REFERRAL_ALPHABET[Math.floor(Math.random() * REFERRAL_ALPHABET.length)];
  return out;
}

async function ensureReferralCode(userId) {
  const cur = await pool.query('SELECT referral_code FROM users WHERE id = $1', [userId]);
  if (cur.rows[0] && cur.rows[0].referral_code) return cur.rows[0].referral_code;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomReferralCode();
    try {
      const { rows } = await pool.query(
        `UPDATE users SET referral_code = $2 WHERE id = $1 AND referral_code IS NULL RETURNING referral_code`,
        [userId, code]
      );
      if (rows[0]) return rows[0].referral_code;
      const again = await pool.query('SELECT referral_code FROM users WHERE id = $1', [userId]);
      if (again.rows[0] && again.rows[0].referral_code) return again.rows[0].referral_code;
    } catch (e) {
      if (e.code !== '23505') throw e; // 重複したらもう一度
    }
  }
  throw new Error('Could not generate referral code');
}

// 招待コードの利用。友達(redeemer)とコードの持ち主の両方にボーナスを付与する。
// 返り値: { ok: true } か { ok: false, reason }
async function redeemReferral(redeemerId, code, redeemerBonus, referrerBonus, referrerMax) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const me = await client.query('SELECT id, referred_by FROM users WHERE id = $1 FOR UPDATE', [redeemerId]);
    if (!me.rows[0]) { await client.query('ROLLBACK'); return { ok: false, reason: 'not_found' }; }
    if (me.rows[0].referred_by) { await client.query('ROLLBACK'); return { ok: false, reason: 'already_redeemed' }; }
    const ref = await client.query('SELECT id FROM users WHERE referral_code = $1 FOR UPDATE', [code]);
    if (!ref.rows[0]) { await client.query('ROLLBACK'); return { ok: false, reason: 'invalid_code' }; }
    if (String(ref.rows[0].id) === String(redeemerId)) { await client.query('ROLLBACK'); return { ok: false, reason: 'own_code' }; }
    const cnt = await client.query('SELECT COUNT(*)::int AS n FROM users WHERE referred_by = $1', [ref.rows[0].id]);
    await client.query('UPDATE users SET referred_by = $2, bonus_credits = bonus_credits + $3 WHERE id = $1', [redeemerId, ref.rows[0].id, redeemerBonus]);
    // 持ち主側の特典には上限を設ける（上限を超えたら友達側だけ特典を受け取る）
    if (cnt.rows[0].n < referrerMax) {
      await client.query('UPDATE users SET bonus_credits = bonus_credits + $2 WHERE id = $1', [ref.rows[0].id, referrerBonus]);
    }
    await client.query('COMMIT');
    return { ok: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function countReferrals(userId) {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE referred_by = $1', [userId]);
  return rows[0].n;
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
    await client.query('UPDATE users SET referred_by = NULL WHERE referred_by = $1', [userId]);
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

async function upsertDailyCategoryScores(clientUserId, displayName, scoreDate, categories) {
  if (!DB_ENABLED) throw new Error('Leaderboard database is unavailable');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const category of categories) {
      await client.query(
        `INSERT INTO daily_category_scores
          (client_user_id, display_name, category_name, score_date, completion_percent, completed_count, target_count, points,
           pomodoro_count, work_minutes, memorized_count, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
         ON CONFLICT (client_user_id, category_name, score_date) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          completion_percent = EXCLUDED.completion_percent,
          completed_count = EXCLUDED.completed_count,
          target_count = EXCLUDED.target_count,
          points = EXCLUDED.points,
          pomodoro_count = EXCLUDED.pomodoro_count,
          work_minutes = EXCLUDED.work_minutes,
          memorized_count = EXCLUDED.memorized_count,
          updated_at = now()`,
        [clientUserId, displayName, category.name, scoreDate, category.progress, category.completed, category.target, category.points,
         category.pomodoro, category.minutes, category.memorized]
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

// 指標ごとに「列名」を固定（ユーザー入力をSQLに直接入れないためのホワイトリスト）
const LEADERBOARD_METRIC_COLUMNS = {
  tasks: 'completed',
  pomodoro: 'pomodoro',
  minutes: 'minutes',
  memorized: 'memorized',
  rate: 'progress',
};

// 期間（from〜to）内のユーザー別合計で順位を出す
async function getCategoryLeaderboard(fromDate, toDate, categoryName, metric) {
  if (!DB_ENABLED) throw new Error('Leaderboard database is unavailable');
  const column = LEADERBOARD_METRIC_COLUMNS[metric] || LEADERBOARD_METRIC_COLUMNS.tasks;
  const { rows } = await pool.query(
    `WITH agg AS (
       SELECT client_user_id,
              MAX(display_name) AS name,
              SUM(completed_count)::int AS completed,
              SUM(target_count)::int AS target,
              SUM(points)::int AS points,
              SUM(pomodoro_count)::int AS pomodoro,
              SUM(work_minutes)::int AS minutes,
              SUM(memorized_count)::int AS memorized,
              CASE WHEN SUM(target_count) = 0 THEN 0
                   ELSE ROUND(100.0 * SUM(completed_count) / SUM(target_count))::int END AS progress
       FROM daily_category_scores
       WHERE score_date BETWEEN $1 AND $2 AND category_name = $3
       GROUP BY client_user_id
     )
     SELECT name, $3::text AS category, progress, completed, target, points, pomodoro, minutes, memorized,
            ${column} AS value,
            row_number() OVER (ORDER BY ${column} DESC, points DESC, name ASC) AS rank
     FROM agg
     WHERE ${column} > 0
     ORDER BY rank
     LIMIT 50`,
    [fromDate, toDate, categoryName]
  );
  return rows;
}


// ---- 公開デッキ ----
const SHARED_DECK_REPORT_THRESHOLD = 3;

async function updateSharedDeck(deckId, ownerUserId, { title, categoryName, description, cards }) {
  const { rowCount } = await pool.query(
    `UPDATE shared_decks SET title = $3, category_name = $4, description = $5, cards = $6::jsonb, card_count = $7
     WHERE id = $1 AND owner_user_id = $2`,
    [deckId, ownerUserId, title, categoryName, description, JSON.stringify(cards), cards.length]
  );
  return rowCount > 0;
}

async function createSharedDeck(ownerUserId, ownerName, { title, categoryName, description, cards }) {
  const { rows } = await pool.query(
    `INSERT INTO shared_decks (owner_user_id, owner_name, title, category_name, description, cards, card_count)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING id, title, category_name, card_count, created_at`,
    [ownerUserId, ownerName, title, categoryName, description, JSON.stringify(cards), cards.length]
  );
  return rows[0];
}

async function countOwnSharedDecks(ownerUserId) {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM shared_decks WHERE owner_user_id = $1', [ownerUserId]);
  return rows[0].n;
}

// 一覧（カード本文は含めない）。sort: new | popular
async function listSharedDecks({ categoryName, sort, query, limit, offset }) {
  const orderBy = sort === 'popular'
    ? '(SELECT COUNT(*) FROM shared_deck_imports i WHERE i.deck_id = d.id) DESC, d.created_at DESC'
    : 'd.created_at DESC';
  const params = [categoryName || null, query ? `%${query}%` : null, limit, offset];
  const { rows } = await pool.query(
    `SELECT d.id, d.title, d.category_name AS "categoryName", d.description, '匿名'::text AS "ownerName",
            d.card_count AS "cardCount", d.created_at AS "createdAt",
            (SELECT COUNT(*)::int FROM shared_deck_imports i WHERE i.deck_id = d.id) AS "importCount"
     FROM shared_decks d
     WHERE d.hidden = FALSE
       AND ($1::text IS NULL OR d.category_name = $1)
       AND ($2::text IS NULL OR d.title ILIKE $2)
     ORDER BY ${orderBy}
     LIMIT $3 OFFSET $4`,
    params
  );
  return rows;
}

async function getSharedDeck(deckId) {
  const { rows } = await pool.query(
    `SELECT id, owner_user_id, title, category_name AS "categoryName", description, '匿名'::text AS "ownerName",
            card_count AS "cardCount", cards, created_at AS "createdAt"
     FROM shared_decks WHERE id = $1 AND hidden = FALSE`,
    [deckId]
  );
  return rows[0] || null;
}

async function recordSharedDeckImport(deckId, userId) {
  await pool.query(
    'INSERT INTO shared_deck_imports (deck_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [deckId, userId]
  );
}

async function deleteSharedDeck(deckId, ownerUserId) {
  const { rowCount } = await pool.query(
    'DELETE FROM shared_decks WHERE id = $1 AND owner_user_id = $2',
    [deckId, ownerUserId]
  );
  return rowCount > 0;
}

// 通報。閾値に達したら自動で非表示
async function reportSharedDeck(deckId, reporterUserId, reason) {
  await pool.query(
    'INSERT INTO shared_deck_reports (deck_id, reporter_user_id, reason) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
    [deckId, reporterUserId, reason]
  );
  await pool.query(
    `UPDATE shared_decks SET report_count = (SELECT COUNT(*)::int FROM shared_deck_reports r WHERE r.deck_id = $1),
            hidden = (SELECT COUNT(*) FROM shared_deck_reports r WHERE r.deck_id = $1) >= $2
     WHERE id = $1`,
    [deckId, SHARED_DECK_REPORT_THRESHOLD]
  );
}

module.exports = {
  get pool() { return pool; },
  DB_ENABLED,
  initDb,
  getWeekWindow,
  getWeeklyUsed,
  reserveUsage,
  refundUsage,
  getDeviceUsage,
  reserveDeviceUsage,
  refundDeviceUsage,
  addBonusCredits,
  ensureReferralCode,
  redeemReferral,
  countReferrals,
  findOrCreateUser,
  getUserById,
  saveAccountData,
  updateDisplayName,
  deleteAccount,
  setSubscriptionStatus,
  setLifetimeStatus,
  linkOriginalTransaction,
  getUserByOriginalTransactionId,
  getShareBonusThisWeek,
  grantShareBonusThisWeek,
  upsertDailyCategoryScores,
  getCategoryLeaderboard,
  createSharedDeck,
  updateSharedDeck,
  countOwnSharedDecks,
  listSharedDecks,
  getSharedDeck,
  recordSharedDeckImport,
  deleteSharedDeck,
  reportSharedDeck,
  LEADERBOARD_METRIC_COLUMNS,
};

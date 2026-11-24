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

  // ---- V11: オンラインプロフィール（表示名・アイコンドット・リーグ参加・公開設定） ----
  // user_id は認証オン時は users.id（数値を文字列化）、認証オフ時は
  // クライアントが送る userId（匿名デバイスID由来）。1行＝1人。
  // display_name が NULL/空＝未設定（従来のプレイヤー-xxxx 表示のまま）。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS online_profiles (
      user_id TEXT PRIMARY KEY,
      display_name TEXT,
      avatar_color TEXT,
      league_opt_in BOOLEAN NOT NULL DEFAULT TRUE,
      activity_public BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // ---- V11: 期限ベースの真のペース%（週次リーグ用） ----
  // 1行＝1人×1週（week_date は月曜）。raw_pace はキャップなしの生値
  // （実績÷今日までの計画量×100）。表示はクライアントが 100% で
  // キャップし、先行分を別バッジで出す。順位は raw_pace で決める。
  // achievement_percent は目標達成度%（実績÷目標量×100、上限100）。
  // pomodoro / tasks_done はその週の回数・件数、memorized は今日学習した
  // カード数（V12.22・A班【3】。従来は今週マスターした枚数だったが、
  // マスターまで約6回の正解が要るため当日は 0 のままだった）。
  // クライアントが端末データから集計して送る。順位には使わない。
  // tasks_done_today / tasks_total_today は今日のタスクの完了数・総数
  // （V12.24・A班。リーグ指標 'taskRate'＝今日のタスク達成率の材料。
  // 総数が 0 の行は達成率 NULL＝順位は最後・値は null）。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pace_scores (
      user_id TEXT NOT NULL,
      week_date DATE NOT NULL,
      display_name TEXT NOT NULL,
      avatar_color TEXT,
      raw_pace INTEGER NOT NULL DEFAULT 0,
      achievement_percent INTEGER NOT NULL DEFAULT 0,
      pomodoro INTEGER NOT NULL DEFAULT 0,
      memorized INTEGER NOT NULL DEFAULT 0,
      tasks_done INTEGER NOT NULL DEFAULT 0,
      tasks_done_today INTEGER NOT NULL DEFAULT 0,
      tasks_total_today INTEGER NOT NULL DEFAULT 0,
      league_opt_in BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, week_date)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pace_scores_week ON pace_scores (week_date, raw_pace DESC);`);
  // V12.24・A班: 既存DBへの追記（新規作成時は CREATE TABLE で既に入っているので no-op）。
  await pool.query(`ALTER TABLE pace_scores ADD COLUMN IF NOT EXISTS tasks_done_today INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE pace_scores ADD COLUMN IF NOT EXISTS tasks_total_today INTEGER NOT NULL DEFAULT 0;`);

  // ---- V12.19: オンボーディング survey の回答（集計用） ----
  // category: 何をがんばりたい？ (study/work/health/hobby/other)
  // source: どこで知った？ (app-store-search/sns/friend-family/ad/other)
  // device_id / user_id は集計には使わず、重複・不正の調査用に残すのみ。
  // 管理画面 (GET /api/admin/onboarding-surveys) は device_id / user_id を返さない。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS onboarding_survey_answers (
      id SERIAL PRIMARY KEY,
      device_id TEXT,
      user_id TEXT,
      category TEXT,
      source TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_onboarding_survey_answers_created ON onboarding_survey_answers (created_at DESC);`);

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
// V12 で日次に移行したため旧・週1回版は使わない（互換のため残置）。
// 新規の付与・照会は getShareBonusToday / grantShareBonusToday を使うこと。
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
// V12 で日次に移行したため旧・週1回版は使わない（互換のため残置）。
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

// V12・E班【10】：今日の日付（JST・DBの時計）。シェア特典の1日1回の日付キー。
// 端末の時計は変えられるため使わない。週の区切り（getWeekWindow）と同じく DB の now() が起点。
async function getTodayDateJST() {
  const { rows } = await pool.query(
    `SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') AS today`,
    [WEEK_TZ]
  );
  return rows[0].today;
}

// V12・E班【10】：今日のシェア特典（付与済みならその量、未付与なら0）。
// share_bonuses テーブルはそのまま使い、bonus_date に「今日の日付」を入れる
// （週版は月曜の日付を入れていた。テーブル・主キー・制約の変更なし）。
async function getShareBonusToday(userId) {
  const today = await getTodayDateJST();
  const { rows } = await pool.query(
    'SELECT amount FROM share_bonuses WHERE user_id = $1 AND bonus_date = $2',
    [userId, today]
  );
  return rows[0] ? parseInt(rows[0].amount, 10) : 0;
}

// V12・E班【10】：今日分のシェア特典を付与する。(user_id, bonus_date)の主キーで
// 「1人・1日1回」をDBが保証する。付与できたら true、今日すでに付与済みなら false。
async function grantShareBonusToday(userId, amount) {
  const today = await getTodayDateJST();
  const { rowCount } = await pool.query(
    `INSERT INTO share_bonuses (user_id, bonus_date, amount)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, bonus_date) DO NOTHING`,
    [userId, today, amount]
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
// V11: 表示名は online_profiles に保存されたユーザー設定名を優先する
// （未設定なら daily_category_scores に保存された匿名名のまま）。
// 順位は metric 列の値の降順。metric=rate の progress は日次タスクの
// 7日間ペース%（0〜100）で、期限ベースの真のペース%ではない。
// 期限ベースの順位は pace_scores（GET /api/league/weekly）を使うこと。
async function getCategoryLeaderboard(fromDate, toDate, categoryName, metric) {
  if (!DB_ENABLED) throw new Error('Leaderboard database is unavailable');
  const column = LEADERBOARD_METRIC_COLUMNS[metric] || LEADERBOARD_METRIC_COLUMNS.tasks;
  const { rows } = await pool.query(
    `WITH agg AS (
       SELECT client_user_id,
              MAX(COALESCE(op.display_name, display_name)) AS name,
              MAX(op.avatar_color) AS avatar_color,
              SUM(completed_count)::int AS completed,
              SUM(target_count)::int AS target,
              SUM(points)::int AS points,
              SUM(pomodoro_count)::int AS pomodoro,
              SUM(work_minutes)::int AS minutes,
              SUM(memorized_count)::int AS memorized,
              CASE WHEN SUM(target_count) = 0 THEN 0
                   ELSE ROUND(100.0 * SUM(completed_count) / SUM(target_count))::int END AS progress
       FROM daily_category_scores dcs
       LEFT JOIN online_profiles op ON op.user_id = dcs.client_user_id
       WHERE score_date BETWEEN $1 AND $2 AND category_name = $3
       GROUP BY client_user_id
     )
     SELECT name, avatar_color, $3::text AS category, progress, completed, target, points, pomodoro, minutes, memorized,
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

// ==========================================================================
// V11: オンラインプロフィール & 期限ベースのペースリーグ
// ==========================================================================

const AVATAR_COLORS = ['#9AA0A6', '#2DFFB4', '#FF7AD9', '#60A5FA', '#FBBF24', '#FB7185'];

/** 表示名の正規化。空文字は「未設定」(null)。20文字まで。 */
function cleanDisplayName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ').slice(0, 20);
  return name || null;
}

function cleanAvatarColor(value) {
  return AVATAR_COLORS.includes(value) ? value : null;
}

async function getOnlineProfile(userId) {
  const { rows } = await pool.query(
    'SELECT user_id, display_name, avatar_color, league_opt_in, activity_public FROM online_profiles WHERE user_id = $1',
    [String(userId)]
  );
  if (!rows[0]) return null;
  return {
    userId: rows[0].user_id,
    displayName: rows[0].display_name || null,
    avatarColor: rows[0].avatar_color || null,
    leagueOptIn: rows[0].league_opt_in !== false,
    activityPublic: rows[0].activity_public !== false,
  };
}

/**
 * プロフィールを部分更新する（渡された項目だけ）。行が無ければ作る。
 * displayName に null を渡すと未設定に戻す（avatarColor も同じ）。
 * 戻り値は更新後のプロフィール。
 */
async function upsertOnlineProfile(userId, patch) {
  const id = String(userId);
  const displayName = patch.displayName !== undefined ? cleanDisplayName(patch.displayName) : undefined;
  const avatarColor = patch.avatarColor !== undefined ? cleanAvatarColor(patch.avatarColor) : undefined;
  const leagueOptIn = patch.leagueOptIn !== undefined ? Boolean(patch.leagueOptIn) : undefined;
  const activityPublic = patch.activityPublic !== undefined ? Boolean(patch.activityPublic) : undefined;
  const { rows } = await pool.query(
    `INSERT INTO online_profiles (user_id, display_name, avatar_color, league_opt_in, activity_public)
     VALUES ($1, $2, $3, COALESCE($4, TRUE), COALESCE($5, TRUE))
     ON CONFLICT (user_id) DO UPDATE SET
       display_name = CASE WHEN $2 IS NULL AND $6::boolean THEN NULL ELSE COALESCE($2, online_profiles.display_name) END,
       avatar_color = CASE WHEN $3 IS NULL AND $7::boolean THEN NULL ELSE COALESCE($3, online_profiles.avatar_color) END,
       league_opt_in = COALESCE($4, online_profiles.league_opt_in),
       activity_public = COALESCE($5, online_profiles.activity_public),
       updated_at = now()
     RETURNING user_id, display_name, avatar_color, league_opt_in, activity_public`,
    [
      id,
      displayName === undefined ? null : displayName,
      avatarColor === undefined ? null : avatarColor,
      leagueOptIn === undefined ? null : leagueOptIn,
      activityPublic === undefined ? null : activityPublic,
      patch.displayName !== undefined,
      patch.avatarColor !== undefined,
    ]
  );
  const r = rows[0];
  return {
    userId: r.user_id,
    displayName: r.display_name || null,
    avatarColor: r.avatar_color || null,
    leagueOptIn: r.league_opt_in !== false,
    activityPublic: r.activity_public !== false,
  };
}

/**
 * 表示名を「共有目標のメンバー名」と「今週のひとこと」の表示にも反映する。
 * daily_category_scores / pace_scores の表示名は読み取り時に
 * online_profiles を優先する（getCategoryLeaderboard / getWeeklyLeague）
 * ため、ここで書き換える必要はない。
 */
async function applyDisplayName(userId, displayName) {
  const id = String(userId);
  const name = cleanDisplayName(displayName);
  if (!name) return;
  await pool.query('UPDATE shared_goal_members SET display_name = $2 WHERE user_id = $1', [id, name]);
  const monday = await pool.query(
    `SELECT to_char(date_trunc('week', now() AT TIME ZONE 'Asia/Tokyo'), 'YYYY-MM-DD') AS d`
  );
  await pool.query(
    'UPDATE rank_comments SET author_name = $2 WHERE owner_user_id = $1 AND week_start = $3',
    [id, name, monday.rows[0].d]
  ).catch(() => {});
}

/** 期限ベースの真のペース%を今週分として保存する（1人×1週で上書き）。
 * V12.24・A班: score.tasksDoneToday / score.tasksTotalToday（今日の
 * タスク完了数・総数）も保存する。無ければ 0（旧クライアント互換）。
 * 0 未満・小数は 0 以上の整数に丸める。 */
async function upsertPaceScore(userId, weekDate, score) {
  const { rows } = await pool.query(
    `INSERT INTO pace_scores
       (user_id, week_date, display_name, avatar_color, raw_pace, achievement_percent,
        pomodoro, memorized, tasks_done, tasks_done_today, tasks_total_today, league_opt_in)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (user_id, week_date) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       avatar_color = EXCLUDED.avatar_color,
       raw_pace = EXCLUDED.raw_pace,
       achievement_percent = EXCLUDED.achievement_percent,
       pomodoro = EXCLUDED.pomodoro,
       memorized = EXCLUDED.memorized,
       tasks_done = EXCLUDED.tasks_done,
       tasks_done_today = EXCLUDED.tasks_done_today,
       tasks_total_today = EXCLUDED.tasks_total_today,
       league_opt_in = EXCLUDED.league_opt_in,
       updated_at = now()
     RETURNING *`,
    [
      String(userId),
      weekDate,
      score.displayName,
      score.avatarColor || null,
      Math.max(0, Math.round(score.rawPace || 0)),
      Math.max(0, Math.min(100, Math.round(score.achievementPercent || 0))),
      Math.max(0, Math.floor(score.pomodoro || 0)),
      Math.max(0, Math.floor(score.memorized || 0)),
      Math.max(0, Math.floor(score.tasksDone || 0)),
      Math.max(0, Math.floor(score.tasksDoneToday || 0)),
      Math.max(0, Math.floor(score.tasksTotalToday || 0)),
      score.leagueOptIn !== false,
    ]
  );
  return rows[0];
}

/**
 * V12.22・A班【1】：旧身元（ウィザード uid／Apple id）の行を消す。
 * v12.20 で pace 同期の userId をデバイスIDに統一したが、旧 uid で
 * 書かれた今週の pace_scores 行が残り、表示名が同じためリーグに
 * 「あなた」が2行出る。sync-pace が previousUserIds を受け取ったら
 * 呼ぶ（失敗しても同期自体は成功させるため、呼び出し側で catch する）。
 * pace_scores は今週分だけ、daily_category_scores は直近7日分だけ消す。
 * 新しい userId 自身の行は消さない（念のため SQL でも除外する）。
 * 戻り値は消した行数（{ pace, daily }）。
 */
async function deleteOldIdentityRows(newUserId, oldUserIds, weekDate, sinceDate) {
  const ids = (Array.isArray(oldUserIds) ? oldUserIds : [])
    .map((v) => String(v || '').trim())
    .filter((v) => v && v !== String(newUserId));
  if (ids.length === 0) return { pace: 0, daily: 0 };
  const pace = await pool.query(
    `DELETE FROM pace_scores
      WHERE user_id = ANY($1::text[]) AND week_date = $2 AND user_id <> $3`,
    [ids, weekDate, String(newUserId)],
  );
  const daily = await pool.query(
    `DELETE FROM daily_category_scores
      WHERE client_user_id = ANY($1::text[]) AND score_date >= $2 AND client_user_id <> $3`,
    [ids, sinceDate, String(newUserId)],
  );
  return { pace: pace.rowCount || 0, daily: daily.rowCount || 0 };
}

/**
 * V12.23・A班【1】：旧身元（ウィザード uid／Apple id）で書かれた
 * 共有目標まわりの行を、新しい正規ID（デバイスID）へ移行する。
 * deleteOldIdentityRows（pace_scores／daily_category_scores の掃除）と
 * 同じタイミング（sync-pace の previousUserIds）で呼ぶ。
 * 共有目標のメンバー行は v12.20 以前の ID のまま残り、活動・実績は
 * デバイスIDで記録されるため、読み取りの JOIN が合わずメンバー詳細が
 * 空になる（暗記・集中・タスクが反映されない）。この移行で直す。
 * shared_goal_members は PRIMARY KEY (goal_id, user_id) のため、
 * 移行先に既に (goal_id, 新ID) の行がある場合は旧行を DELETE する
 * （UPDATE すると PK 違反になる）。同じ扱いが必要な PK 付きテーブル
 * （declarations／kicks／task_completions）も同様にする。
 * PK の無い履歴テーブル（values／contributions／comments／stamps／
 * events）は単純 UPDATE。shared_goals.owner_user_id も移行する。
 * 'guest_user' は全員共通の壊れた行のため移行しない（v12.20 の方針）。
 * 対応表 identity_aliases に旧→新を残す（読み取り時フォールバック用）。
 * 失敗しても同期自体は成功させるため、呼び出し側で catch する。
 * 戻り値は移行した行数。
 */
async function migrateSharedGoalIdentity(newUserId, oldUserIds) {
  const ids = (Array.isArray(oldUserIds) ? oldUserIds : [])
    .map((v) => String(v || '').trim())
    .filter((v) => v && v !== String(newUserId) && v !== 'guest_user');
  const counts = { aliases: 0, members: 0, values: 0, contributions: 0, declarations: 0, comments: 0, stamps: 0, tasks: 0, kicks: 0, events: 0, goals: 0 };
  if (ids.length === 0) return counts;
  const nid = String(newUserId);
  // 対応表（無ければ作る。sharedGoals.js の SCHEMA にも同じ定義がある）。
  await pool.query(
    `CREATE TABLE IF NOT EXISTS identity_aliases (
       old_user_id TEXT PRIMARY KEY,
       canonical_user_id TEXT NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
  );
  for (const oldId of ids) {
    const r = await pool.query(
      `INSERT INTO identity_aliases (old_user_id, canonical_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [oldId, nid],
    );
    counts.aliases += r.rowCount || 0;
  }
  // PK の無い履歴テーブルはまとめて UPDATE。
  counts.values = (await pool.query(
    `UPDATE shared_goal_values SET user_id = $2 WHERE user_id = ANY($1::text[])`,
    [ids, nid],
  )).rowCount || 0;
  counts.contributions = (await pool.query(
    `UPDATE shared_goal_contributions SET user_id = $2 WHERE user_id = ANY($1::text[])`,
    [ids, nid],
  )).rowCount || 0;
  counts.comments = (await pool.query(
    `UPDATE shared_goal_comments SET user_id = $2 WHERE user_id = ANY($1::text[])`,
    [ids, nid],
  )).rowCount || 0;
  counts.events = (await pool.query(
    `UPDATE shared_goal_events SET author_user_id = $2 WHERE author_user_id = ANY($1::text[])`,
    [ids, nid],
  )).rowCount || 0;
  // スタンプ：送り手・宛先の両方を移行する。
  counts.stamps += (await pool.query(
    `UPDATE shared_goal_stamps SET user_id = $2 WHERE user_id = ANY($1::text[])`,
    [ids, nid],
  )).rowCount || 0;
  counts.stamps += (await pool.query(
    `UPDATE shared_goal_stamps SET target_user_id = $2 WHERE target_user_id = ANY($1::text[])`,
    [ids, nid],
  )).rowCount || 0;
  // 目標の所有者も移行する（isOwner 判定が旧IDのままだと壊れる）。
  counts.goals = (await pool.query(
    `UPDATE shared_goals SET owner_user_id = $2 WHERE owner_user_id = ANY($1::text[])`,
    [ids, nid],
  )).rowCount || 0;
  // PK 付きテーブル：移行先に同キーの行があれば旧行を消し、無ければ UPDATE。
  const migratePkRows = async (rows, keyCols, table) => {
    let n = 0;
    for (const row of rows) {
      const keys = keyCols.map((c) => row[c]);
      const existsParams = [...keys, nid];
      const existsWhere = keyCols.map((c, i) => `${c} = $${i + 1}`).join(' AND ') + ` AND user_id = $${keyCols.length + 1}`;
      const exists = await pool.query(
        `SELECT 1 FROM ${table} WHERE ${existsWhere}`,
        existsParams,
      );
      if (exists.rowCount) {
        const delParams = [...keys, ids];
        const delWhere = keyCols.map((c, i) => `${c} = $${i + 1}`).join(' AND ') + ` AND user_id = ANY($${keyCols.length + 1}::text[])`;
        n += (await pool.query(`DELETE FROM ${table} WHERE ${delWhere}`, delParams)).rowCount || 0;
      } else {
        const updParams = [...keys, nid, ids];
        const updWhere = keyCols.map((c, i) => `${c} = $${i + 1}`).join(' AND ') + ` AND user_id = ANY($${keyCols.length + 2}::text[])`;
        n += (await pool.query(
          `UPDATE ${table} SET user_id = $${keyCols.length + 1} WHERE ${updWhere}`,
          updParams,
        )).rowCount || 0;
      }
    }
    return n;
  };
  // members (goal_id, user_id)／declarations (goal_id, user_id)／
  // kicks (goal_id, user_id)。kicked_by は別途まとめて UPDATE する。
  const memberRows = await pool.query(
    `SELECT goal_id FROM shared_goal_members WHERE user_id = ANY($1::text[])`,
    [ids]);
  counts.members = await migratePkRows(memberRows.rows, ['goal_id'], 'shared_goal_members');
  const declarationRows = await pool.query(
    `SELECT goal_id FROM shared_goal_declarations WHERE user_id = ANY($1::text[])`,
    [ids]);
  counts.declarations = await migratePkRows(declarationRows.rows, ['goal_id'], 'shared_goal_declarations');
  const kickRows = await pool.query(
    `SELECT goal_id FROM shared_goal_kicks WHERE user_id = ANY($1::text[])`,
    [ids]);
  counts.kicks = await migratePkRows(kickRows.rows, ['goal_id'], 'shared_goal_kicks');
  counts.kicks += (await pool.query(
    `UPDATE shared_goal_kicks SET kicked_by = $2 WHERE kicked_by = ANY($1::text[])`,
    [ids, nid],
  )).rowCount || 0;
  // task_completions (task_id, user_id, completed_date)。
  // completed_date は 'YYYY-MM-DD' 文字列で扱う（Date オブジェクトの
  // まま渡すとタイムゾーンでずれるため）。
  const taskRows = await pool.query(
    `SELECT task_id, to_char(completed_date, 'YYYY-MM-DD') AS completed_date
     FROM shared_goal_task_completions WHERE user_id = ANY($1::text[])`,
    [ids]);
  counts.tasks = await migratePkRows(taskRows.rows, ['task_id', 'completed_date'], 'shared_goal_task_completions');
  return counts;
}

/**
 * 今週のペースリーグ：参加中の人だけを生のペース%（raw_pace）順に返す。
 * 表示名は保存時の名前（プロフィール更新時は次回同期で反映される）。
 * requesterId がリーグ不参加なら optedOut=true を返す（自分の行は出さない）。
 * V12.2・A班: metric で並び替えの指標を切り替える（pace=raw_pace（既定・従来通り）/
 * achievement=achievement_percent / memorized=memorized / pomodoro=pomodoro）。
 * pace_scores の対応する列で降順ソートする。各行に value（その指標の値）と
 * unit（'%'／'枚'／'回'）を付ける。既存の行フィールド（progress・pacePercent 等）は
 * 変えない（旧クライアント互換）。metric は呼び出し側で正規化済みの値を渡すこと。
 * V12.24・A班: taskRate＝今日のタスク達成率（tasks_done_today /
 * tasks_total_today × 100。四捨五入して整数%）。総数が 0 の行（旧行・
 * 今日タスク無し）は NULL になり、行の taskRate・value は null、
 * 順位は NULLS LAST で最後になる。myValue も null（getMyLeagueRank）。
 */
// V12.24・A班: 今日のタスク達成率の SQL 式。LEAGUE_METRIC_COLUMNS と
// getWeeklyLeague の SELECT（task_rate 別名）で共用する。
const TASK_RATE_SQL = `CASE WHEN tasks_total_today > 0 THEN ROUND(tasks_done_today::float / tasks_total_today * 100) ELSE NULL END`;
const LEAGUE_METRIC_COLUMNS = {
  pace: 'raw_pace',
  achievement: 'achievement_percent',
  memorized: 'memorized',
  pomodoro: 'pomodoro',
  taskRate: TASK_RATE_SQL,
};
const LEAGUE_METRIC_UNITS = {
  pace: '%',
  achievement: '%',
  memorized: '枚',
  pomodoro: '回',
  taskRate: '%',
};
const LEAGUE_METRIC_VALUE_FIELDS = {
  pace: 'raw_pace',
  achievement: 'achievement_percent',
  memorized: 'memorized',
  pomodoro: 'pomodoro',
  taskRate: 'task_rate',
};
async function getWeeklyLeague(weekDate, requesterId, metric = 'pace') {
  const m = LEAGUE_METRIC_COLUMNS[metric] ? metric : 'pace';
  const column = LEAGUE_METRIC_COLUMNS[m];
  const valueField = LEAGUE_METRIC_VALUE_FIELDS[m];
  let optedOut = false;
  if (requesterId) {
    const mine = await getOnlineProfile(requesterId);
    if (mine && mine.leagueOptIn === false) optedOut = true;
  }
  const { rows } = await pool.query(
    `SELECT user_id, display_name AS name, avatar_color,
            raw_pace, achievement_percent, pomodoro, memorized, tasks_done,
            ${TASK_RATE_SQL} AS task_rate,
            row_number() OVER (ORDER BY ${column} DESC NULLS LAST, achievement_percent DESC, display_name ASC) AS rank
     FROM pace_scores
     WHERE week_date = $1 AND league_opt_in = TRUE
     ORDER BY rank
     LIMIT 50`,
    [weekDate]
  );
  return {
    optedOut,
    metric: m,
    entries: rows.map((r) => ({
      name: r.name,
      avatarColor: r.avatar_color || null,
      category: 'overall',
      rank: Number(r.rank),
      progress: Number(r.raw_pace),
      pacePercent: Number(r.raw_pace),
      achievementPercent: Number(r.achievement_percent),
      pomodoro: Number(r.pomodoro),
      memorized: Number(r.memorized),
      tasksDone: Number(r.tasks_done),
      completed: Number(r.tasks_done),
      target: 0,
      points: 0,
      // V12.24・A班: 今日のタスク達成率（総数 0・旧行は null）。
      // value も同じ値（taskRate のとき task_rate、他は従来通り）。
      // NULL のまま Number() すると 0 になってしまうため null を保つ。
      taskRate: r.task_rate == null ? null : Number(r.task_rate),
      value: r[valueField] == null ? null : Number(r[valueField]),
      unit: LEAGUE_METRIC_UNITS[m],
      isMe: requesterId ? String(r.user_id) === String(requesterId) : false,
    })),
  };
}

/**
 * V12.20・C班: 要求者本人の順位（LIMIT 50 の外でも付く）。
 * getWeeklyLeague の行順位（row_number() OVER (ORDER BY <metric> DESC,
 * achievement_percent DESC, display_name ASC)）と一致させるため、
 * 単なる「<metric> が自分より大きい人数」ではなく、同値のときの
 * タイブレーク（achievement_percent 降順・display_name 昇順）も
 * 同じ条件で数える。行が無い（今週未同期）・参加オフなら null。
 * 返す value はその指標の本人の値（クライアントの「あなたの順位」
 * 別枠に表示する値）。metric は呼び出し側で正規化済みの値を渡すこと。
 * V12.24・A班: taskRate で本人の総数が 0 のとき metric_value は NULL
 * になり、value・rank ともに null を返す（順位は決められないため。
 * Number(null) は 0 になってしまうので null チェックが必須）。
 */
async function getMyLeagueRank(weekDate, requesterId, metric = 'pace') {
  const m = LEAGUE_METRIC_COLUMNS[metric] ? metric : 'pace';
  const column = LEAGUE_METRIC_COLUMNS[m];
  const mine = await pool.query(
    `SELECT display_name, ${column} AS metric_value, achievement_percent
     FROM pace_scores
     WHERE week_date = $1 AND user_id = $2 AND league_opt_in = TRUE`,
    [weekDate, String(requesterId)]
  );
  if (!mine.rows[0]) return null;
  if (mine.rows[0].metric_value == null) return { rank: null, value: null };
  const myValue = Number(mine.rows[0].metric_value);
  const myAchievement = Number(mine.rows[0].achievement_percent);
  const myName = mine.rows[0].display_name;
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM pace_scores
     WHERE week_date = $1 AND league_opt_in = TRUE AND (
       ${column} > $2
       OR (${column} = $2 AND achievement_percent > $3)
       OR (${column} = $2 AND achievement_percent = $3 AND display_name < $4)
     )`,
    [weekDate, myValue, myAchievement, myName]
  );
  return { rank: rows[0].n + 1, value: myValue };
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
    `SELECT d.id, d.title, d.category_name AS "categoryName", d.description,
            COALESCE(NULLIF(d.owner_name, '匿名'), p.display_name, '匿名') AS "ownerName", d.owner_user_id AS "ownerId",
            d.card_count AS "cardCount", d.created_at AS "createdAt",
            (SELECT COUNT(*)::int FROM shared_deck_imports i WHERE i.deck_id = d.id) AS "importCount"
     FROM shared_decks d
     LEFT JOIN online_profiles p ON p.user_id = d.owner_user_id
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
    `SELECT d.id, d.title, d.category_name AS "categoryName", d.description,
            COALESCE(NULLIF(d.owner_name, '匿名'), p.display_name, '匿名') AS "ownerName", d.owner_user_id AS "ownerId",
            d.card_count AS "cardCount", d.cards, d.created_at AS "createdAt"
     FROM shared_decks d
     LEFT JOIN online_profiles p ON p.user_id = d.owner_user_id
     WHERE d.id = $1 AND d.hidden = FALSE`,
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

// ---- オンボーディング survey の回答（V12.19） ----
// category / source はサーバー側で allowlist 済みの値か null だけが入る想定。
// device_id / user_id はどちらか一方が無くても保存する（調査用のみ）。
async function recordOnboardingSurveyAnswer(deviceId, userId, category, source) {
  await pool.query(
    'INSERT INTO onboarding_survey_answers (device_id, user_id, category, source) VALUES ($1,$2,$3,$4)',
    [deviceId, userId, category, source]
  );
}

// 管理画面用：device_id / user_id を含まない集計だけを返す。
async function getOnboardingSurveyStats() {
  const { rows: byCategory } = await pool.query(
    `SELECT category, COUNT(*)::int AS count FROM onboarding_survey_answers
     WHERE category IS NOT NULL GROUP BY category ORDER BY count DESC`
  );
  const { rows: bySource } = await pool.query(
    `SELECT source, COUNT(*)::int AS count FROM onboarding_survey_answers
     WHERE source IS NOT NULL GROUP BY source ORDER BY count DESC`
  );
  const { rows: totalRows } = await pool.query('SELECT COUNT(*)::int AS n FROM onboarding_survey_answers');
  const { rows: recent } = await pool.query(
    `SELECT category, source, created_at AS "createdAt" FROM onboarding_survey_answers
     ORDER BY created_at DESC LIMIT 50`
  );
  const countsByCategory = {};
  for (const r of byCategory) countsByCategory[r.category] = r.count;
  const countsBySource = {};
  for (const r of bySource) countsBySource[r.source] = r.count;
  return { countsByCategory, countsBySource, total: totalRows[0].n, recent };
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
  getShareBonusToday,
  grantShareBonusToday,
  upsertDailyCategoryScores,
  getCategoryLeaderboard,
  getOnlineProfile,
  upsertOnlineProfile,
  applyDisplayName,
  upsertPaceScore,
  deleteOldIdentityRows,
  migrateSharedGoalIdentity,
  getWeeklyLeague,
  getMyLeagueRank,
  LEAGUE_METRIC_COLUMNS,
  LEAGUE_METRIC_UNITS,
  AVATAR_COLORS,
  cleanDisplayName,
  cleanAvatarColor,
  createSharedDeck,
  updateSharedDeck,
  countOwnSharedDecks,
  listSharedDecks,
  getSharedDeck,
  recordSharedDeckImport,
  deleteSharedDeck,
  reportSharedDeck,
  recordOnboardingSurveyAnswer,
  getOnboardingSurveyStats,
  LEADERBOARD_METRIC_COLUMNS,
};

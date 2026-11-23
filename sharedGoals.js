'use strict';
// ============================================================================
// 共有目標（Shared Goals）— Iteration 3
//   ユーザーが目標を作り、招待コードで友達を呼び、全員で同じ目標・
//   同じペース% を追う。チャットはなし（モデレーション費用のため）
//   — やり取りはスタンプ（絵文字リアクション）のみ。
//
// 競争指標（ユーザーと決定済み）: ペース% のみ。
//   ペース% = 実績 ÷ 今日までの計画量 × 100。サーバーは生のペース%
//   （キャップなし）を返す。表示はクライアントが 100% でキャップし、
//   先行分を「+28% 先行」バッジで別に出す（V11-1）。順位は生値で決める。
//   メンバーのペース% = メンバー貢献量 ÷ メンバーの今日までの計画量
//     （目標量をメンバー数で均等割り）。
//   共有ペース% = 合計貢献量 ÷ 合計の今日までの計画量。
//   週間ペースは月曜時点の目標で計算する（週の途中で目標を緩めても
//   ペースは変わらない）。共有目標の target は作成後変更できない
//   （更新エンドポイントを用意していない）ため、このルールは自動的に満たされる。
//   生の量（単語数・分数）は順位に使わない。
//
// 表示名（V11）: メンバーの表示名は online_profiles の設定名を優先する
//   （未設定なら従来のプレイヤー-xxxx）。設定名の変更は
//   PUT /api/online/profile で shared_goal_members にも反映される。
//
// 共有ストリーク: 全メンバーがその日の勝利条件を満たした日だけ数える。
//   勝利条件 = その日の貢献量が「1人あたりの1日分」以上。
//   逃した日は 0 にリセットしない（ただ増えないだけ＝累計カウント）。
//   TODO(freeze): フリーズ（凍結）で逃した日を修復する経路は未実装。
//   このコードベースにフリーズ機能は存在しない（2026-11-23 時点で
//   grep 確認）。フリーズが追加されたら、ここで「フリーズ消費で
//   共有ストリークの欠けた日を補う」エンドポイントを繋ぐこと。
//
// UNVERIFIED: backend/auth.js と backend/iap.js がこのパックに無いため
//   （server.js が require しているがファイルが存在しない）、このモジュール
//   の認証まわりの動作は未検証。community.js と同じ auth.requireAuth の
//   使い方だけを踏襲しており、認証ロジック自体は一切作っていない。
//   Render 側の実ファイルで auth.requireAuth / req.userId の動きを確認すること。
//   Postgres がこの環境に無いため、エンドポイントのライブ動作も未検証。
//   確認手順はファイル末尾の「Render での確認手順」を参照。
// ============================================================================
const crypto = require('crypto');
// V12.2・A班: コメント本文のチェックは community.js の screenText を流用する
// （URL・連絡先・攻撃的な言葉・ケア対象の文言を同じ基準で弾く）。
const { screenText } = require('./community');

// V6: スタンプ機能は廃止した（POST /api/shared-goals/:id/stamp を削除）。
// shared_goal_stamps テーブルと loadGoalDetail の stamps 読み取りは残置
// （旧データの CASCADE 削除と互換性のため。v6クライアントは表示しない）。
// V12.4・A班: メンバー上限 10人（SHARED_GOAL_MAX_MEMBERS。旧30人。
//   既存の10人超の目標は追い出さない。新規参加だけ止める）。
//   オーナーのキック（POST /:id/kick。オーナーのみ・自分自身は不可。
//   オーナーが抜けるときはキックではなく既存の /leave を使う。
//   所有権は最古メンバーへ移る。最後の1人なら目標ごと消える）。
//   キック記録は shared_goal_kicks に残し、キックされた人は
//   GET /api/shared-goals/kicked で「外されました」と確認できる。
//   今日のノルマ達成率（members[] の todayQuota / todayQuotaRate）。
//   種類ごとの1日分：count/time は dailyTargetPerMember、
//   habit は1日1回のチェックで100%。旧クライアント互換のため
//   新フィールドはオプショナル（無ければクライアントが計算する）。
//   共有目標の公開範囲とコメントは V12.2・A班を参照。
// V12.2・A班: 共有目標の公開範囲（visibility: private/public。未指定・
//   旧データは 'private'）とコメント（shared_goal_comments）。
//   公開目標は GET /api/shared-goals/public で一覧でき、
//   POST /api/shared-goals/:id/join-public でコード無しで参加できる。
//   コメントはメンバーのみ読み書き可、最大500文字、screenText で検査し、
//   通報は community_reports（target_type='shared_goal_comment'）に記録する。
//   既存のデータ構造・業務ロジックは再設計していない（新規オプションフィールド・
//   列と新規エンドポイントの追加のみ）。
// V12・D班: 共有目標の種類（kind）。
//   count=個数ベース（従来通り。unit は自由入力）/ time=時間ベース
//   （target は分。unit は「分」固定）/ habit=習慣チェックベース
//   （target は目標日数。1日1回のチェックで amount=1 を積む。
//   進捗は「5日達成／30日」）。kind は新規オプションフィールドで、
//   未指定・旧データは 'count' として扱う（既存の共有目標は壊さない）。
//   ペース% の計算は種類によらず同じ（貢献合計 ÷ 今日までの計画量）。
//   習慣は contribute で amount=1・1日1回までをサーバーで強制する。

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shared_goals (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  target NUMERIC NOT NULL CHECK (target > 0),
  unit TEXT NOT NULL DEFAULT '',
  deadline DATE NOT NULL,
  start_date DATE NOT NULL DEFAULT CURRENT_DATE,
  invite_code TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- V12・D班: kind は既存テーブルにも後付けする（CREATE TABLE IF NOT EXISTS
-- だけでは既存行に列が増えないため ALTER を併記する）。
ALTER TABLE shared_goals ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'count';
-- V12.2・A班: visibility は kind と同じ後付けパターン。
--   'private'=招待コードのみ（既定・旧データもこれ）/ 'public'=一覧に出て
--   コード無しで参加できる。旧データは ALTER の DEFAULT で 'private' になる。
ALTER TABLE shared_goals ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';
CREATE INDEX IF NOT EXISTS idx_shared_goals_public ON shared_goals (visibility, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shared_goals_owner ON shared_goals (owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shared_goals_code ON shared_goals (invite_code);
CREATE TABLE IF NOT EXISTS shared_goal_members (
  goal_id BIGINT NOT NULL REFERENCES shared_goals(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (goal_id, user_id)
);
CREATE TABLE IF NOT EXISTS shared_goal_contributions (
  id BIGSERIAL PRIMARY KEY,
  goal_id BIGINT NOT NULL REFERENCES shared_goals(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  note TEXT NOT NULL DEFAULT '',
  contributed_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shared_goal_contrib ON shared_goal_contributions (goal_id, user_id, contributed_date);
CREATE TABLE IF NOT EXISTS shared_goal_stamps (
  id BIGSERIAL PRIMARY KEY,
  goal_id BIGINT NOT NULL REFERENCES shared_goals(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  target_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shared_goal_stamps ON shared_goal_stamps (goal_id, created_at DESC);
-- 共通タスク（Iteration 4・班G）：メンバー全員が同じタスクに取り組む。
-- 順位は変えない（ペース%のみで競う）。タスクはチェックリストで、
-- 貢献量（contributions）とは別物。完了は「その日の達成」として
-- メンバー別に数えるだけ。1目標あたり最大30件。
CREATE TABLE IF NOT EXISTS shared_goal_tasks (
  id BIGSERIAL PRIMARY KEY,
  goal_id BIGINT NOT NULL REFERENCES shared_goals(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shared_goal_tasks ON shared_goal_tasks (goal_id, created_at ASC);
CREATE TABLE IF NOT EXISTS shared_goal_task_completions (
  task_id BIGINT NOT NULL REFERENCES shared_goal_tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  completed_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (task_id, user_id, completed_date)
);
CREATE INDEX IF NOT EXISTS idx_shared_goal_task_done ON shared_goal_task_completions (task_id, completed_date);
-- V12.2・A班: 共有目標のコメント。メンバー同士のやり取り用。
--   表示名・アイコンドットは投稿時のスナップショット（rank_comments の
--   author_name と同じ考え方）。hidden / report_count は通報3件での
--   自動非表示用（community_reports のパターンを流用）。
CREATE TABLE IF NOT EXISTS shared_goal_comments (
  id BIGSERIAL PRIMARY KEY,
  goal_id BIGINT NOT NULL REFERENCES shared_goals(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  avatar_color TEXT,
  text TEXT NOT NULL,
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  report_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shared_goal_comments ON shared_goal_comments (goal_id, created_at ASC);
-- V12.4・A班: キック記録。キックされた人が次回開いたときに
-- 「外されました」と分かるように残す（GET /api/shared-goals/kicked）。
-- 再参加したら行を消す（join 時に DELETE）。目標が消えたら CASCADE で消える。
CREATE TABLE IF NOT EXISTS shared_goal_kicks (
  goal_id BIGINT NOT NULL REFERENCES shared_goals(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  kicked_by TEXT NOT NULL,
  kicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (goal_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_shared_goal_kicks_user ON shared_goal_kicks (user_id, kicked_at DESC);
`;

// ---------- 小さな道具（community.js と同じ流儀） ----------
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { buckets.set(key, arr); return true; }
  arr.push(now);
  buckets.set(key, arr);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) { if (!v.length || now - v[v.length - 1] > 3600 * 1000) buckets.delete(k); }
}, 10 * 60 * 1000).unref();

const clean = (v, max) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, max) : '');
const oneLine = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const isId = (v) => /^\d{1,18}$/.test(String(v));
const anonName = (uid) => 'プレイヤー-' + crypto.createHash('sha256').update(String(uid)).digest('hex').slice(0, 4);

const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 紛らわしい文字(0/O, 1/I/L)を除外（db.js の招待コードと同じ）

// V12・D班: 共有目標の種類。count=個数 / time=時間（分）/ habit=習慣チェック（日数）。
const SHARED_GOAL_KINDS = ['count', 'time', 'habit'];
// V12.4・A班: 共有目標のメンバー上限。v12.2 までは 30人だった。
// 既存の10人超の目標は追い出さない（新規参加だけ止める）。
const SHARED_GOAL_MAX_MEMBERS = 10;
const normalizeKind = (v) => (SHARED_GOAL_KINDS.includes(v) ? v : 'count');
// V12.2・A班: 共有目標の公開範囲。'public' のときだけ公開、
// 未指定・不正値は 'private'（旧データも 'private' 扱い）。
const SHARED_GOAL_VISIBILITIES = ['private', 'public'];
const normalizeVisibility = (v) => (v === 'public' ? 'public' : 'private');
// 種類ごとの単位（time は「分」固定、habit は単位なし、count は入力通り）。
const unitForKind = (kind, unit) => {
  if (kind === 'time') return '分';
  if (kind === 'habit') return '';
  return unit || '';
};
function randomInviteCode() {
  let out = '';
  for (let i = 0; i < 8; i++) out += INVITE_ALPHABET[Math.floor(Math.random() * INVITE_ALPHABET.length)];
  return out;
}

function parseDay(s) {
  // node-postgres は DATE カラムを JS の Date オブジェクトとして返す。
  // そのまま String() すると 'Mon Nov 23 2026 ...' になり正規表現に
  // 一致せず null になるため、Date も受け取れるようにする（v5 修正）。
  // 文字列は従来通り 'YYYY-MM-DD' の厳密な形式のみ受け付ける
  // （クライアントからの deadline バリデーション用途を維持するため、
  //  'YYYY-MM-DDTHH...' のような ISO 文字列はここでは通さない）。
  if (s instanceof Date) {
    if (Number.isNaN(s.getTime())) return null;
    return new Date(s.getFullYear(), s.getMonth(), s.getDate());
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}
// Date -> 'YYYY-MM-DD'（返却値用。クライアントの pace.ts の parseDay は
// この形式しか読めないため、deadline / startDate に ISO 文字列は返さない）。
function formatDay(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mo}-${day}`;
}
// 'YYYY-MM-DD' 文字列はそのまま、Date は formatDay で文字列化する。
// SQL 側で to_char 済みなら文字列が来るので、そのまま通る。
function dayString(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Date) return formatDay(v);
  return null;
}
function daysBetween(a, b) {
  // null / 不正な値が来ても例外にしない（v5 修正。修正前は
  // daysBetween(null, null) が a.getFullYear() で TypeError になり、
  // wrap が 503 を返していた）。呼び出し側は 0 日として扱う。
  if (!(a instanceof Date) || !(b instanceof Date)) return 0;
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((utcB - utcA) / 86400000);
}
// V11: ペース% は生値（キャップなし）で返す。表示の 100% キャップ＋
// 「先行」バッジはクライアント側（src/utils/pace.ts の displayPace /
// aheadLabel）で行う。順位はこの生値で決める。
function rawPace(v) {
  if (!Number.isFinite(v) || v <= 0) return 0;
  return v;
}
// 今日までの計画量（src/utils/pace.ts の plannedByToday と同じ定義）。
function plannedByToday(target, startDate, deadline, today) {
  const start = parseDay(startDate);
  const end = parseDay(deadline);
  const now = parseDay(today);
  if (!start || !end || !now || !(target > 0)) return 0;
  const totalDays = Math.max(1, daysBetween(start, end) + 1);
  const elapsed = Math.min(Math.max(daysBetween(start, now) + 1, 0), totalDays);
  return (target * elapsed) / totalDays;
}

function register({ app, db, auth }) {
  let ready = null;
  function ensure() {
    if (!db.pool) return Promise.reject(new Error('DB disabled'));
    if (!ready) ready = db.pool.query(SCHEMA).catch((e) => { ready = null; throw e; });
    return ready;
  }
  const q = (text, params) => db.pool.query(text, params);

  // リクエストID: 503 の原因追及用。レスポンスに含め、ログにも出す。
  // crypto.randomUUID() は Node 14.17+ で利用可。
  function newRequestId() {
    return typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString('hex');
  }

  const wrap = (fn) => async (req, res) => {
    const requestId = newRequestId();
    req.requestId = requestId;
    try {
      try { await ensure(); } catch (e) { e.step = e.step || 'ensure-schema'; throw e; }
      await fn(req, res);
    }
    catch (e) {
      // 失敗箇所: e.step が付いていればそれを使う（loadGoalDetail /
      // 作成トランザクションなどが設定する）。無ければハンドラ名。
      const step = e.step || fn.name || 'handler';
      const userId = req.userId ? String(req.userId) : 'unknown';
      // 内部詳細（スタック・SQL）はログだけに出し、レスポンスには出さない。
      console.error('[shared-goals] requestId=%s %s %s user=%s step=%s error=%s',
        requestId, req.method, req.path, userId, step, e.message);
      if (e.stack) console.error('[shared-goals] requestId=%s stack: %s', requestId, e.stack);
      if (!res.headersSent) {
        // DB 自体が無効/未接続なら種別を分ける（再試行しても直らない系）。
        const code = e.message === 'DB disabled' ? 'DB_UNAVAILABLE' : 'SERVER_ERROR';
        res.status(503).json({
          error: 'いま利用できません。時間をおいて再度お試しください。',
          code,
          requestId,
        });
      }
    }
  };

  async function isMember(goalId, userId) {
    const r = await q('SELECT 1 FROM shared_goal_members WHERE goal_id = $1 AND user_id = $2', [goalId, userId]);
    return r.rowCount > 0;
  }

  // V11: メンバーの表示名は online_profiles の設定名を優先する
  // （未設定なら従来のプレイヤー-xxxx）。
  async function displayNameFor(uid) {
    try {
      const profile = await db.getOnlineProfile(uid);
      if (profile && profile.displayName) return profile.displayName;
    } catch (_) { /* 取れなくても匿名名で作る */ }
    return anonName(uid);
  }

  // V12.2・A班: コメント投稿者のアイコンドット（online_profiles の設定色。
  // 未設定なら null＝クライアントが既定色で表示する）。
  async function avatarColorFor(uid) {
    try {
      const profile = await db.getOnlineProfile(uid);
      if (profile && profile.avatarColor) return profile.avatarColor;
    } catch (_) { /* 取れなくても null で作る */ }
    return null;
  }

  // 目標1件分の集計（メンバー・貢献・スタンプ・ペース%・共有ストリーク・共通タスク）。
  // today はサーバー日付（CURRENT_DATE）。週のペースは月曜時点の目標で
  // 計算するルールだが、target は不変のため当日分でそのまま満たされる。
  // viewerUserId（任意）：タスクの doneToday（閲覧者が今日完了したか）を
  // 付けるために使う。未指定なら全タスク doneToday=false。
  // loadGoalDetail で例外が起きたとき、wrap のログに失敗箇所が出るよう
  // step を付けて投げ直す（v5 修正）。
  async function loadGoalDetail(goalId, viewerUserId) {
    try {
      return await loadGoalDetailInner(goalId, viewerUserId);
    } catch (e) {
      e.step = e.step || 'loadGoalDetail';
      throw e;
    }
  }

  async function loadGoalDetailInner(goalId, viewerUserId) {
    const g = await q(
      `SELECT id, owner_user_id, title, target, unit, kind, visibility,
              to_char(deadline, 'YYYY-MM-DD') AS deadline,
              to_char(start_date, 'YYYY-MM-DD') AS start_date,
              invite_code, created_at,
              to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today
       FROM shared_goals WHERE id = $1`,
      [goalId]);
    if (!g.rowCount) return null;
    const goal = g.rows[0];
    const target = Number(goal.target);
    const members = await q(
      `SELECT user_id, display_name, joined_at FROM shared_goal_members
       WHERE goal_id = $1 ORDER BY joined_at ASC`,
      [goalId]);
    const contribs = await q(
      `SELECT id, user_id, amount, note,
              to_char(contributed_date, 'YYYY-MM-DD') AS contributed_date,
              created_at
       FROM shared_goal_contributions WHERE goal_id = $1 ORDER BY contributed_date DESC, created_at DESC LIMIT 200`,
      [goalId]);
    const stamps = await q(
      `SELECT id, user_id, emoji, target_user_id, created_at
       FROM shared_goal_stamps WHERE goal_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [goalId]);

    const memberCount = members.rows.length;
    const startDay = parseDay(goal.start_date);
    const endDay = parseDay(goal.deadline);
    const planned = plannedByToday(target, goal.start_date, goal.deadline, goal.today);
    // start/end が読めない（想定外の値の）ときは totalDays=1 に倒す。
    // 修正前はここで daysBetween(parseDay(...), parseDay(...)) を
    // ガード無しに呼び、node-postgres が返す Date オブジェクトが
    // parseDay で null になって TypeError → 全エンドポイント 503 だった。
    const totalDays = startDay && endDay
      ? Math.max(1, daysBetween(startDay, endDay) + 1)
      : 1;
    const dailyTarget = memberCount > 0 ? target / memberCount / totalDays : 0;

    // メンバー別: 貢献合計・今日の貢献・ペース%
    const byUser = {};
    for (const c of contribs.rows) {
      const uid = c.user_id;
      byUser[uid] = byUser[uid] || { total: 0, today: 0, winDates: new Set() };
      byUser[uid].total += Number(c.amount);
    }
    // 日別・ユーザー別の合計（勝利判定用）
    const perDay = await q(
      `SELECT user_id, to_char(contributed_date, 'YYYY-MM-DD') AS d, SUM(amount)::float AS amt
       FROM shared_goal_contributions WHERE goal_id = $1 GROUP BY user_id, contributed_date`,
      [goalId]);
    for (const row of perDay.rows) {
      const uid = row.user_id;
      byUser[uid] = byUser[uid] || { total: 0, today: 0, winDates: new Set() };
      if (row.d === goal.today) byUser[uid].today += row.amt;
      if (row.amt >= dailyTarget && dailyTarget > 0) byUser[uid].winDates.add(row.d);
    }
    // V12.2・A班: メンバーごとの直近の活動日時（lastActiveAt）。
    // 貢献の記録・共通タスクの完了のうち最新のもの。どちらも無ければ参加日時。
    const lastActiveRows = await q(
      `SELECT user_id, MAX(created_at) AS last_active FROM (
         SELECT user_id, created_at FROM shared_goal_contributions WHERE goal_id = $1
         UNION ALL
         SELECT tc.user_id, tc.created_at FROM shared_goal_task_completions tc
           JOIN shared_goal_tasks t ON t.id = tc.task_id WHERE t.goal_id = $1
       ) s GROUP BY user_id`,
      [goalId]);
    const lastActiveByUser = {};
    for (const r of lastActiveRows.rows) lastActiveByUser[r.user_id] = r.last_active;
    // 共有ストリーク: 全メンバーが勝利した日の累計（逃した日は 0 に戻さない）
    let sharedWinDates = [];
    if (memberCount > 0) {
      const all = new Set();
      Object.values(byUser).forEach((u) => u.winDates.forEach((d) => all.add(d)));
      sharedWinDates = [...all].filter((d) => members.rows.every((m) => (byUser[m.user_id] || { winDates: new Set() }).winDates.has(d))).sort();
    }

    const memberList = members.rows.map((m) => {
      const u = byUser[m.user_id] || { total: 0, today: 0, winDates: new Set() };
      const memberPlanned = memberCount > 0 ? planned / memberCount : 0;
      // V12.4・A班: 今日のノルマ達成率（個数ベースではなくノルマ中心）。
      // todayQuota = その人の今日のノルマ量（count/time は
      // dailyTargetPerMember、habit は1日1回のチェック＝1）。
      // todayQuotaRate = 今日の貢献 ÷ 今日のノルマ × 100（0〜100でキャップ。
      // habit は今日1回チェックしたら 100%）。ノルマが 0 の
      // ときは貢献があれば 100%、無ければ 0%。
      const isHabit = normalizeKind(goal.kind) === 'habit';
      const todayQuota = isHabit ? 1 : dailyTarget;
      const todayQuotaRate = isHabit
        ? (u.today > 0 ? 100 : 0)
        : (todayQuota > 0
            ? Math.min(100, Math.round((u.today / todayQuota) * 100))
            : (u.today > 0 ? 100 : 0));
      return {
        userId: m.user_id,
        displayName: m.display_name || anonName(m.user_id),
        contribution: u.total,
        todayContribution: u.today,
        pacePercent: memberPlanned > 0 ? rawPace((u.total / memberPlanned) * 100) : (u.total > 0 ? 100 : 0),
        // V12.4・A班: 今日のノルマとその達成率（旧クライアント互換のため
        // オプショナル。無ければクライアントが同じ式で計算する）。
        todayQuota,
        todayQuotaRate,
        wonToday: u.winDates.has(goal.today),
        // V12.2・A班: 直近の活動日時（貢献・タスク完了の最新。無ければ参加日時）。
        lastActiveAt: lastActiveByUser[m.user_id] || m.joined_at,
        // 共通タスク：そのメンバーが今日完了したタスク数（後で tasks から数えて入れる）
        tasksDoneToday: 0,
        isOwner: m.user_id === goal.owner_user_id,
        joinedAt: m.joined_at,
      };
    });
    // 共有目標内の順位はペース% 順（生値。表示は 100% キャップ＋先行バッジ）。
    memberList.sort((a, b) => b.pacePercent - a.pacePercent || b.contribution - a.contribution);

    // 共通タスク（Iteration 4）：一覧＋今日の完了者。完了は当日のみ有効
    // （completed_date = CURRENT_DATE の行だけを数える）。
    const taskRows = await q(
      `SELECT id, title, created_by, created_at FROM shared_goal_tasks
       WHERE goal_id = $1 ORDER BY created_at ASC, id ASC LIMIT 30`,
      [goalId]);
    const doneRows = taskRows.rowCount
      ? await q(
          `SELECT task_id, user_id FROM shared_goal_task_completions
           WHERE task_id = ANY($1::bigint[]) AND completed_date = CURRENT_DATE`,
          [taskRows.rows.map((t) => t.id)])
      : { rows: [] };
    const doneByTask = {};
    for (const r of doneRows.rows) {
      (doneByTask[String(r.task_id)] = doneByTask[String(r.task_id)] || []).push(r.user_id);
    }
    const tasks = taskRows.rows.map((t) => {
      const done = doneByTask[String(t.id)] || [];
      return {
        id: String(t.id),
        title: t.title,
        createdBy: t.created_by,
        createdAt: t.created_at,
        completedByToday: done,
        doneTodayCount: done.length,
        doneToday: viewerUserId ? done.includes(String(viewerUserId)) : false,
      };
    });
    for (const m of memberList) {
      m.tasksDoneToday = tasks.filter((t) => t.completedByToday.includes(m.userId)).length;
    }

    const totalContribution = memberList.reduce((s, m) => s + m.contribution, 0);
    // V12・D班: 閲覧者（自分）の今日の貢献量。習慣チェックの「今日やった」
    // 表示（済みならボタンを押せない）に使う。未指定なら 0。
    const myTodayContribution = viewerUserId
      ? (byUser[String(viewerUserId)] || { today: 0 }).today
      : 0;
    return {
      id: String(goal.id),
      title: goal.title,
      target,
      unit: goal.unit || '',
      // V12・D班: 種類。旧データは 'count'（DB の DEFAULT と同じ）。
      kind: normalizeKind(goal.kind),
      // V12.2・A班: 公開範囲。旧データは 'private'（DB の DEFAULT と同じ）。
      visibility: normalizeVisibility(goal.visibility),
      deadline: dayString(goal.deadline),
      startDate: dayString(goal.start_date),
      inviteCode: goal.invite_code,
      createdAt: goal.created_at,
      isOwner: false, // 呼び出し側で上書きする（自分の行かどうかはここでは分からない）
      memberCount,
      // V12.4・A班: メンバー上限（10人）。クライアントは満員表示に使う。
      maxMembers: SHARED_GOAL_MAX_MEMBERS,
      totalContribution,
      myTodayContribution,
      plannedByToday: planned,
      pacePercent: planned > 0 ? rawPace((totalContribution / planned) * 100) : (totalContribution > 0 ? 100 : 0),
      dailyTargetPerMember: dailyTarget,
      sharedStreakDays: sharedWinDates.length,
      sharedWinDates,
      lastSharedWinDate: sharedWinDates.length ? sharedWinDates[sharedWinDates.length - 1] : null,
      members: memberList,
      contributions: contribs.rows.map((c) => ({
        id: String(c.id), userId: c.user_id, amount: Number(c.amount), note: c.note || '',
        date: dayString(c.contributed_date), createdAt: c.created_at,
      })),
      stamps: stamps.rows.map((s) => ({
        id: String(s.id), userId: s.user_id, emoji: s.emoji,
        targetUserId: s.target_user_id || null, createdAt: s.created_at,
      })),
      // 共通タスク（メンバー全員が同じタスクに取り組む。順位はペース%のまま）
      tasks,
    };
  }

  // ---- アカウント削除のとき、共有目標のメンバー・貢献・スタンプも消す ----
  // community.js と同じく、server.js の DELETE /api/account より先に登録
  // されるため next() で後続の削除処理へ渡す。オーナーが抜ける場合は
  // 最も古いメンバーへ所有権を移し、誰も残らなければ目標ごと消す。
  app.delete('/api/account', auth.requireAuth, async (req, res, next) => {
    try {
      if (db.pool) {
        await ensure();
        const uid = String(req.userId);
        const owned = await q('SELECT id FROM shared_goals WHERE owner_user_id = $1', [uid]);
        await q('DELETE FROM shared_goal_contributions WHERE user_id = $1', [uid]);
        await q('DELETE FROM shared_goal_comments WHERE user_id = $1', [uid]);
        await q('DELETE FROM shared_goal_stamps WHERE user_id = $1 OR target_user_id = $1', [uid]);
        await q('DELETE FROM shared_goal_task_completions WHERE user_id = $1', [uid]);
        await q('DELETE FROM shared_goal_members WHERE user_id = $1', [uid]);
        for (const row of owned.rows) {
          const rest = await q('SELECT user_id FROM shared_goal_members WHERE goal_id = $1 ORDER BY joined_at ASC LIMIT 1', [row.id]);
          if (rest.rowCount) {
            await q('UPDATE shared_goals SET owner_user_id = $1 WHERE id = $2', [rest.rows[0].user_id, row.id]);
          } else {
            await q('DELETE FROM shared_goals WHERE id = $1', [row.id]);
          }
        }
      }
    } catch (e) { console.error('[shared-goals] purge failed:', e.message); }
    next();
  });

  // ================= 共有目標の作成・参加 =================
  app.post('/api/shared-goals', auth.requireAuth, wrap(async (req, res) => {
    const uid = String(req.userId);
    if (limited('sg:create:' + uid, 10, 3600 * 1000)) return res.status(429).json({ error: '作成が多すぎます。少し時間をおいてください。' });
    const b = req.body || {};
    const title = oneLine(b.title, 80);
    const target = Number(b.target);
    // V12・D班: kind（count/time/habit。未指定・不正値は 'count'）。
    // time は unit「分」固定、habit は unit なし・target は目標日数（1〜365）。
    const kind = normalizeKind(b.kind);
    // V12.2・A班: visibility（private/public。未指定・不正値は 'private'）。
    const visibility = normalizeVisibility(b.visibility);
    const unit = unitForKind(kind, oneLine(b.unit, 20));
    const deadline = String(b.deadline || '');
    if (!title) return res.status(400).json({ error: 'タイトルを入力してください。' });
    if (!Number.isFinite(target) || target <= 0 || target > 100000000) return res.status(400).json({ error: '目標量は 0 より大きい数で入力してください。' });
    if (kind === 'habit' && target > 365) return res.status(400).json({ error: '習慣の目標日数は 365日までです。' });
    if (!parseDay(deadline)) return res.status(400).json({ error: '期限は YYYY-MM-DD で入力してください。' });
    if (parseDay(deadline) < parseDay(new Date().toISOString().slice(0, 10))) return res.status(400).json({ error: '期限は今日以降にしてください。' });
    const mine = await q('SELECT COUNT(*)::int AS n FROM shared_goals WHERE owner_user_id = $1', [uid]);
    if (mine.rows[0].n >= 20) return res.status(400).json({ error: '作れる共有目標は20個までです。' });
    // 目標＋メンバーの INSERT は1トランザクションにする（v5 修正）。
    // 修正前は INSERT 成功後に loadGoalDetail が例外を投げると目標だけ
    // DB に残り、次回作成時も20個上限のカウントに入る「ゴミ目標」に
    // なっていた。leave ハンドラと同じ client.query('BEGIN') の流儀。
    // V11: 作成者の表示名はプロフィールの設定名を優先する。
    const creatorName = await displayNameFor(uid);
    let goalId = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomInviteCode();
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        const ins = await client.query(
          `INSERT INTO shared_goals (owner_user_id, title, target, unit, kind, visibility, deadline, invite_code)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [uid, title, target, unit, kind, visibility, deadline, code]);
        goalId = ins.rows[0].id;
        await client.query('INSERT INTO shared_goal_members (goal_id, user_id, display_name) VALUES ($1, $2, $3)',
          [goalId, uid, creatorName]);
        await client.query('COMMIT');
        break;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        goalId = null;
        if (e.code !== '23505') { e.step = 'create-insert'; throw e; } // 招待コード重複だけ再試行
      } finally {
        client.release();
      }
    }
    if (!goalId) {
      return res.status(503).json({
        error: '招待コードを作れませんでした。もう一度お試しください。',
        code: 'SERVER_ERROR',
        requestId: req.requestId,
      });
    }
    // 集計（loadGoalDetail）が失敗したら、作った目標を消してから 503 に
    // する。残すと「作れませんでした」と言われながら DB に目標だけ残り、
    // 20個上限のカウントに入り続けるため。
    let detail;
    try {
      detail = await loadGoalDetail(goalId, uid);
    } catch (e) {
      await q('DELETE FROM shared_goals WHERE id = $1', [goalId]).catch(() => {});
      throw e;
    }
    if (!detail) {
      await q('DELETE FROM shared_goals WHERE id = $1', [goalId]).catch(() => {});
      return res.status(503).json({
        error: 'いま利用できません。時間をおいて再度お試しください。',
        code: 'SERVER_ERROR',
        requestId: req.requestId,
      });
    }
    detail.isOwner = true;
    return res.json({ goal: detail });
  }));

  // 自分が参加している共有目標の一覧（ペース%・共有ストリーク付き）
  app.get('/api/shared-goals', auth.requireAuth, wrap(async (req, res) => {
    const uid = String(req.userId);
    const ids = await q(
      `SELECT goal_id FROM shared_goal_members WHERE user_id = $1 ORDER BY joined_at DESC LIMIT 50`,
      [uid]);
    const goals = [];
    for (const row of ids.rows) {
      const detail = await loadGoalDetail(row.goal_id, uid);
      if (detail) {
        detail.isOwner = detail.members.some((m) => m.userId === uid && m.isOwner);
        // 一覧では貢献履歴・スタンプ履歴は返さない（軽量化）
        delete detail.contributions;
        delete detail.stamps;
        goals.push(detail);
      }
    }
    res.json({ goals });
  }));

  // V12.2・A班: 公開中の共有目標の一覧（誰でも見られる。参加には別途
  // POST /:id/join-public を使う）。visibility='public' のものだけを
  // 作成日降順で返す。q があればタイトルで部分一致検索。
  // V12.4・A班: kind で種類フィルター（count/time/habit。不正値は無視＝
  // 全種類）。各行に maxMembers（10人）と isFull（満員か）を付ける。
  // NOTE: GET /api/shared-goals/:id より前に置くこと（'public' が :id に
  // 取られないように）。ペース% は loadGoalDetail と同じ定義
  // （貢献合計 ÷ 今日までの計画量。生値・キャップなし）。
  app.get('/api/shared-goals/public', auth.requireAuth, wrap(async (req, res) => {
    const search = oneLine(req.query.q, 60);
    // LIKE の特殊文字をエスケープして、入力した文字そのものを検索する
    const pattern = search ? '%' + search.replace(/[\\%_]/g, (m) => '\\' + m) + '%' : null;
    const kindFilter = SHARED_GOAL_KINDS.includes(String(req.query.kind || '')) ? String(req.query.kind) : null;
    const limit = Math.max(1, Math.min(50, Math.floor(Number(req.query.limit) || 20)));
    const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
    const rows = await q(
      `SELECT g.id, g.owner_user_id, g.title, g.target, g.unit, g.kind,
              to_char(g.deadline, 'YYYY-MM-DD') AS deadline,
              to_char(g.start_date, 'YYYY-MM-DD') AS start_date,
              g.created_at,
              to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today,
              (SELECT display_name FROM shared_goal_members m
                WHERE m.goal_id = g.id AND m.user_id = g.owner_user_id) AS owner_display_name,
              (SELECT COUNT(*)::int FROM shared_goal_members m WHERE m.goal_id = g.id) AS member_count,
              (SELECT COALESCE(SUM(amount), 0)::float FROM shared_goal_contributions c WHERE c.goal_id = g.id) AS total_contribution
       FROM shared_goals g
       WHERE g.visibility = 'public'
         AND ($1::text IS NULL OR g.title ILIKE $1::text)
         AND ($4::text IS NULL OR g.kind = $4::text)
       ORDER BY g.created_at DESC LIMIT $2 OFFSET $3`,
      [pattern, limit + 1, offset, kindFilter]);
    const hasMore = rows.rowCount > limit;
    const page = hasMore ? rows.rows.slice(0, limit) : rows.rows;
    const goals = page.map((r) => {
      const target = Number(r.target);
      const planned = plannedByToday(target, r.start_date, r.deadline, r.today);
      const total = Number(r.total_contribution) || 0;
      const memberCount = Number(r.member_count) || 0;
      return {
        id: String(r.id),
        title: r.title,
        kind: normalizeKind(r.kind),
        unit: r.unit || '',
        target,
        deadline: dayString(r.deadline),
        visibility: 'public',
        memberCount,
        maxMembers: SHARED_GOAL_MAX_MEMBERS,
        isFull: memberCount >= SHARED_GOAL_MAX_MEMBERS,
        pacePercent: planned > 0 ? rawPace((total / planned) * 100) : (total > 0 ? 100 : 0),
        ownerDisplayName: r.owner_display_name || anonName(r.owner_user_id),
        createdAt: r.created_at,
      };
    });
    res.json({ goals, hasMore, nextOffset: hasMore ? offset + limit : offset + goals.length });
  }));

  // V12.4・A班: 自分がキックされた共有目標の一覧（「外されました」の案内用）。
  // キックされた人はメンバー一覧から消えるため、GET /:id では 403 になって
  // 理由が分からない。ここでタイトル・外した人・日時を返す。再参加したら
  // 記録は消える（join 時に DELETE）。確認済みのものはクライアントが
  // AsyncStorage で覚えて表示しない（サーバー側では消さない）。
  // NOTE: GET /api/shared-goals/:id より前に置くこと（'kicked' が :id に
  // 取られないように）。
  app.get('/api/shared-goals/kicked', auth.requireAuth, wrap(async (req, res) => {
    const uid = String(req.userId);
    const rows = await q(
      `SELECT k.goal_id, k.kicked_at, g.title,
              (SELECT display_name FROM shared_goal_members m
                WHERE m.goal_id = k.goal_id AND m.user_id = k.kicked_by) AS kicked_by_name
       FROM shared_goal_kicks k
       JOIN shared_goals g ON g.id = k.goal_id
       WHERE k.user_id = $1
       ORDER BY k.kicked_at DESC LIMIT 20`,
      [uid]);
    res.json({
      kicked: rows.rows.map((r) => ({
        goalId: String(r.goal_id),
        title: r.title,
        kickedAt: r.kicked_at,
        kickedByDisplayName: r.kicked_by_name || '',
      })),
    });
  }));

  app.get('/api/shared-goals/:id', auth.requireAuth, wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: '不正なIDです。' });
    const uid = String(req.userId);
    if (!(await isMember(req.params.id, uid))) return res.status(403).json({ error: 'この共有目標のメンバーではありません。' });
    const detail = await loadGoalDetail(req.params.id, uid);
    if (!detail) return res.status(404).json({ error: '共有目標が見つかりません。' });
    detail.isOwner = detail.members.some((m) => m.userId === uid && m.isOwner);
    res.json({ goal: detail });
  }));

  // 招待コードで参加（コードは大文字・英数字のみに正規化）
  app.post('/api/shared-goals/join', auth.requireAuth, wrap(async (req, res) => {
    const uid = String(req.userId);
    const code = String((req.body && req.body.code) || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 8) return res.status(400).json({ error: '招待コードは8文字です。', code: 'INVALID_CODE' });
    const g = await q('SELECT id FROM shared_goals WHERE invite_code = $1', [code]);
    if (!g.rowCount) return res.status(404).json({ error: '招待コードが見つかりません。', code: 'INVALID_CODE' });
    const goalId = g.rows[0].id;
    if (await isMember(goalId, uid)) {
      const detail = await loadGoalDetail(goalId, uid);
      if (!detail) return res.status(404).json({ error: '共有目標が見つかりません。' });
      detail.isOwner = detail.members.some((m) => m.userId === uid && m.isOwner);
      return res.json({ goal: detail, alreadyMember: true });
    }
    const cnt = await q('SELECT COUNT(*)::int AS n FROM shared_goal_members WHERE goal_id = $1', [goalId]);
    // V12.4・A班: メンバー上限は 10人。既存の10人超の目標は追い出さない
    // （新規参加だけ止める）。
    if (cnt.rows[0].n >= SHARED_GOAL_MAX_MEMBERS) return res.status(400).json({ error: 'この共有目標は満員です（10人まで）。' });
    await q('INSERT INTO shared_goal_members (goal_id, user_id, display_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [goalId, uid, await displayNameFor(uid)]);
    // V12.4・A班: 過去にキックされた記録があれば、再参加で消す
    // （「外されました」の案内を出し続けないため）。
    await q('DELETE FROM shared_goal_kicks WHERE goal_id = $1 AND user_id = $2', [goalId, uid]);
    const detail = await loadGoalDetail(goalId, uid);
    if (!detail) return res.status(404).json({ error: '共有目標が見つかりません。' });
    detail.isOwner = false;
    res.json({ goal: detail, alreadyMember: false });
  }));

  // V12.2・A班: 公開目標に招待コード無しで参加する。返す形はコード参加と
  // 同じ（{ goal, alreadyMember }）。対象がプライベートなら 403。
  // メンバー数上限（10人）はコード参加と同じものを適用する。
  app.post('/api/shared-goals/:id/join-public', auth.requireAuth, wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: '不正なIDです。' });
    const uid = String(req.userId);
    const g = await q('SELECT id, visibility FROM shared_goals WHERE id = $1', [req.params.id]);
    if (!g.rowCount) return res.status(404).json({ error: '共有目標が見つかりません。' });
    if (normalizeVisibility(g.rows[0].visibility) !== 'public') {
      return res.status(403).json({ error: 'この共有目標は招待コードでのみ参加できます。' });
    }
    const goalId = g.rows[0].id;
    if (await isMember(goalId, uid)) {
      const detail = await loadGoalDetail(goalId, uid);
      if (!detail) return res.status(404).json({ error: '共有目標が見つかりません。' });
      detail.isOwner = detail.members.some((m) => m.userId === uid && m.isOwner);
      return res.json({ goal: detail, alreadyMember: true });
    }
    const cnt = await q('SELECT COUNT(*)::int AS n FROM shared_goal_members WHERE goal_id = $1', [goalId]);
    if (cnt.rows[0].n >= SHARED_GOAL_MAX_MEMBERS) return res.status(400).json({ error: 'この共有目標は満員です（10人まで）。' });
    await q('INSERT INTO shared_goal_members (goal_id, user_id, display_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [goalId, uid, await displayNameFor(uid)]);
    // V12.4・A班: 過去にキックされた記録があれば、再参加で消す。
    await q('DELETE FROM shared_goal_kicks WHERE goal_id = $1 AND user_id = $2', [goalId, uid]);
    const detail = await loadGoalDetail(goalId, uid);
    if (!detail) return res.status(404).json({ error: '共有目標が見つかりません。' });
    detail.isOwner = false;
    res.json({ goal: detail, alreadyMember: false });
  }));

  // ================= 共有目標のコメント（V12.2・A班） =================
  // メンバー同士のやり取り用。読み書きともメンバーのみ。
  // 表示名・アイコンドットは投稿時のスナップショット。
  const shapeComment = (r) => ({
    id: String(r.id),
    displayName: r.display_name || anonName(r.user_id),
    avatarColor: r.avatar_color || null,
    text: r.text,
    createdAt: r.created_at,
  });

  // コメント一覧（古い順。通報で非表示になったものは出さない）。
  app.get('/api/shared-goals/:id/comments', auth.requireAuth, wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: '不正なIDです。' });
    const uid = String(req.userId);
    if (!(await isMember(req.params.id, uid))) return res.status(403).json({ error: 'この共有目標のメンバーではありません。' });
    const limit = Math.max(1, Math.min(50, Math.floor(Number(req.query.limit) || 20)));
    const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
    const rows = await q(
      `SELECT id, user_id, display_name, avatar_color, text, created_at
       FROM shared_goal_comments
       WHERE goal_id = $1 AND hidden = FALSE
       ORDER BY created_at ASC, id ASC LIMIT $2 OFFSET $3`,
      [req.params.id, limit + 1, offset]);
    const hasMore = rows.rowCount > limit;
    const page = hasMore ? rows.rows.slice(0, limit) : rows.rows;
    res.json({ comments: page.map(shapeComment), hasMore, nextOffset: hasMore ? offset + limit : offset + page.length });
  }));

  // コメントを投稿する（最大500文字。community.js の screenText と同じチェック）。
  app.post('/api/shared-goals/:id/comments', auth.requireAuth, wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: '不正なIDです。' });
    const uid = String(req.userId);
    if (limited('sg:comment:' + uid, 20, 10 * 60 * 1000)) return res.status(429).json({ error: '操作が多すぎます。少し時間をおいてください。' });
    if (!(await isMember(req.params.id, uid))) return res.status(403).json({ error: 'この共有目標のメンバーではありません。' });
    const text = clean(req.body && req.body.text, 500);
    if (!text) return res.status(400).json({ error: 'コメントを入力してください。' });
    if (Array.from(text).length > 500) return res.status(400).json({ error: 'コメントは500文字までです。' });
    const s = screenText(text);
    if (!s.ok) return res.status(422).json({ error: s.error, code: s.code });
    const ins = await q(
      `INSERT INTO shared_goal_comments (goal_id, user_id, display_name, avatar_color, text)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, user_id, display_name, avatar_color, text, created_at`,
      [req.params.id, uid, await displayNameFor(uid), await avatarColorFor(uid), text]);
    res.json({ comment: shapeComment(ins.rows[0]) });
  }));

  // コメントを通報する。community_reports に種別 'shared_goal_comment' で
  // 記録する（投稿 'post'・ランキングひとこと 'comment' と区別できる値）。
  // 通報3件で自動非表示（community.js の REPORT_HIDE_THRESHOLD と同じ3件）。
  app.post('/api/shared-goals/:id/comments/:commentId/report', auth.requireAuth, wrap(async (req, res) => {
    if (!isId(req.params.id) || !isId(req.params.commentId)) return res.status(400).json({ error: '不正なIDです。' });
    const uid = String(req.userId);
    if (limited('sg:comment-report:' + uid, 20, 3600 * 1000)) return res.status(429).json({ error: '通報が多すぎます。' });
    if (!(await isMember(req.params.id, uid))) return res.status(403).json({ error: 'この共有目標のメンバーではありません。' });
    const found = await q(
      'SELECT id, user_id FROM shared_goal_comments WHERE id = $1 AND goal_id = $2',
      [req.params.commentId, req.params.id]);
    if (!found.rowCount) return res.status(404).json({ error: 'コメントが見つかりません。' });
    if (found.rows[0].user_id === uid) return res.status(400).json({ error: '自分のコメントは通報できません。' });
    const reason = oneLine(req.body && req.body.reason, 100) || '不適切な内容';
    const ins = await q(
      `INSERT INTO community_reports (target_type, target_id, reporter_user_id, reason)
       VALUES ('shared_goal_comment', $1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`,
      [req.params.commentId, uid, reason]);
    if (ins.rowCount) {
      const cnt = await q(
        "SELECT COUNT(*)::int AS c FROM community_reports WHERE target_type = 'shared_goal_comment' AND target_id = $1",
        [req.params.commentId]);
      await q(
        `UPDATE shared_goal_comments SET report_count = $2::int,
           hidden = (hidden OR $2::int >= 3)
         WHERE id = $1`,
        [req.params.commentId, cnt.rows[0].c]);
    }
    res.json({ ok: true });
  }));

  // 貢献を記録する。日付はサーバー当日固定（過去への書き込みで
  // ペース% を操作できないようにする）。amount は 1 回分の追加量。
  app.post('/api/shared-goals/:id/contribute', auth.requireAuth, wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: '不正なIDです。' });
    const uid = String(req.userId);
    if (limited('sg:contrib:' + uid, 60, 10 * 60 * 1000)) return res.status(429).json({ error: '操作が多すぎます。少し時間をおいてください。' });
    if (!(await isMember(req.params.id, uid))) return res.status(403).json({ error: 'この共有目標のメンバーではありません。' });
    const amount = Number(req.body && req.body.amount);
    const note = clean(req.body && req.body.note, 100);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) return res.status(400).json({ error: '記録する量は 0 より大きい数で入力してください。' });
    // V12・D班: 習慣チェックは 1日1回・amount=1 だけ（チェック＝1日達成）。
    // 複数回・まとめての記録で日数を水増しできないようにする。
    const gKind = await q('SELECT kind FROM shared_goals WHERE id = $1', [req.params.id]);
    if (gKind.rowCount && normalizeKind(gKind.rows[0].kind) === 'habit') {
      if (amount !== 1) return res.status(400).json({ error: '習慣チェックは1日1回です。' });
      const today = await q(
        `SELECT COUNT(*)::int AS n FROM shared_goal_contributions
         WHERE goal_id = $1 AND user_id = $2 AND contributed_date = CURRENT_DATE`,
        [req.params.id, uid]);
      if (today.rows[0].n > 0) return res.status(400).json({ error: '今日はすでにチェック済みです。' });
    }
    await q(
      `INSERT INTO shared_goal_contributions (goal_id, user_id, amount, note) VALUES ($1, $2, $3, $4)`,
      [req.params.id, uid, amount, note]);
    const detail = await loadGoalDetail(req.params.id, uid);
    if (!detail) return res.status(404).json({ error: '共有目標が見つかりません。' });
    detail.isOwner = detail.members.some((m) => m.userId === uid && m.isOwner);
    res.json({ goal: detail });
  }));

  // ================= 共通タスク（Iteration 4・班G） =================
  // メンバー全員が同じタスクに取り組む。順位はペース%のまま（タスクは
  // 貢献量に換算しない）。完了は「今日」の達成のみ（completed_date は
  // サーバー当日固定。過去日への書き込みでごまかせない）。
  // 作成はメンバー誰でも可（上限30件）。削除はオーナーのみ。
  app.post('/api/shared-goals/:id/tasks', auth.requireAuth, wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: '不正なIDです。' });
    const uid = String(req.userId);
    if (limited('sg:task:' + uid, 20, 3600 * 1000)) return res.status(429).json({ error: '操作が多すぎます。少し時間をおいてください。' });
    if (!(await isMember(req.params.id, uid))) return res.status(403).json({ error: 'この共有目標のメンバーではありません。' });
    const title = oneLine(req.body && req.body.title, 80);
    if (!title) return res.status(400).json({ error: 'タスクを入力してください。' });
    const cnt = await q('SELECT COUNT(*)::int AS n FROM shared_goal_tasks WHERE goal_id = $1', [req.params.id]);
    if (cnt.rows[0].n >= 30) return res.status(400).json({ error: '共通タスクは30個までです。' });
    await q('INSERT INTO shared_goal_tasks (goal_id, title, created_by) VALUES ($1, $2, $3)',
      [req.params.id, title, uid]);
    const detail = await loadGoalDetail(req.params.id, uid);
    if (!detail) return res.status(404).json({ error: '共有目標が見つかりません。' });
    detail.isOwner = detail.members.some((m) => m.userId === uid && m.isOwner);
    res.json({ goal: detail });
  }));

  // 今日の完了をトグルする（押すたびに完了⇄未完了）。返すのは更新後の目標全体。
  app.post('/api/shared-goals/:id/tasks/:taskId/toggle', auth.requireAuth, wrap(async (req, res) => {
    if (!isId(req.params.id) || !isId(req.params.taskId)) return res.status(400).json({ error: '不正なIDです。' });
    const uid = String(req.userId);
    if (limited('sg:task-toggle:' + uid, 120, 10 * 60 * 1000)) return res.status(429).json({ error: '操作が多すぎます。少し時間をおいてください。' });
    if (!(await isMember(req.params.id, uid))) return res.status(403).json({ error: 'この共有目標のメンバーではありません。' });
    const t = await q('SELECT id FROM shared_goal_tasks WHERE id = $1 AND goal_id = $2', [req.params.taskId, req.params.id]);
    if (!t.rowCount) return res.status(404).json({ error: 'タスクが見つかりません。' });
    const done = await q(
      'SELECT 1 FROM shared_goal_task_completions WHERE task_id = $1 AND user_id = $2 AND completed_date = CURRENT_DATE',
      [req.params.taskId, uid]);
    if (done.rowCount) {
      await q('DELETE FROM shared_goal_task_completions WHERE task_id = $1 AND user_id = $2 AND completed_date = CURRENT_DATE',
        [req.params.taskId, uid]);
    } else {
      await q('INSERT INTO shared_goal_task_completions (task_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [req.params.taskId, uid]);
    }
    const detail = await loadGoalDetail(req.params.id, uid);
    if (!detail) return res.status(404).json({ error: '共有目標が見つかりません。' });
    detail.isOwner = detail.members.some((m) => m.userId === uid && m.isOwner);
    res.json({ goal: detail });
  }));

  // 共通タスクの削除（オーナーのみ。完了履歴は CASCADE で消える）。
  app.delete('/api/shared-goals/:id/tasks/:taskId', auth.requireAuth, wrap(async (req, res) => {
    if (!isId(req.params.id) || !isId(req.params.taskId)) return res.status(400).json({ error: '不正なIDです。' });
    const uid = String(req.userId);
    if (!(await isMember(req.params.id, uid))) return res.status(403).json({ error: 'この共有目標のメンバーではありません。' });
    const g = await q('SELECT owner_user_id FROM shared_goals WHERE id = $1', [req.params.id]);
    if (!g.rowCount) return res.status(404).json({ error: '共有目標が見つかりません。' });
    if (g.rows[0].owner_user_id !== uid) return res.status(403).json({ error: 'タスクを削除できるのは作成者だけです。' });
    const del = await q('DELETE FROM shared_goal_tasks WHERE id = $1 AND goal_id = $2', [req.params.taskId, req.params.id]);
    if (!del.rowCount) return res.status(404).json({ error: 'タスクが見つかりません。' });
    const detail = await loadGoalDetail(req.params.id, uid);
    if (!detail) return res.status(404).json({ error: '共有目標が見つかりません。' });
    detail.isOwner = true;
    res.json({ goal: detail });
  }));

  // 抜ける。オーナーが抜けたら最も古いメンバーへ所有権を移す。
  // 最後の1人が抜けたら目標ごと消す（貢献・スタンプは CASCADE で消える）。
  app.post('/api/shared-goals/:id/leave', auth.requireAuth, wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: '不正なIDです。' });
    const uid = String(req.userId);
    if (!(await isMember(req.params.id, uid))) return res.status(403).json({ error: 'この共有目標のメンバーではありません。' });
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM shared_goal_members WHERE goal_id = $1 AND user_id = $2', [req.params.id, uid]);
      const g = await client.query('SELECT owner_user_id FROM shared_goals WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!g.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: '共有目標が見つかりません。' }); }
      const rest = await client.query('SELECT user_id FROM shared_goal_members WHERE goal_id = $1 ORDER BY joined_at ASC LIMIT 1', [req.params.id]);
      if (!rest.rowCount) {
        await client.query('DELETE FROM shared_goals WHERE id = $1', [req.params.id]);
      } else if (g.rows[0].owner_user_id === uid) {
        await client.query('UPDATE shared_goals SET owner_user_id = $1 WHERE id = $2', [rest.rows[0].user_id, req.params.id]);
      }
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }));

  // V12.4・A班: メンバーを外す（キック）。オーナー（作成者）のみ実行可。
  //   - 自分自身はキック不可（オーナーが抜けるときは /leave を使う。
  //     所有権は最古メンバーへ移る。最後の1人なら目標ごと消える）。
  //   - キックされた人は shared_goal_members から外れる（貢献履歴・
  //     コメントは残す）。その目標の共通タスクの完了記録も消す
  //     （残すと「今日 N/M人」の分母・分子がずれるため）。
  //   - shared_goal_kicks に記録を残す（キックされた人が次回開いたときに
  //     GET /api/shared-goals/kicked で「外されました」と分かるように）。
  //   - アクティビティにも記録する（activity_events。失敗してもキック
  //     自体は成功させる＝ベストエフォート）。
  //   - 返すのは更新後の目標全体（クライアントは差し替えるだけ）。
  app.post('/api/shared-goals/:id/kick', auth.requireAuth, wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: '不正なIDです。' });
    const uid = String(req.userId);
    if (limited('sg:kick:' + uid, 20, 10 * 60 * 1000)) return res.status(429).json({ error: '操作が多すぎます。少し時間をおいてください。' });
    const targetUserId = String((req.body && req.body.userId) || '').trim();
    if (!targetUserId) return res.status(400).json({ error: '外すメンバーを指定してください。' });
    if (targetUserId === uid) return res.status(400).json({ error: '自分自身を外すことはできません。オーナーが抜けるときは「抜ける」を使ってください。' });
    const g = await q('SELECT id, owner_user_id, title FROM shared_goals WHERE id = $1', [req.params.id]);
    if (!g.rowCount) return res.status(404).json({ error: '共有目標が見つかりません。' });
    if (g.rows[0].owner_user_id !== uid) return res.status(403).json({ error: 'メンバーを外せるのは作成者だけです。' });
    if (!(await isMember(req.params.id, targetUserId))) return res.status(404).json({ error: 'そのメンバーは見つかりません。' });
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM shared_goal_members WHERE goal_id = $1 AND user_id = $2', [req.params.id, targetUserId]);
      await client.query(
        `DELETE FROM shared_goal_task_completions
         WHERE user_id = $2 AND task_id IN (SELECT id FROM shared_goal_tasks WHERE goal_id = $1)`,
        [req.params.id, targetUserId]);
      await client.query(
        `INSERT INTO shared_goal_kicks (goal_id, user_id, kicked_by) VALUES ($1, $2, $3)
         ON CONFLICT (goal_id, user_id) DO UPDATE SET kicked_by = EXCLUDED.kicked_by, kicked_at = NOW()`,
        [req.params.id, targetUserId, uid]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    // アクティビティへの記録はベストエフォート（activity_events が
    // まだ無い・失敗してもキック自体は成功扱いにする）。
    try {
      const ownerName = await displayNameFor(uid);
      await q(
        `INSERT INTO activity_events (owner_user_id, author_name, kind, text, hidden)
         VALUES ($1, $2, 'goal', $3, FALSE)`,
        [uid, ownerName, `共有目標「${String(g.rows[0].title).slice(0, 40)}」からメンバーを外しました`]);
    } catch (_) { /* 記録できなくてもキックは成功 */ }
    const detail = await loadGoalDetail(req.params.id, uid);
    if (!detail) return res.status(404).json({ error: '共有目標が見つかりません。' });
    detail.isOwner = true;
    res.json({ goal: detail });
  }));
}

module.exports = { register, parseDay, daysBetween, plannedByToday, formatDay };

/*
 * ── Render での確認手順（Postgres がこの環境に無いため未検証） ──
 * 1. backend/auth.js・backend/iap.js が Render 側に存在することを確認
 *    （無ければ server.js 自体が起動しない。auth.js / iap.js は作り直さないこと）。
 * 2. server.js に `require('./sharedGoals').register({ app, db, auth });` を
 *    community の register 直後に追加済み（Iteration 3）。
 * 3. デプロイ後、Render のログで "Database initialization failed" が無いことと、
 *    初回の共有目標作成時に shared_goals 等のテーブルが作られることを確認。
 * 4. 動作確認（2アカウント推奨）:
 *    - POST /api/shared-goals（title/target/unit/deadline）→ 200 で goal が返る
 *    - 返った inviteCode（8文字）で別アカウントが POST /api/shared-goals/join
 *    - 両者が POST /api/shared-goals/:id/contribute（amount）→ pacePercent が
 *      生値で返ること（V11: 表示はクライアントが 100% でキャップ＋先行バッジ。
 *      旧 v10 クライアントは formatPace が 150% で頭打ちするため表示は変わらない）
 *    - 全員が dailyTargetPerMember 以上を当日入れた日だけ sharedStreakDays が
 *      増えること。片方だけの日は増えないこと
 *    - スタンプは V6 で廃止（POST /api/shared-goals/:id/stamp は存在しないこと）
 *    - GET /api/shared-goals で自分の参加中の目標だけが返ること
 *    - 共有目標の target を変える API が無いこと（週の途中で目標を緩められない）
 * 5. 共通タスク（Iteration 4）:
 *    - POST /api/shared-goals/:id/tasks（title）→ goal.tasks に追加される
 *    - POST /api/shared-goals/:id/tasks/:taskId/toggle → 自分の今日の完了が
 *      付いたり外れたりする（doneToday / doneTodayCount が変わる）
 *    - 他のメンバーが toggle しても自分の pacePercent は変わらないこと
 *      （タスクは貢献量に換算しない＝順位はペース%のまま）
 *    - DELETE /api/shared-goals/:id/tasks/:taskId はオーナー以外 403
 *    - 31件目のタスク作成は 400（上限30件）
 * 6. GET /api/version → { version: '7.1.0', features: { sharedGoals: true, ... } }
 *    が返ること（server.js に追加済み。旧サーバーでは 404 になる）。
 *    V12・D班: バージョンは 7.1.0 に上がる（activity feed のページングと
 *    共有目標 kind の追加のため。Render の再デプロイが必要）。
 * 7. 共有目標の種類（V12・D班）:
 *    - POST /api/shared-goals（kind: 'time'）→ goal.kind='time'、unit='分'
 *    - POST /api/shared-goals（kind: 'habit', target: 30）→ goal.kind='habit'、unit=''
 *    - kind 未指定の作成 → goal.kind='count'（従来通り）
 *    - habit の contribute は amount=1 のみ、同じ日に2回目は 400
 *    - 旧データ（kind 列が無い頃の目標）→ GET で kind='count' が返ること
 * 8. 公開範囲とコメント（V12.2・A班。バージョンは 7.2.0 に上がる）:
 *    - POST /api/shared-goals（visibility: 'public'）→ goal.visibility='public'
 *    - visibility 未指定の作成 → goal.visibility='private'（従来通り）
 *    - 旧データ（visibility 列が無い頃の目標）→ GET で visibility='private' が返ること
 *    - GET /api/shared-goals/public → 公開目標だけが作成日降順で返る（?q= でタイトル検索）
 *    - POST /api/shared-goals/:id/join-public（公開目標）→ { goal, alreadyMember }
 *    - POST /api/shared-goals/:id/join-public（プライベート目標）→ 403
 *    - POST /api/shared-goals/:id/comments（メンバー・500文字まで）→ { comment }
 *    - GET /api/shared-goals/:id/comments → 古い順・hasMore/nextOffset 付き
 *    - POST /api/shared-goals/:id/comments/:commentId/report → { ok: true }
 *    - GET /api/shared-goals/:id の members[] に pacePercent・contribution・
 *      lastActiveAt が入っていること
 *    - GET /api/version → { version: '7.2.0', features: { sharedGoalVisibility: true,
 *      sharedGoalComments: true, leaderboardMetrics: true, ... } }
 *    - GET /api/league/weekly?metric=memorized → memorized 順・各行に value・unit・
 *      トップレベルに metric が付くこと（未指定は pace で従来通り）
 *    - GET /api/leaderboard?metric=pace → 従来の rate と同じ並びで value・unit 付き
 * 9. メンバー上限10人・キック・今日のノルマ達成率（V12.4・A班。バージョンは 7.3.0 に上がる）:
 *    - POST /api/shared-goals/join（10人目の参加済みの目標に11人目が参加）→ 400「満員です（10人まで）」
 *    - POST /api/shared-goals/:id/join-public（同上）→ 400「満員です（10人まで）」
 *    - 既存の10人超の目標はそのまま（追い出さない。新規参加だけ止まる）
 *    - GET /api/shared-goals/public?kind=habit → 習慣だけが返る。?kind=不正値 → 全種類
 *    - GET /api/shared-goals/public の各行に maxMembers=10・isFull が付くこと
 *    - POST /api/shared-goals/:id/kick（オーナー以外）→ 403
 *    - POST /api/shared-goals/:id/kick（自分自身）→ 400
 *    - POST /api/shared-goals/:id/kick（オーナーが他人をキック）→ { goal } が返り、
 *      members から消えていること。キックされた人の共通タスク完了も消えていること
 *    - GET /api/shared-goals/kicked（キックされたアカウント）→ { kicked: [{ goalId, title, kickedByDisplayName }] }
 *    - キックされた人が再参加したら GET /api/shared-goals/kicked から消えること
 *    - GET /api/shared-goals/:id の members[] に todayQuota・todayQuotaRate が入っていること
 *    - habit のメンバーが今日チェックしたら todayQuotaRate=100、してなければ 0
 *    - GET /api/version → { version: '7.3.0', features: { sharedGoalKick: true,
 *      dailyQuotaRate: true, sharedGoalFinder: true, ... } }
 * 10. 503 が出たときの切り分け（v5）: Render → Logs で
 *    `[shared-goals] requestId=... POST /api/shared-goals user=... step=... error=...`
 *    を探す。step=loadGoalDetail なら集計の例外、step=ensure-schema なら
 *    テーブル作成の失敗、step=create-insert なら INSERT の失敗。
 *    クライアントが受け取った requestId とログの requestId を突き合わせる。
 *    code=DB_UNAVAILABLE なら DATABASE_URL 未設定/DB未接続を疑う
 *    （db.js で pool が null だと ensure() が 'DB disabled' で失敗する）。
 */

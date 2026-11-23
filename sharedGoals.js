'use strict';
// ============================================================================
// 共有目標（Shared Goals）— Iteration 3
//   ユーザーが目標を作り、招待コードで友達を呼び、全員で同じ目標・
//   同じペース% を追う。チャットはなし（モデレーション費用のため）
//   — やり取りはスタンプ（絵文字リアクション）のみ。
//
// 競争指標（ユーザーと決定済み）: ペース% のみ。
//   ペース% = 実績 ÷ 今日までの計画量 × 100、上限 150%。
//   メンバーのペース% = メンバー貢献量 ÷ メンバーの今日までの計画量
//     （目標量をメンバー数で均等割り）。
//   共有ペース% = 合計貢献量 ÷ 合計の今日までの計画量（上限 150%）。
//   週間ペースは月曜時点の目標で計算する（週の途中で目標を緩めても
//   ペースは変わらない）。共有目標の target は作成後変更できない
//   （更新エンドポイントを用意していない）ため、このルールは自動的に満たされる。
//   生の量（単語数・分数）は順位に使わない。
//
// 共有ストリーク: 全メンバーがその日の勝利条件を満たした日だけ数える。
//   勝利条件 = その日の貢献量が「1人あたりの1日分」以上。
//   逃した日は 0 にリセットしない（ただ増えないだけ＝累計カウント）。
//   TODO(freeze): フリーズ（凍結）で逃した日を修復する経路は未実装。
//   このコードベースにフリーズ機能は存在しない（2026-11-23 時点で
//   grep 確認）。フリーズが追加されたら、ここで「フリーズ消費で
//   共有ストリークの欠けた日を補う」エンドポイントを繋ぐこと。
//
// ⚠️ UNVERIFIED: backend/auth.js と backend/iap.js がこのパックに無いため
//   （server.js が require しているがファイルが存在しない）、このモジュール
//   の認証まわりの動作は未検証。community.js と同じ auth.requireAuth の
//   使い方だけを踏襲しており、認証ロジック自体は一切作っていない。
//   Render 側の実ファイルで auth.requireAuth / req.userId の動きを確認すること。
//   Postgres がこの環境に無いため、エンドポイントのライブ動作も未検証。
//   確認手順はファイル末尾の「Render での確認手順」を参照。
// ============================================================================
const crypto = require('crypto');

// スタンプは固定の絵文字だけ（自由入力なし＝モデレーション不要）。
const STAMP_EMOJIS = ['👏', '🔥', '💪', '🎉', '✨', '🙌'];
const PACE_CAP = 150;

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
function randomInviteCode() {
  let out = '';
  for (let i = 0; i < 8; i++) out += INVITE_ALPHABET[Math.floor(Math.random() * INVITE_ALPHABET.length)];
  return out;
}

function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}
function daysBetween(a, b) {
  const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((utcB - utcA) / 86400000);
}
function capPace(v) {
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(PACE_CAP, v);
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

  const wrap = (fn) => async (req, res) => {
    try { await ensure(); await fn(req, res); }
    catch (e) {
      console.error('[shared-goals]', req.method, req.path, e.message);
      if (!res.headersSent) res.status(503).json({ error: 'いま利用できません。時間をおいて再度お試しください。' });
    }
  };

  async function isMember(goalId, userId) {
    const r = await q('SELECT 1 FROM shared_goal_members WHERE goal_id = $1 AND user_id = $2', [goalId, userId]);
    return r.rowCount > 0;
  }

  // 目標1件分の集計（メンバー・貢献・スタンプ・ペース%・共有ストリーク・共通タスク）。
  // today はサーバー日付（CURRENT_DATE）。週のペースは月曜時点の目標で
  // 計算するルールだが、target は不変のため当日分でそのまま満たされる。
  // viewerUserId（任意）：タスクの doneToday（閲覧者が今日完了したか）を
  // 付けるために使う。未指定なら全タスク doneToday=false。
  async function loadGoalDetail(goalId, viewerUserId) {
    const g = await q(
      `SELECT id, owner_user_id, title, target, unit, deadline, start_date,
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
      `SELECT id, user_id, amount, note, contributed_date, created_at
       FROM shared_goal_contributions WHERE goal_id = $1 ORDER BY contributed_date DESC, created_at DESC LIMIT 200`,
      [goalId]);
    const stamps = await q(
      `SELECT id, user_id, emoji, target_user_id, created_at
       FROM shared_goal_stamps WHERE goal_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [goalId]);

    const memberCount = members.rows.length;
    const planned = plannedByToday(target, goal.start_date, goal.deadline, goal.today);
    const totalDays = Math.max(1, daysBetween(parseDay(goal.start_date), parseDay(goal.deadline)) + 1);
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
      return {
        userId: m.user_id,
        displayName: m.display_name || anonName(m.user_id),
        contribution: u.total,
        todayContribution: u.today,
        pacePercent: memberPlanned > 0 ? capPace((u.total / memberPlanned) * 100) : (u.total > 0 ? 100 : 0),
        wonToday: u.winDates.has(goal.today),
        // 共通タスク：そのメンバーが今日完了したタスク数（後で tasks から数えて入れる）
        tasksDoneToday: 0,
        isOwner: m.user_id === goal.owner_user_id,
        joinedAt: m.joined_at,
      };
    });
    // 共有目標内の順位はペース% 順（上限 150%）。
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
    return {
      id: String(goal.id),
      title: goal.title,
      target,
      unit: goal.unit || '',
      deadline: goal.deadline,
      startDate: goal.start_date,
      inviteCode: goal.invite_code,
      createdAt: goal.created_at,
      isOwner: false, // 呼び出し側で上書きする（自分の行かどうかはここでは分からない）
      memberCount,
      totalContribution,
      plannedByToday: planned,
      pacePercent: planned > 0 ? capPace((totalContribution / planned) * 100) : (totalContribution > 0 ? 100 : 0),
      dailyTargetPerMember: dailyTarget,
      sharedStreakDays: sharedWinDates.length,
      sharedWinDates,
      lastSharedWinDate: sharedWinDates.length ? sharedWinDates[sharedWinDates.length - 1] : null,
      members: memberList,
      contributions: contribs.rows.map((c) => ({
        id: String(c.id), userId: c.user_id, amount: Number(c.amount), note: c.note || '',
        date: c.contributed_date, createdAt: c.created_at,
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
    const unit = oneLine(b.unit, 20);
    const deadline = String(b.deadline || '');
    if (!title) return res.status(400).json({ error: 'タイトルを入力してください。' });
    if (!Number.isFinite(target) || target <= 0 || target > 100000000) return res.status(400).json({ error: '目標量は 0 より大きい数で入力してください。' });
    if (!parseDay(deadline)) return res.status(400).json({ error: '期限は YYYY-MM-DD で入力してください。' });
    if (parseDay(deadline) < parseDay(new Date().toISOString().slice(0, 10))) return res.status(400).json({ error: '期限は今日以降にしてください。' });
    const mine = await q('SELECT COUNT(*)::int AS n FROM shared_goals WHERE owner_user_id = $1', [uid]);
    if (mine.rows[0].n >= 20) return res.status(400).json({ error: '作れる共有目標は20個までです。' });
    let code = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      code = randomInviteCode();
      try {
        const ins = await q(
          `INSERT INTO shared_goals (owner_user_id, title, target, unit, deadline, invite_code)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [uid, title, target, unit, deadline, code]);
        await q('INSERT INTO shared_goal_members (goal_id, user_id, display_name) VALUES ($1, $2, $3)',
          [ins.rows[0].id, uid, anonName(uid)]);
        const detail = await loadGoalDetail(ins.rows[0].id, uid);
        detail.isOwner = true;
        return res.json({ goal: detail });
      } catch (e) {
        if (e.code !== '23505') throw e; // 招待コード重複だけ再試行
      }
    }
    return res.status(503).json({ error: '招待コードを作れませんでした。もう一度お試しください。' });
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
      detail.isOwner = detail.members.some((m) => m.userId === uid && m.isOwner);
      return res.json({ goal: detail, alreadyMember: true });
    }
    const cnt = await q('SELECT COUNT(*)::int AS n FROM shared_goal_members WHERE goal_id = $1', [goalId]);
    if (cnt.rows[0].n >= 30) return res.status(400).json({ error: 'この共有目標は満員です（30人まで）。' });
    await q('INSERT INTO shared_goal_members (goal_id, user_id, display_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [goalId, uid, anonName(uid)]);
    const detail = await loadGoalDetail(goalId, uid);
    detail.isOwner = false;
    res.json({ goal: detail, alreadyMember: false });
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
    await q(
      `INSERT INTO shared_goal_contributions (goal_id, user_id, amount, note) VALUES ($1, $2, $3, $4)`,
      [req.params.id, uid, amount, note]);
    const detail = await loadGoalDetail(req.params.id, uid);
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
    detail.isOwner = true;
    res.json({ goal: detail });
  }));

  // スタンプ（絵文字リアクション）。自由入力なし。同じ絵文字を同じ相手に
  // 何度も押せるが、履歴は最新100件まで返す。
  app.post('/api/shared-goals/:id/stamp', auth.requireAuth, wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: '不正なIDです。' });
    const uid = String(req.userId);
    if (limited('sg:stamp:' + uid, 60, 10 * 60 * 1000)) return res.status(429).json({ error: '操作が多すぎます。少し時間をおいてください。' });
    if (!(await isMember(req.params.id, uid))) return res.status(403).json({ error: 'この共有目標のメンバーではありません。' });
    const emoji = String((req.body && req.body.emoji) || '');
    if (!STAMP_EMOJIS.includes(emoji)) return res.status(400).json({ error: '使えるスタンプは 👏 🔥 💪 🎉 ✨ 🙌 です。' });
    const targetUserId = typeof (req.body && req.body.targetUserId) === 'string' && req.body.targetUserId
      ? String(req.body.targetUserId).slice(0, 80) : null;
    if (targetUserId && !(await isMember(req.params.id, targetUserId))) return res.status(400).json({ error: 'スタンプの相手はメンバーから選んでください。' });
    const ins = await q(
      `INSERT INTO shared_goal_stamps (goal_id, user_id, emoji, target_user_id) VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
      [req.params.id, uid, emoji, targetUserId]);
    res.json({ stamp: { id: String(ins.rows[0].id), userId: uid, emoji, targetUserId, createdAt: ins.rows[0].created_at } });
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
}

module.exports = { register, STAMP_EMOJIS };

/*
 * ── Render での確認手順（Postgres がこの環境に無いため未検証） ──
 * 1. backend/auth.js・backend/iap.js が Render 側に存在することを確認
 *    （無ければ server.js 自体が起動しない。auth.js / iap.js は作り直さないこと）。
 * 2. server.js に `require('./sharedGoals').register({ app, db, auth });` を
 *    community の register 直後に追加済み（Iteration 3）。
 * 3. デプロイ後、Render のログで "Database initialization failed" が無いことと、
 *    初回の共有目標作成時に shared_goals 等のテーブルが作られることを確認。
 * 4. 動作確認（2アカウント推奨）:
 *    - POST /api/shared-goals（title/target/unit/deadline）→ 201 相当で goal が返る
 *    - 返った inviteCode（8文字）で別アカウントが POST /api/shared-goals/join
 *    - 両者が POST /api/shared-goals/:id/contribute（amount）→ pacePercent が
 *      150% で頭打ちになること（大量に contribute して確認）
 *    - 全員が dailyTargetPerMember 以上を当日入れた日だけ sharedStreakDays が
 *      増えること。片方だけの日は増えないこと
 *    - POST /api/shared-goals/:id/stamp（emoji は 👏 🔥 💪 🎉 ✨ 🙌 のみ）
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
 * 6. GET /api/version → { version: '4.0.0', features: { sharedGoals: true, ... } }
 *    が返ること（server.js に追加済み。旧サーバーでは 404 になる）。
 */

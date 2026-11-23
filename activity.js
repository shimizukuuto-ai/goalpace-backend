'use strict';
// ============================================================================
// 最近のアクティビティ（V11）
//   最近達成されたタスク・最近覚えられた暗記カードが流れる軽量フィード。
//   投稿はクライアントの完了フックから POST /api/activity で送る
//   （App.tsx 側の配線は iteration11_notes/integration-b.md を参照。
//   このモジュール自体は App.tsx を触らない）。
//   表示は GET /api/activity/feed（直近7日・新しい順）。
//   V12・D班: 無限に長くならないようページング付き。
//   ?limit=（既定20・最大50）&offset=（既定0）。limit+1 件読んで
//   hasMore を判定し、nextOffset を返す。クライアントは初回20件＋
//   「もっと見る」で追加読み込みする。
//
// 方針（community.js と同じ流儀）:
// - 匿名IDベース。認証オン時はセッションの userId、認証オフ時は
//   クライアントが送る userId（未サインイン時の匿名ID）→ X-Device-Id。
// - 本文は community.js の screenText で検査する（攻撃的な言葉・
//   URL・連絡先は載せない。つらい気持ちの投稿は支援文言で止める）。
// - 公開をオフにしている人の投稿は保存だけしてフィードには出さない
//   （hidden=1）。通報3件で自動非表示（community_reports を流用）。
// - タスク名・カード内容などの本文は最大80文字。個人の詳細は送らない。
// ============================================================================
const crypto = require('crypto');
const { screenText } = require('./community');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS activity_events (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  report_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activity_events_feed ON activity_events (hidden, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_owner ON activity_events (owner_user_id, created_at DESC);
-- 通報は community_reports を流用する（community.js と同じ定義。
-- community 側の ensure より先に通報が来ても動くよう、ここでも作る）。
CREATE TABLE IF NOT EXISTS community_reports (
  id BIGSERIAL PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id BIGINT NOT NULL,
  reporter_user_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (target_type, target_id, reporter_user_id)
);
`;

// kind: task=タスク達成 / card=暗記カードを覚えた / pomodoro=集中完了 / goal=目標達成
const ACTIVITY_KINDS = ['task', 'card', 'pomodoro', 'goal'];
const TEXT_MAX = 80;
const REPORT_HIDE_THRESHOLD = 3;

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

const clean = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const anonName = (uid) => 'プレイヤー-' + crypto.createHash('sha256').update(String(uid)).digest('hex').slice(0, 4);

function register({ app, db, auth }) {
  let ready = null;
  function ensure() {
    if (!db.pool) return Promise.reject(new Error('DB disabled'));
    if (!ready) ready = db.pool.query(SCHEMA).catch((e) => { ready = null; throw e; });
    return ready;
  }
  const q = (text, params) => db.pool.query(text, params);

  // 認証オン時は auth.requireAuth が req.userId を入れる。認証オフ時は
  // クライアントが送る userId（body・query）か X-Device-Id を使う。
  // server.js の onlineIdentity と同じ解決順（ここでは auth モジュールを
  // 直接参照しないため、REQUIRE_AUTH は環境変数で見る）。
  const REQUIRE_AUTH = process.env.REQUIRE_AUTH === 'true';
  function resolveIdentity(req) {
    if (REQUIRE_AUTH) return req.userId ? String(req.userId) : '';
    const fromBody = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';
    if (fromBody) return fromBody;
    const fromQuery = typeof req.query?.userId === 'string' ? req.query.userId.trim() : '';
    if (fromQuery) return fromQuery;
    const raw = req.headers['x-device-id'];
    if (typeof raw === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(raw.trim())) return raw.trim();
    return '';
  }

  const wrap = (fn) => async (req, res) => {
    try { await ensure(); await fn(req, res); }
    catch (e) {
      console.error('[activity]', req.method, req.path, e.message);
      if (!res.headersSent) res.status(503).json({ error: 'いま利用できません。時間をおいて再度お試しください。' });
    }
  };

  // 投稿者の表示名：プロフィールの設定名があればそれ、無ければ匿名名。
  async function authorNameFor(uid) {
    try {
      const profile = await db.getOnlineProfile(uid);
      if (profile && profile.displayName) return profile.displayName;
    } catch (_) { /* プロフィールが取れなくても匿名名で投稿する */ }
    return anonName(uid);
  }

  // ---- アカウント削除のとき、アクティビティも消す ----
  // community.js / sharedGoals.js と同じく server.js の DELETE /api/account
  // より先に登録されるため next() で後続の削除処理へ渡す。
  app.delete('/api/account', auth.requireAuth, async (req, res, next) => {
    try {
      if (db.pool) {
        await ensure();
        await q('DELETE FROM activity_events WHERE owner_user_id = $1', [String(req.userId)]);
      }
    } catch (e) { console.error('[activity] purge failed:', e.message); }
    next();
  });

  // ================= 投稿（タスク完了・暗記・集中・目標達成） =================
  // body: { userId?, kind: 'task'|'card'|'pomodoro'|'goal', text }
  // text は「何をやったか」の短文（例：「単語テストを達成」「25分集中を完了」）。
  // 連続投稿の暴走防止：1人10分に30件まで。公開オフの人は hidden で保存。
  app.post('/api/activity', wrap(async (req, res) => {
    const uid = resolveIdentity(req);
    if (!uid || uid.length > 80) return res.status(400).json({ error: 'Invalid userId' });
    if (limited('act:' + uid, 30, 10 * 60 * 1000)) {
      return res.status(429).json({ error: '操作が多すぎます。少し時間をおいてください。' });
    }
    const kind = ACTIVITY_KINDS.includes(req.body?.kind) ? req.body.kind : '';
    const text = clean(req.body?.text, TEXT_MAX);
    if (!kind) return res.status(400).json({ error: 'kind を指定してください。' });
    if (!text) return res.status(400).json({ error: '内容を入力してください。' });
    const s = screenText(text);
    if (!s.ok) return res.status(422).json({ error: s.error, code: s.code });
    let hidden = false;
    try {
      const profile = await db.getOnlineProfile(uid);
      if (profile && profile.activityPublic === false) hidden = true;
    } catch (_) { /* プロフィールが取れなくても投稿は受ける */ }
    const name = await authorNameFor(uid);
    const ins = await q(
      `INSERT INTO activity_events (owner_user_id, author_name, kind, text, hidden)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [uid, name, kind, text, hidden]
    );
    res.json({ ok: true, id: String(ins.rows[0].id), hidden, createdAt: ins.rows[0].created_at });
  }));

  // ================= フィード（直近7日・新しい順・ページング付き） =================
  // ?userId= で自分の行に mine が付く。通報で非表示になったものは出ない。
  // V12・D班: ?limit=（既定20・1〜50）&offset=（既定0）。limit+1 件読んで
  // hasMore を判定する（余分な1件は返さない）。nextOffset は次の offset。
  app.get('/api/activity/feed', wrap(async (req, res) => {
    const uid = resolveIdentity(req);
    const limit = Math.max(1, Math.min(50, Math.floor(Number(req.query.limit) || 20)));
    const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
    const r = await q(
      `SELECT id, author_name, kind, text, created_at,
              (owner_user_id = $1) AS mine
       FROM activity_events
       WHERE hidden = FALSE AND created_at > NOW() - INTERVAL '7 days'
       ORDER BY created_at DESC, id DESC
       LIMIT $2 OFFSET $3`,
      [uid, limit + 1, offset]
    );
    const hasMore = r.rows.length > limit;
    const rows = hasMore ? r.rows.slice(0, limit) : r.rows;
    res.json({
      events: rows.map((x) => ({
        id: String(x.id),
        authorName: x.author_name,
        kind: x.kind,
        text: x.text,
        createdAt: x.created_at,
        mine: !!x.mine,
      })),
      hasMore,
      nextOffset: offset + rows.length,
      limit,
      offset,
    });
  }));

  // ================= 通報（3件で自動非表示。community_reports を流用） =================
  app.post('/api/activity/:id/report', auth.requireAuth, wrap(async (req, res) => {
    const id = String(req.params.id || '');
    if (!/^\d{1,18}$/.test(id)) return res.status(400).json({ error: '不正なIDです。' });
    if (limited('act-r:' + req.userId, 20, 3600 * 1000)) return res.status(429).json({ error: '通報が多すぎます。' });
    const reporter = String(req.userId);
    const found = await q('SELECT owner_user_id FROM activity_events WHERE id = $1', [id]);
    if (!found.rowCount) return res.status(404).json({ error: '見つかりません。' });
    if (found.rows[0].owner_user_id === reporter) return res.status(400).json({ error: '自分の投稿は通報できません。' });
    const reason = clean(req.body?.reason, 100) || '不適切な内容';
    const ins = await q(
      `INSERT INTO community_reports (target_type, target_id, reporter_user_id, reason)
       VALUES ('activity', $1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`,
      [id, reporter, reason]
    );
    if (ins.rowCount) {
      const cnt = await q(
        "SELECT COUNT(*)::int AS c FROM community_reports WHERE target_type = 'activity' AND target_id = $1",
        [id]
      );
      await q(
        'UPDATE activity_events SET report_count = $2::int, hidden = (hidden OR $2::int >= $3::int) WHERE id = $1',
        [id, cnt.rows[0].c, REPORT_HIDE_THRESHOLD]
      );
    }
    res.json({ ok: true });
  }));
}

module.exports = { register };

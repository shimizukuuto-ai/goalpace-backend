'use strict';
// 公開投稿（発見タブ）とランキングの「ひとこと」。
// 方針: サインイン必須 / 1人1コメント / 通報3人で自動非表示 / ブロック / 管理者の非表示・削除・投稿禁止 / 緊急停止スイッチ
const crypto = require('crypto');

const REPORT_HIDE_THRESHOLD = Math.max(2, Number(process.env.REPORT_HIDE_THRESHOLD) || 3);
const POSTS_PER_DAY = 3;
const MAX_LIVE_POSTS = 30;
const COMMENT_MAX = 40;
const TITLE_MAX = 60;
const BODY_MIN = 30;
const BODY_MAX = 2000;
const COMMENT_COOLDOWN_MS = 30 * 1000;

const SUPPORT_MESSAGE =
  'つらい気持ちを書いてくれてありがとう。安全のため、この内容はみんなには公開できません（下書きは消えていません）。' +
  'ひとりで抱え込まず、話せる窓口もあります。#いのちSOS 0120-061-338、よりそいホットライン 0120-279-338（どちらも24時間・無料）。' +
  'いま危険を感じるときは110番か119番へ。海外にいる場合は、その国の緊急通報番号へ連絡してください。';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS community_posts (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  category_name TEXT NOT NULL DEFAULT '',
  based_on JSONB,
  ai_assisted BOOLEAN NOT NULL DEFAULT FALSE,
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  hidden_reason TEXT,
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  report_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_community_posts_list ON community_posts (hidden, deleted, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_posts_owner ON community_posts (owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_posts_hash ON community_posts (body_hash);
CREATE TABLE IF NOT EXISTS rank_comments (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  week_start DATE NOT NULL,
  body TEXT NOT NULL,
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  hidden_reason TEXT,
  report_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner_user_id, week_start)
);
CREATE TABLE IF NOT EXISTS community_reports (
  id BIGSERIAL PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id BIGINT NOT NULL,
  reporter_user_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (target_type, target_id, reporter_user_id)
);
CREATE TABLE IF NOT EXISTS community_blocks (
  blocker_user_id TEXT NOT NULL,
  blocked_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_user_id, blocked_user_id)
);
CREATE TABLE IF NOT EXISTS community_bans (
  user_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

// ---------- 文字チェック ----------
const nfkc = (s) => String(s || '').normalize('NFKC');
const squash = (s) => nfkc(s).toLowerCase().replace(/[\s.,_\-*~・、。!?！？"'`’]/g, '');

const BAD_WORDS = ['死ね', '氏ね', '殺すぞ', '殺してやる', 'ぶっ殺', '自殺しろ', '消えろ', 'ガイジ', '池沼', 'キチガイ', 'きちがい', 'fuck', 'nigger', 'faggot', 'killyourself']
  .concat((process.env.NG_WORDS || '').split(','))
  .map(squash).filter(Boolean);
const CARE_WORDS = ['死にたい', 'しにたい', '消えたい', 'きえたい', '生きていたくない', '生きるのがつらい', 'いなくなりたい', '自傷', 'リスカ', 'リストカット', 'オーバードーズ', '首を吊', '首をつ']
  .map(squash);
const CONTACT_WORDS = ['lineid', 'line交換', 'ライン交換', 'ライン教えて', 'dmください', 'dm下さい', 'インスタ交換', 'カカオid', 'discordid'].map(squash);

const URL_RE = /(https?:\/\/|www\.|\b[a-z0-9-]{2,}\.(com|net|org|jp|co\.jp|io|me|ly|gg|xyz|info|app|dev|tv|cc|link|site|online|shop)\b)/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const HANDLE_RE = /(^|[^a-z0-9_])@[a-z0-9_.]{3,}/i;

function hasPhone(raw) {
  const cleaned = raw.replace(/\d{4}[-\/年]\d{1,2}[-\/月]\d{1,2}/g, '');
  const found = cleaned.match(/\+?\d[\d\- ]{8,}\d/g) || [];
  return found.some((x) => (x.match(/\d/g) || []).length >= 10);
}

function screenText(text) {
  const raw = nfkc(text).toLowerCase();
  const sq = squash(text);
  if (CARE_WORDS.some((w) => sq.includes(w))) return { ok: false, code: 'CARE', error: SUPPORT_MESSAGE };
  if (URL_RE.test(raw)) return { ok: false, code: 'LINK', error: 'URLやリンクは載せられません。' };
  if (EMAIL_RE.test(raw) || HANDLE_RE.test(raw) || hasPhone(raw) || CONTACT_WORDS.some((w) => sq.includes(w))) {
    return { ok: false, code: 'CONTACT', error: 'メールアドレス・電話番号・IDなどの連絡先は載せられません。' };
  }
  if (BAD_WORDS.some((w) => sq.includes(w))) {
    return { ok: false, code: 'BAD', error: '攻撃的な言葉が含まれています。言い方を変えてみてください。' };
  }
  return { ok: true };
}

// ---------- 小さな道具 ----------
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

function weekStartJst(d = new Date()) {
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  const dow = (jst.getUTCDay() + 6) % 7; // 月曜=0
  jst.setUTCDate(jst.getUTCDate() - dow);
  return jst.toISOString().slice(0, 10);
}

const TABLES = { post: 'community_posts', comment: 'rank_comments' };

function register({ app, db, auth }) {
  let ready = null;
  function ensure() {
    if (!db.pool) return Promise.reject(new Error('DB disabled'));
    if (!ready) ready = db.pool.query(SCHEMA).catch((e) => { ready = null; throw e; });
    return ready;
  }
  const q = (text, params) => db.pool.query(text, params);
  const enabled = () => process.env.COMMUNITY_ENABLED !== 'false';

  function softUserId(req) {
    try {
      const h = req.headers.authorization || '';
      if (!h.startsWith('Bearer ')) return '';
      const d = auth.verifySessionToken(h.slice(7));
      return d && d.userId != null ? String(d.userId) : '';
    } catch (_) { return ''; }
  }

  const wrap = (fn) => async (req, res) => {
    if (!enabled()) return res.status(503).json({ error: '現在、投稿機能は一時停止しています。' });
    try { await ensure(); await fn(req, res); }
    catch (e) {
      console.error('[community]', req.method, req.path, e.message);
      if (!res.headersSent) res.status(503).json({ error: 'いま利用できません。時間をおいて再度お試しください。' });
    }
  };

  async function writeGuard(req, res) {
    const uid = String(req.userId);
    if (limited('w:' + uid, 20, 10 * 60 * 1000)) {
      res.status(429).json({ error: '操作が多すぎます。少し時間をおいてください。' });
      return true;
    }
    const banned = await q('SELECT 1 FROM community_bans WHERE user_id = $1', [uid]);
    if (banned.rowCount) { res.status(403).json({ error: 'このアカウントは投稿できません。' }); return true; }
    return false;
  }

  async function reportTarget(type, id, reporter, reason) {
    const table = TABLES[type];
    if (!table) return 'missing';
    const found = await q(`SELECT owner_user_id FROM ${table} WHERE id = $1`, [id]);
    if (!found.rowCount) return 'missing';
    if (found.rows[0].owner_user_id === reporter) return 'own';
    const ins = await q(
      'INSERT INTO community_reports (target_type, target_id, reporter_user_id, reason) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id',
      [type, id, reporter, reason]);
    if (ins.rowCount) {
      const cnt = await q('SELECT COUNT(*)::int AS c FROM community_reports WHERE target_type = $1 AND target_id = $2', [type, id]);
      await q(
        `UPDATE ${table} SET report_count = $2::int,
           hidden_reason = CASE WHEN (NOT hidden) AND $2::int >= $3::int THEN 'reports' ELSE hidden_reason END,
           hidden = (hidden OR $2::int >= $3::int)
         WHERE id = $1`,
        [id, cnt.rows[0].c, REPORT_HIDE_THRESHOLD]);
    }
    return 'ok';
  }

  const shapePost = (r) => ({
    id: String(r.id), authorName: r.author_name, kind: r.kind, title: r.title, body: r.body,
    categoryName: r.category_name, basedOn: r.based_on || null, aiAssisted: r.ai_assisted,
    createdAt: r.created_at, mine: !!r.mine,
  });

  // ---- アカウント削除のとき、投稿・コメントも消す（既存の削除処理の前に実行） ----
  app.delete('/api/account', auth.requireAuth, async (req, res, next) => {
    try {
      if (db.pool) {
        await ensure();
        const uid = String(req.userId);
        await q('DELETE FROM community_posts WHERE owner_user_id = $1', [uid]);
        await q('DELETE FROM rank_comments WHERE owner_user_id = $1', [uid]);
        await q('DELETE FROM community_blocks WHERE blocker_user_id = $1 OR blocked_user_id = $1', [uid]);
        await q('DELETE FROM community_reports WHERE reporter_user_id = $1', [uid]);
      }
    } catch (e) { console.error('[community] purge failed:', e.message); }
    next();
  });

  // ================= 投稿（自分の話・小論文） =================
  app.post('/api/posts', auth.requireAuth, wrap(async (req, res) => {
    if (await writeGuard(req, res)) return;
    const uid = String(req.userId);
    const b = req.body || {};
    const kind = b.kind === 'essay' ? 'essay' : (b.kind === 'story' ? 'story' : '');
    const title = oneLine(b.title, TITLE_MAX);
    const body = clean(b.body, BODY_MAX);
    const category = oneLine(b.categoryName, 20);
    if (!kind) return res.status(400).json({ error: '「自分の話」か「小論文」を選んでください。' });
    if (!title) return res.status(400).json({ error: 'タイトルを入力してください。' });
    if (Array.from(body).length < BODY_MIN) return res.status(400).json({ error: `本文は${BODY_MIN}文字以上で書いてください。` });
    let basedOn = null;
    if (b.basedOn && typeof b.basedOn === 'object') {
      const k = ['lesson', 'book', 'quiz'].includes(b.basedOn.kind) ? b.basedOn.kind : null;
      const topic = oneLine(b.basedOn.topic, 60);
      const t = oneLine(b.basedOn.title, 80);
      if (k && (topic || t)) basedOn = { kind: k, topic, title: t };
    }
    for (const text of [title, body]) {
      const s = screenText(text);
      if (!s.ok) return res.status(422).json({ error: s.error, code: s.code });
    }
    const day = await q("SELECT COUNT(*)::int AS c FROM community_posts WHERE owner_user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'", [uid]);
    if (day.rows[0].c >= POSTS_PER_DAY) return res.status(429).json({ error: `投稿は1日${POSTS_PER_DAY}件までです。明日また書いてください。` });
    const live = await q('SELECT COUNT(*)::int AS c FROM community_posts WHERE owner_user_id = $1 AND deleted = FALSE', [uid]);
    if (live.rows[0].c >= MAX_LIVE_POSTS) return res.status(400).json({ error: `公開できる投稿は${MAX_LIVE_POSTS}件までです。古い投稿を消してください。` });
    const hash = crypto.createHash('sha256').update(squash(body)).digest('hex');
    const dup = await q("SELECT 1 FROM community_posts WHERE body_hash = $1 AND created_at > NOW() - INTERVAL '7 days' LIMIT 1", [hash]);
    if (dup.rowCount) return res.status(400).json({ error: '同じ内容の投稿がすでにあります。' });
    const ins = await q(
      `INSERT INTO community_posts (owner_user_id, author_name, kind, title, body, body_hash, category_name, based_on, ai_assisted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [uid, anonName(uid), kind, title, body, hash, category, basedOn ? JSON.stringify(basedOn) : null, !!basedOn]);
    res.json({ post: { id: String(ins.rows[0].id) } });
  }));

  app.get('/api/posts/mine', auth.requireAuth, wrap(async (req, res) => {
    const r = await q(
      `SELECT id, author_name, kind, title, body, category_name, based_on, ai_assisted, created_at, hidden, TRUE AS mine
       FROM community_posts WHERE owner_user_id = $1 AND deleted = FALSE ORDER BY created_at DESC LIMIT 50`,
      [String(req.userId)]);
    res.json({ posts: r.rows.map((x) => ({ ...shapePost(x), hidden: x.hidden })) });
  }));

  app.get('/api/posts', wrap(async (req, res) => {
    const uid = softUserId(req);
    const kind = ['story', 'essay'].includes(req.query.kind) ? req.query.kind : null;
    const limit = Math.max(1, Math.min(30, Math.floor(Number(req.query.limit) || 20)));
    const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
    const r = await q(
      `SELECT p.id, p.author_name, p.kind, p.title, p.body, p.category_name, p.based_on, p.ai_assisted, p.created_at,
              (p.owner_user_id = $1) AS mine
       FROM community_posts p
       WHERE p.hidden = FALSE AND p.deleted = FALSE AND ($2::text IS NULL OR p.kind = $2::text)
         AND NOT EXISTS (SELECT 1 FROM community_blocks b WHERE b.blocker_user_id = $1 AND b.blocked_user_id = p.owner_user_id)
       ORDER BY p.created_at DESC LIMIT $3 OFFSET $4`,
      [uid, kind, limit, offset]);
    res.json({ posts: r.rows.map(shapePost) });
  }));

  app.delete('/api/posts/:id', auth.requireAuth, wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: '不正なIDです。' });
    const r = await q('UPDATE community_posts SET deleted = TRUE, hidden = TRUE WHERE id = $1 AND owner_user_id = $2 AND deleted = FALSE RETURNING id', [req.params.id, String(req.userId)]);
    if (!r.rowCount) return res.status(404).json({ error: '投稿が見つかりません。' });
    res.json({ ok: true });
  }));

  app.post('/api/posts/:id/report', auth.requireAuth, wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: '不正なIDです。' });
    if (limited('r:' + req.userId, 20, 3600 * 1000)) return res.status(429).json({ error: '通報が多すぎます。' });
    const out = await reportTarget('post', req.params.id, String(req.userId), oneLine(req.body && req.body.reason, 100) || '不適切な内容');
    if (out === 'missing') return res.status(404).json({ error: '投稿が見つかりません。' });
    if (out === 'own') return res.status(400).json({ error: '自分の投稿は通報できません。' });
    res.json({ ok: true });
  }));

  // ================= ランキングの「ひとこと」（1人1つ・毎週リセット） =================
  app.get('/api/rank-comments', wrap(async (req, res) => {
    const uid = softUserId(req);
    const week = weekStartJst();
    const list = await q(
      `SELECT c.id, c.author_name, c.body, c.updated_at, (c.owner_user_id = $1) AS mine
       FROM rank_comments c
       WHERE c.week_start = $2 AND c.hidden = FALSE
         AND NOT EXISTS (SELECT 1 FROM community_blocks b WHERE b.blocker_user_id = $1 AND b.blocked_user_id = c.owner_user_id)
       ORDER BY c.updated_at DESC LIMIT 50`,
      [uid, week]);
    let myComment = null;
    if (uid) {
      const m = await q('SELECT id, body, hidden FROM rank_comments WHERE owner_user_id = $1 AND week_start = $2', [uid, week]);
      if (m.rowCount) myComment = { id: String(m.rows[0].id), body: m.rows[0].body, hidden: m.rows[0].hidden };
    }
    res.json({
      weekStart: week,
      comments: list.rows.map((r) => ({ id: String(r.id), authorName: r.author_name, body: r.body, updatedAt: r.updated_at, mine: !!r.mine })),
      myComment,
    });
  }));

  app.put('/api/rank-comments', auth.requireAuth, wrap(async (req, res) => {
    if (await writeGuard(req, res)) return;
    const uid = String(req.userId);
    const text = oneLine(req.body && req.body.text, COMMENT_MAX * 3);
    if (!text) return res.status(400).json({ error: 'コメントを入力してください。' });
    if (Array.from(text).length > COMMENT_MAX) return res.status(400).json({ error: `${COMMENT_MAX}文字までです。` });
    const s = screenText(text);
    if (!s.ok) return res.status(422).json({ error: s.error, code: s.code });
    const week = weekStartJst();
    const cur = await q('SELECT updated_at FROM rank_comments WHERE owner_user_id = $1 AND week_start = $2', [uid, week]);
    if (cur.rowCount && Date.now() - new Date(cur.rows[0].updated_at).getTime() < COMMENT_COOLDOWN_MS) {
      return res.status(429).json({ error: '少し時間をおいてから書き直してください。' });
    }
    await q(
      `INSERT INTO rank_comments (owner_user_id, author_name, week_start, body) VALUES ($1, $2, $3, $4)
       ON CONFLICT (owner_user_id, week_start) DO UPDATE SET body = EXCLUDED.body, updated_at = NOW()`,
      [uid, anonName(uid), week, text]);
    res.json({ ok: true, weekStart: week });
  }));

  app.delete('/api/rank-comments', auth.requireAuth, wrap(async (req, res) => {
    await q('DELETE FROM rank_comments WHERE owner_user_id = $1 AND week_start = $2', [String(req.userId), weekStartJst()]);
    res.json({ ok: true });
  }));

  app.post('/api/rank-comments/:id/report', auth.requireAuth, wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: '不正なIDです。' });
    if (limited('r:' + req.userId, 20, 3600 * 1000)) return res.status(429).json({ error: '通報が多すぎます。' });
    const out = await reportTarget('comment', req.params.id, String(req.userId), oneLine(req.body && req.body.reason, 100) || '不適切な内容');
    if (out === 'missing') return res.status(404).json({ error: 'コメントが見つかりません。' });
    if (out === 'own') return res.status(400).json({ error: '自分のコメントは通報できません。' });
    res.json({ ok: true });
  }));

  // ================= ブロック =================
  app.post('/api/community/block', auth.requireAuth, wrap(async (req, res) => {
    const table = TABLES[req.body && req.body.type];
    const id = req.body && req.body.id;
    if (!table || !isId(id)) return res.status(400).json({ error: '不正なリクエストです。' });
    const r = await q(`SELECT owner_user_id FROM ${table} WHERE id = $1`, [id]);
    if (!r.rowCount) return res.status(404).json({ error: '見つかりません。' });
    const owner = r.rows[0].owner_user_id;
    if (owner === String(req.userId)) return res.status(400).json({ error: '自分はブロックできません。' });
    await q('INSERT INTO community_blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [String(req.userId), owner]);
    res.json({ ok: true });
  }));

  app.delete('/api/community/blocks', auth.requireAuth, wrap(async (req, res) => {
    await q('DELETE FROM community_blocks WHERE blocker_user_id = $1', [String(req.userId)]);
    res.json({ ok: true });
  }));

  // ================= 管理者（ADMIN_TOKEN を設定したときだけ有効） =================
  function adminOk(req) {
    const t = process.env.ADMIN_TOKEN || '';
    if (t.length < 24) return false;
    const a = Buffer.from(String(req.headers['x-admin-token'] || ''));
    const b = Buffer.from(t);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const adminWrap = (fn) => async (req, res) => {
    if (!adminOk(req)) return res.status(404).json({ error: 'Not found' });
    try { await ensure(); await fn(req, res); }
    catch (e) { console.error('[community-admin]', e.message); res.status(500).json({ error: 'failed' }); }
  };

  app.get('/api/admin/community/queue', adminWrap(async (req, res) => {
    const posts = await q(
      `SELECT id, owner_user_id, author_name, kind, title, LEFT(body, 300) AS body, hidden, hidden_reason, report_count, created_at,
              ARRAY(SELECT reason FROM community_reports r WHERE r.target_type = 'post' AND r.target_id = p.id ORDER BY r.created_at DESC LIMIT 3) AS reasons
       FROM community_posts p WHERE deleted = FALSE AND (hidden = TRUE OR report_count > 0) ORDER BY created_at DESC LIMIT 100`);
    const comments = await q(
      `SELECT id, owner_user_id, author_name, body, hidden, hidden_reason, report_count, updated_at,
              ARRAY(SELECT reason FROM community_reports r WHERE r.target_type = 'comment' AND r.target_id = c.id ORDER BY r.created_at DESC LIMIT 3) AS reasons
       FROM rank_comments c WHERE hidden = TRUE OR report_count > 0 ORDER BY updated_at DESC LIMIT 100`);
    res.json({ posts: posts.rows, comments: comments.rows });
  }));

  app.post('/api/admin/community/:type/:id/:action', adminWrap(async (req, res) => {
    const { type, id, action } = req.params;
    const table = TABLES[type];
    if (!table || !isId(id)) return res.status(400).json({ error: 'bad request' });
    if (action === 'hide') {
      await q(`UPDATE ${table} SET hidden = TRUE, hidden_reason = 'admin' WHERE id = $1`, [id]);
    } else if (action === 'unhide') {
      await q(`UPDATE ${table} SET hidden = FALSE, hidden_reason = NULL, report_count = 0 WHERE id = $1`, [id]);
      await q('DELETE FROM community_reports WHERE target_type = $1 AND target_id = $2', [type, id]);
    } else if (action === 'delete') {
      if (type === 'post') await q('UPDATE community_posts SET deleted = TRUE, hidden = TRUE WHERE id = $1', [id]);
      else await q('DELETE FROM rank_comments WHERE id = $1', [id]);
    } else {
      return res.status(400).json({ error: 'bad action' });
    }
    res.json({ ok: true });
  }));

  app.post('/api/admin/community-ban', adminWrap(async (req, res) => {
    const userId = String((req.body && req.body.userId) || '');
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (req.body.ban === false) {
      await q('DELETE FROM community_bans WHERE user_id = $1', [userId]);
    } else {
      await q('INSERT INTO community_bans (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
      await q("UPDATE community_posts SET hidden = TRUE, hidden_reason = 'banned' WHERE owner_user_id = $1", [userId]);
      await q("UPDATE rank_comments SET hidden = TRUE, hidden_reason = 'banned' WHERE owner_user_id = $1", [userId]);
    }
    res.json({ ok: true });
  }));
}

module.exports = { register, screenText, weekStartJst };

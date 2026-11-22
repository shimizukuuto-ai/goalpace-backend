const crypto = require('crypto');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./db');
const auth = require('./auth');
const iap = require('./iap');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

// ==========================================================================
// 設定 & モデル設定 (OpenRouter / Groq / Llama 3)
// ==========================================================================
const API_KEY = process.env.OPENROUTER_API_KEY || process.env.GROQ_API_KEY;
const IS_OPENROUTER = Boolean(process.env.OPENROUTER_API_KEY || (API_KEY && API_KEY.startsWith('sk-or-')));

const API_BASE = IS_OPENROUTER
  ? 'https://openrouter.ai/api/v1/chat/completions'
  : 'https://api.groq.com/openai/v1/chat/completions';

const DEFAULT_MODEL = IS_OPENROUTER
  ? (process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3.5-lightning:free')
  : (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile');

// 認証を必須にするかどうか（開発中や個人利用では false 推奨）
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === 'true';

// 1日あたりの利用回数上限（DBが有効な場合）
const FREE_DAILY_LIMIT = parseInt(process.env.FREE_DAILY_LIMIT || '10', 10);
const SUBSCRIBED_DAILY_LIMIT = 100;
const SHARE_BONUS_AMOUNT = 3;

const MOCK_MODE = process.env.MOCK_MODE === 'true';

const MOCK_QUESTIONS = {
  questions: [
    { id: 'q1', question: '現在の進捗や現状のレベルはどのくらいですか？', type: 'text', unit: '' },
    { id: 'q2', question: '1日または1週間に確保できる作業時間は何時間ですか？', type: 'number', unit: '時間' },
    { id: 'q3', question: 'これまでに同様の目標に取り組んだ経験はありますか？', type: 'text', unit: '' },
  ],
};

const MOCK_PLAN = {
  feasibility: '現実的',
  reasoning: '（モック）目標期間に対して無理のないペース配分が可能です。基本習慣の確立から着手しましょう。',
  achievableDate: '2027-01-15',
  requiredPace: '1日あたり1〜2時間の集中作業を週5日継続',
  tasks: [
    { week: 1, dailyTasks: ['全体のゴールを3つのマイルストーンに分解する', '必要な教材やツールを準備する'] },
    { week: 2, dailyTasks: ['基礎ルーティンを毎日25分実践する', '週末に進捗を振り返る'] },
  ],
};

const MOCK_CHECKIN = {
  onTrack: true,
  updatedPace: '順調です。このままのペースを維持してください。',
  updatedTasks: ['明日の重要タスクを1つ前倒しで着手する', 'ポモドーロタイマーを活用して集中時間を記録する'],
  message: '素晴らしい進捗です！計画通りに着実に前進しています。',
  achievementProbability: 0.82,
  projectedFinishDate: '2027-01-10',
  currentPacePercent: 42,
};

function resolveLocale(req) {
  return req.body.locale === 'en' ? 'en' : 'ja';
}

function localeSuffix(locale) {
  return locale === 'en'
    ? '\n\nIMPORTANT: Output all text fields (feasibility, reasoning, requiredPace, dailyTasks, message, updatedPace, updatedTasks, etc.) in English only. Do not include Japanese characters.'
    : '\n\n重要: 出力するJSON内のテキストはすべて自然で読みやすい日本語にしてください。';
}

// ==========================================================================
// AI (OpenRouter / Groq / Llama 3) 呼び出し処理
// ==========================================================================
async function callGroqLlama({ system, userText, locale, jsonMode = true }) {
  if (!API_KEY) {
    if (MOCK_MODE) {
      console.warn('[DEV] API_KEY未設定のためモックを返します');
      return null;
    }
    throw new Error('API_KEY is not set. Please set OPENROUTER_API_KEY or GROQ_API_KEY in your .env or Render Environment Variables.');
  }

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: userText }
  ];

  const body = {
    model: DEFAULT_MODEL,
    messages,
    temperature: 0.2,
  };

  if (jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${API_KEY}`,
  };
  if (IS_OPENROUTER) {
    headers['HTTP-Referer'] = 'https://github.com/shimizusorashou/ControlCenter';
    headers['X-Title'] = 'ControlCenter';
  }

  const maxRetries = 3;
  let res, errText;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      res = await fetch(API_BASE, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (res.ok) break;

      errText = await res.text();
      console.error(`AI API ${res.status} body:`, errText);

      const isRateLimited = res.status === 429;
      const isRetryable = (res.status === 503 || res.status === 500 || isRateLimited);

      if (isRetryable && attempt < maxRetries) {
        const waitMs = 1500 * Math.pow(2, attempt);
        console.log(`AI API ${res.status}, retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})...`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      throw new Error(`AI API error (${res.status}): ${errText}`);
    } catch (e) {
      if (attempt >= maxRetries) throw e;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error('AI returned empty response: ' + JSON.stringify(data));
  }
  return text;
}

function parseJson(text) {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.search(/[{\[]/);
  if (start === -1) {
    throw new Error('No JSON object/array found in response: ' + cleaned.slice(0, 200));
  }

  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;

  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }

  if (end === -1) {
    throw new Error('Could not find matching closing bracket in response: ' + cleaned.slice(0, 200));
  }

  return JSON.parse(cleaned.slice(start, end + 1));
}

// ==========================================================================
// 認証 & レート制限ミドルウェア
// ==========================================================================
function optionalAuth(req, res, next) {
  if (!REQUIRE_AUTH) {
    req.userId = 'guest_user';
    return next();
  }
  return auth.requireAuth(req, res, next);
}

async function optionalUsageLimit(req, res, next) {
  if (!REQUIRE_AUTH) return next();
  if (!db.DB_ENABLED) return res.status(503).json({ error: 'Account service is unavailable' });
  try {
    const user = await db.getUserById(req.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });

    const subscriptionActive = Boolean(
      user.is_subscribed && user.subscription_expires_at &&
      new Date(user.subscription_expires_at).getTime() > Date.now()
    );
    const isPaid = user.is_lifetime || subscriptionActive;
    const { todayCount } = await db.getUsageCounts(user.id);
    const shareBonusToday = await db.getShareBonusToday(user.id);
    const dailyLimit = (isPaid ? SUBSCRIBED_DAILY_LIMIT : FREE_DAILY_LIMIT) + shareBonusToday;

    if (todayCount >= dailyLimit) {
      return res.status(429).json({ error: '本日分の利用上限に達しました。' });
    }
    await db.recordUsageEvent(user.id, req.path);
    next();
  } catch (err) {
    console.error('AI usage limit check failed:', err);
    res.status(503).json({ error: 'AI usage service is temporarily unavailable' });
  }
}

// ==========================================================================
// エンドポイント
// ==========================================================================

// ヘルスチェック（Renderが利用）
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    provider: IS_OPENROUTER ? 'openrouter' : (API_KEY ? 'groq' : 'unconfigured'),
    model: DEFAULT_MODEL,
  });
});

app.get('/', (req, res) => {
  res.json({
    app: 'GoalPace & ControlCenter Unified Backend',
    status: 'running',
    aiProvider: IS_OPENROUTER ? 'OpenRouter' : (API_KEY ? 'Groq (Llama 3)' : 'unconfigured'),
    model: DEFAULT_MODEL,
    endpoints: ['/api/questions', '/api/plan', '/api/checkin', '/health']
  });
});

// 1. 目標ヒアリング質問生成
app.post('/api/questions', optionalAuth, optionalUsageLimit, async (req, res) => {
  try {
    const { goal, targetDate } = req.body;
    const locale = resolveLocale(req);

    if (MOCK_MODE || !API_KEY) {
      console.log('[MOCK] /api/questions');
      return res.json(MOCK_QUESTIONS);
    }

    const system = `あなたはプロフェッショナルな目標達成・計画立案コーチです。
ユーザーから提示された「目標」と「達成期日」を分析し、現実的な計画を作成するために必要な現状把握の質問を3〜5問作成してください。

必ず以下のJSON形式のみで出力してください（他の文章は出力しないでください）：
{
  "questions": [
    {
      "id": "q1",
      "question": "質問文",
      "type": "text" または "number",
      "unit": "単位（例: 時間, 万円, kgなど。不要なら空文字）"
    }
  ]
}` + localeSuffix(locale);

    const userText = `【目標】: ${goal}\n【達成期日】: ${targetDate}`;
    const text = await callGroqLlama({ system, userText, locale });
    const parsed = parseJson(text);
    res.json(parsed);
  } catch (err) {
    console.error('/api/questions error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 2. プラン・ロードマップ生成
app.post('/api/plan', optionalAuth, optionalUsageLimit, async (req, res) => {
  try {
    const { goal, targetDate, baselineAnswers } = req.body;
    const locale = resolveLocale(req);

    if (MOCK_MODE || !API_KEY) {
      console.log('[MOCK] /api/plan');
      return res.json(MOCK_PLAN);
    }

    const system = `あなたは目標達成・行動設計のエキスパートです。
ユーザーの目標、期日、現状の回答をもとに、達成可能性（feasibility）を科学的・現実的に分析し、週ごとの具体的なタスクロードマップを作成してください。

必ず以下のJSON形式のみで出力してください：
{
  "feasibility": "現実的" または "やや厳しい" または "非現実的",
  "reasoning": "達成可能性の根拠・アドバイス（2〜3文）",
  "achievableDate": "現実的に達成可能な日付（YYYY-MM-DD形式。期日が妥当なら期日と同じ）",
  "requiredPace": "1日あたりにこなすべき目安（例: 毎日1時間の学習、平日2時間の開発など）",
  "tasks": [
    {
      "week": 1,
      "dailyTasks": ["タスク1", "タスク2", "タスク3"]
    },
    {
      "week": 2,
      "dailyTasks": ["タスク1", "タスク2"]
    }
  ]
}
※ tasksは最初の2〜4週分の具体的なアクションを出力してください。各タスクはControlCenterのToDoリストに登録しやすい具体的で実行可能な粒度にしてください。` + localeSuffix(locale);

    const userText = `【目標】: ${goal}\n【達成期日】: ${targetDate}\n【現状の回答】: ${JSON.stringify(baselineAnswers)}`;
    const text = await callGroqLlama({ system, userText, locale });
    const parsed = parseJson(text);
    res.json(parsed);
  } catch (err) {
    console.error('/api/plan error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 3. フィードバックループ（チェックイン・進捗評価・プラン再調整）
app.post('/api/checkin', optionalAuth, optionalUsageLimit, async (req, res) => {
  try {
    const { project, todayEntry } = req.body;
    const locale = resolveLocale(req);

    if (MOCK_MODE || !API_KEY) {
      console.log('[MOCK] /api/checkin');
      return res.json(MOCK_CHECKIN);
    }

    let scheduleElapsedPercent = null;
    try {
      const start = new Date(project.createdAt);
      const end = new Date(project.targetDate + 'T00:00:00');
      const now = new Date();
      const totalMs = end.getTime() - start.getTime();
      if (totalMs > 0) {
        const elapsedMs = Math.min(Math.max(now.getTime() - start.getTime(), 0), totalMs);
        scheduleElapsedPercent = Math.round((elapsedMs / totalMs) * 100);
      }
    } catch (e) {
      // 日付パースエラーは無視
    }

    const previousCurrentPacePercent = typeof project.aiCurrentPacePercent === 'number'
      ? project.aiCurrentPacePercent
      : null;

    const system = `あなたは目標達成ペースメーカーAIです。
プロジェクト全体の進捗履歴、今日の進捗ログ（気分・完了タスク・メモ）を分析し、
達成確率・着地予想日・軌道修正プランを算出してフィードバックしてください。

必ず以下のJSON形式のみで出力してください：
{
  "onTrack": true または false,
  "updatedPace": "明日以降の推奨ペース（例: ペース維持、または毎日+30分など）",
  "updatedTasks": ["明日取り組むべき具体的タスク1", "タスク2"],
  "message": "ユーザーへのフィードバック・激励メッセージ（2〜3文、率直かつ建設的に）",
  "achievementProbability": 0.00〜1.00の数値（目標期日までに達成できる確率）,
  "projectedFinishDate": "このペースで進んだ場合の着地予測日（YYYY-MM-DD形式）",
  "currentPacePercent": 0〜130の数値（全体の道のりを100とした場合の現在地）
}` + localeSuffix(locale);

    const userText = `【プロジェクト情報】: ${JSON.stringify(project)}
【本日のチェックイン】: ${JSON.stringify(todayEntry)}
【経過日数の割合目安】: ${scheduleElapsedPercent === null ? '不明' : scheduleElapsedPercent + '%'}
【前回のAI進捗率】: ${previousCurrentPacePercent === null ? '初回' : previousCurrentPacePercent + '%'}`;

    const text = await callGroqLlama({ system, userText, locale });
    const parsed = parseJson(text);

    if (typeof parsed.achievementProbability === 'number') {
      parsed.achievementProbability = Math.min(Math.max(parsed.achievementProbability, 0.05), 0.98);
    }
    if (typeof parsed.currentPacePercent === 'number') {
      parsed.currentPacePercent = Math.min(Math.max(parsed.currentPacePercent, 0), 130);
    }

    res.json(parsed);
  } catch (err) {
    console.error('/api/checkin error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/flashcards', optionalAuth, optionalUsageLimit, async (req, res) => {
  try {
    const topic = typeof req.body?.topic === 'string' ? req.body.topic.trim() : '';
    const count = Math.max(1, Math.min(10, Math.floor(Number(req.body?.count) || 5)));
    const locale = resolveLocale(req);
    if (!topic || topic.length > 300) {
      return res.status(400).json({ error: 'Topic must contain 1–300 characters.' });
    }
    if (MOCK_MODE || !API_KEY) return res.json({ cards: [] });

    const system = `Create concise, accurate study flashcards. Return only valid JSON in this exact shape: {"cards":[{"question":"...","answer":"..."}]}. Create exactly ${count} distinct cards. Do not include markdown.` + localeSuffix(locale);
    const text = await callGroqLlama({ system, userText: `Topic: ${topic}\nCreate exactly ${count} useful question and answer cards.`, locale });
    const parsed = parseJson(text);
    const cards = (Array.isArray(parsed) ? parsed : parsed?.cards)
      ?.map(card => ({ question: String(card?.question || '').trim(), answer: String(card?.answer || '').trim() }))
      .filter(card => card.question && card.answer)
      .slice(0, count);
    if (!cards?.length) throw new Error('AI returned no usable flashcards');
    res.json({ cards });
  } catch (err) {
    console.error('/api/flashcards error:', err);
    res.status(500).json({ error: 'Could not generate flashcards right now.' });
  }
});

// Daily category leaderboard. Only nickname and aggregate counts are stored; task text is never sent.
app.post('/api/leaderboard/sync', optionalAuth, async (req, res) => {
  try {
    const { displayName, date, categories } = req.body || {};
    // In production, the leaderboard identity comes from the signed-in session,
    // never from a userId supplied by the app.
    const userId = REQUIRE_AUTH ? String(req.userId) : req.body?.userId;
    if (typeof userId !== 'string' || userId.length < 1 || userId.length > 80) {
      return res.status(400).json({ error: 'Invalid userId' });
    }
    if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 40) {
      return res.status(400).json({ error: 'Invalid displayName' });
    }
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date' });
    }
    if (!Array.isArray(categories) || categories.length > 30) {
      return res.status(400).json({ error: 'Invalid categories' });
    }
    const normalized = categories.map(item => ({
      name: String(item?.name || '').trim().slice(0, 40),
      progress: Math.max(0, Math.min(100, Math.round(Number(item?.progress) || 0))),
      completed: Math.max(0, Math.min(100000, Math.floor(Number(item?.completed) || 0))),
      target: Math.max(0, Math.min(100000, Math.floor(Number(item?.target) || 0))),
      points: Math.max(0, Math.min(1000000, Math.floor(Number(item?.points) || 0))),
      pomodoro: Math.max(0, Math.min(100000, Math.floor(Number(item?.pomodoro) || 0))),
      minutes: Math.max(0, Math.min(1000000, Math.floor(Number(item?.minutes) || 0))),
      memorized: Math.max(0, Math.min(100000, Math.floor(Number(item?.memorized) || 0))),
    })).filter(item => item.name && (item.target + item.completed + item.pomodoro + item.minutes + item.memorized) > 0);
    // ランキングの名前は匿名（プレイヤー-＋IDから作る4文字）。端末から送られた名前は使わない
    const anonName = 'プレイヤー-' + crypto.createHash('sha256').update(userId).digest('hex').slice(0, 4);
    await db.upsertDailyCategoryScores(userId, anonName, date, normalized);
    res.json({ ok: true });
  } catch (err) {
    console.error('/api/leaderboard/sync error:', err);
    res.status(503).json({ error: 'Leaderboard is unavailable' });
  }
});

// 週次ランキング: from/to（YYYY-MM-DD, 最大7日間）, category, metric で取得
const LEADERBOARD_METRICS = Object.keys(db.LEADERBOARD_METRIC_COLUMNS);
app.get('/api/leaderboard', optionalAuth, async (req, res) => {
  try {
    const to = String(req.query.to || req.query.date || '');
    const from = String(req.query.from || req.query.date || '');
    const category = String(req.query.category || '').trim().slice(0, 40);
    const metric = LEADERBOARD_METRICS.includes(req.query.metric) ? req.query.metric : 'tasks';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || !category) {
      return res.status(400).json({ error: 'from, to and category are required' });
    }
    const days = (Date.parse(to) - Date.parse(from)) / 86400000;
    if (!(days >= 0 && days <= 6)) {
      return res.status(400).json({ error: 'Range must be 1 to 7 days' });
    }
    const entries = await db.getCategoryLeaderboard(from, to, category, metric);
    res.json({ metric, entries });
  } catch (err) {
    console.error('/api/leaderboard error:', err);
    res.status(503).json({ error: 'Leaderboard is unavailable' });
  }
});

// ---- 公開デッキ（ユーザーが明示的に公開したものだけ。カードは公開者が選んだ内容のみ） ----
function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function isDeckId(value) {
  return /^\d{1,18}$/.test(String(value));
}

app.post('/api/shared-decks', auth.requireAuth, async (req, res) => {
  try {
    const title = cleanText(req.body?.title, 80);
    const categoryName = cleanText(req.body?.categoryName, 40);
    const description = cleanText(req.body?.description, 300);
    const rawCards = Array.isArray(req.body?.cards) ? req.body.cards : [];
    const cards = rawCards
      .map(card => ({ question: cleanText(card?.question, 500), answer: cleanText(card?.answer, 1000) }))
      .filter(card => card.question && card.answer);
    if (!title) return res.status(400).json({ error: 'タイトルを入力してください。' });
    if (!categoryName) return res.status(400).json({ error: 'カテゴリーを選んでください。' });
    if (cards.length < 1 || cards.length > 300) return res.status(400).json({ error: 'カードは1〜300枚で公開してください。' });
    if (await db.countOwnSharedDecks(String(req.userId)) >= 20) {
      return res.status(400).json({ error: '公開デッキは20個までです。' });
    }
    // 公開者の名前は出さない（匿名）。ユーザーIDも公開しない
    const deck = await db.createSharedDeck(String(req.userId), '匿名', { title, categoryName, description, cards });
    res.json({ deck });
  } catch (err) {
    console.error('POST /api/shared-decks error:', err);
    res.status(503).json({ error: '公開に失敗しました。時間をおいて再度お試しください。' });
  }
});

app.get('/api/shared-decks', optionalAuth, async (req, res) => {
  try {
    const categoryName = cleanText(req.query.category, 40);
    const query = cleanText(req.query.q, 60);
    const sort = req.query.sort === 'popular' ? 'popular' : 'new';
    const limit = Math.max(1, Math.min(50, Math.floor(Number(req.query.limit) || 30)));
    const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
    const decks = await db.listSharedDecks({ categoryName, sort, query, limit, offset });
    res.json({ decks });
  } catch (err) {
    console.error('GET /api/shared-decks error:', err);
    res.status(503).json({ error: '公開デッキを読み込めませんでした。' });
  }
});

app.get('/api/shared-decks/:id', optionalAuth, async (req, res) => {
  try {
    if (!isDeckId(req.params.id)) return res.status(400).json({ error: '不正なIDです。' });
    const deck = await db.getSharedDeck(req.params.id);
    if (!deck) return res.status(404).json({ error: 'デッキが見つかりません。' });
    const { owner_user_id, ...publicDeck } = deck; // 公開者の内部IDは返さない
    res.json({ deck: publicDeck });
  } catch (err) {
    console.error('GET /api/shared-decks/:id error:', err);
    res.status(503).json({ error: '公開デッキを読み込めませんでした。' });
  }
});

// 取り込み: カード本文を返す。クライアント側で自分のデッキに追加する
app.post('/api/shared-decks/:id/import', auth.requireAuth, async (req, res) => {
  try {
    if (!isDeckId(req.params.id)) return res.status(400).json({ error: '不正なIDです。' });
    const deck = await db.getSharedDeck(req.params.id);
    if (!deck) return res.status(404).json({ error: 'デッキが見つかりません。' });
    if (deck.owner_user_id === String(req.userId)) {
      return res.status(400).json({ error: '自分のデッキは取り込めません。' });
    }
    await db.recordSharedDeckImport(req.params.id, String(req.userId));
    res.json({ title: deck.title, categoryName: deck.categoryName, cards: deck.cards });
  } catch (err) {
    console.error('POST /api/shared-decks/:id/import error:', err);
    res.status(503).json({ error: '取り込みに失敗しました。' });
  }
});

// 公開を取り下げ（自分のデッキだけ）
// 公開済みデッキの内容を更新（自動公開の同期用。持ち主だけが更新できる）
app.put('/api/shared-decks/:id', auth.requireAuth, async (req, res) => {
  try {
    if (!isDeckId(req.params.id)) return res.status(400).json({ error: '不正なIDです。' });
    const title = cleanText(req.body?.title, 80);
    const categoryName = cleanText(req.body?.categoryName, 40);
    const description = cleanText(req.body?.description, 300);
    const rawCards = Array.isArray(req.body?.cards) ? req.body.cards : [];
    const cards = rawCards
      .map(card => ({ question: cleanText(card?.question, 500), answer: cleanText(card?.answer, 1000) }))
      .filter(card => card.question && card.answer);
    if (!title) return res.status(400).json({ error: 'タイトルを入力してください。' });
    if (!categoryName) return res.status(400).json({ error: 'カテゴリーを選んでください。' });
    if (cards.length < 1 || cards.length > 300) return res.status(400).json({ error: 'カードは1〜300枚で公開してください。' });
    const ok = await db.updateSharedDeck(req.params.id, String(req.userId), { title, categoryName, description, cards });
    if (!ok) return res.status(404).json({ error: 'デッキが見つかりません。' });
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/shared-decks error:', err);
    res.status(503).json({ error: '更新に失敗しました。時間をおいて再度お試しください。' });
  }
});

app.delete('/api/shared-decks/:id', auth.requireAuth, async (req, res) => {
  try {
    if (!isDeckId(req.params.id)) return res.status(400).json({ error: '不正なIDです。' });
    const ok = await db.deleteSharedDeck(req.params.id, String(req.userId));
    if (!ok) return res.status(404).json({ error: 'デッキが見つかりません。' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/shared-decks/:id error:', err);
    res.status(503).json({ error: '取り下げに失敗しました。' });
  }
});

// 通報（App Store審査のための報告機能）
app.post('/api/shared-decks/:id/report', auth.requireAuth, async (req, res) => {
  try {
    if (!isDeckId(req.params.id)) return res.status(400).json({ error: '不正なIDです。' });
    const reason = cleanText(req.body?.reason, 200) || '不適切な内容';
    const deck = await db.getSharedDeck(req.params.id);
    if (!deck) return res.status(404).json({ error: 'デッキが見つかりません。' });
    await db.reportSharedDeck(req.params.id, String(req.userId), reason);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/shared-decks/:id/report error:', err);
    res.status(503).json({ error: '通報を受け付けられませんでした。' });
  }
});

// 認証（必要時）
app.post('/api/auth/apple', async (req, res) => {
  try {
    if (!db.DB_ENABLED) return res.status(503).json({ error: 'Account service is unavailable' });
    const { identityToken, displayName } = req.body;
    if (typeof identityToken !== 'string' || identityToken.length > 12000) {
      return res.status(400).json({ error: 'A valid Apple identity token is required' });
    }
    if (displayName !== undefined && (typeof displayName !== 'string' || displayName.trim().length > 40)) {
      return res.status(400).json({ error: 'displayName must be at most 40 characters' });
    }
    const appleUserId = await auth.verifyAppleIdentityToken(identityToken);
    let user = await db.findOrCreateUser(appleUserId);
    if (displayName?.trim()) {
      user = { ...user, ...(await db.updateDisplayName(user.id, displayName.trim())) };
    }
    const sessionToken = auth.issueSessionToken(user.id);
    res.json({
      sessionToken,
      user: { id: user.id, displayName: user.display_name || null, accountData: user.account_data || {} },
      isSubscribed: user.is_subscribed,
      isLifetime: user.is_lifetime,
      expiresAt: user.subscription_expires_at || null,
    });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.get('/api/account', auth.requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.userId);
    if (!user) return res.status(404).json({ error: 'Account not found' });
    res.json({
      user: { id: user.id, displayName: user.display_name || null, accountData: user.account_data || {} },
      isSubscribed: Boolean(user.is_subscribed && user.subscription_expires_at && new Date(user.subscription_expires_at).getTime() > Date.now()),
      isLifetime: user.is_lifetime,
      expiresAt: user.subscription_expires_at || null,
    });
  } catch (err) {
    console.error('/api/account error:', err);
    res.status(503).json({ error: 'Account service is unavailable' });
  }
});

app.put('/api/account/data', auth.requireAuth, async (req, res) => {
  try {
    const { accountData, displayName } = req.body || {};
    if (!accountData || typeof accountData !== 'object' || Array.isArray(accountData)) {
      return res.status(400).json({ error: 'accountData must be an object' });
    }
    if (displayName !== undefined && (typeof displayName !== 'string' || displayName.trim().length > 40)) {
      return res.status(400).json({ error: 'displayName must be at most 40 characters' });
    }
    const user = await db.saveAccountData(req.userId, accountData, displayName?.trim());
    if (!user) return res.status(404).json({ error: 'Account not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('/api/account/data error:', err);
    res.status(503).json({ error: 'Account sync is unavailable' });
  }
});

app.delete('/api/account', auth.requireAuth, async (req, res) => {
  try {
    if (!db.DB_ENABLED) return res.status(503).json({ error: 'Account service is unavailable' });
    await db.deleteAccount(req.userId);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/account error:', err);
    res.status(503).json({ error: 'Account deletion is unavailable' });
  }
});

app.post('/api/iap/verify', auth.requireAuth, async (req, res) => {
  try {
    if (!db.DB_ENABLED) return res.status(503).json({ error: 'Purchase verification is unavailable' });
    const { signedTransactionInfo } = req.body || {};
    if (typeof signedTransactionInfo !== 'string' || signedTransactionInfo.length > 30000) {
      return res.status(400).json({ error: 'A valid signed transaction is required' });
    }
    const transaction = await iap.verifyTransaction(signedTransactionInfo);
    if (transaction.bundleId !== process.env.APPLE_BUNDLE_ID) {
      return res.status(400).json({ error: 'Transaction belongs to a different app' });
    }
    const currentOwner = await db.getUserByOriginalTransactionId(transaction.originalTransactionId);
    if (currentOwner && String(currentOwner.id) !== String(req.userId)) {
      return res.status(409).json({ error: 'This purchase is linked to another account' });
    }
    const entitlement = await iap.applyTransactionToUser(req.userId, transaction);
    res.json(entitlement);
  } catch (err) {
    console.error('/api/iap/verify error:', err);
    res.status(400).json({ error: 'Purchase could not be verified' });
  }
});

// ポート起動
const PORT = process.env.PORT || 3000;
if (REQUIRE_AUTH && (!process.env.SESSION_JWT_SECRET || !process.env.APPLE_BUNDLE_ID || !db.DB_ENABLED)) {
  throw new Error('Production auth requires SESSION_JWT_SECRET, APPLE_BUNDLE_ID, and DATABASE_URL.');
}

db.initDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 GoalPace + ControlCenter Unified Server running on port ${PORT}`);
      console.log(`🤖 AI Provider: ${API_KEY ? (IS_OPENROUTER ? 'OpenRouter' : 'Groq') : 'not configured'} [Model: ${DEFAULT_MODEL}]`);
      console.log(`🔒 Require Auth: ${REQUIRE_AUTH}`);
    });
  })
  .catch(error => {
    console.error('Database initialization failed:', error);
    if (REQUIRE_AUTH) process.exit(1);
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 GoalPace + ControlCenter Unified Server running on port ${PORT} (database unavailable)`);
    });
  });

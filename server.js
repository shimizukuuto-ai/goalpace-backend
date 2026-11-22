require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./db');
const auth = require('./auth');
const iap = require('./iap');

const app = express();
app.use(cors());
app.use(express.json());
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
  if (!db.DB_ENABLED || !REQUIRE_AUTH) return next();
  try {
    const user = await db.getUserById(req.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });

    const isPaid = user.is_subscribed || user.is_lifetime;
    const { todayCount } = await db.getUsageCounts(user.id);
    const shareBonusToday = await db.getShareBonusToday(user.id);
    const dailyLimit = (isPaid ? SUBSCRIBED_DAILY_LIMIT : FREE_DAILY_LIMIT) + shareBonusToday;

    if (todayCount >= dailyLimit) {
      return res.status(429).json({ error: '本日分の利用上限に達しました。' });
    }
    await db.recordUsageEvent(user.id, req.path);
    next();
  } catch (err) {
    next();
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

    if (MOCK_MODE || !GROQ_API_KEY) {
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

    if (MOCK_MODE || !GROQ_API_KEY) {
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

    if (MOCK_MODE || !GROQ_API_KEY) {
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

// Daily category leaderboard. Only nickname and aggregate counts are stored; task text is never sent.
app.post('/api/leaderboard/sync', async (req, res) => {
  try {
    const { userId, displayName, date, categories } = req.body || {};
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
    })).filter(item => item.name && item.target > 0);
    await db.upsertDailyCategoryScores(userId, displayName.trim().slice(0, 40), date, normalized);
    res.json({ ok: true });
  } catch (err) {
    console.error('/api/leaderboard/sync error:', err);
    res.status(503).json({ error: 'Leaderboard is unavailable' });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const date = String(req.query.date || '');
    const category = String(req.query.category || '').trim().slice(0, 40);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !category) {
      return res.status(400).json({ error: 'date and category are required' });
    }
    const entries = await db.getDailyCategoryLeaderboard(date, category);
    res.json({ entries });
  } catch (err) {
    console.error('/api/leaderboard error:', err);
    res.status(503).json({ error: 'Leaderboard is unavailable' });
  }
});

// 認証（必要時）
app.post('/api/auth/apple', async (req, res) => {
  try {
    const { identityToken } = req.body;
    const appleUserId = await auth.verifyAppleIdentityToken(identityToken);
    let user = await db.getUserByAppleId(appleUserId);
    if (!user) user = await db.createUser(appleUserId);
    const sessionToken = auth.issueSessionToken(user.id);
    res.json({ sessionToken, isSubscribed: user.is_subscribed, isLifetime: user.is_lifetime });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// ポート起動
const PORT = process.env.PORT || 3000;
db.initDb()
  .catch(error => console.error('Database initialization failed:', error))
  .finally(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 GoalPace + ControlCenter Unified Server running on port ${PORT}`);
      console.log(`🤖 AI Provider: ${API_KEY ? (IS_OPENROUTER ? 'OpenRouter' : 'Groq') : 'not configured'} [Model: ${DEFAULT_MODEL}]`);
      console.log(`🔒 Require Auth: ${REQUIRE_AUTH}`);
    });
  });

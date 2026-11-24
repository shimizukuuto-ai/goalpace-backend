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
//   V12.18・D班（項目38の決定）: フリーズはクライアント側（pace.ts・
//   AsyncStorage）だけで足りるため、サーバー変更はしない。理由：
//   (1) 個人ストリークは端末のタスク／チェックイン日付から計算する
//   もので、サーバーは持っていない。(2) リーグの pace_scores は
//   sync-pace が送る実績÷計画量で、フリーズはその比を変えない。
//   (3) 共有ストリークは「全員が勝った日」の定義そのものなので、
//   個人のフリーズで他人の負け日を勝ち日に書き換えてはならない。
//   よってこの TODO は残すが、サーバー側の対応は不要と判断した。
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
// V12.6・C班: 数値タイプ（kind='value'）と達成の決め方。
//   value=目標値ベース（開始値→目標値。例：体重 95kg→80kg）。
//   start_value（NULL可。無い場合は target を開始値扱いにしない＝
//   進捗は記録待ち）と achievement_rule（'auto'|'deadline'|'declare'、
//   既定 'auto'）を shared_goals に後付けする（kind・visibility と
//   同じ ADD COLUMN IF NOT EXISTS パターン）。
//   現在値は POST /:id/contribute の body { value } で記録し、
//   shared_goal_values（goal_id, user_id, value, logged_at）に毎回
//   1行残す。最新の1件が現在値。contributions にはその日初回だけ
//   amount=1 を入れる（habit と同じ1日1回の形でペース%・ストリーク・
//   今日のノルマ達成率の「今日記録したか」を保つ。2回目以降は値の
//   修正のみで貢献は増えない）。全体の達成率はクライアントの
//   sharedGoalOverallRate が開始値→目標値の近づき具合で出す。
//   達成の決め方（achievementRule）は v12.6 では保存だけだったが、
//   v12.7・A班で実行した（申告ボタン・期日の合否入力・自動判定。I12.7-9）。
// V12.7・A班: 達成の決め方（achievementRule）の実行。
//   v12.6 では保存だけだった achievement_rule を動かす。
//   - declare: shared_goal_declarations（goal_id, user_id, declared_at）。
//     メンバーが「達成した」を申告・取り消しできる。全員が申告したら
//     達成（achievement_status='achieved'）。1人でも取り消したら active に戻る。
//   - deadline: shared_goals.deadline_result（'pass'|'fail'）＋
//     deadline_result_at。作成者だけが期日を過ぎてから入れられる。
//     pass → achieved、fail → failed。取り消し（null）で active に戻る。
//   - auto: contribute 時に判定する。value は記録したメンバーの最新値が
//     開始値→目標値に到達したら達成。count/time/habit は貢献合計が
//     target に到達したら達成（同じ 'auto' の意味）。
//   達成状態は shared_goals.achievement_status（'active'|'achieved'|
//   'failed'、既定 'active'）＋ achieved_at。loadGoalDetail が
//   achievementStatus / achievedAt / deadlineResult / declaredCount /
//   myDeclared / deadlinePassed とメンバーごとの declared を返す。
//   旧データは全て 'active'・申告なし（表示・判定とも従来通り）。
// V12.8・C班: 共有目標のチーム管理（メンバーごとの週間統計と最近の記録）。
//   - 週間統計: loadGoalDetail が members[] の各行に weeklyStats
//     { pomodoro, memorized, tasksDone, weekStart } を付ける。出所は
//     POST /api/leaderboard/sync-pace が今週分として保存する pace_scores
//     （db.getWeekWindow と同じ月曜 0:00 JST の週）。新規テーブル・列は
//     作らない（pace_scores は V11 からある）。統計を送っていない
//     メンバーは 0（未送信と 0 回は区別しない）。pace_scores が無い
//     環境でも詳細が 503 にならないよう、読み取り失敗時は 0 扱いにする。
//   - 最近の記録: 新規 GET /api/shared-goals/:id/members/:userId/activity。
//     /api/activity/feed の activity_events（task/card/pomodoro/goal、
//     hidden のものは出さない）と、この共有目標への貢献記録
//     （shared_goal_contributions）を新しい順に混ぜて返す（既定10件・
//     最大20件）。閲覧者・対象ともメンバー限定（非メンバーは 403、
//     対象がメンバーでなければ 404）。
// V12.15・B班: メンバーごとの累計の実績（チーム表示用）。
//   - loadGoalDetail が members[] の各行に totalStats
//     { pomodoro, memorized, tasksDone } を付ける。出所は weeklyStats と
//     同じ pace_scores だが、週で絞らず全週の合計（SUM）にする。
//     新規テーブル・列は作らない。weeklyStats は旧クライアント互換の
//     ため残す（表示には使わない）。読み取り失敗時は 0 扱いにする。
//   - バージョンは 7.9.0 に上がる（features.memberTotalStats）。
// V12.2・A班: 共有目標の公開範囲（visibility: private/public。未指定・
//   旧データは 'private'）とコメント（shared_goal_comments）。
//   公開目標は GET /api/shared-goals/public で一覧でき、
//   POST /api/shared-goals/:id/join-public でコード無しで参加できる。
//   コメントはメンバーのみ読み書き可、最大500文字、screenText で検査し、
//   通報は community_reports（target_type='shared_goal_comment'）に記録する。
//   既存のデータ構造・業務ロジックは再設計していない（新規オプションフィールド・
//   列と新規エンドポイントの追加のみ）。
// V12.11・A班: グループ活動トースト用の出来事ストア（shared_goal_events）。
//   今日タブに「他の共有目標メンバーがコメント投稿／達成したときにトーストで
//   知らせる」機能のための、共有目標に紐づく出来事だけの軽量ストア。
//   既存の GET /api/activity/feed は全ユーザーの直近7日の task/card/
//   pomodoro/goal で共有目標に紐づかず、コメントも達成も載らないため
//   流用できない（新規テーブル＋専用エンドポイント GET /api/shared-goals/updates）。
//   出来事は kind='comment'|'achieved'|'taskDone' の3種。
//   - comment: コメント投稿時（text=コメント本文。500文字制限は従来通り）。
//   - achieved: 達成への遷移（active→achieved）の瞬間のみ1行。
//     declare（全員申告が揃ったとき）・deadline-result（pass のとき）・
//     auto（contribute で到達したとき）。failed は対象外。
//     refreshDeclareStatus は参加・退出・キックからも呼ばれるため、
//     UPDATE の行数で遷移を検出してから書く（二重書き込み防止）。
//   - taskDone: 共通タスクの完了時（text=タスク名。完了＝INSERT のみ。
//     取消＝DELETE は対象外）。
//   書き込みはすべてベストエフォート（失敗しても本体の処理は成功させる。
//   キック時の activity_events への書き方と同じ流儀）。
//   読み取りは GET /api/shared-goals/updates（認証必須・メンバー限定・
//   直近24時間・新しい順。自分の出来事も含めて返す＝除外はクライアント側）。
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
  mode TEXT NOT NULL DEFAULT 'coop',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- V12・D班: kind は既存テーブルにも後付けする（CREATE TABLE IF NOT EXISTS
-- だけでは既存行に列が増えないため ALTER を併記する）。
ALTER TABLE shared_goals ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'count';
-- V12.2・A班: visibility は kind と同じ後付けパターン。
--   'private'=招待コードのみ（既定・旧データもこれ）/ 'public'=一覧に出て
--   コード無しで参加できる。旧データは ALTER の DEFAULT で 'private' になる。
ALTER TABLE shared_goals ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';
-- V12.24・A班: mode は kind・visibility と同じ後付けパターン。
--   'coop'=協力型（1つの共有目標。共通タスクのボーナスは最初の完了者
--   だけがチームに加算）/ 'compete'=競争型（各自の目標でペースを競う。
--   共通タスクの完了は自分の貢献にだけ加算）。作成時に選ぶ。
--   作成後の変更は不可（更新エンドポイントは無い）。
--   旧データは ALTER の DEFAULT で 'coop' になる。
ALTER TABLE shared_goals ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'coop';
-- V12.6・C班: 数値タイプの開始値（value のときだけ使う。NULL可。
--   無い場合は target を開始値扱いにしない＝進捗は記録待ち）と
--   達成の決め方（'auto'|'deadline'|'declare'。既定 'auto'）。
--   kind・visibility と同じ後付けパターン。
ALTER TABLE shared_goals ADD COLUMN IF NOT EXISTS start_value NUMERIC;
ALTER TABLE shared_goals ADD COLUMN IF NOT EXISTS achievement_rule TEXT NOT NULL DEFAULT 'auto';
-- V12.7・A班: 達成の実行状態（achievement_status 'active'|'achieved'|
-- 'failed'、achieved_at、deadline_result 'pass'|'fail'、deadline_result_at）
-- と「達成した」の申告テーブル。kind・visibility と同じ後付けパターン。
ALTER TABLE shared_goals ADD COLUMN IF NOT EXISTS achievement_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE shared_goals ADD COLUMN IF NOT EXISTS achieved_at TIMESTAMPTZ;
ALTER TABLE shared_goals ADD COLUMN IF NOT EXISTS deadline_result TEXT;
ALTER TABLE shared_goals ADD COLUMN IF NOT EXISTS deadline_result_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS shared_goal_declarations (
  goal_id BIGINT NOT NULL REFERENCES shared_goals(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  declared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (goal_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_shared_goal_declarations ON shared_goal_declarations (goal_id, declared_at ASC);
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
-- V12.23・A班【1】：旧ID→正規ID（デバイスID）の対応表。sync-pace の
-- 移行（db.migrateSharedGoalIdentity）で書き、読み取り時フォールバックで
-- 読む。'guest_user' は入れない＝移行しない（全員共通の壊れた行のため）。
CREATE TABLE IF NOT EXISTS identity_aliases (
  old_user_id TEXT PRIMARY KEY,
  canonical_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- V12.23・A班【4】：日付の既定を JST にする。CURRENT_DATE は DB の
-- セッションタイムゾーン（UTC）で決まるため、新規行の日付がユーザーの
-- 今日とずれる。既存行の値は変えない（新規行だけ JST になる）。
ALTER TABLE shared_goals ALTER COLUMN start_date SET DEFAULT ((now() AT TIME ZONE 'Asia/Tokyo')::date);
ALTER TABLE shared_goal_contributions ALTER COLUMN contributed_date SET DEFAULT ((now() AT TIME ZONE 'Asia/Tokyo')::date);
ALTER TABLE shared_goal_task_completions ALTER COLUMN completed_date SET DEFAULT ((now() AT TIME ZONE 'Asia/Tokyo')::date);
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
-- V12.6・C班: 数値タイプの現在値の記録。1回の記録で1行（上書きしない。
--   最新の1件が現在値で、履歴も残る）。contributions とは別物で、
--   個数・時間・習慣の記録は変えない。目標が消えたら CASCADE で消える。
CREATE TABLE IF NOT EXISTS shared_goal_values (
  id BIGSERIAL PRIMARY KEY,
  goal_id BIGINT NOT NULL REFERENCES shared_goals(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  value NUMERIC NOT NULL,
  logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shared_goal_values ON shared_goal_values (goal_id, user_id, logged_at DESC, id DESC);
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
  value NUMERIC NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- V12.24・A班: value は共通タスク1件あたりのボーナス量（1〜100000。
--   既定 1）。kind・visibility と同じ後付けパターン（既存行は 1）。
--   完了時のボーナス計算に使うだけで、保存されるのはタスクの value
--   のみ（ボーナス自体は保存しない。loadGoalDetailInner で都度計算）。
ALTER TABLE shared_goal_tasks ADD COLUMN IF NOT EXISTS value NUMERIC NOT NULL DEFAULT 1;
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
-- V12.11・A班: グループ活動トースト用の出来事ストア（shared_goal_events）。
--   共有目標に紐づく出来事だけを残す軽量テーブル。goal_id は TEXT
--   （仕様通り。shared_goals.id とは文字列比較で結ぶ。外部キーなし）。
--   目標が消えたら読み取り側の JOIN で出なくなる（CASCADE は無い）。
--   kind は 'comment'|'achieved'|'taskDone' の3種のみを書く。
--   text は kind によりコメント本文／目標タイトル（achieved）／タスク名。
CREATE TABLE IF NOT EXISTS shared_goal_events (
  id BIGSERIAL PRIMARY KEY,
  goal_id TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  avatar_color TEXT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shared_goal_events_goal ON shared_goal_events (goal_id, created_at DESC);
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

// V12.23・A班【4】：共有目標の「今日」は日本時間（JST）で決める。
// DB のセッションタイムゾーンは UTC（Render 既定）のため、CURRENT_DATE
// や to_char(timestamp) はユーザーの今日と最大9〜11時間ずれる。
// これが value タイプの「今日 0%」の原因：朝に記録した値は UTC では
// 前日になり、goal.today（UTC の今日）と一致しなかった。
// ペース・週の区切りは従来から JST（db.getWeekWindow 等）なので、
// 共有目標の「今日」も JST に統一する。
const JST_TODAY_SQL = `to_char(now() AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD')`;
const jstDateSql = (col) => `to_char(${col} AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD')`;

const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 紛らわしい文字(0/O, 1/I/L)を除外（db.js の招待コードと同じ）

// V12・D班: 共有目標の種類。count=個数 / time=時間（分）/ habit=習慣チェック（日数）。
// V12.6・C班: value=目標値（開始値→目標値を追う。例：体重 95kg→80kg）。
const SHARED_GOAL_KINDS = ['count', 'time', 'habit', 'value'];
// V12.4・A班: 共有目標のメンバー上限。v12.2 までは 30人だった。
// 既存の10人超の目標は追い出さない（新規参加だけ止める）。
const SHARED_GOAL_MAX_MEMBERS = 10;
const normalizeKind = (v) => (SHARED_GOAL_KINDS.includes(v) ? v : 'count');
// V12.6・C班: 共有目標の達成の決め方。auto=数字到達で自動 /
// deadline=期日に結果を入れる / declare=「達成した」で申告する。
// 未指定・不正値は 'auto'（旧データも 'auto' 扱い）。
const SHARED_GOAL_ACHIEVEMENT_RULES = ['auto', 'deadline', 'declare'];
const normalizeAchievementRule = (v) => (SHARED_GOAL_ACHIEVEMENT_RULES.includes(v) ? v : 'auto');
// V12.2・A班: 共有目標の公開範囲。'public' のときだけ公開、
// 未指定・不正値は 'private'（旧データも 'private' 扱い）。
const SHARED_GOAL_VISIBILITIES = ['private', 'public'];
const normalizeVisibility = (v) => (v === 'public' ? 'public' : 'private');
// V12.24・A班: 共有目標のモード。'coop'=協力型 / 'compete'=競争型。
// 'compete' のときだけ競争型、未指定・不正値・旧データは 'coop'。
const normalizeMode = (v) => (v === 'compete' ? 'compete' : 'coop');
// 種類ごとの単位（time は「分」固定、habit は単位なし、count・value は入力通り）。
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

  // V12.20・C班: メンバー identity の正規化（canonicalIdentity）。
  // pace_scores.user_id（POST /api/leaderboard/sync-pace）と
  // activity_events.owner_user_id（POST /api/activity）は、認証オフ時
  // クライアントが送る userId / X-Device-Id（＝端末ID。A班が
  // syncTruePace で getDeviceId() を送る）で入る。共有目標だけ
  // auth.requireAuth の req.userId を見ており、backend/auth.js は
  // このツリーに無いため、認証オフ時に requireAuth が req.userId へ
  // 何を入れるかは未検証（'guest_user' や 'undefined' なら全員が
  // 同じメンバーIDになり、shared_goal_members と pace_scores /
  // activity_events の JOIN（友達の活動・メンバー活動）が一致しない）。
  // そのため認証オフ時は server.js の onlineIdentity / activity.js の
  // resolveIdentity と同じ解決順（body.userId → query.userId →
  // X-Device-Id）で端末IDを取り、3つの名前空間を同じ ID で揃える。
  // 認証オン時は従来通り requireAuth の req.userId を使う。どれも
  // 取れないときだけ requireAuth が入れた実値（'guest_user' /
  // 'undefined' は除く）をフォールバックにする。既存の 'guest_user'
  // 行は移行しない（全員共通の壊れた行のため。Mac 側で確認すること）。
  const REQUIRE_AUTH = process.env.REQUIRE_AUTH === 'true';
  function resolveMemberId(req) {
    if (REQUIRE_AUTH) return req.userId ? String(req.userId) : '';
    const fromBody = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';
    if (fromBody) return fromBody;
    const fromQuery = typeof req.query?.userId === 'string' ? req.query.userId.trim() : '';
    if (fromQuery) return fromQuery;
    const raw = req.headers['x-device-id'];
    if (typeof raw === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(raw.trim())) return raw.trim();
    const fallback = req.userId ? String(req.userId) : '';
    if (fallback && fallback !== 'guest_user' && fallback !== 'undefined') return fallback;
    return '';
  }

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
          error: 'いま利用できません。時間をおいて再度お試しください。', errorJa: 'いま利用できません。時間をおいて再度お試しください。', errorEn: 'Unavailable right now. Please try again later.',
          code,
          requestId,
        });
      }
    }
  };

  // V12.23・A班【2】：メンバー判定は旧IDでも正規IDでも通す。
  // 対応表（identity_aliases）に旧ID→正規IDがあれば、その正規IDの行も
  // メンバーとみなす（移行前の行・同期していない端末のため）。逆向き
  // （正規IDで問い合わせたとき旧IDの行）も同じく通す。対応表が無ければ
  // （未デプロイ等）従来通りの直接一致だけを見る。
  async function isMember(goalId, userId) {
    const r = await q('SELECT 1 FROM shared_goal_members WHERE goal_id = $1 AND user_id = $2', [goalId, userId]);
    if (r.rowCount > 0) return true;
    try {
      const aliases = await q(
        `SELECT canonical_user_id FROM identity_aliases WHERE old_user_id = $1`,
        [userId]);
      for (const a of aliases.rows) {
        const r2 = await q('SELECT 1 FROM shared_goal_members WHERE goal_id = $1 AND user_id = $2', [goalId, a.canonical_user_id]);
        if (r2.rowCount > 0) return true;
      }
      const olds = await q(
        `SELECT old_user_id FROM identity_aliases WHERE canonical_user_id = $1`,
        [userId]);
      for (const o of olds.rows) {
        const r3 = await q('SELECT 1 FROM shared_goal_members WHERE goal_id = $1 AND user_id = $2', [goalId, o.old_user_id]);
        if (r3.rowCount > 0) return true;
      }
    } catch (_) { /* 対応表が無ければ従来通りの判定だけ */ }
    return false;
  }

  // V12.23・A班【2】：旧ID→正規IDの対応表を1回のクエリで読む。
  // 返すのは { canon, olds }（canon: 旧→新、olds: 新→旧の配列）。
  // 対応表が無ければ両方とも空（従来通りの動きになる）。
  async function loadIdentityAliases(userIds) {
    const canon = new Map();
    const olds = new Map();
    try {
      const ids = [...new Set((userIds || []).map((v) => String(v || '')).filter(Boolean))];
      if (ids.length === 0) return { canon, olds };
      const rows = await q(
        `SELECT old_user_id, canonical_user_id FROM identity_aliases
         WHERE old_user_id = ANY($1::text[]) OR canonical_user_id = ANY($1::text[])`,
        [ids]);
      for (const r of rows.rows) {
        canon.set(r.old_user_id, r.canonical_user_id);
        if (!olds.has(r.canonical_user_id)) olds.set(r.canonical_user_id, []);
        olds.get(r.canonical_user_id).push(r.old_user_id);
      }
    } catch (_) { /* 対応表が無ければ空のまま */ }
    return { canon, olds };
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

  // V12.11・A班: 共有目標の出来事を1行書く（ベストエフォート）。
  //   書き込みに失敗しても呼び出し元の処理は成功させる（例外はここで
  //   吸収する。キック時の activity_events への書き方と同じ流儀）。
  //   authorName / avatarColor は呼び出し元が持つスナップショットを渡す
  //   （コメント投稿時は INSERT した行の値、他は displayNameFor 等）。
  async function recordSharedGoalEvent({ goalId, authorUserId, authorName, avatarColor, kind, text }) {
    try {
      await q(
        `INSERT INTO shared_goal_events (goal_id, author_user_id, author_name, avatar_color, kind, text)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [String(goalId), String(authorUserId), authorName || '', avatarColor || null, kind, text || '']);
    } catch (e) {
      console.error('[shared-goals] record event failed:', e.message);
    }
  }

  // V12.11・A班: 達成の出来事を1行書く（ベストエフォート）。
  //   text は目標タイトル（クライアントのトーストが「○○が達成しました」
  //   と作るための材料。goalTitle は読み取り側も返すが、行自体にも残す）。
  //   遷移検出は呼び出し元で行う（ここは「書く」だけ。呼ぶのは
  //   active→achieved の瞬間だけ）。
  async function recordAchievedEvent(goalId, authorUserId) {
    try {
      const g = await q('SELECT title FROM shared_goals WHERE id = $1', [goalId]);
      const title = g.rowCount ? g.rows[0].title : '';
      await recordSharedGoalEvent({
        goalId,
        authorUserId,
        authorName: await displayNameFor(authorUserId),
        avatarColor: await avatarColorFor(authorUserId),
        kind: 'achieved',
        text: title,
      });
    } catch (e) {
      console.error('[shared-goals] record achieved event failed:', e.message);
    }
  }

  // 目標1件分の集計（メンバー・貢献・スタンプ・ペース%・共有ストリーク・共通タスク）。
  // today は日本時間（JST）の今日（V12.23・A班【4】。以前は CURRENT_DATE＝
  // DB の UTC だったため、朝の記録が前日扱いになり value タイプの
  // 「今日 0%」が起きた）。週のペースは月曜時点の目標で
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
              mode, start_value, achievement_rule,
              achievement_status, achieved_at, deadline_result, deadline_result_at,
              to_char(deadline, 'YYYY-MM-DD') AS deadline,
              to_char(start_date, 'YYYY-MM-DD') AS start_date,
              invite_code, created_at,
              ${JST_TODAY_SQL} AS today
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
    // V12.6・C班: 数値タイプの値の記録（新しい順。1人の最新値と
    // 全体の最新値・今日記録したかをここから導く）。
    const values = await q(
      `SELECT user_id, value, logged_at,
              ${jstDateSql('logged_at')} AS logged_date
       FROM shared_goal_values WHERE goal_id = $1 ORDER BY logged_at DESC, id DESC LIMIT 500`,
      [goalId]);

    // V12.7・A班: 「達成した」の申告（declare ルール用。メンバーごと）。
    // 申告したメンバーの declaredAt と、申告した人数をここから導く。
    const declarations = await q(
      `SELECT user_id, declared_at FROM shared_goal_declarations WHERE goal_id = $1`,
      [goalId]);
    const declaredAtByUser = {};
    // V12.23・A班【2】：旧ID→正規IDの対応表をここで一度だけ読む。
    // このあとのメンバー別集計はすべて正規IDに寄せて作る（移行前の行・
    // 同期しないメンバーの行でも、活動・実績が正規IDで読めるようにする）。
    // 対応表が無ければ canon は恒等写像＝従来通りの動きになる。
    const { canon: aliasCanon } = await loadIdentityAliases([
      ...members.rows.map((m) => m.user_id),
      ...contribs.rows.map((c) => c.user_id),
      ...values.rows.map((v) => v.user_id),
      ...declarations.rows.map((d) => d.user_id),
    ]);
    const canon = (id) => aliasCanon.get(String(id)) || String(id);
    for (const d of declarations.rows) declaredAtByUser[canon(d.user_id)] = d.declared_at;

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
      const uid = canon(c.user_id);
      byUser[uid] = byUser[uid] || { total: 0, today: 0, winDates: new Set() };
      byUser[uid].total += Number(c.amount);
    }
    // 日別・ユーザー別の合計（勝利判定用）。日付は created_at の JST
    // 日付で分ける（V12.23・A班【4】。contributed_date 列は UTC の
    // CURRENT_DATE 既定で入るため、朝の記録が前日扱いになる）。
    const perDay = await q(
      `SELECT user_id, ${jstDateSql('created_at')} AS d, SUM(amount)::float AS amt
       FROM shared_goal_contributions WHERE goal_id = $1 GROUP BY user_id, ${jstDateSql('created_at')}`,
      [goalId]);
    for (const row of perDay.rows) {
      const uid = canon(row.user_id);
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
    for (const r of lastActiveRows.rows) {
      const key = canon(r.user_id);
      // 旧ID行と正規ID行の両方があるときは新しい方を残す。
      if (!lastActiveByUser[key] || new Date(r.last_active) > new Date(lastActiveByUser[key])) lastActiveByUser[key] = r.last_active;
    }
    // 共有ストリーク: 全メンバーが勝利した日の累計（逃した日は 0 に戻さない）
    let sharedWinDates = [];
    if (memberCount > 0) {
      const all = new Set();
      Object.values(byUser).forEach((u) => u.winDates.forEach((d) => all.add(d)));
      sharedWinDates = [...all].filter((d) => members.rows.every((m) => (byUser[canon(m.user_id)] || { winDates: new Set() }).winDates.has(d))).sort();
    }

    // V12.6・C班: 数値タイプの最新値（メンバーごと＋全体）。
    // values は logged_at DESC 順なので、最初に出てきた行がその人の最新値。
    // logged_date は JST の日付で見る（V12.23・A班【4】。以前は UTC の
    // to_char だったため、朝に記録した値が「今日記録したか」に入らなかった）。
    const latestValueByUser = {};
    const valueLoggedTodayByUser = {};
    for (const v of values.rows) {
      const key = canon(v.user_id);
      if (latestValueByUser[key] === undefined) latestValueByUser[key] = Number(v.value);
      if (v.logged_date === goal.today) valueLoggedTodayByUser[key] = true;
    }
    const latestValueOverall = values.rows.length ? Number(values.rows[0].value) : null;

    // V12.8・C班: メンバーごとの今週の統計（暗記したカード枚数・
    // ポモドーロ回数・完了タスク数）。出所は sync-pace が保存する
    // pace_scores。週の区切りは sync-pace と同じ月曜 0:00 JST
    // （db.getWeekWindow と同じ式を SQL で再現する）。
    // pace_scores が無い環境でも詳細が壊れないよう、読み取りに
    // 失敗したら 0 扱いにする（ここで例外を投げない）。
    let weeklyStatsByUser = {};
    let weekStart = null;
    try {
      const weekRow = await q(
        `SELECT to_char(date_trunc('week', now() AT TIME ZONE 'Asia/Tokyo'), 'YYYY-MM-DD') AS week_start`);
      weekStart = (weekRow.rows[0] && weekRow.rows[0].week_start) || null;
      if (weekStart && members.rows.length > 0) {
        // V12.23・A班【2】：旧IDと正規IDの両方で引く（移行前の行も読む）。
        // 戻りは正規IDに寄せ、両方あるときは正規ID行を優先する。
        const statIds = [...new Set([...members.rows.map((m) => m.user_id), ...members.rows.map((m) => canon(m.user_id))])];
        const statsRows = await q(
          `SELECT user_id, pomodoro, memorized, tasks_done FROM pace_scores
           WHERE user_id = ANY($1::text[]) AND week_date = $2::date`,
          [statIds, weekStart]);
        for (const r of statsRows.rows) {
          const key = canon(r.user_id);
          if (weeklyStatsByUser[key] && r.user_id !== key) continue;
          weeklyStatsByUser[key] = {
            pomodoro: Math.max(0, Number(r.pomodoro) || 0),
            memorized: Math.max(0, Number(r.memorized) || 0),
            tasksDone: Math.max(0, Number(r.tasks_done) || 0),
          };
        }
      }
    } catch (_) { weeklyStatsByUser = {}; }

    // V12.15・B班: メンバーごとの累計の実績（暗記したカード枚数・
    // ポモドーロ回数・完了タスク数）。出所は weeklyStats と同じ
    // pace_scores だが、週で絞らず全週の合計（SUM）にする。
    // pace_scores が無い環境でも詳細が壊れないよう、読み取りに
    // 失敗したら 0 扱いにする（ここで例外を投げない）。
    let totalStatsByUser = {};
    try {
      if (members.rows.length > 0) {
        // V12.23・A班【2】：旧IDと正規IDの両方で引く（移行前の行も読む）。
        // 戻りは正規IDに寄せ、両方あるときは正規ID行を優先する。
        const statIds = [...new Set([...members.rows.map((m) => m.user_id), ...members.rows.map((m) => canon(m.user_id))])];
        const totalRows = await q(
          `SELECT user_id, COALESCE(SUM(pomodoro), 0) AS pomodoro,
                  COALESCE(SUM(memorized), 0) AS memorized,
                  COALESCE(SUM(tasks_done), 0) AS tasks_done
           FROM pace_scores WHERE user_id = ANY($1::text[]) GROUP BY user_id`,
          [statIds]);
        for (const r of totalRows.rows) {
          const key = canon(r.user_id);
          if (totalStatsByUser[key] && r.user_id !== key) continue;
          totalStatsByUser[key] = {
            pomodoro: Math.max(0, Number(r.pomodoro) || 0),
            memorized: Math.max(0, Number(r.memorized) || 0),
            tasksDone: Math.max(0, Number(r.tasks_done) || 0),
          };
        }
      }
    } catch (_) { totalStatsByUser = {}; }

    const memberList = members.rows.map((m) => {
      // V12.23・A班【2】：集計の照合は正規IDで行う（メンバー行が旧IDでも
      // 活動・実績は正規IDで読めるようにする）。
      const cid = canon(m.user_id);
      const u = byUser[cid] || { total: 0, today: 0, winDates: new Set() };
      const memberPlanned = memberCount > 0 ? planned / memberCount : 0;
      // V12.4・A班: 今日のノルマ達成率（個数ベースではなくノルマ中心）。
      // todayQuota = その人の今日のノルマ量（count/time は
      // dailyTargetPerMember、habit は1日1回のチェック＝1）。
      // todayQuotaRate = 今日の貢献 ÷ 今日のノルマ × 100（0〜100でキャップ。
      // habit は今日1回チェックしたら 100%）。ノルマが 0 の
      // ときは貢献があれば 100%、無ければ 0%。
      const isHabit = normalizeKind(goal.kind) === 'habit';
      // V12.6・C班: 数値タイプの今日のノルマは「今日値を1回記録する」
      // こと。todayQuota=1（1回の記録）、達成率は記録済み100%・未記録0%。
      const isValue = normalizeKind(goal.kind) === 'value';
      const todayQuota = isHabit || isValue ? 1 : dailyTarget;
      const todayQuotaRate = isHabit
        ? (u.today > 0 ? 100 : 0)
        : isValue
          ? (valueLoggedTodayByUser[cid] ? 100 : 0)
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
        // V12.6・C班: 数値タイプのその人の最新値と今日記録したか
        // （count/time/habit では null/false のまま）。
        currentValue: latestValueByUser[cid] ?? null,
        valueLoggedToday: Boolean(valueLoggedTodayByUser[cid]),
        // V12.7・A班: 「達成した」の申告状態（declare ルール用。
        // 申告していない・旧データでは declared=false・declaredAt=null）。
        declared: Boolean(declaredAtByUser[cid]),
        declaredAt: declaredAtByUser[cid] || null,
        wonToday: u.winDates.has(goal.today),
        // V12.2・A班: 直近の活動日時（貢献・タスク完了の最新。無ければ参加日時）。
        lastActiveAt: lastActiveByUser[cid] || m.joined_at,
        // V12.8・C班: 今週の統計（暗記枚数・ポモドーロ回数・完了タスク数。
        // sync-pace の pace_scores 由来。統計を送っていないメンバーは 0）。
        weeklyStats: {
          pomodoro: (weeklyStatsByUser[cid] || {}).pomodoro || 0,
          memorized: (weeklyStatsByUser[cid] || {}).memorized || 0,
          tasksDone: (weeklyStatsByUser[cid] || {}).tasksDone || 0,
          weekStart,
        },
        // V12.15・B班: 累計の実績（暗記枚数・ポモドーロ回数・完了タスク数。
        // pace_scores の全週の合計。weeklyStats は旧クライアント互換のため残す）。
        totalStats: {
          pomodoro: (totalStatsByUser[cid] || {}).pomodoro || 0,
          memorized: (totalStatsByUser[cid] || {}).memorized || 0,
          tasksDone: (totalStatsByUser[cid] || {}).tasksDone || 0,
        },
        // 共通タスク：そのメンバーが今日完了したタスク数（後で tasks から数えて入れる）
        tasksDoneToday: 0,
        isOwner: m.user_id === goal.owner_user_id,
        joinedAt: m.joined_at,
      };
    });
    // 共有目標内の順位はペース% 順（生値。表示は 100% キャップ＋先行バッジ）。
    memberList.sort((a, b) => b.pacePercent - a.pacePercent || b.contribution - a.contribution);

    // 共通タスク（Iteration 4）：一覧＋今日の完了者。完了は当日のみ有効
    // （JST の今日に完了した行だけを数える。V12.23・A班【4】。以前は
    // completed_date = CURRENT_DATE＝UTC だったため、朝の完了が前日扱い
    // になることがあった）。
    // V12.24・A班: value（タスク1件あたりのボーナス量。既定 1）も読む。
    const taskRows = await q(
      `SELECT id, title, created_by, value, created_at FROM shared_goal_tasks
       WHERE goal_id = $1 ORDER BY created_at ASC, id ASC LIMIT 30`,
      [goalId]);
    // created_at も読む：coop のボーナスは「今日最初に完了した人」だけ
    // に付くため、最初の完了者を決めるのに使う（下の firstCompleterByTask）。
    const doneRows = taskRows.rowCount
      ? await q(
          `SELECT task_id, user_id, created_at FROM shared_goal_task_completions
           WHERE task_id = ANY($1::bigint[]) AND ${jstDateSql('created_at')} = ${JST_TODAY_SQL}`,
          [taskRows.rows.map((t) => t.id)])
      : { rows: [] };
    const doneByTask = {};
    // V12.24・A班: タスクごとの今日最初の完了者（coop のボーナス対象）。
    // created_at が最も早い人。同じ時刻なら user_id の辞書順で決める
    // （決定論的。created_at だけでは同値があり得るため）。
    const firstCompleterByTask = {};
    for (const r of doneRows.rows) {
      const tid = String(r.task_id);
      const uid = canon(r.user_id);
      (doneByTask[tid] = doneByTask[tid] || []).push(uid);
      const prev = firstCompleterByTask[tid];
      if (!prev || new Date(r.created_at) < new Date(prev.createdAt)
        || (new Date(r.created_at).getTime() === new Date(prev.createdAt).getTime() && uid < prev.userId)) {
        firstCompleterByTask[tid] = { userId: uid, createdAt: r.created_at };
      }
    }
    const tasks = taskRows.rows.map((t) => {
      const done = doneByTask[String(t.id)] || [];
      return {
        id: String(t.id),
        title: t.title,
        createdBy: t.created_by,
        // V12.24・A班: タスク1件あたりのボーナス量（旧行・NULL は 1）。
        value: t.value == null ? 1 : Number(t.value),
        createdAt: t.created_at,
        completedByToday: done,
        doneTodayCount: done.length,
        doneToday: viewerUserId ? done.includes(canon(String(viewerUserId))) : false,
        // V12.24・A班: 今日チームに加算されたボーナス（下で決める。
        // value タイプと compete モードでは常に 0）。
        bonusToday: 0,
      };
    });
    for (const m of memberList) {
      m.tasksDoneToday = tasks.filter((t) => t.completedByToday.includes(canon(m.userId))).length;
    }

    // V12.24・A班: 共通タスクのボーナス（computed — 保存しない。
    // double-count guard：完了行を貢献に書き込まず、読み取り時に都度
    // 計算するため、同じ完了が2回数えられることは無い）。
    // 対象は count / time / habit のみ。value タイプは対象外
    // （value は「現在値」を追う種類で、タスク完了を量に換算しない。
    // bonusToday は 0 のまま・貢献にも加算しない）。
    // coop（協力型）：タスクごとに今日最初に完了した人だけが
    // task.value をチームに加算する。2人目以降の完了はチームには
    // 加算しない（bonusToday＝そのタスクが今日チームに加えた量）。
    // compete（競争型）：各メンバーが自分で完了したタスクの value が
    // その人自身の貢献にだけ加算される（チーム合計には他人の分は
    // 入らない）。タスクの bonusToday は 0（チーム単位の加算が無いため）。
    const taskBonusByMember = {};
    if (normalizeKind(goal.kind) !== 'value') {
      const mode = normalizeMode(goal.mode);
      for (const t of tasks) {
        const v = Number(t.value) || 1;
        if (mode === 'compete') {
          for (const uid of new Set(t.completedByToday)) {
            taskBonusByMember[uid] = (taskBonusByMember[uid] || 0) + v;
          }
          t.bonusToday = 0;
        } else {
          const first = firstCompleterByTask[t.id];
          if (first) {
            t.bonusToday = v;
            taskBonusByMember[first.userId] = (taskBonusByMember[first.userId] || 0) + v;
          }
        }
      }
    }
    // ボーナスをメンバーの貢献合計に入れる（全体の達成率も動く。
    // totalContribution はこのあと memberList から合計するため、
    // ここで contribution を足しておけば全体にも反映される）。
    // pacePercent も同じ式で計算し直す（順位はペース%順のまま）。
    for (const m of memberList) {
      const bonus = taskBonusByMember[canon(m.userId)] || 0;
      if (bonus > 0) {
        m.contribution += bonus;
        const memberPlanned = memberCount > 0 ? planned / memberCount : 0;
        m.pacePercent = memberPlanned > 0 ? rawPace((m.contribution / memberPlanned) * 100) : (m.contribution > 0 ? 100 : 0);
      }
    }
    // ボーナスで pacePercent が変わることがあるため、同じ並び順
    // （ペース%降順・貢献降順）で並べ直す。
    memberList.sort((a, b) => b.pacePercent - a.pacePercent || b.contribution - a.contribution);

    const totalContribution = memberList.reduce((s, m) => s + m.contribution, 0);
    // V12・D班: 閲覧者（自分）の今日の貢献量。習慣チェックの「今日やった」
    // 表示（済みならボタンを押せない）に使う。未指定なら 0。
    const myTodayContribution = viewerUserId
      ? (byUser[canon(String(viewerUserId))] || { today: 0 }).today
      : 0;
    // V12.7・A班: 閲覧者（自分）が「達成した」を申告済みか
    // （declare ルール用。未指定なら false）。
    const myDeclared = viewerUserId ? Boolean(declaredAtByUser[canon(String(viewerUserId))]) : false;
    return {
      id: String(goal.id),
      title: goal.title,
      target,
      unit: goal.unit || '',
      // V12・D班: 種類。旧データは 'count'（DB の DEFAULT と同じ）。
      kind: normalizeKind(goal.kind),
      // V12.2・A班: 公開範囲。旧データは 'private'（DB の DEFAULT と同じ）。
      visibility: normalizeVisibility(goal.visibility),
      // V12.24・A班: モード。旧データは 'coop'（DB の DEFAULT と同じ）。
      // 作成後の変更は不可（更新エンドポイントは無い）。
      mode: normalizeMode(goal.mode),
      // V12.6・C班: 数値タイプの開始値と達成の決め方。旧データは
      // startValue=null・achievementRule='auto'（DB の DEFAULT と同じ）。
      // currentValue はメンバー全員の記録のうち最新の1件（無ければ
      // null＝記録待ち）。myCurrentValue は閲覧者本人の最新値。
      startValue: goal.start_value == null ? null : Number(goal.start_value),
      achievementRule: normalizeAchievementRule(goal.achievement_rule),
      // V12.7・A班: 達成の実行状態。旧データ・旧カラム無しは 'active'
      // （DB の DEFAULT と同じ）。achievedAt / deadlineResult /
      // deadlineResultAt が無ければ null。declaredCount は今の
      // メンバーのうち申告済みの人数。deadlinePassed は期日を過ぎたか
      // （サーバー当日で判定。クライアントの時計に依存しない）。
      achievementStatus: ['achieved', 'failed'].includes(goal.achievement_status) ? goal.achievement_status : 'active',
      achievedAt: goal.achieved_at || null,
      deadlineResult: goal.deadline_result === 'pass' || goal.deadline_result === 'fail' ? goal.deadline_result : null,
      deadlineResultAt: goal.deadline_result_at || null,
      declaredCount: memberList.filter((m) => m.declared).length,
      myDeclared,
      deadlinePassed: Boolean(endDay && daysBetween(endDay, parseDay(goal.today)) > 0),
      currentValue: latestValueOverall,
      myCurrentValue: viewerUserId ? (latestValueByUser[String(viewerUserId)] ?? null) : null,
      deadline: dayString(goal.deadline),
      startDate: dayString(goal.start_date),
      inviteCode: goal.invite_code,
      createdAt: goal.created_at,
      isOwner: false, // 呼び出し側で上書きする（自分の行かどうかはここでは分からない）
      memberCount,
      // V12.4・A班: メンバー上限（10人）。クライアントは満員表示に使う。
      maxMembers: SHARED_GOAL_MAX_MEMBERS,
      // V12.8・C班: 今週の月曜（weeklyStats の週の区切り。sync-pace と同じ）。
      weekStart,
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
        const uid = resolveMemberId(req);
        const owned = await q('SELECT id FROM shared_goals WHERE owner_user_id = $1', [uid]);
        await q('DELETE FROM shared_goal_contributions WHERE user_id = $1', [uid]);
        // V12.6・C班: 数値タイプの値の記録も消す（貢献と同じ扱い）。
        await q('DELETE FROM shared_goal_values WHERE user_id = $1', [uid]);
        // V12.7・A班: 「達成した」の申告も消す（貢献と同じ扱い）。
        await q('DELETE FROM shared_goal_declarations WHERE user_id = $1', [uid]);
        await q('DELETE FROM shared_goal_comments WHERE user_id = $1', [uid]);
        // V12.11・A班: グループ活動トースト用の出来事も消す（自分の行のみ。
        // 他メンバーの出来事は残る＝目標の履歴として読めるまま）。
        await q('DELETE FROM shared_goal_events WHERE author_user_id = $1', [uid]);
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
    const uid = resolveMemberId(req);
    if (limited('sg:create:' + uid, 10, 3600 * 1000)) return res.status(429).json({ error: '作成が多すぎます。少し時間をおいてください。', errorJa: '作成が多すぎます。少し時間をおいてください。', errorEn: 'You are creating too many. Please wait a while.' });
    const b = req.body || {};
    const title = oneLine(b.title, 80);
    const target = Number(b.target);
    // V12・D班: kind（count/time/habit。未指定・不正値は 'count'）。
    // time は unit「分」固定、habit は unit なし・target は目標日数（1〜365）。
    const kind = normalizeKind(b.kind);
    // V12.2・A班: visibility（private/public。未指定・不正値は 'private'）。
    const visibility = normalizeVisibility(b.visibility);
    // V12.24・A班: mode（coop/compete。'compete' のときだけ競争型、
    // 未指定・不正値は 'coop'）。作成後の変更は不可（更新エンドポイントは無い）。
    const mode = normalizeMode(b.mode);
    const unit = unitForKind(kind, oneLine(b.unit, 20));
    // V12.6・C班: startValue（valueタイプの開始値）と achievementRule
    // （'auto'|'deadline'|'declare'。未指定・不正値は 'auto'）。
    // valueタイプ以外では startValue は使わないため NULL にする。
    // valueタイプで startValue が無い場合は target を開始値扱いにしない
    // （開始値なし＝進捗は記録待ち。全体の達成率は null を返す）。
    const startValueRaw = Number(b.startValue);
    const startValue = kind === 'value' && Number.isFinite(startValueRaw) ? startValueRaw : null;
    const achievementRule = normalizeAchievementRule(b.achievementRule);
    const deadline = String(b.deadline || '');
    if (!title) return res.status(400).json({ error: 'タイトルを入力してください。', errorJa: 'タイトルを入力してください。', errorEn: 'Please enter a title.' });
    if (!Number.isFinite(target) || target <= 0 || target > 100000000) return res.status(400).json({ error: '目標量は 0 より大きい数で入力してください。', errorJa: '目標量は 0 より大きい数で入力してください。', errorEn: 'Please enter a target greater than 0.' });
    if (kind === 'habit' && target > 365) return res.status(400).json({ error: '習慣の目標日数は 365日までです。', errorJa: '習慣の目標日数は 365日までです。', errorEn: 'Habit goals are up to 365 days.' });
    if (startValue !== null && Math.abs(startValue) > 100000000) return res.status(400).json({ error: '開始値は 1億以内の数で入力してください。', errorJa: '開始値は 1億以内の数で入力してください。', errorEn: 'Please enter a start value within 100,000,000.' });
    if (kind === 'value' && startValue !== null && startValue === target) return res.status(400).json({ error: '開始値と目標値は違う値にしてください。', errorJa: '開始値と目標値は違う値にしてください。', errorEn: 'The start value and target value must be different.' });
    if (!parseDay(deadline)) return res.status(400).json({ error: '期限は YYYY-MM-DD で入力してください。', errorJa: '期限は YYYY-MM-DD で入力してください。', errorEn: 'Please enter the deadline as YYYY-MM-DD.' });
    if (parseDay(deadline) < parseDay(new Date().toISOString().slice(0, 10))) return res.status(400).json({ error: '期限は今日以降にしてください。', errorJa: '期限は今日以降にしてください。', errorEn: 'Please set the deadline to today or later.' });
    const mine = await q('SELECT COUNT(*)::int AS n FROM shared_goals WHERE owner_user_id = $1', [uid]);
    if (mine.rows[0].n >= 20) return res.status(400).json({ error: '作れる共有目標は20個までです。', errorJa: '作れる共有目標は20個までです。', errorEn: 'You can create up to 20 shared goals.' });
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
          `INSERT INTO shared_goals (owner_user_id, title, target, unit, kind, visibility, mode, deadline, invite_code, start_value, achievement_rule)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [uid, title, target, unit, kind, visibility, mode, deadline, code, startValue, achievementRule]);
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
        error: '招待コードを作れませんでした。もう一度お試しください。', errorJa: '招待コードを作れませんでした。もう一度お試しください。', errorEn: 'Could not create an invite code. Please try again.',
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
        error: 'いま利用できません。時間をおいて再度お試しください。', errorJa: 'いま利用できません。時間をおいて再度お試しください。', errorEn: 'Unavailable right now. Please try again later.',
        code: 'SERVER_ERROR',
        requestId: req.requestId,
      });
    }
    detail.isOwner = true;
    return res.json({ goal: detail });
  }));

  // 自分が参加している共有目標の一覧（ペース%・共有ストリーク付き）
  app.get('/api/shared-goals', auth.requireAuth, wrap(async (req, res) => {
    const uid = resolveMemberId(req);
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
              g.start_value, g.achievement_rule, g.achievement_status, g.mode,
              to_char(g.deadline, 'YYYY-MM-DD') AS deadline,
              to_char(g.start_date, 'YYYY-MM-DD') AS start_date,
              g.created_at,
              ${JST_TODAY_SQL} AS today,
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
        // V12.24・A班: モード（公開一覧でも見える。旧データは 'coop'）。
        mode: normalizeMode(r.mode),
        // V12.6・C班: 数値タイプの開始値と達成の決め方（公開一覧でも見える）。
        startValue: r.start_value == null ? null : Number(r.start_value),
        achievementRule: normalizeAchievementRule(r.achievement_rule),
        // V12.7・A班: 達成状態（公開一覧でも見える。旧データは 'active'）。
        achievementStatus: ['achieved', 'failed'].includes(r.achievement_status) ? r.achievement_status : 'active',
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
    const uid = resolveMemberId(req);
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

  // ================= グループ活動の出来事（V12.11・A班） =================
  // GET /api/shared-goals/updates
  //   今日タブのグループ活動トースト用。クライアントがポーリングで叩く。
  //   ?limit=（既定20・最大50）。返すのは「要求者がメンバーである共有目標」
  //   の出来事で、直近24時間以内・新しい順。自分の出来事も含めて返す
  //   （除外はクライアント側でやる）。メンバーでない目標の出来事は
  //   絶対に返さない（shared_goal_members との JOIN で絞る）。
  //   kind は 'comment'|'achieved'|'taskDone' の3種のみ。
  // NOTE: GET /api/shared-goals/:id より前に置くこと（'updates' が :id に
  // 取られないように。'kicked' と同じ理由）。
  app.get('/api/shared-goals/updates', auth.requireAuth, wrap(async (req, res) => {
    const uid = resolveMemberId(req);
    const limit = Math.max(1, Math.min(50, Math.floor(Number(req.query.limit) || 20)));
    const rows = await q(
      `SELECT e.id, e.goal_id, g.title AS goal_title, e.kind,
              e.author_user_id, e.author_name, e.avatar_color, e.text, e.created_at
       FROM shared_goal_events e
       JOIN shared_goals g ON g.id::text = e.goal_id
       JOIN shared_goal_members m ON m.goal_id = g.id AND m.user_id = $1
       WHERE e.created_at > NOW() - INTERVAL '24 hours'
         AND e.kind IN ('comment', 'achieved', 'taskDone')
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT $2`,
      [uid, limit]);
    res.json({
      events: rows.rows.map((r) => ({
        id: String(r.id),
        goalId: String(r.goal_id),
        goalTitle: r.goal_title,
        kind: r.kind,
        authorUserId: r.author_user_id,
        authorName: r.author_name,
        avatarColor: r.avatar_color || null,
        text: r.text,
        createdAt: r.created_at,
      })),
    });
  }));

  app.get('/api/shared-goals/:id', auth.requireAuth, wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: '不正なIDです。', errorJa: '不正なIDです。', errorEn: 'Invalid ID.' });
    const uid = resolveMemberId(req);
    if (!(await isMember(req.params.id, uid))) return res.status(403).json({ error: 'この共有目標のメンバーではありません。', errorJa: 'この共有目標のメンバーではありません。', errorEn: 'You are not a member of this shared goal.' });
    const detail = await loadGoalDetail(req.params.id, uid);
    if (!detail) return res.status(404).json({ error: '共有目標が見つかりません。', errorJa: '共有目標が見つかりません。', errorEn: 'Shared goal not found.' });
    detail.isOwner = detail.members.some((m) => m.userId === uid && m.isOwner);
    res.json({ goal: detail });
  }));

  // ================= メンバーの最近の記録（V12.8・C班） =================
  // GET /api/shared-goals/:id/members/:userId/activity
  //   ?limit=（既定10・1〜20）。閲覧者・対象ともメンバー限定。
  //   /api/activity/feed の activity_events（task/card/pomodoro/goal。
  //   公開オフ・通報で hidden のものは出さない）と、この共有目標への
  //   貢献記録（shared_goal_contributions）を新しい順に混ぜて返す
  //   （直近7日分。貢献の text が空のときはクライアントが量から作る）。
  //   どちらかのテーブルが無い環境でも空の一覧を返す（503 にしない）。
  app.get('/api/shared-goals/:id/members/:userId/activity', auth.requireAuth, wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: '不正なIDです。', errorJa: '不正なIDです。', errorEn: 'Invalid ID.' });
    const targetUserId = String(req.params.userId || '');
    if (!targetUserId || targetUserId.length > 80) return res.status(400).json({ error: '不正なIDです。', errorJa: '不正なIDです。', errorEn: 'Invalid ID.' });
    const uid = resolveMemberId(req);
    if (!(await isMember(req.params.id, uid))) return res.status(403).json({ error: 'この共有目標のメンバーではありません。', errorJa: 'この共有目標のメンバーではありません。', errorEn: 'You are not a member of this shared goal.' });
    if (!(await isMember(req.params.id, targetUserId))) return res.status(404).json({ error: 'メンバーが見つかりません。', errorJa: 'メンバーが見つかりません。', errorEn: 'Member not found.' });
    // V12.23・A班【2】：対象メンバーの活動は、保存されているIDと
    // 正規IDの両方で引く。活動（activity_events）はデバイスIDで記録
    // されるが、メンバー行が旧IDのままだと片方だけでは空になる。
    const { canon: aliasCanon } = await loadIdentityAliases([targetUserId]);
    const targetIds = [...new Set([targetUserId, aliasCanon.get(targetUserId) || targetUserId])];
    const limit = Math.max(1, Math.min(20, Math.floor(Number(req.query.limit) || 10)));
    const events = [];
    try {
      const feedRows = await q(
        `SELECT id, kind, text, minutes, created_at FROM activity_events
         WHERE owner_user_id = ANY($1::text[]) AND hidden = FALSE AND created_at > NOW() - INTERVAL '7 days'
         ORDER BY created_at DESC, id DESC LIMIT $2`,
        [targetIds, limit]);
      for (const r of feedRows.rows) {
        events.push({
          id: `a-${r.id}`, kind: r.kind, text: r.text || '',
          minutes: Number(r.minutes) || 0,
          createdAt: r.created_at,
        });
      }
    } catch (_) { /* activity_events が無い環境では貢献記録だけ返す */ }
    try {
      const contribRows = await q(
        `SELECT id, amount, note, created_at FROM shared_goal_contributions
         WHERE goal_id = $1 AND user_id = ANY($3::text[]) AND created_at > NOW() - INTERVAL '7 days'
         ORDER BY created_at DESC, id DESC LIMIT $2`,
        [req.params.id, limit, targetIds]);
      for (const r of contribRows.rows) {
        events.push({
          id: `c-${r.id}`, kind: 'contribution', text: r.note || '',
          amount: Number(r.amount),
          createdAt: r.created_at,
        });
      }
    } catch (_) { /* 貢献記録が読めなくてもフィード分は返す */ }
    events.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const memberRow = await q(
      'SELECT display_name FROM shared_goal_members WHERE goal_id = $1 AND user_id = $2',
      [req.params.id, targetUserId]);
    res.json({
      events: events.slice(0, limit),
      memberUserId: targetUserId,
      displayName: (memberRow.rows[0] && memberRow.rows[0].display_name) || anonName(targetUserId),
    });
  }));

  // 招待コードで参加（コードは大文字・英数字のみに正規化）
  app.post('/api/shared-goals/join', auth.requireAuth, wrap(async (req, res) => {
    const uid = resolveMemberId(req);
    const code = String((req.body && req.body.code) || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 8) return res.status(400).json({ error: '招待コードは8文字です。', errorJa: '招待コードは8文字です。', errorEn: 'The invite code is 8 characters.', code: 'INVALID_CODE' });
    const g = await q('SELECT id FROM shared_goals WHERE invite_code = $1', [code]);
    if (!g.rowCount) return res.status(404).json({ error: '招待コードが見つかりません。', errorJa: '招待コードが見つかりません。', errorEn: 'Invite code not found.', code: 'INVALID_CODE' });
    const goalId = g.rows[0].id;
    if (await isMember(goalId, uid)) {
      const detail = await loadGoalDetail(goalId, uid);
      if (!detail) return res.status(404).json({ error: '共有目標が見つかりません。', errorJa: '共有目標が見つかりません。', errorEn: 'Shared goal not found.' });
      detail.isOwner = detail.members.some((m) => m.userId === uid && m.isOwner);
      return res.json({ goal: detail, alreadyMember: true });
    }
    const cnt = await q('SELECT COUNT(*)::int AS n FROM shared_goal_members WHERE goal_id = $1', [goalId]);
    // V12.4・A班: メンバー上限は 10人。既存の10人超の目標は追い出さない
    // （新規参加だけ止める）。
    if (cnt.rows[0].n >= SHARED_GOAL_MAX_MEMBERS) return res.status(400).json({ error: 'この共有目標は満員です（10人まで）。', errorJa: 'この共有目標は満員です（10人まで）。', errorEn: 'This shared goal is full (up to 10 members).' });
    await q('INSERT INTO shared_goal_members (goal_id, user_id, display_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [goalId, uid, await displayNameFor(uid)]);
    // V12.4・A班: 過去にキックされた記録があれば、再参加で消す
    // （「外されました」の案内を出し続けないため）。
    await q('DELETE FROM shared_goal_kicks WHERE goal_id = $1 AND user_id = $2', [goalId, uid]);
    // V12.7・A班: 新しいメンバーが増えたら「全員申告済み」ではなくなる
    // ため、declare ルールの達成状態を数え直す（失敗しても参加は成功）。
    try { await refreshDeclareStatus(goalId); } catch (_) {}
    const detail = await loadGoalDetail(goalId, uid);
    if (!detail) return res.status(404).json({ error: '共有目標が見つかりません。', errorJa: '共有目標が見つかりません。', errorEn: 'Shared goal not found.' });
    detail.isOwner = false;
    res.json({ goal: detail, alreadyMember: false });
  }));

  // V12.2・A班: 公開目標に招待コード無しで参加する。返す形はコード参加と
  // 同じ（{ goal, alreadyMember }）。対象がプライベートなら 403。
  // メンバー数上限（10人）はコード参加と同じものを適用する。
  app.post('/api/shared-goals/:id/join-public', auth.requireAuth, wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: '不正なIDです。', errorJa: '不正なIDです。', errorEn: 'Invalid ID.' });
    const uid = resolveMemberId(req);
    const g = await q('SELECT id, visibility FROM shared_goals WHERE id = $1', [req.params.id]);
    if (!g.rowCount) return res.status(404).json({ error: '共有目標が見つかりません。', errorJa: '共有目標が見つかりません。', errorEn: 'Shared goal not found.' });
    if (normalizeVisibility(g.rows[0].visibility) !== 'public') {
      return res.status(403).json({ error: 'この共有目標は招待コードでのみ参加できます。', errorJa: 'この共有目標は招待コードでのみ参加できます。', errorEn: 'This shared goal can only be joined with an invite code.' });
    }
    const goalId = g.rows[0].id;
    if (await isMember(goalId, uid)) {
      const detail = await loadGoalDetail(goalId, uid);
      if (!detail) return res.status(404).json({ error: '共有目標が見つかりません。', errorJa: '共有目標が見つかりません。', errorEn: 'Shared goal not found.' });
      detail.isOwner = detail.members.some((m) => m.userId === uid && m.isOwner);
      return res.json({ goal: detail, alreadyMember: true });
    }
    const cnt = await q('SELECT COUNT(*)::int AS n FROM shared_goal_members WHERE goal_id = $1', [goalId]);
    if (cnt.rows[0].n >= SHARED_GOAL_MAX_MEMBERS) return res.status(400).json({ error: 'この共有目標は満員です（10人まで）。', errorJa: 'この共有目標は満員です（10人まで）。', errorEn: 'This shared goal is full (up to 10 members).' });
    await q('INSERT INTO shared_goal_members (goal_id, user_id, display_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [goalId, uid, await displayNameFor(uid)]);
    // V12.4・A班: 過去にキックされた記録があれば、再参加で消す。
    await q('DELETE FROM shared_goal_kicks WHERE goal_id = $1 AND user_id = $2', [goalId, uid]);
    // V12.7・A班: 新しいメンバーが増えたら「全員申告済み」ではなくなる
    // ため、declare ルールの達成状態を数え直す（失敗しても参加は成功）。
    try { await refreshDeclareStatus(goalId); } catch (_) {}
    const detail = await loadGoalDetail(goalId, uid);
    if (!detail) return res.status(404).json({ error: '共有目標が見つかりません。', errorJa: '共有目標が見つかりません。', errorEn: 'Shared goal not found.' });
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
    if (!isId(req.params.id)) return res.status(400).json({ error: '不正なIDです。', errorJa: '不正なIDです。', errorEn: 'Invalid ID.' });
    const uid = resolveMemberId(req);
    if (!(await isMember(req.params.id, uid))) return res.status(403).json({ error: 'この共有目標のメンバーではありません。', errorJa: 'この共有目標のメンバーではありません。', errorEn: 'You are not a member of this shared goal.' });
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
    if (!isId(req.params.id)) return res.status(400).json({ error: '不正なIDです。', errorJa: '不正なIDです。', errorEn: 'Invalid ID.' });
    const uid = resolveMemberId(req);
    if (limited('sg:comment:' + uid, 20, 10 * 60 * 1000)) return res.status(429).json({ error: '操作が多すぎます。少し時間をおいてください。', errorJa: '操作が多すぎます。少し時間をおいてください。', errorEn: 'Too many actions. Please wait a while.' });
    if (!(await isMember(req.params.id, uid))) return res.status(403).json({ error: 'この共有目標のメンバーではありません。', errorJa: 'この共有目標のメンバーではありません。', errorEn: 'You are not a member of this shared goal.' });
    const text = clean(req.body && req.body.text, 500);
    if (!text) return res.status(400).json({ error: 'コメントを入力してください。', errorJa: 'コメントを入力してください。', errorEn: 'Please enter a comment.' });
    if (Array.from(text).length > 500) return res.status(400).json({ error: 'コメントは500文字までです。', errorJa: 'コメントは500文字までです。', errorEn: 'Comments are up to 500 characters.' });
    const s = screenText(text);
    if (!s.ok) return res.status(422).json({ error: s.error, errorJa: s.error, errorEn: s.errorEn, code: s.code });
    const ins = await q(
      `INSERT INTO shared_goal_comments (goal_id, user_id, display_name, avatar_color, text)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, user_id, display_name, avatar_color, text, created_at`,
      [req.params.id, uid, await displayNameFor(uid), await avatarColorFor(uid), text]);
    // V12.11・A班: コメント投稿の出来事を書く（ベストエフォート。
    // 失敗してもコメント投稿自体は成功。text=コメント本文のまま。
    // 表示側で短く切るのはクライアントの仕事）。
    await recordSharedGoalEvent({
      goalId: req.params.id,
      authorUserId: uid,
      authorName: ins.rows[0].display_name,
      avatarColor: ins.rows[0].avatar_color,
      kind: 'comment',
      text,
    });
    res.json({ comment: shapeComment(ins.rows[0]) });
  }));

  // コメントを通報する。community_reports に種別 'shared_goal_comment' で
  // 記録する（投稿 'post'・ランキングひとこと 'comment' と区別できる値）。
  // 通報3件で自動非表示（community.js の REPORT_HIDE_THRESHOLD と同じ3件）。
  app.post('/api/shared-goals/:id/comments/:commentId/report', auth.requireAuth, wrap(async (req, res) => {
    if (!isId(req.params.id) || !isId(req.params.commentId)) return res.status(400).json({ error: '不正なIDです。', errorJa: '不正なIDです。', errorEn: 'Invalid ID.' });
    const uid = resolveMemberId(req);
    if (limited('sg:comment-report:' + uid, 20, 3600 * 1000)) return res.status(429).json({ error: '通報が多すぎます。', errorJa: '通報が多すぎます。', errorEn: 'Too many reports.' });
    if (!(await isMember(req.params.id, uid))) return res.status(403).json({ error: 'この共有目標のメンバーではありません。', errorJa: 'この共有目標のメンバーではありません。', errorEn: 'You are not a member of this shared goal.' });
    const found = await q(
      'SELECT id, user_id FROM shared_goal_comments WHERE id = $1 AND goal_id = $2',
      [req.params.commentId, req.params.id]);
    if (!found.rowCount) return res.status(404).json({ error: 'コメントが見つかりません。', errorJa: 'コメントが見つかりません。', errorEn: 'Comment not found.' });
    if (found.rows[0].user_id === uid) return res.status(400).json({ error: '自分のコメントは通報できません。', errorJa: '自分のコメントは通報できません。', errorEn: 'You cannot report your own comment.' });
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

  // V12.7・A班: 'auto' ルールの達成判定（contribute 時に呼ぶ）。
  // 既に achieved/failed なら何もしない。value は記録したメンバーの
  // 最新値が開始値→目標値に到達したら達成（開始値が無ければ判定しない）。
  // count/time/habit は貢献合計が target に到達したら達成
  // （同じ 'auto' の意味。例：300単語の合計が 300 になったら達成）。
  // V12.11・A班: active→achieved への遷移が起きたら true を返す
  // （呼び出し元が達成の出来事を書くため。遷移しなければ false。
  // UPDATE に achievement_status='active' の条件を付けて行数で
  // 遷移を検出する＝同時 contribute が重なっても二重に書かない）。
  async function maybeAutoAchieve(goalId, recordedValue) {
    const g = await q('SELECT achievement_rule, achievement_status, kind, target, start_value FROM shared_goals WHERE id = $1', [goalId]);
    if (!g.rowCount) return false;
    const row = g.rows[0];
    if (normalizeAchievementRule(row.achievement_rule) !== 'auto') return false;
    if (row.achievement_status !== 'active') return false;
    const target = Number(row.target);
    if (!Number.isFinite(target) || target <= 0) return false;
    let reached = false;
    if (normalizeKind(row.kind) === 'value') {
      const start = row.start_value == null ? null : Number(row.start_value);
      const current = Number(recordedValue);
      if (start === null || !Number.isFinite(start) || !Number.isFinite(current)) return false;
      const denom = target - start;
      if (denom === 0) return false;
      reached = (current - start) / denom >= 1;
    } else {
      const sum = await q('SELECT COALESCE(SUM(amount), 0)::float AS total FROM shared_goal_contributions WHERE goal_id = $1', [goalId]);
      reached = Number(sum.rows[0].total) >= target;
    }
    if (!reached) return false;
    const upd = await q(`UPDATE shared_goals SET achievement_status = 'achieved', achieved_at = NOW()
                         WHERE id = $1 AND achievement_status = 'active'`, [goalId]);
    return upd.rowCount > 0;
  }

  // V12.7・A班: 'declare' ルールの達成状態の再計算（申告・取り消し・
  // 参加・退出のときに呼ぶ）。メンバーが1人以上いて全員が申告済みなら
  // achieved、そうでなければ achieved だったものを active に戻す
  // （failed には触らない。declare ルールで failed になる経路は無い）。
  async function refreshDeclareStatus(goalId) {
    const counts = await q(
      `SELECT (SELECT COUNT(*)::int FROM shared_goal_members WHERE goal_id = $1) AS members,
              (SELECT COUNT(*)::int FROM shared_goal_declarations d
                JOIN shared_goal_members m ON m.goal_id = d.goal_id AND m.user_id = d.user_id
                WHERE d.goal_id = $1) AS declared`,
      [goalId]);
    const { members, declared } = counts.rows[0];
    const allDeclared = members > 0 && declared >= members;
    if (allDeclared) {
      const upd = await q(`UPDATE shared_goals SET achievement_status = 'achieved', achieved_at = COALESCE(achieved_at, NOW())
               WHERE id = $1 AND achievement_status = 'active'`, [goalId]);
      // V12.11・A班: active→achieved への遷移のときだけ達成の出来事を1行
      // 書く（UPDATE の行数で遷移を検出。既に achieved なら行数は 0）。
      // この関数は申告・取り消しだけでなく参加・退出・キックからも
      // 呼ばれるため、達成のきっかけになった人を引数では渡せない。
      // 申告者のうち最新の人を出来事の作者とする（その人の申告で
      // 全員分が揃った、という意味で最も近い）。
      if (upd.rowCount > 0) {
        const last = await q(
          `SELECT user_id FROM shared_goal_declarations WHERE goal_id = $1
           ORDER BY declared_at DESC LIMIT 1`,
          [goalId]);
        if (last.rowCount) await recordAchievedEvent(goalId, last.rows[0].user_id);
      }
    } else {
      await q(`UPDATE shared_goals SET achievement_status = 'active', achieved_at = NULL
               WHERE id = $1 AND achievement_status = 'achieved'`, [goalId]);
    }
  }

  // 貢献を記録する。日付はサーバー当日固定（過去への書き込みで
  // ペース% を操作できないようにする）。amount は 1 回分の追加量。
  app.post('/api/shared-goals/:id/contribute', auth.requireAuth, wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: '不正なIDです。', errorJa: '不正なIDです。', errorEn: 'Invalid ID.' });
    const uid = resolveMemberId(req);
    if (limited('sg:contrib:' + uid, 60, 10 * 60 * 1000)) return res.status(429).json({ error: '操作が多すぎます。少し時間をおいてください。', errorJa: '操作が多すぎます。少し時間をおいてください。', errorEn: 'Too many actions. Please wait a while.' });
    if (!(await isMember(req.params.id, uid))) return res.status(403).json({ error: 'この共有目標のメンバーではありません。', errorJa: 'この共有目標のメンバーではありません。', errorEn: 'You are not a member of this shared goal.' });
    const note = clean(req.body && req.body.note, 100);
    // V12・D班: 習慣チェックは 1日1回・amount=1 だけ（チェック＝1日達成）。
    // 複数回・まとめての記録で日数を水増しできないようにする。
    const gKind = await q('SELECT kind FROM shared_goals WHERE id = $1', [req.params.id]);
    const goalKind = gKind.rowCount ? normalizeKind(gKind.rows[0].kind) : 'count';
    // V12.6・C班: 数値タイプは「現在の値」の記録。body は { value }。
    // amount は使わない（送られてきても無視する）。値は
    // shared_goal_values に毎回1行残し、最新の1件が現在値になる。
    // contributions にはその日初回だけ amount=1 を入れる（habit と同じ
    // 1日1回の形で、ペース%・共有ストリーク・今日のノルマ達成率の
    // 「今日記録したか」を保つ。2回目以降の記録は値の修正のみで
    // 貢献は増えない）。値が無い・数値でない場合は 400。
    if (goalKind === 'value') {
      const value = Number(req.body && req.body.value);
      if (!Number.isFinite(value) || Math.abs(value) > 100000000) return res.status(400).json({ error: '現在の値を入力してください。', errorJa: '現在の値を入力してください。', errorEn: 'Please enter the current value.' });
      const today = await q(
        `SELECT COUNT(*)::int AS n FROM shared_goal_contributions
         WHERE goal_id = $1 AND user_id = $2 AND ${jstDateSql('created_at')} = ${JST_TODAY_SQL}`,
        [req.params.id, uid]);
      await q(
        `INSERT INTO shared_goal_values (goal_id, user_id, value) VALUES ($1, $2, $3)`,
        [req.params.id, uid, value]);
      if (today.rows[0].n === 0) {
        await q(
          `INSERT INTO shared_goal_contributions (goal_id, user_id, amount, note) VALUES ($1, $2, 1, $3)`,
          [req.params.id, uid, note]);
      }
      // V12.7・A班: 'auto' ルールの達成判定（value は記録した値で判定）。
      // V12.11・A班: active→achieved への遷移が起きたら達成の出来事を
      // 書く（ベストエフォート。記録した人が作者）。
      if (await maybeAutoAchieve(req.params.id, value)) {
        await recordAchievedEvent(req.params.id, uid);
      }
      const detail = await loadGoalDetail(req.params.id, uid);
      if (!detail) return res.status(404).json({ error: '共有目標が見つかりません。', errorJa: '共有目標が見つかりません。', errorEn: 'Shared goal not found.' });
      detail.isOwner = detail.members.some((m) => m.userId === uid && m.isOwner);
      return res.json({ goal: detail });
    }
    const amount = Number(req.body && req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) return res.status(400).json({ error: '記録する量は 0 より大きい数で入力してください。', errorJa: '記録する量は 0 より大きい数で入力してください。', errorEn: 'Please enter an amount greater than 0.' });
    if (goalKind === 'habit') {
      if (amount !== 1) return res.status(400).json({ error: '習慣チェックは1日1回です。', errorJa: '習慣チェックは1日1回です。', errorEn: 'Habit check-ins are once a day.' });
      const today = await q(
        `SELECT COUNT(*)::int AS n FROM shared_goal_contributions
         WHERE goal_id = $1 AND user_id = $2 AND ${jstDateSql('created_at')} = ${JST_TODAY_SQL}`,
        [req.params.id, uid]);
      if (today.rows[0].n > 0) return res.status(400).json({ error: '今日はすでにチェック済みです。', errorJa: '今日はすでにチェック済みです。', errorEn: 'Already checked in today.' });
    }
    await q(
      `INSERT INTO shared_goal_contributions (goal_id, user_id, amount, note) VALUES ($1, $2, $3, $4)`,
      [req.params.id, uid, amount, note]);
    // V12.7・A班: 'auto' ルールの達成判定（count/time/habit は貢献合計で判定）。
    // V12.11・A班: active→achieved への遷移が起きたら達成の出来事を
    // 書く（ベストエフォート。記録した人が作者）。
    if (await maybeAutoAchieve(req.params.id, null)) {
      await recordAchievedEvent(req.params.id, uid);
    }
    const detail = await loadGoalDetail(req.params.id, uid);
    if (!detail) return res.status(404).json({ error: '共有目標が見つかりません。', errorJa: '共有目標が見つかりません。', errorEn: 'Shared goal not found.' });
    detail.isOwner = detail.members.some((m) => m.userId === uid && m.isOwner);
    res.json({ goal: detail });
  }));

  // ================= 達成の決め方の実行（V12.7・A班） =================
  // (a) 「達成した」の申告・取り消し（declare ルール用）。
  // メンバーだけが自分の申告を出せる。body { declared?: boolean }
  // （未指定は true＝申告する）。申告・取り消しのたびに全員申告かを
  // 数え直し、達成状態を更新する。返すのは更新後の目標全体。
  app.post('/api/shared-goals/:id/declare', auth.requireAuth, wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: '不正なIDです。', errorJa: '不正なIDです。', errorEn: 'Invalid ID.' });
    const uid = resolveMemberId(req);
    if (limited('sg:declare:' + uid, 20, 10 * 60 * 1000)) return res.status(429).json({ error: '操作が多すぎます。少し時間をおいてください。', errorJa: '操作が多すぎます。少し時間をおいてください。', errorEn: 'Too many actions. Please wait a while.' });
    if (!(await isMember(req.params.id, uid))) return res.status(403).json({ error: 'この共有目標のメンバーではありません。', errorJa: 'この共有目標のメンバーではありません。', errorEn: 'You are not a member of this shared goal.' });
    const g = await q('SELECT achievement_rule FROM shared_goals WHERE id = $1', [req.params.id]);
    if (!g.rowCount) return res.status(404).json({ error: '共有目標が見つかりません。', errorJa: '共有目標が見つかりません。', errorEn: 'Shared goal not found.' });
    if (normalizeAchievementRule(g.rows[0].achievement_rule) !== 'declare') {
      return res.status(400).json({ error: 'この共有目標は申告で達成を決める目標ではありません。', errorJa: 'この共有目標は申告で達成を決める目標ではありません。', errorEn: 'This shared goal does not decide completion by declaration.' });
    }
    const declared = (req.body && req.body.declared) !== false;
    if (declared) {
      await q(`INSERT INTO shared_goal_declarations (goal_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [req.params.id, uid]);
    } else {
      await q('DELETE FROM shared_goal_declarations WHERE goal_id = $1 AND user_id = $2', [req.params.id, uid]);
    }
    await refreshDeclareStatus(req.params.id);
    const detail = await loadGoalDetail(req.params.id, uid);
    if (!detail) return res.status(404).json({ error: '共有目標が見つかりません。', errorJa: '共有目標が見つかりません。', errorEn: 'Shared goal not found.' });
    detail.isOwner = detail.members.some((m) => m.userId === uid && m.isOwner);
    res.json({ goal: detail });
  }));

  // (b) 期日の合否を入れる（deadline ルール用。作成者だけ）。
  // body { result: 'pass' | 'fail' | null }。null は取り消し（active に戻す）。
  // pass → achieved、fail → failed。期日前でも入れられるが、クライアントは
  // 期日を過ぎてから入力を促す（作成者が期日前に合否を決めたい場合もあるため、
  // サーバー側では期日を強制しない）。
  app.post('/api/shared-goals/:id/deadline-result', auth.requireAuth, wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: '不正なIDです。', errorJa: '不正なIDです。', errorEn: 'Invalid ID.' });
    const uid = resolveMemberId(req);
    if (limited('sg:deadline-result:' + uid, 20, 10 * 60 * 1000)) return res.status(429).json({ error: '操作が多すぎます。少し時間をおいてください。', errorJa: '操作が多すぎます。少し時間をおいてください。', errorEn: 'Too many actions. Please wait a while.' });
    if (!(await isMember(req.params.id, uid))) return res.status(403).json({ error: 'この共有目標のメンバーではありません。', errorJa: 'この共有目標のメンバーではありません。', errorEn: 'You are not a member of this shared goal.' });
    const g = await q('SELECT owner_user_id, achievement_rule, achievement_status FROM shared_goals WHERE id = $1', [req.params.id]);
    if (!g.rowCount) return res.status(404).json({ error: '共有目標が見つかりません。', errorJa: '共有目標が見つかりません。', errorEn: 'Shared goal not found.' });
    if (g.rows[0].owner_user_id !== uid) return res.status(403).json({ error: '期日の結果を入れられるのは作成者だけです。', errorJa: '期日の結果を入れられるのは作成者だけです。', errorEn: 'Only the creator can enter the deadline result.' });
    if (normalizeAchievementRule(g.rows[0].achievement_rule) !== 'deadline') {
      return res.status(400).json({ error: 'この共有目標は期日で達成を決める目標ではありません。', errorJa: 'この共有目標は期日で達成を決める目標ではありません。', errorEn: 'This shared goal does not decide completion by deadline.' });
    }
    // V12.11・A班: pass 前の達成状態を覚えておく。既に achieved なら
    // pass の入れ直しなので出来事は書かない（遷移のときだけ1行）。
    // failed からの pass は achieved への遷移なので書く。
    const wasAchieved = g.rows[0].achievement_status === 'achieved';
    const result = (req.body && req.body.result) ?? null;
    if (result !== 'pass' && result !== 'fail' && result !== null) return res.status(400).json({ error: '結果は合格・不合格のどちらかで入力してください。', errorJa: '結果は合格・不合格のどちらかで入力してください。', errorEn: 'Please enter a result of pass or fail.' });
    if (result === null) {
      await q(`UPDATE shared_goals SET deadline_result = NULL, deadline_result_at = NULL,
               achievement_status = 'active', achieved_at = NULL WHERE id = $1`, [req.params.id]);
    } else if (result === 'pass') {
      await q(`UPDATE shared_goals SET deadline_result = 'pass', deadline_result_at = NOW(),
               achievement_status = 'achieved', achieved_at = COALESCE(achieved_at, NOW()) WHERE id = $1`, [req.params.id]);
      // V12.11・A班: pass で achieved になった瞬間だけ出来事を書く
      // （ベストエフォート。fail・取り消しは対象外。結果を入れた
      // 作成者が作者）。
      if (!wasAchieved) await recordAchievedEvent(req.params.id, uid);
    } else {
      await q(`UPDATE shared_goals SET deadline_result = 'fail', deadline_result_at = NOW(),
               achievement_status = 'failed', achieved_at = NULL WHERE id = $1`, [req.params.id]);
    }
    const detail = await loadGoalDetail(req.params.id, uid);
    if (!detail) return res.status(404).json({ error: '共有目標が見つかりません。', errorJa: '共有目標が見つかりません。', errorEn: 'Shared goal not found.' });
    detail.isOwner = true;
    res.json({ goal: detail });
  }));

  // ================= 共通タスク（Iteration 4・班G） =================
  // メンバー全員が同じタスクに取り組む。順位はペース%のまま（タスクは
  // 貢献量に換算しない）。完了は「今日」の達成のみ（completed_date は
  // サーバー当日固定。過去日への書き込みでごまかせない）。
  // 作成はメンバー誰でも可（上限30件）。削除はオーナーのみ。
  app.post('/api/shared-goals/:id/tasks', auth.requireAuth, wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: '不正なIDです。', errorJa: '不正なIDです。', errorEn: 'Invalid ID.' });
    const uid = resolveMemberId(req);
    if (limited('sg:task:' + uid, 20, 3600 * 1000)) return res.status(429).json({ error: '操作が多すぎます。少し時間をおいてください。', errorJa: '操作が多すぎます。少し時間をおいてください。', errorEn: 'Too many actions. Please wait a while.' });
    if (!(await isMember(req.params.id, uid))) return res.status(403).json({ error: 'この共有目標のメンバーではありません。', errorJa: 'この共有目標のメンバーではありません。', errorEn: 'You are not a member of this shared goal.' });
    const title = oneLine(req.body && req.body.title, 80);
    if (!title) return res.status(400).json({ error: 'タスクを入力してください。', errorJa: 'タスクを入力してください。', errorEn: 'Please enter a task.' });
    // V12.24・A班: value（タスク1件あたりのボーナス量。1〜100000。
    // 未指定・不正値は 1）。完了時のボーナス計算に使う。
    const valueRaw = Number(req.body && req.body.value);
    const value = Number.isFinite(valueRaw) ? Math.max(1, Math.min(100000, valueRaw)) : 1;
    const cnt = await q('SELECT COUNT(*)::int AS n FROM shared_goal_tasks WHERE goal_id = $1', [req.params.id]);
    if (cnt.rows[0].n >= 30) return res.status(400).json({ error: '共通タスクは30個までです。', errorJa: '共通タスクは30個までです。', errorEn: 'You can add up to 30 shared tasks.' });
    await q('INSERT INTO shared_goal_tasks (goal_id, title, created_by, value) VALUES ($1, $2, $3, $4)',
      [req.params.id, title, uid, value]);
    const detail = await loadGoalDetail(req.params.id, uid);
    if (!detail) return res.status(404).json({ error: '共有目標が見つかりません。', errorJa: '共有目標が見つかりません。', errorEn: 'Shared goal not found.' });
    detail.isOwner = detail.members.some((m) => m.userId === uid && m.isOwner);
    res.json({ goal: detail });
  }));

  // 今日の完了をトグルする（押すたびに完了⇄未完了）。返すのは更新後の目標全体。
  app.post('/api/shared-goals/:id/tasks/:taskId/toggle', auth.requireAuth, wrap(async (req, res) => {
    if (!isId(req.params.id) || !isId(req.params.taskId)) return res.status(400).json({ error: '不正なIDです。', errorJa: '不正なIDです。', errorEn: 'Invalid ID.' });
    const uid = resolveMemberId(req);
    if (limited('sg:task-toggle:' + uid, 120, 10 * 60 * 1000)) return res.status(429).json({ error: '操作が多すぎます。少し時間をおいてください。', errorJa: '操作が多すぎます。少し時間をおいてください。', errorEn: 'Too many actions. Please wait a while.' });
    if (!(await isMember(req.params.id, uid))) return res.status(403).json({ error: 'この共有目標のメンバーではありません。', errorJa: 'この共有目標のメンバーではありません。', errorEn: 'You are not a member of this shared goal.' });
    const t = await q('SELECT id, title FROM shared_goal_tasks WHERE id = $1 AND goal_id = $2', [req.params.taskId, req.params.id]);
    if (!t.rowCount) return res.status(404).json({ error: 'タスクが見つかりません。', errorJa: 'タスクが見つかりません。', errorEn: 'Task not found.' });
    const done = await q(
      `SELECT 1 FROM shared_goal_task_completions WHERE task_id = $1 AND user_id = $2 AND ${jstDateSql('created_at')} = ${JST_TODAY_SQL}`,
      [req.params.taskId, uid]);
    if (done.rowCount) {
      await q(`DELETE FROM shared_goal_task_completions WHERE task_id = $1 AND user_id = $2 AND ${jstDateSql('created_at')} = ${JST_TODAY_SQL}`,
        [req.params.taskId, uid]);
    } else {
      await q('INSERT INTO shared_goal_task_completions (task_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [req.params.taskId, uid]);
      // V12.11・A班: 共通タスクの完了の出来事を書く（ベストエフォート。
      // 完了＝INSERT のときだけ。text=タスク名。取消＝DELETE は対象外）。
      await recordSharedGoalEvent({
        goalId: req.params.id,
        authorUserId: uid,
        authorName: await displayNameFor(uid),
        avatarColor: await avatarColorFor(uid),
        kind: 'taskDone',
        text: t.rows[0].title,
      });
    }
    const detail = await loadGoalDetail(req.params.id, uid);
    if (!detail) return res.status(404).json({ error: '共有目標が見つかりません。', errorJa: '共有目標が見つかりません。', errorEn: 'Shared goal not found.' });
    detail.isOwner = detail.members.some((m) => m.userId === uid && m.isOwner);
    res.json({ goal: detail });
  }));

  // 共通タスクの削除（オーナーのみ。完了履歴は CASCADE で消える）。
  app.delete('/api/shared-goals/:id/tasks/:taskId', auth.requireAuth, wrap(async (req, res) => {
    if (!isId(req.params.id) || !isId(req.params.taskId)) return res.status(400).json({ error: '不正なIDです。', errorJa: '不正なIDです。', errorEn: 'Invalid ID.' });
    const uid = resolveMemberId(req);
    if (!(await isMember(req.params.id, uid))) return res.status(403).json({ error: 'この共有目標のメンバーではありません。', errorJa: 'この共有目標のメンバーではありません。', errorEn: 'You are not a member of this shared goal.' });
    const g = await q('SELECT owner_user_id FROM shared_goals WHERE id = $1', [req.params.id]);
    if (!g.rowCount) return res.status(404).json({ error: '共有目標が見つかりません。', errorJa: '共有目標が見つかりません。', errorEn: 'Shared goal not found.' });
    if (g.rows[0].owner_user_id !== uid) return res.status(403).json({ error: 'タスクを削除できるのは作成者だけです。', errorJa: 'タスクを削除できるのは作成者だけです。', errorEn: 'Only the creator can delete tasks.' });
    const del = await q('DELETE FROM shared_goal_tasks WHERE id = $1 AND goal_id = $2', [req.params.taskId, req.params.id]);
    if (!del.rowCount) return res.status(404).json({ error: 'タスクが見つかりません。', errorJa: 'タスクが見つかりません。', errorEn: 'Task not found.' });
    const detail = await loadGoalDetail(req.params.id, uid);
    if (!detail) return res.status(404).json({ error: '共有目標が見つかりません。', errorJa: '共有目標が見つかりません。', errorEn: 'Shared goal not found.' });
    detail.isOwner = true;
    res.json({ goal: detail });
  }));

  // 抜ける。オーナーが抜けたら最も古いメンバーへ所有権を移す。
  // 最後の1人が抜けたら目標ごと消す（貢献・スタンプは CASCADE で消える）。
  app.post('/api/shared-goals/:id/leave', auth.requireAuth, wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: '不正なIDです。', errorJa: '不正なIDです。', errorEn: 'Invalid ID.' });
    const uid = resolveMemberId(req);
    if (!(await isMember(req.params.id, uid))) return res.status(403).json({ error: 'この共有目標のメンバーではありません。', errorJa: 'この共有目標のメンバーではありません。', errorEn: 'You are not a member of this shared goal.' });
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM shared_goal_members WHERE goal_id = $1 AND user_id = $2', [req.params.id, uid]);
      // V12.7・A班: 抜ける人の申告も消す（残すと「全員申告済み」の
      // 数え直しがずれるため。貢献履歴・コメントは従来通り残す）。
      await client.query('DELETE FROM shared_goal_declarations WHERE goal_id = $1 AND user_id = $2', [req.params.id, uid]);
      const g = await client.query('SELECT owner_user_id FROM shared_goals WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!g.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: '共有目標が見つかりません。', errorJa: '共有目標が見つかりません。', errorEn: 'Shared goal not found.' }); }
      const rest = await client.query('SELECT user_id FROM shared_goal_members WHERE goal_id = $1 ORDER BY joined_at ASC LIMIT 1', [req.params.id]);
      if (!rest.rowCount) {
        await client.query('DELETE FROM shared_goals WHERE id = $1', [req.params.id]);
      } else if (g.rows[0].owner_user_id === uid) {
        await client.query('UPDATE shared_goals SET owner_user_id = $1 WHERE id = $2', [rest.rows[0].user_id, req.params.id]);
      }
      await client.query('COMMIT');
      // V12.7・A班: 残りのメンバーだけで「全員申告済み」になることがある
      // ため、declare ルールの達成状態を数え直す（失敗しても退出は成功）。
      try { await refreshDeclareStatus(req.params.id); } catch (_) {}
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
  //     コメントは残す）。その目標の共通タスクの完了記録と「達成した」
  //     の申告も消す（残すと「今日 N/M人」・「全員申告済み」がずれるため）。
  //   - shared_goal_kicks に記録を残す（キックされた人が次回開いたときに
  //     GET /api/shared-goals/kicked で「外されました」と分かるように）。
  //   - アクティビティにも記録する（activity_events。失敗してもキック
  //     自体は成功させる＝ベストエフォート）。
  //   - 返すのは更新後の目標全体（クライアントは差し替えるだけ）。
  app.post('/api/shared-goals/:id/kick', auth.requireAuth, wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: '不正なIDです。', errorJa: '不正なIDです。', errorEn: 'Invalid ID.' });
    const uid = resolveMemberId(req);
    if (limited('sg:kick:' + uid, 20, 10 * 60 * 1000)) return res.status(429).json({ error: '操作が多すぎます。少し時間をおいてください。', errorJa: '操作が多すぎます。少し時間をおいてください。', errorEn: 'Too many actions. Please wait a while.' });
    const targetUserId = String((req.body && req.body.userId) || '').trim();
    if (!targetUserId) return res.status(400).json({ error: '外すメンバーを指定してください。', errorJa: '外すメンバーを指定してください。', errorEn: 'Please choose a member to remove.' });
    if (targetUserId === uid) return res.status(400).json({ error: '自分自身を外すことはできません。オーナーが抜けるときは「抜ける」を使ってください。', errorJa: '自分自身を外すことはできません。オーナーが抜けるときは「抜ける」を使ってください。', errorEn: 'You cannot remove yourself. If the owner wants to leave, use "Leave".' });
    const g = await q('SELECT id, owner_user_id, title FROM shared_goals WHERE id = $1', [req.params.id]);
    if (!g.rowCount) return res.status(404).json({ error: '共有目標が見つかりません。', errorJa: '共有目標が見つかりません。', errorEn: 'Shared goal not found.' });
    if (g.rows[0].owner_user_id !== uid) return res.status(403).json({ error: 'メンバーを外せるのは作成者だけです。', errorJa: 'メンバーを外せるのは作成者だけです。', errorEn: 'Only the creator can remove members.' });
    if (!(await isMember(req.params.id, targetUserId))) return res.status(404).json({ error: 'そのメンバーは見つかりません。', errorJa: 'そのメンバーは見つかりません。', errorEn: 'That member was not found.' });
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM shared_goal_members WHERE goal_id = $1 AND user_id = $2', [req.params.id, targetUserId]);
      await client.query(
        `DELETE FROM shared_goal_task_completions
         WHERE user_id = $2 AND task_id IN (SELECT id FROM shared_goal_tasks WHERE goal_id = $1)`,
        [req.params.id, targetUserId]);
      // V12.7・A班: キックされた人の申告も消す（残すと「全員申告済み」の
      // 数え直しがずれるため）。
      await client.query('DELETE FROM shared_goal_declarations WHERE goal_id = $1 AND user_id = $2',
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
    // V12.7・A班: 残りのメンバーだけで「全員申告済み」になることがある
    // ため、declare ルールの達成状態を数え直す（失敗してもキックは成功）。
    try { await refreshDeclareStatus(req.params.id); } catch (_) {}
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
    if (!detail) return res.status(404).json({ error: '共有目標が見つかりません。', errorJa: '共有目標が見つかりません。', errorEn: 'Shared goal not found.' });
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
 * 11. 数値タイプとAI作成（V12.6・C班。バージョンは 7.4.0 に上がる。
 *    AI提案エンドポイント自体は server.js の A班分。ここは保存と記録の確認）:
 *    - POST /api/shared-goals（kind: 'value', target: 80, unit: 'kg',
 *      startValue: 95, achievementRule: 'declare'）→ goal.kind='value'、
 *      goal.startValue=95、goal.achievementRule='declare'、unit='kg'
 *    - POST /api/shared-goals（kind: 'value', startValue なし）→
 *      goal.startValue=null（target を開始値扱いにしない。全体の達成率は
 *      クライアントで null＝表示なしになる）
 *    - POST /api/shared-goals（kind: 'value', startValue と target が同じ）
 *      → 400「開始値と目標値は違う値にしてください。」
 *    - POST /api/shared-goals（kind: 'value', achievementRule: 'xxx'）
 *      → goal.achievementRule='auto'（不正値は既定値）
 *    - POST /api/shared-goals（kind: 'count' に startValue を付けても）
 *      → goal.startValue=null（value 以外では使わない）
 *    - kind 未指定・旧データの作成 → goal.kind='count'、startValue=null、
 *      achievementRule='auto'（従来通り。旧共有目標は壊れない）
 *    - POST /api/shared-goals/:id/contribute（value タイプ、{ value: 94 }）
 *      → { goal } が返り、goal.currentValue=94、myCurrentValue=94、
 *      members[] の自分の todayQuotaRate=100、contribution が 1 増える
 *    - 同じ日に2回目（{ value: 93.5 }）→ goal.currentValue=93.5 に
 *      更新されるが contribution は増えない（値の修正のみ）
 *    - POST /api/shared-goals/:id/contribute（value タイプ、value なし）
 *      → 400「現在の値を入力してください。」（amount だけ送っても同じ）
 *    - POST /api/shared-goals/:id/contribute（count タイプ、{ value: 5 }）
 *      → value は無視され、従来通り amount が要る（amount なしは 400）
 *    - GET /api/shared-goals/public?kind=value → 数値タイプだけが返る。
 *      各行に startValue・achievementRule が付くこと
 *    - GET /api/version → { version: '7.4.0', features: {
 *      aiSharedGoalCreation: true, ... } }
 * 12. 達成の決め方の実行（V12.7・A班。バージョンは 7.5.0 に上がる）:
 *    - POST /api/shared-goals（kind: 'value', target: 80, startValue: 95,
 *      achievementRule: 'declare'）→ goal.achievementStatus='active'、
 *      goal.declaredCount=0、goal.deadlinePassed=false（期日前なら）
 *    - POST /api/shared-goals/:id/declare（{ declared: true }、メンバー）
 *      → { goal } が返り、自分の members[] に declared=true、declaredCount=1
 *    - 全員が declare したら goal.achievementStatus='achieved'、
 *      achievedAt が入ること。1人が { declared: false } で取り消したら
 *      achievementStatus='active'、achievedAt=null に戻ること
 *    - POST /api/shared-goals/:id/declare（rule が 'auto' の目標）
 *      → 400「申告で達成を決める目標ではありません。」
 *    - POST /api/shared-goals/:id/declare（メンバーでない人）→ 403
 *    - POST /api/shared-goals/:id/deadline-result（{ result: 'pass' }、
 *      作成者・rule='deadline'）→ achievementStatus='achieved'、
 *      deadlineResult='pass'。{ result: 'fail' } → 'failed'。
 *      { result: null } → 'active'・deadlineResult=null に戻ること
 *    - POST /api/shared-goals/:id/deadline-result（作成者以外）→ 403。
 *      （rule が 'deadline' でない目標）→ 400
 *    - POST /api/shared-goals/:id/contribute（value、{ value: 80 }、
 *      start 95・target 80・rule='auto'）→ achievementStatus='achieved'
 *    - POST /api/shared-goals/:id/contribute（count、合計が target 到達・
 *      rule='auto'）→ achievementStatus='achieved'
 *    - POST /api/shared-goals/:id/contribute（rule='declare'・'deadline'）
 *      → 記録しても achievementStatus は変わらないこと
 *    - GET /api/shared-goals/public の各行に achievementStatus が付くこと
 *    - GET /api/version → { version: '7.5.0', features: {
 *      achievementRuleExecution: true, ... } }
 * 13. メンバーごとの週間統計と最近の記録（V12.8・C班。バージョンは 7.6.0 に上がる）:
 *    - GET /api/shared-goals/:id の members[] に weeklyStats
 *      { pomodoro, memorized, tasksDone, weekStart } が付くこと
 *      （今週の月曜始まり。sync-pace で統計を送ったメンバーの数が入る。
 *      送っていないメンバーは 0）。weekStart は今週の月曜の日付。
 *    - 週間統計が無くても GET /api/shared-goals/:id が 200 で返ること
 *      （pace_scores が空でも 503 にならない）。
 *    - GET /api/shared-goals/:id/members/:userId/activity（メンバー）→
 *      { events: [{ id, kind, text, createdAt }] }。kind は
 *      task/card/pomodoro/goal/contribution。直近7日・新しい順・既定10件。
 *    - メンバーでない閲覧者 → 403。対象がメンバーでない → 404。
 *    - GET /api/version → { version: '7.6.0', features: {
 *      memberWeeklyStats: true, ... } }
 * 14. メンバーごとの累計の実績（V12.15・B班。バージョンは 7.9.0 に上がる）:
 *    - GET /api/shared-goals/:id の members[] に totalStats
 *      { pomodoro, memorized, tasksDone } が付くこと
 *      （pace_scores の全週の合計。週の区切りは無い。統計を送ったことが
 *      あるメンバーの累計が入り、送っていないメンバーは 0）。
 *    - weeklyStats { pomodoro, memorized, tasksDone, weekStart } は
 *      旧クライアント互換のため残ること。
 *    - 累計の集計が無くても GET /api/shared-goals/:id が 200 で返ること
 *      （pace_scores が空でも 503 にならない）。
 *    - GET /api/version → { version: '7.9.0', features: {
 *      memberTotalStats: true, ... } }
 * 10. 503 が出たときの切り分け（v5）: Render → Logs で
 *    `[shared-goals] requestId=... POST /api/shared-goals user=... step=... error=...`
 *    を探す。step=loadGoalDetail なら集計の例外、step=ensure-schema なら
 *    テーブル作成の失敗、step=create-insert なら INSERT の失敗。
 *    クライアントが受け取った requestId とログの requestId を突き合わせる。
 *    code=DB_UNAVAILABLE なら DATABASE_URL 未設定/DB未接続を疑う
 *    （db.js で pool が null だと ensure() が 'DB disabled' で失敗する）。
 */

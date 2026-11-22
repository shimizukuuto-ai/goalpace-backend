const STORAGE_KEY = 'paceProjectsV1';
const $ = (id) => document.getElementById(id);

let projects = loadProjects();
let wizardDraft = null;   // in-progress new goal being built in the wizard
let activeProjectId = null;

function loadProjects() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}
function saveProjects() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
}
function uid() {
  return 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }
function showView(id) {
  document.querySelectorAll('.view').forEach((v) => hide(v));
  show($(id));
}

// ---------------------------------------------------------------
// Pace ribbon: visualizes elapsed time vs target date, with a
// today-marker and a color reflecting the latest AI evaluation.
// ---------------------------------------------------------------
function paceStatus(project) {
  const logs = project.progressLogs || [];
  if (logs.length === 0) {
    if (project.plan.feasibility === '非現実的') return 'danger';
    if (project.plan.feasibility === 'やや厳しい') return 'warn';
    return 'ok';
  }
  const last = logs[logs.length - 1];
  return last.onTrack ? 'ok' : 'warn';
}

function renderRibbon(project, mini) {
  const start = new Date(project.createdAt).getTime();
  const end = new Date(project.targetDate).getTime();
  const now = Date.now();
  const total = Math.max(end - start, 1);
  const elapsed = Math.min(Math.max(now - start, 0), total);
  const pct = Math.round((elapsed / total) * 100);
  const status = paceStatus(project);

  return `
    <div class="ribbon ${mini ? 'mini' : ''}">
      <div class="ribbon-track">
        <div class="ribbon-fill ${status === 'ok' ? '' : status}" style="width:${pct}%"></div>
        <div class="ribbon-marker" style="left:${pct}%"></div>
      </div>
      ${mini ? '' : `<div class="ribbon-labels"><span>開始</span><span>目標日: ${project.targetDate}</span></div>`}
    </div>
  `;
}

function daysLeft(targetDate) {
  const diff = new Date(targetDate).getTime() - Date.now();
  const d = Math.ceil(diff / (1000 * 60 * 60 * 24));
  return d >= 0 ? `あと${d}日` : `期限超過${Math.abs(d)}日`;
}

// ---------------------------------------------------------------
// LIST VIEW
// ---------------------------------------------------------------
function renderList() {
  const grid = $('listGrid');
  if (projects.length === 0) {
    show($('listEmpty'));
    grid.innerHTML = '';
    return;
  }
  hide($('listEmpty'));
  grid.innerHTML = projects.map((p) => `
    <div class="goal-card" data-id="${p.id}">
      <div class="goal-card-head">
        <span class="goal-card-title">${escapeHtml(p.goal)}</span>
        <span class="badge ${paceStatus(p) === 'ok' ? 'ok' : paceStatus(p) === 'warn' ? 'warn' : 'danger'}">${paceStatus(p) === 'ok' ? '順調' : '要調整'}</span>
      </div>
      <p class="goal-card-date mono">目標日 ${p.targetDate} ・ ${daysLeft(p.targetDate)}</p>
      ${renderRibbon(p, true)}
    </div>
  `).join('');

  grid.querySelectorAll('.goal-card').forEach((card) => {
    card.addEventListener('click', () => openDetail(card.dataset.id));
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

$('btnNewGoal').addEventListener('click', openWizard);
$('btnEmptyNewGoal').addEventListener('click', openWizard);

// ---------------------------------------------------------------
// WIZARD (create a new goal)
// ---------------------------------------------------------------
function openWizard() {
  wizardDraft = { questions: [], baselineAnswers: {} };
  $('goal').value = '';
  $('targetDate').value = '';
  hide($('setupError'));
  document.querySelectorAll('.wz-step').forEach((s) => hide(s));
  show($('wz-step-goal'));
  showView('view-wizard');
}

$('btnWizardBack').addEventListener('click', () => {
  showView('view-list');
});

$('btnStart').addEventListener('click', async () => {
  const goal = $('goal').value.trim();
  const targetDate = $('targetDate').value;
  hide($('setupError'));
  if (!goal || !targetDate) {
    $('setupError').textContent = '目標と目標日の両方を入力してください。';
    show($('setupError'));
    return;
  }
  wizardDraft.goal = goal;
  wizardDraft.targetDate = targetDate;

  hide($('wz-step-goal'));
  show($('wz-step-questions'));
  show($('questionsLoading'));
  hide($('btnPlan'));
  $('questionsForm').innerHTML = '';

  try {
    const res = await fetch('/api/questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal, targetDate }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    wizardDraft.questions = data.questions;
    $('questionsForm').innerHTML = data.questions.map((q) => `
      <label for="q_${q.id}">${escapeHtml(q.question)}</label>
      <input id="q_${q.id}" type="${q.type === 'number' ? 'number' : 'text'}" placeholder="${escapeHtml(q.unit || '')}">
    `).join('');
    hide($('questionsLoading'));
    show($('btnPlan'));
  } catch (err) {
    $('questionsError').textContent = 'エラー: ' + err.message;
    show($('questionsError'));
    hide($('questionsLoading'));
  }
});

$('btnPlan').addEventListener('click', async () => {
  wizardDraft.questions.forEach((q) => {
    wizardDraft.baselineAnswers[q.question] = $('q_' + q.id).value;
  });

  hide($('wz-step-questions'));
  show($('wz-step-plan'));
  show($('planLoading'));
  hide($('planResult'));
  hide($('btnSaveProject'));

  try {
    const res = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal: wizardDraft.goal,
        targetDate: wizardDraft.targetDate,
        baselineAnswers: wizardDraft.baselineAnswers,
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    wizardDraft.plan = data;
    $('planResult').innerHTML = renderPlanSummary(data);
    hide($('planLoading'));
    show($('planResult'));
    show($('btnSaveProject'));
  } catch (err) {
    $('planLoading').innerHTML = '<span class="field-error">エラー: ' + err.message + '</span>';
  }
});

function feasibilityBadgeClass(f) {
  if (f === '現実的') return 'ok';
  if (f === 'やや厳しい') return 'warn';
  return 'danger';
}

function renderPlanSummary(plan) {
  return `
    <span class="badge ${feasibilityBadgeClass(plan.feasibility)}">${plan.feasibility}</span>
    <p style="font-size:13px;color:var(--text-muted);margin:10px 0;">${escapeHtml(plan.reasoning || '')}</p>
    <div class="stat-row" style="grid-template-columns:1fr 1fr;">
      <div class="stat"><p class="stat-label">達成可能日</p><p class="stat-value mono">${plan.achievableDate}</p></div>
      <div class="stat"><p class="stat-label">必要ペース</p><p class="stat-value">${escapeHtml(plan.requiredPace)}</p></div>
    </div>
    ${renderTaskWeeks(plan.tasks)}
  `;
}

function renderTaskWeeks(tasks) {
  return (tasks || []).map((w) => `
    <p class="task-week">第${w.week}週</p>
    <div class="task-list">${(w.dailyTasks || []).map((t) => `<div class="task-item">${escapeHtml(t)}</div>`).join('')}</div>
  `).join('');
}

$('btnSaveProject').addEventListener('click', () => {
  const project = {
    id: uid(),
    goal: wizardDraft.goal,
    targetDate: wizardDraft.targetDate,
    createdAt: new Date().toISOString(),
    baselineAnswers: wizardDraft.baselineAnswers,
    plan: wizardDraft.plan,
    planHistory: [{ date: new Date().toISOString().slice(0, 10), plan: wizardDraft.plan, reason: '初期計画' }],
    progressLogs: [],
  };
  projects.push(project);
  saveProjects();
  renderList();
  openDetail(project.id);
});

// ---------------------------------------------------------------
// DETAIL VIEW
// ---------------------------------------------------------------
function openDetail(id) {
  activeProjectId = id;
  renderDetail();
  showView('view-detail');
}

$('btnDetailBack').addEventListener('click', () => {
  activeProjectId = null;
  renderList();
  showView('view-list');
});

function getActiveProject() {
  return projects.find((p) => p.id === activeProjectId);
}

function renderDetail() {
  const p = getActiveProject();
  if (!p) return;
  const status = paceStatus(p);

  $('dtGoalTitle').textContent = p.goal;
  $('dtGoalSub').textContent = `目標日 ${p.targetDate} ・ ${daysLeft(p.targetDate)}`;
  $('dtBadge').textContent = status === 'ok' ? 'ペース通り' : status === 'warn' ? '要調整' : '遅れ';
  $('dtBadge').className = `badge ${status === 'ok' ? 'ok' : status}`;
  $('dtRibbon').innerHTML = renderRibbon(p, false);
  $('dtAchDate').textContent = p.plan.achievableDate;
  $('dtPace').textContent = p.plan.requiredPace;
  $('dtDaysLeft').textContent = daysLeft(p.targetDate);
  $('dtTasks').innerHTML = renderTaskWeeks(p.plan.tasks ? p.plan.tasks.slice(0, 1) : []);

  const logs = p.progressLogs.slice().reverse();
  $('dtLogHistory').innerHTML = logs.length
    ? logs.map((log) => `
        <div class="log-item">
          <span class="log-date">${log.date} ・ ${escapeHtml(log.feel)}</span>
          <p class="log-note">${escapeHtml(log.note || '（メモなし）')}</p>
          <span class="badge ${log.onTrack ? 'ok' : 'warn'}">${log.onTrack ? 'ペース通り' : '要調整'}</span>
          <p class="log-message">${escapeHtml(log.message || '')}</p>
        </div>
      `).join('')
    : '<p class="log-empty">まだ記録がありません。今日の進捗を記録してみましょう。</p>';
}

$('btnDeleteGoal').addEventListener('click', () => {
  const p = getActiveProject();
  if (!p) return;
  if (!confirm(`「${p.goal}」を削除しますか？この操作は取り消せません。`)) return;
  projects = projects.filter((x) => x.id !== p.id);
  saveProjects();
  activeProjectId = null;
  renderList();
  showView('view-list');
});

// ---------------------------------------------------------------
// CHECK-IN MODAL
// ---------------------------------------------------------------
$('btnOpenCheckin').addEventListener('click', () => {
  $('progressNote').value = '';
  $('feel').value = '順調';
  hide($('checkinResult'));
  hide($('checkinLoading'));
  $('btnCheckin').disabled = false;
  show($('btnCheckin'));
  $('btnCancelCheckin').textContent = 'キャンセル';
  show($('checkinOverlay'));
});

$('btnCancelCheckin').addEventListener('click', () => {
  hide($('checkinOverlay'));
  renderDetail();
});

$('btnCheckin').addEventListener('click', async () => {
  const p = getActiveProject();
  if (!p) return;

  const entry = {
    date: new Date().toISOString().slice(0, 10),
    note: $('progressNote').value,
    feel: $('feel').value,
  };

  show($('checkinLoading'));
  hide($('checkinResult'));
  $('btnCheckin').disabled = true;

  try {
    const res = await fetch('/api/checkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: {
          goal: p.goal,
          targetDate: p.targetDate,
          baselineAnswers: p.baselineAnswers,
          plan: p.plan,
          progressLogs: p.progressLogs,
        },
        todayEntry: entry,
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    entry.onTrack = data.onTrack;
    entry.message = data.message;
    p.progressLogs.push(entry);
    p.planHistory.push({ date: entry.date, plan: p.plan, reason: '再評価前のスナップショット' });
    p.plan = {
      ...p.plan,
      requiredPace: data.updatedPace,
      tasks: [{ week: '更新後', dailyTasks: data.updatedTasks || [] }, ...(p.plan.tasks || [])],
    };
    saveProjects();

    $('checkinResult').innerHTML = `
      <div class="badge ${data.onTrack ? 'ok' : 'warn'}" style="margin-top:14px;">${data.onTrack ? 'ペース通り' : '要調整'}</div>
      <p style="font-size:14px;background:var(--panel-2);border-radius:9px;padding:12px;margin:8px 0;">${escapeHtml(data.message)}</p>
      <p class="section-label">明日からのタスク</p>
      <div class="task-list">${(data.updatedTasks || []).map((t) => `<div class="task-item">${escapeHtml(t)}</div>`).join('')}</div>
    `;
    hide($('checkinLoading'));
    show($('checkinResult'));
    hide($('btnCheckin'));
    $('btnCancelCheckin').textContent = '閉じる';
  } catch (err) {
    $('checkinLoading').innerHTML = '<span class="field-error">エラー: ' + err.message + '</span>';
  }
});

// ---------------------------------------------------------------
// INIT
// ---------------------------------------------------------------
renderList();
showView('view-list');

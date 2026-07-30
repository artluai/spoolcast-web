const CREDENTIALS_KEY = 'spoolcast-board-credentials';
const COMPLETED_DISPLAY_KEY = 'spoolcast-board-completed-display';
const AGENT_ROLE_KEY = 'spoolcast-board-agent-role';
const MERMAID_URL = '/vendor/mermaid-11.12.0.min.js';
const mentionableIdentities = ['Ralph', 'Fable', 'Codex'];
const statusFilters = [
  ['todo', 'Open'],
  ['in_progress', 'In progress'],
  ['done', 'Done'],
];

const tagLabels = {
  fable: 'Fable',
  codex: 'Codex',
  founder: 'Founder',
};

const teamFilters = [
  ['fable', 'Fable'],
  ['codex', 'Codex'],
  ['founder', 'Founder'],
];

const savedCompletedDisplay = localStorage.getItem(COMPLETED_DISPLAY_KEY);
const state = {
  credentials: localStorage.getItem(CREDENTIALS_KEY) || '',
  viewer: null,
  board: { updatedAt: null, tasks: [], goals: [] },
  visibleStatuses: new Set(statusFilters.map(([value]) => value)),
  visibleTeams: new Set(teamFilters.map(([value]) => value)),
  editingId: null,
  aboutLoaded: false,
  aboutData: null,
  diagramsLoaded: false,
  collapsedGoals: new Set(),
  completedDisplay: ['strike', 'check'].includes(savedCompletedDisplay)
    ? savedCompletedDisplay
    : 'strike',
  agentRole: localStorage.getItem(AGENT_ROLE_KEY) || 'Fable',
  showReadMentions: false,
  replyingTo: null,
  focusCommentId: null,
};

const elements = {
  loginView: document.querySelector('#login-view'),
  loginForm: document.querySelector('#login-form'),
  username: document.querySelector('#username'),
  password: document.querySelector('#password'),
  loginError: document.querySelector('#login-error'),
  boardView: document.querySelector('#board-view'),
  viewerChip: document.querySelector('#viewer-chip'),
  agentRoleControl: document.querySelector('#agent-role-control'),
  agentRole: document.querySelector('#agent-role'),
  aboutButton: document.querySelector('#about-button'),
  logoutButton: document.querySelector('#logout-button'),
  addTaskButton: document.querySelector('#add-task-button'),
  mentionsCount: document.querySelector('#mentions-count'),
  mentionsList: document.querySelector('#mentions-list'),
  showReadMentions: document.querySelector('#show-read-mentions'),
  markAllRead: document.querySelector('#mark-all-read'),
  activeCount: document.querySelector('#active-count'),
  activeList: document.querySelector('#active-list'),
  nowView: document.querySelector('#now-view'),
  statusCounts: document.querySelector('#status-counts'),
  filterMenu: document.querySelector('#filter-menu'),
  filterCount: document.querySelector('#filter-count'),
  displayMenu: document.querySelector('#display-menu'),
  refreshButton: document.querySelector('#refresh-button'),
  refreshLabel: document.querySelector('#refresh-label'),
  lastRefreshed: document.querySelector('#last-refreshed'),
  projectList: document.querySelector('#project-list'),
  boardError: document.querySelector('#board-error'),
  aboutDialog: document.querySelector('#about-dialog'),
  aboutClose: document.querySelector('#about-close'),
  aboutSummary: document.querySelector('#about-summary'),
  architectureDiagram: document.querySelector('#architecture-diagram'),
  pipelineDiagram: document.querySelector('#pipeline-diagram'),
  diagramRetry: document.querySelector('#diagram-retry'),
  diagramRetryButton: document.querySelector('#diagram-retry-button'),
  documentLinks: document.querySelector('#document-links'),
  taskDialog: document.querySelector('#task-dialog'),
  taskForm: document.querySelector('#task-form'),
  dialogEyebrow: document.querySelector('#dialog-eyebrow'),
  dialogTitle: document.querySelector('#dialog-title'),
  dialogClose: document.querySelector('#dialog-close'),
  taskPlainTitle: document.querySelector('#task-plain-title'),
  taskPurpose: document.querySelector('#task-purpose'),
  taskGoal: document.querySelector('#task-goal'),
  taskOwner: document.querySelector('#task-owner'),
  taskTag: document.querySelector('#task-tag'),
  taskStatus: document.querySelector('#task-status'),
  taskTitle: document.querySelector('#task-title'),
  taskNote: document.querySelector('#task-note'),
  plainLanguageDetails: document.querySelector('#plain-language-details'),
  discussion: document.querySelector('#discussion'),
  commentIdentity: document.querySelector('#comment-identity'),
  replyBanner: document.querySelector('#reply-banner'),
  replyLabel: document.querySelector('#reply-label'),
  cancelReply: document.querySelector('#cancel-reply'),
  commentInput: document.querySelector('#comment-input'),
  mentionButtons: document.querySelector('#mention-buttons'),
  postComment: document.querySelector('#post-comment'),
  commentList: document.querySelector('#comment-list'),
  dialogError: document.querySelector('#dialog-error'),
  archiveTaskButton: document.querySelector('#archive-task-button'),
  claimTaskButton: document.querySelector('#claim-task-button'),
  cancelTaskButton: document.querySelector('#cancel-task-button'),
};

function setError(element, message = '') {
  element.textContent = message;
  element.hidden = !message;
}

function showBoardError(message) {
  setError(elements.boardError, message);
  window.setTimeout(() => setError(elements.boardError), 5000);
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function effectiveIdentity() {
  return state.viewer === 'AI' ? state.agentRole : state.viewer;
}

function shortTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function taskComments(task) {
  return Array.isArray(task.comments) ? task.comments : [];
}

function isMentionFor(comment, identity = effectiveIdentity()) {
  return identity && Array.isArray(comment.mentions) && comment.mentions.includes(identity);
}

function isCommentRead(comment, identity = effectiveIdentity()) {
  return identity && Array.isArray(comment.readBy) && comment.readBy.includes(identity);
}

function logOut() {
  localStorage.removeItem(CREDENTIALS_KEY);
  localStorage.removeItem('spoolcast-board-token');
  state.credentials = '';
  state.viewer = null;
  state.aboutLoaded = false;
  state.aboutData = null;
  state.diagramsLoaded = false;
  state.replyingTo = null;
  state.focusCommentId = null;
  elements.boardView.hidden = true;
  elements.loginView.hidden = false;
  elements.password.value = '';
  elements.username.focus();
}

let mermaidLoadPromise = null;

function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (mermaidLoadPromise) return mermaidLoadPromise;

  mermaidLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = MERMAID_URL;
    script.dataset.mermaidRuntime = 'true';
    script.addEventListener('load', () => {
      if (window.mermaid) resolve(window.mermaid);
      else reject(new Error('The diagram renderer did not initialize.'));
    });
    script.addEventListener('error', () => reject(new Error('The diagram renderer did not load.')));
    document.head.append(script);
  }).catch((error) => {
    document.querySelector('script[data-mermaid-runtime]')?.remove();
    mermaidLoadPromise = null;
    throw error;
  });

  return mermaidLoadPromise;
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Basic ${state.credentials}`);
  if (options.body) headers.set('Content-Type', 'application/json');

  const response = await fetch(path, { ...options, headers });
  const isJson = response.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await response.json() : null;

  if (response.status === 401) {
    logOut();
    throw new Error('That login is no longer valid. Please sign in again.');
  }
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
  return { data, response };
}

function taskName(task) {
  return task.title;
}

function goalFor(task) {
  return (
    state.board.goals.find(({ id }) => id === (task.goal || 'cloud')) ||
    state.board.goals[0] || {
      id: 'cloud',
      title: 'Run everything from anywhere',
      summary: '',
    }
  );
}

function matchesFilter(task) {
  return state.visibleStatuses.has(task.status) && state.visibleTeams.has(task.tag);
}

function statusDot(task) {
  const labels = { todo: 'Open', in_progress: 'In progress', done: 'Complete' };
  const dot = makeElement(
    'span',
    `status-dot status-${task.status}`,
    task.status === 'done' ? '✓' : '',
  );
  dot.setAttribute('role', 'img');
  dot.setAttribute('aria-label', labels[task.status]);
  return dot;
}

function ownerBadge(task) {
  if (!task.owner || task.status === 'done') return null;
  const badge = makeElement('span', 'row-owner', task.owner.slice(0, 1));
  badge.title = `${task.owner} is working on this`;
  badge.setAttribute('aria-label', `${task.owner} is working on this`);
  return badge;
}

function issueRow(task, { showGoal = false } = {}) {
  const row = makeElement(
    'button',
    `issue-row issue-${task.status} completed-display-${state.completedDisplay}`,
  );
  row.type = 'button';
  row.addEventListener('click', () => openTask(task));
  row.append(statusDot(task));

  const copy = makeElement('span', 'issue-copy');
  copy.append(makeElement('span', 'issue-title', taskName(task)));
  copy.append(makeElement('span', 'issue-purpose', task.purpose || task.plainTitle || ''));
  if (showGoal) copy.append(makeElement('span', 'issue-parent', goalFor(task).title));
  row.append(copy);

  const meta = makeElement('span', 'issue-meta');
  const tag = makeElement('span', `row-tag tag-${task.tag}`, tagLabels[task.tag]);
  tag.title = `Recommended team: ${tagLabels[task.tag]}`;
  meta.append(tag);
  const owner = ownerBadge(task);
  if (owner) meta.append(owner);
  meta.append(makeElement('span', 'row-chevron', '›'));
  row.append(meta);
  return row;
}

function emptyRow(message) {
  return makeElement('div', 'empty-row', message);
}

function mentionsForViewer() {
  const identity = effectiveIdentity();
  const mentions = [];
  for (const task of state.board.tasks.filter((candidate) => !candidate.archived)) {
    for (const comment of taskComments(task)) {
      if (isMentionFor(comment, identity)) mentions.push({ task, comment });
    }
  }
  return mentions.sort(
    (left, right) =>
      new Date(right.comment.createdAt).getTime() - new Date(left.comment.createdAt).getTime(),
  );
}

function mentionRow(task, comment) {
  const unread = !isCommentRead(comment);
  const row = makeElement('button', `mention-row${unread ? ' is-unread' : ''}`);
  row.type = 'button';
  row.append(
    makeElement('span', 'mention-author', comment.author),
    makeElement('span', 'mention-task', task.title),
    makeElement('span', 'mention-preview', comment.body),
    makeElement('span', 'mention-time', shortTime(comment.createdAt)),
  );
  row.addEventListener('click', async () => {
    try {
      if (unread) await markCommentRead(task.id, comment.id);
      const freshTask = state.board.tasks.find((candidate) => candidate.id === task.id);
      if (freshTask) openTask(freshTask, { focusCommentId: comment.id });
    } catch (error) {
      showBoardError(error.message);
    }
  });
  return row;
}

function renderMentions() {
  const allMentions = mentionsForViewer();
  const unread = allMentions.filter(({ comment }) => !isCommentRead(comment));
  const visible = state.showReadMentions ? allMentions : unread;
  elements.mentionsCount.textContent = unread.length ? String(unread.length) : '';
  elements.markAllRead.hidden = unread.length === 0;
  elements.showReadMentions.setAttribute('aria-pressed', String(state.showReadMentions));
  elements.showReadMentions.textContent = state.showReadMentions ? 'Hide read' : 'Show read';
  elements.mentionsList.replaceChildren();

  if (!visible.length) {
    elements.mentionsList.append(
      emptyRow(state.showReadMentions ? 'No mentions yet.' : 'No unread mentions.'),
    );
    return;
  }
  for (const { task, comment } of visible) {
    elements.mentionsList.append(mentionRow(task, comment));
  }
}

function renderActive() {
  elements.nowView.hidden = !state.visibleStatuses.has('in_progress');
  if (elements.nowView.hidden) return;

  const active = state.board.tasks.filter(
    (task) => !task.archived && task.status === 'in_progress' && state.visibleTeams.has(task.tag),
  );
  elements.activeCount.textContent = active.length ? String(active.length) : '';
  elements.activeList.replaceChildren();
  if (!active.length) {
    elements.activeList.append(emptyRow('Nothing is marked in progress.'));
    return;
  }
  for (const task of active) elements.activeList.append(issueRow(task, { showGoal: true }));
}

function projectCounts(tasks) {
  const done = tasks.filter((task) => task.status === 'done').length;
  const active = tasks.filter((task) => task.status === 'in_progress').length;
  const open = tasks.filter((task) => task.status === 'todo').length;
  return `${done} done · ${active} active · ${open} open`;
}

function projectGroup(goal) {
  const allTasks = state.board.tasks.filter(
    (task) => !task.archived && (task.goal || 'cloud') === goal.id,
  );
  const visibleTasks = allTasks.filter(matchesFilter);
  const collapsed = state.collapsedGoals.has(goal.id);
  const group = makeElement('section', 'project-group');

  const header = makeElement('button', 'project-header');
  header.type = 'button';
  header.setAttribute('aria-expanded', String(!collapsed));
  const caret = makeElement('span', 'project-caret', collapsed ? '›' : '⌄');
  const copy = makeElement('span', 'project-copy');
  copy.append(makeElement('span', 'project-title', goal.title));
  copy.append(makeElement('span', 'project-summary', goal.summary));
  header.append(caret, copy, makeElement('span', 'project-counts', projectCounts(allTasks)));
  header.addEventListener('click', () => {
    if (collapsed) state.collapsedGoals.delete(goal.id);
    else state.collapsedGoals.add(goal.id);
    renderProjects();
  });
  group.append(header);

  if (!collapsed) {
    const list = makeElement('div', 'issue-list project-issues');
    if (!visibleTasks.length) list.append(emptyRow('No tasks match this view.'));
    else {
      const currentTask = currentRoadmapTask();
      for (const task of visibleTasks) {
        if (task.id === currentTask?.id) list.append(youAreHereMarker());
        list.append(issueRow(task));
      }
    }
    group.append(list);
  }
  return group;
}

function currentRoadmapTask() {
  const tasks = state.board.tasks.filter((task) => !task.archived);
  return (
    tasks.find((task) => task.status === 'in_progress') ||
    tasks.find((task) => task.status === 'todo') ||
    null
  );
}

function youAreHereMarker() {
  const marker = makeElement('div', 'you-are-here');
  marker.append(makeElement('span', '', 'You are here'), makeElement('span', 'marker-line'));
  return marker;
}

function renderProjects() {
  elements.projectList.replaceChildren();
  for (const goal of state.board.goals) elements.projectList.append(projectGroup(goal));
}

function renderDisplaySetting() {
  for (const input of elements.displayMenu.querySelectorAll('input[name="completed-display"]')) {
    input.checked = input.value === state.completedDisplay;
  }
}

function renderFilters() {
  for (const input of elements.filterMenu.querySelectorAll('input[name="status-filter"]')) {
    input.checked = state.visibleStatuses.has(input.value);
  }
  for (const input of elements.filterMenu.querySelectorAll('input[name="team-filter"]')) {
    input.checked = state.visibleTeams.has(input.value);
  }

  const restrictedGroups =
    Number(state.visibleStatuses.size !== statusFilters.length) +
    Number(state.visibleTeams.size !== teamFilters.length);
  elements.filterCount.textContent = restrictedGroups ? String(restrictedGroups) : '';
  elements.filterMenu
    .querySelector('summary')
    .setAttribute(
      'aria-label',
      restrictedGroups ? `Filter, ${restrictedGroups} groups narrowed` : 'Filter',
    );
  renderDisplaySetting();
}

function populateGoalOptions() {
  const selected = elements.taskGoal.value;
  elements.taskGoal.replaceChildren();
  for (const goal of state.board.goals) {
    const option = makeElement('option', '', goal.title);
    option.value = goal.id;
    elements.taskGoal.append(option);
  }
  if (selected && state.board.goals.some(({ id }) => id === selected)) {
    elements.taskGoal.value = selected;
  }
}

function renderIdentityControls() {
  const isAgent = state.viewer === 'AI';
  elements.agentRoleControl.hidden = !isAgent;
  elements.agentRole.value = state.agentRole;
  const identity = effectiveIdentity();
  elements.viewerChip.textContent = identity || '';
  elements.viewerChip.dataset.initial = identity?.slice(0, 1) || '?';
}

function renderBoard() {
  const tasks = state.board.tasks.filter((task) => !task.archived);
  renderIdentityControls();
  elements.statusCounts.textContent = projectCounts(tasks);
  populateGoalOptions();
  renderMentions();
  renderActive();
  renderFilters();
  renderProjects();
}

async function renderAboutDiagrams(data) {
  elements.diagramRetry.hidden = true;
  elements.architectureDiagram.setAttribute('aria-busy', 'true');
  elements.pipelineDiagram.setAttribute('aria-busy', 'true');
  try {
    const mermaid = await loadMermaid();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: {
        background: '#ffffff',
        primaryColor: '#e9effe',
        primaryTextColor: '#1c1919',
        primaryBorderColor: '#3b6fe0',
        lineColor: '#716a6a',
        secondaryColor: '#fcfbfa',
        tertiaryColor: '#ffffff',
        fontFamily: "ui-monospace, 'SF Mono', Menlo, Monaco, monospace",
      },
    });
    for (const [id, element, definition] of [
      ['architecture-diagram-svg', elements.architectureDiagram, data.architecture],
      ['pipeline-diagram-svg', elements.pipelineDiagram, data.pipeline],
    ]) {
      const { svg, bindFunctions } = await mermaid.render(id, definition);
      element.innerHTML = svg;
      bindFunctions?.(element);
    }
    if (
      !elements.architectureDiagram.querySelector('svg') ||
      !elements.pipelineDiagram.querySelector('svg')
    ) {
      throw new Error('The diagram renderer returned an incomplete result.');
    }
    state.diagramsLoaded = true;
  } catch {
    state.diagramsLoaded = false;
    elements.architectureDiagram.textContent = 'The architecture diagram could not be loaded.';
    elements.pipelineDiagram.textContent = 'The pipeline diagram could not be loaded.';
    elements.diagramRetry.hidden = false;
  } finally {
    elements.architectureDiagram.removeAttribute('aria-busy');
    elements.pipelineDiagram.removeAttribute('aria-busy');
  }
}

async function loadAbout() {
  if (!state.aboutLoaded) {
    const { data } = await request('/api/about');
    state.aboutData = data;
    elements.aboutSummary.textContent = data.summary;
    elements.documentLinks.replaceChildren();

    if (data.links?.length) {
      for (const link of data.links) {
        const anchor = makeElement('a', '', link.label);
        anchor.href = link.url;
        anchor.target = '_blank';
        anchor.rel = 'noreferrer';
        elements.documentLinks.append(anchor);
      }
    } else {
      elements.documentLinks.append(
        makeElement('span', 'links-note', 'Repository links are not configured yet.'),
      );
    }
    state.aboutLoaded = true;
  }

  if (!state.diagramsLoaded) await renderAboutDiagrams(state.aboutData);
}

function setRefreshLoading(isLoading) {
  elements.refreshButton.disabled = isLoading;
  elements.refreshButton.classList.toggle('is-loading', isLoading);
  elements.refreshButton.setAttribute('aria-busy', String(isLoading));
  elements.refreshLabel.textContent = isLoading ? 'Refreshing…' : 'Refresh';
}

async function loadBoard({ quiet = false, showLoading = false } = {}) {
  const loadingStartedAt = showLoading ? performance.now() : null;
  if (showLoading) setRefreshLoading(true);
  try {
    const { data, response } = await request('/api/board');
    state.board = data;
    state.viewer = response.headers.get('X-Board-Identity') || 'Unknown';
    elements.loginView.hidden = true;
    elements.boardView.hidden = false;
    elements.lastRefreshed.textContent = `Last refreshed ${shortTime(new Date())}`;
    renderBoard();
  } catch (error) {
    if (!quiet && !state.credentials) return;
    if (!elements.loginView.hidden) setError(elements.loginError, error.message);
    else showBoardError(error.message);
  } finally {
    if (showLoading) {
      const remaining = 350 - (performance.now() - loadingStartedAt);
      if (remaining > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, remaining));
      }
      setRefreshLoading(false);
    }
  }
}

function appendCommentText(container, body) {
  const parts = body.split(/(@(?:Ralph|Fable|Codex)\b)/gi);
  for (const part of parts) {
    const identity = mentionableIdentities.find(
      (candidate) => `@${candidate}`.toLowerCase() === part.toLowerCase(),
    );
    container.append(
      identity
        ? makeElement('span', 'comment-mention', `@${identity}`)
        : document.createTextNode(part),
    );
  }
}

function setReply(task, comment) {
  state.replyingTo = comment.id;
  elements.replyBanner.hidden = false;
  elements.replyLabel.textContent = `Replying to ${comment.author}`;
  elements.commentInput.focus();
  renderMentionButtons(task);
}

function clearReply(task) {
  state.replyingTo = null;
  elements.replyBanner.hidden = true;
  elements.replyLabel.textContent = '';
  if (task) renderMentionButtons(task);
}

function renderMentionButtons(task) {
  elements.mentionButtons.replaceChildren();
  const currentIdentity = effectiveIdentity();
  for (const identity of mentionableIdentities.filter(
    (candidate) => candidate !== currentIdentity,
  )) {
    const button = makeElement('button', 'mention-button', `@${identity}`);
    button.type = 'button';
    button.addEventListener('click', () => {
      const spacer = elements.commentInput.value.trim() ? ' ' : '';
      elements.commentInput.value = `${elements.commentInput.value}${spacer}@${identity} `;
      elements.commentInput.focus();
    });
    elements.mentionButtons.append(button);
  }

  if (state.replyingTo) {
    const target = taskComments(task).find((comment) => comment.id === state.replyingTo);
    if (!target) clearReply();
  }
}

function commentCard(task, comment) {
  const unread = isMentionFor(comment) && !isCommentRead(comment);
  const card = makeElement(
    'article',
    `comment-card${unread ? ' is-unread' : ''}${
      state.focusCommentId === comment.id ? ' is-focused' : ''
    }`,
  );
  card.dataset.commentId = comment.id;

  const heading = makeElement('div', 'comment-heading');
  heading.append(
    makeElement('span', 'comment-avatar', comment.author.slice(0, 1)),
    makeElement('strong', '', comment.author),
    makeElement('time', '', shortTime(comment.createdAt)),
  );
  card.append(heading);

  if (comment.replyTo) {
    const parent = taskComments(task).find((candidate) => candidate.id === comment.replyTo);
    card.append(
      makeElement(
        'p',
        'reply-context',
        parent ? `Replying to ${parent.author}: ${parent.body.slice(0, 90)}` : 'Reply',
      ),
    );
  }

  const body = makeElement('p', 'comment-body');
  appendCommentText(body, comment.body);
  card.append(body);

  const footer = makeElement('div', 'comment-footer');
  if (Array.isArray(comment.mentions) && comment.mentions.length) {
    footer.append(makeElement('span', 'comment-tags', `Notified ${comment.mentions.join(', ')}`));
  }
  const reply = makeElement('button', 'text-button', 'Reply');
  reply.type = 'button';
  reply.addEventListener('click', () => setReply(task, comment));
  footer.append(reply);
  card.append(footer);
  return card;
}

function renderComments(task) {
  const identity = effectiveIdentity();
  elements.commentIdentity.textContent = `Commenting as ${identity}`;
  renderMentionButtons(task);
  elements.commentList.replaceChildren();
  const comments = [...taskComments(task)].sort(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
  if (!comments.length) {
    elements.commentList.append(emptyRow('No comments yet.'));
    return;
  }
  for (const comment of comments) elements.commentList.append(commentCard(task, comment));

  if (state.focusCommentId) {
    const focused = elements.commentList.querySelector(
      `[data-comment-id="${CSS.escape(state.focusCommentId)}"]`,
    );
    window.setTimeout(() => focused?.scrollIntoView({ block: 'center' }), 0);
  }
}

function resetTaskDialog() {
  elements.taskForm.reset();
  elements.taskDialog.classList.remove('details-mode');
  elements.plainLanguageDetails.open = false;
  elements.discussion.hidden = true;
  elements.commentInput.value = '';
  state.replyingTo = null;
  state.focusCommentId = null;
  state.editingId = null;
  populateGoalOptions();
  elements.archiveTaskButton.hidden = true;
  elements.claimTaskButton.hidden = true;
  setError(elements.dialogError);
}

function openAddTask() {
  resetTaskDialog();
  elements.dialogEyebrow.textContent = 'New task';
  elements.dialogTitle.textContent = 'Add task';
  elements.taskGoal.value = state.board.goals[0]?.id || 'cloud';
  elements.taskTag.value = 'founder';
  elements.taskStatus.value = 'todo';
  elements.taskDialog.showModal();
  elements.taskTitle.focus();
}

function openTask(task, { focusCommentId = null } = {}) {
  resetTaskDialog();
  state.editingId = task.id;
  state.focusCommentId = focusCommentId;
  elements.taskDialog.classList.add('details-mode');
  elements.discussion.hidden = false;
  elements.dialogEyebrow.textContent = goalFor(task).title;
  elements.dialogTitle.textContent = task.title;
  elements.taskPlainTitle.value = task.plainTitle || task.title;
  elements.taskPurpose.value = task.purpose || '';
  elements.taskGoal.value = task.goal || 'cloud';
  elements.taskOwner.value = task.owner || '';
  elements.taskTag.value = task.tag;
  elements.taskStatus.value = task.status;
  elements.taskTitle.value = task.title;
  elements.taskNote.value = task.note || '';
  elements.archiveTaskButton.hidden = false;
  const humanViewer = state.viewer === 'Ralph';
  elements.claimTaskButton.hidden =
    !humanViewer || task.status === 'done' || task.owner === state.viewer;
  elements.claimTaskButton.textContent = `Claim as ${state.viewer}`;
  renderComments(task);
  elements.taskDialog.showModal();
}

async function patchTask(id, changes) {
  await request(`/api/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(changes),
  });
  await loadBoard({ quiet: true });
}

async function markCommentRead(taskId, commentId) {
  await request(
    `/api/tasks/${encodeURIComponent(taskId)}/comments/${encodeURIComponent(commentId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ read: true, identity: effectiveIdentity() }),
    },
  );
  await loadBoard({ quiet: true });
}

async function markEveryMentionRead() {
  await request('/api/mentions/read-all', {
    method: 'POST',
    body: JSON.stringify({ identity: effectiveIdentity() }),
  });
  await loadBoard({ quiet: true });
}

async function postComment() {
  if (!state.editingId) return;
  const body = elements.commentInput.value.trim();
  if (!body) {
    setError(elements.dialogError, 'Write a comment before posting.');
    return;
  }

  elements.postComment.disabled = true;
  setError(elements.dialogError);
  try {
    await request(`/api/tasks/${encodeURIComponent(state.editingId)}/comments`, {
      method: 'POST',
      body: JSON.stringify({
        body,
        author: effectiveIdentity(),
        replyTo: state.replyingTo,
      }),
    });
    elements.commentInput.value = '';
    state.replyingTo = null;
    state.focusCommentId = null;
    await loadBoard({ quiet: true });
    const freshTask = state.board.tasks.find((task) => task.id === state.editingId);
    if (freshTask) {
      clearReply(freshTask);
      renderComments(freshTask);
    }
  } catch (error) {
    setError(elements.dialogError, error.message);
  } finally {
    elements.postComment.disabled = false;
  }
}

async function saveTask(event) {
  event.preventDefault();
  setError(elements.dialogError);
  const title = elements.taskTitle.value.trim();
  const plainTitle =
    elements.taskPlainTitle.value.trim() ||
    (title.length > 160 ? `${title.slice(0, 157)}...` : title);
  const payload = {
    title,
    plainTitle,
    purpose: elements.taskPurpose.value,
    goal: elements.taskGoal.value,
    note: elements.taskNote.value,
    owner: elements.taskOwner.value || null,
    tag: elements.taskTag.value,
    status: elements.taskStatus.value,
  };

  try {
    if (state.editingId) {
      await request(`/api/tasks/${encodeURIComponent(state.editingId)}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
    } else {
      await request('/api/tasks', { method: 'POST', body: JSON.stringify(payload) });
    }
    elements.taskDialog.close();
    await loadBoard({ quiet: true });
  } catch (error) {
    setError(elements.dialogError, error.message);
  }
}

elements.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setError(elements.loginError);
  const username = elements.username.value.trim().toLowerCase();
  const password = elements.password.value;
  if (!username || !password) return;
  state.credentials = btoa(`${username}:${password}`);
  localStorage.setItem(CREDENTIALS_KEY, state.credentials);
  await loadBoard();
});

elements.logoutButton.addEventListener('click', logOut);
elements.agentRole.addEventListener('change', () => {
  state.agentRole = elements.agentRole.value;
  localStorage.setItem(AGENT_ROLE_KEY, state.agentRole);
  renderIdentityControls();
  renderMentions();
  const task = state.board.tasks.find((candidate) => candidate.id === state.editingId);
  if (task && elements.taskDialog.open) renderComments(task);
});
elements.showReadMentions.addEventListener('click', () => {
  state.showReadMentions = !state.showReadMentions;
  renderMentions();
});
elements.markAllRead.addEventListener('click', async () => {
  try {
    await markEveryMentionRead();
  } catch (error) {
    showBoardError(error.message);
  }
});
elements.aboutButton.addEventListener('click', async () => {
  try {
    await loadAbout();
    elements.aboutDialog.showModal();
  } catch (error) {
    showBoardError(error.message);
  }
});
elements.aboutClose.addEventListener('click', () => elements.aboutDialog.close());
elements.diagramRetryButton.addEventListener('click', async () => {
  elements.diagramRetryButton.disabled = true;
  elements.diagramRetryButton.textContent = 'Loading…';
  await renderAboutDiagrams(state.aboutData);
  elements.diagramRetryButton.disabled = false;
  elements.diagramRetryButton.textContent = 'Retry diagrams';
});
elements.addTaskButton.addEventListener('click', openAddTask);
elements.refreshButton.addEventListener('click', () =>
  loadBoard({ quiet: true, showLoading: true }),
);
elements.filterMenu.addEventListener('change', (event) => {
  const groups = {
    'status-filter': state.visibleStatuses,
    'team-filter': state.visibleTeams,
  };
  const group = groups[event.target.name];
  if (!group) return;
  if (event.target.checked) group.add(event.target.value);
  else group.delete(event.target.value);
  renderFilters();
  renderActive();
  renderProjects();
});
document.addEventListener('click', (event) => {
  if (elements.filterMenu.open && !elements.filterMenu.contains(event.target)) {
    elements.filterMenu.open = false;
  }
});
elements.displayMenu.addEventListener('change', (event) => {
  if (event.target.name !== 'completed-display') return;
  state.completedDisplay = event.target.value;
  localStorage.setItem(COMPLETED_DISPLAY_KEY, state.completedDisplay);
  renderProjects();
});
elements.dialogClose.addEventListener('click', () => elements.taskDialog.close());
elements.taskDialog.addEventListener('click', (event) => {
  if (event.target === elements.taskDialog) elements.taskDialog.close();
});
elements.cancelTaskButton.addEventListener('click', () => elements.taskDialog.close());
elements.cancelReply.addEventListener('click', () => {
  const task = state.board.tasks.find((candidate) => candidate.id === state.editingId);
  clearReply(task);
});
elements.postComment.addEventListener('click', postComment);
elements.commentInput.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    postComment();
  }
});
elements.taskForm.addEventListener('submit', saveTask);
elements.archiveTaskButton.addEventListener('click', async () => {
  if (!state.editingId) return;
  try {
    await patchTask(state.editingId, { archived: true });
    elements.taskDialog.close();
  } catch (error) {
    setError(elements.dialogError, error.message);
  }
});
elements.claimTaskButton.addEventListener('click', async () => {
  if (!state.editingId) return;
  try {
    await patchTask(state.editingId, {
      owner: state.viewer,
      status: 'in_progress',
    });
    elements.taskDialog.close();
  } catch (error) {
    setError(elements.dialogError, error.message);
  }
});

window.addEventListener('focus', () => {
  if (state.credentials && !elements.boardView.hidden) loadBoard({ quiet: true });
});
window.setInterval(() => {
  if (state.credentials && !elements.boardView.hidden) loadBoard({ quiet: true });
}, 30_000);

if (state.credentials) loadBoard();
else elements.username.focus();

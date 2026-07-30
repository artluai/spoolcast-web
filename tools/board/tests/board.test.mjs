import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { onRequestGet as getAbout } from '../functions/api/about.js';
import { onRequestGet as getBoard, onRequestPut as putBoard } from '../functions/api/board.js';
import { onRequestPost as markAllMentionsRead } from '../functions/api/mentions/read-all.js';
import { onRequestPatch as patchTask } from '../functions/api/tasks/[id].js';
import { onRequestPatch as markCommentRead } from '../functions/api/tasks/[id]/comments/[commentId].js';
import { onRequestPost as postComment } from '../functions/api/tasks/[id]/comments/index.js';
import { onRequestPost as postTask } from '../functions/api/tasks/index.js';
import { parseTasks } from '../seed-lib.mjs';

class MemoryKv {
  constructor() {
    this.values = new Map();
  }

  async get(key, format) {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return format === 'json' ? JSON.parse(value) : value;
  }

  async put(key, value) {
    this.values.set(key, value);
  }
}

function environment() {
  return {
    BOARD: new MemoryKv(),
    BOARD_PASSWORD_RALPH: 'test-ralph-password',
    BOARD_PASSWORD_AGENTS: 'test-agent-password',
    GITHUB_REPO_URL: 'https://github.com/example/spoolcast-web',
  };
}

function request(url, credentials, options = {}) {
  const headers = new Headers(options.headers);
  if (credentials) {
    headers.set('Authorization', `Basic ${Buffer.from(credentials).toString('base64')}`);
  }
  if (options.body) headers.set('Content-Type', 'application/json');
  return new Request(url, { ...options, headers });
}

test('board requires valid credentials and identifies the matching person', async () => {
  const env = environment();
  const unauthorized = await getBoard({
    request: request('http://board.test/api/board'),
    env,
  });
  assert.equal(unauthorized.status, 401);

  const wrongPassword = await getBoard({
    request: request('http://board.test/api/board', 'ralph:wrong'),
    env,
  });
  assert.equal(wrongPassword.status, 401);

  const authorized = await getBoard({
    request: request('http://board.test/api/board', 'ralph:test-ralph-password'),
    env,
  });
  assert.equal(authorized.status, 200);
  assert.equal(authorized.headers.get('X-Board-Identity'), 'Ralph');
  const board = await authorized.json();
  assert.equal(board.updatedAt, new Date(0).toISOString());
  assert.deepEqual(board.tasks, []);
  assert.equal(board.goals.length, 7);
});

test('creating and updating a task attributes each write', async () => {
  const env = environment();
  const createdResponse = await postTask({
    request: request('http://board.test/api/tasks', 'ralph:test-ralph-password', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Decide the credits model',
        tag: 'founder',
        owner: 'Ralph',
      }),
    }),
    env,
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.updatedBy, 'Ralph');
  assert.equal(created.status, 'todo');
  assert.equal(created.goal, 'cloud');

  const updatedResponse = await patchTask({
    request: request(`http://board.test/api/tasks/${created.id}`, 'agents:test-agent-password', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'in_progress', owner: 'Codex' }),
    }),
    env,
    params: { id: created.id },
  });
  assert.equal(updatedResponse.status, 200);
  const updated = await updatedResponse.json();
  assert.equal(updated.updatedBy, 'AI');
  assert.equal(updated.owner, 'Codex');
  assert.equal(updated.status, 'in_progress');
});

test('Fable and Codex can own agent work', async () => {
  const env = environment();
  const response = await postTask({
    request: request('http://board.test/api/tasks', 'agents:test-agent-password', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Design the autopilot failure policy',
        owner: 'Fable',
        tag: 'fable',
        goal: 'autopilot',
      }),
    }),
    env,
  });

  assert.equal(response.status, 201);
  const task = await response.json();
  assert.equal(task.owner, 'Fable');
  assert.equal(task.tag, 'fable');
  assert.equal(task.goal, 'autopilot');
  assert.equal(task.updatedBy, 'AI');
});

test('invalid task changes are rejected', async () => {
  const env = environment();
  const response = await postTask({
    request: request('http://board.test/api/tasks', 'ralph:test-ralph-password', {
      method: 'POST',
      body: JSON.stringify({ title: 'Invalid owner', owner: 'Kimi' }),
    }),
    env,
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /owner must be one of/);
});

test('comments support agent identity, replies, mentions, and read state', async () => {
  const env = environment();
  const createdResponse = await postTask({
    request: request('http://board.test/api/tasks', 'ralph:test-ralph-password', {
      method: 'POST',
      body: JSON.stringify({ title: 'Review the roadmap' }),
    }),
    env,
  });
  const task = await createdResponse.json();

  const missingAgentIdentity = await postComment({
    request: request(
      `http://board.test/api/tasks/${task.id}/comments`,
      'agents:test-agent-password',
      {
        method: 'POST',
        body: JSON.stringify({ body: 'Starting this work.' }),
      },
    ),
    env,
    params: { id: task.id },
  });
  assert.equal(missingAgentIdentity.status, 400);

  const firstResponse = await postComment({
    request: request(
      `http://board.test/api/tasks/${task.id}/comments`,
      'agents:test-agent-password',
      {
        method: 'POST',
        body: JSON.stringify({
          author: 'Codex',
          body: '@Fable Please review the implementation.',
        }),
      },
    ),
    env,
    params: { id: task.id },
  });
  assert.equal(firstResponse.status, 201);
  const first = await firstResponse.json();
  assert.equal(first.author, 'Codex');
  assert.deepEqual(first.mentions, ['Fable']);
  assert.deepEqual(first.readBy, ['Codex']);

  const agentReplyResponse = await postComment({
    request: request(
      `http://board.test/api/tasks/${task.id}/comments`,
      'agents:test-agent-password',
      {
        method: 'POST',
        body: JSON.stringify({
          body: 'Reviewed. The implementation is ready.',
          author: 'Fable',
          replyTo: first.id,
        }),
      },
    ),
    env,
    params: { id: task.id },
  });
  assert.equal(agentReplyResponse.status, 201);
  const agentReply = await agentReplyResponse.json();
  assert.equal(agentReply.author, 'Fable');
  assert.equal(agentReply.replyTo, first.id);
  assert.deepEqual(agentReply.mentions, ['Codex']);

  const humanReplyResponse = await postComment({
    request: request(
      `http://board.test/api/tasks/${task.id}/comments`,
      'ralph:test-ralph-password',
      {
        method: 'POST',
        body: JSON.stringify({
          body: 'Reviewed. One detail needs attention.',
          author: 'Fable',
          replyTo: first.id,
        }),
      },
    ),
    env,
    params: { id: task.id },
  });
  assert.equal(humanReplyResponse.status, 201);
  const humanReply = await humanReplyResponse.json();
  assert.equal(humanReply.author, 'Ralph');
  assert.equal(humanReply.replyTo, first.id);
  assert.deepEqual(humanReply.mentions, ['Codex']);

  const readResponse = await markCommentRead({
    request: request(
      `http://board.test/api/tasks/${task.id}/comments/${first.id}`,
      'ralph:test-ralph-password',
      {
        method: 'PATCH',
        body: JSON.stringify({ read: true, identity: 'Fable' }),
      },
    ),
    env,
    params: { id: task.id, commentId: first.id },
  });
  assert.equal(readResponse.status, 200);
  assert.ok((await readResponse.json()).readBy.includes('Ralph'));

  const markAllResponse = await markAllMentionsRead({
    request: request('http://board.test/api/mentions/read-all', 'agents:test-agent-password', {
      method: 'POST',
      body: JSON.stringify({ identity: 'Fable' }),
    }),
    env,
  });
  assert.equal(markAllResponse.status, 200);
  assert.equal((await markAllResponse.json()).marked, 1);

  const boardResponse = await getBoard({
    request: request('http://board.test/api/board', 'agents:test-agent-password'),
    env,
  });
  const board = await boardResponse.json();
  assert.equal(board.tasks[0].comments.length, 3);
  assert.ok(board.tasks[0].comments[0].readBy.includes('Fable'));
});

test('only the agents account can replace the board during initial seeding', async () => {
  const env = environment();
  const completeTitle = `Render worker: ${'complete technical detail '.repeat(8)}`.trim();
  const payload = {
    tasks: [{ id: 't_seeded', title: completeTitle, status: 'done', tag: 'fable' }],
  };

  const forbidden = await putBoard({
    request: request('http://board.test/api/board', 'ralph:test-ralph-password', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
    env,
  });
  assert.equal(forbidden.status, 403);

  const seeded = await putBoard({
    request: request('http://board.test/api/board', 'agents:test-agent-password', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
    env,
  });
  assert.equal(seeded.status, 200);
  const board = await seeded.json();
  assert.equal(board.tasks[0].id, 't_seeded');
  assert.equal(board.tasks[0].title, completeTitle);
  assert.ok(board.tasks[0].plainTitle.length <= 160);
  assert.equal(board.tasks[0].updatedBy, 'AI');
});

test('About content is private and supplies configured repository links', async () => {
  const env = environment();
  const unauthorized = await getAbout({
    request: request('http://board.test/api/about'),
    env,
  });
  assert.equal(unauthorized.status, 401);

  const authorized = await getAbout({
    request: request('http://board.test/api/about', 'agents:test-agent-password'),
    env,
  });
  const about = await authorized.json();
  assert.equal(about.links.length, 3);
  assert.match(about.summary, /turns writing into television/);
  assert.match(about.summary, /credits/);
  assert.match(about.architecture, /Editor/);
  assert.match(about.pipeline, /World kit/);
});

test('TASKS parser preserves order, status, and recommendation labels', async () => {
  const taskPath = fileURLToPath(new URL('../../../docs/TASKS.md', import.meta.url));
  const markdown = await readFile(taskPath, 'utf8');
  const tasks = parseTasks(markdown);

  assert.ok(tasks.length >= 20);
  assert.equal(tasks[0].goal, 'cloud');
  assert.equal(tasks[0].status, 'done');
  assert.equal(tasks[0].tag, 'fable');
  assert.equal(tasks[0].owner, 'Fable');
  assert.ok(tasks.every((task) => task.plainTitle.length > 0 && task.plainTitle.length <= 160));
  assert.ok(tasks.every((task) => task.purpose.length > 20));
  assert.ok(
    tasks.every((task) => (task.status === 'todo' ? task.owner === null : task.owner !== null)),
  );
  assert.ok(tasks.some((task) => task.status === 'in_progress'));
  assert.ok(tasks.some((task) => task.tag === 'codex' && task.status === 'todo'));
  assert.ok(tasks.some((task) => task.tag === 'founder'));
  for (const goal of ['cloud', 'editor', 'ingest', 'autopilot', 'show', 'money', 'founder']) {
    assert.ok(
      tasks.some((task) => task.goal === goal),
      `expected at least one task for goal ${goal}`,
    );
  }

  const renderWorker = tasks.find((task) => task.title.startsWith('Remotion render worker'));
  assert.ok(renderWorker);
  assert.match(renderWorker.title, /Node and Chromium/);
  assert.equal(renderWorker.goal, 'cloud');
  assert.equal(renderWorker.owner, null);
  assert.equal(renderWorker.note, '');
});

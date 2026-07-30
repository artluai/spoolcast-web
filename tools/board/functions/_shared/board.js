import { ApiError } from './http.js';
import { goalIds } from './goals.js';

export const statuses = ['todo', 'in_progress', 'done'];
export const owners = ['Ralph', 'Fable', 'Codex'];
export const tags = ['fable', 'codex', 'founder'];
export const commentIdentities = ['Ralph', 'Fable', 'Codex'];

export function emptyBoard() {
  return {
    updatedAt: new Date(0).toISOString(),
    tasks: [],
  };
}

export async function readBoard(env) {
  if (!env.BOARD || typeof env.BOARD.get !== 'function') {
    throw new ApiError(500, 'The BOARD KV binding is not configured.');
  }

  const stored = await env.BOARD.get('board', 'json');
  if (!stored) return emptyBoard();
  if (!Array.isArray(stored.tasks) || typeof stored.updatedAt !== 'string') {
    throw new ApiError(500, 'The stored board data is invalid.');
  }
  return stored;
}

export async function writeBoard(env, board) {
  board.updatedAt = new Date().toISOString();
  await env.BOARD.put('board', JSON.stringify(board));
  return board;
}

function stringValue(value, field, { required = false, maximum = 2000 } = {}) {
  if (value === null || value === undefined) {
    if (required) throw new ApiError(400, `${field} is required.`);
    return '';
  }
  if (typeof value !== 'string') throw new ApiError(400, `${field} must be text.`);
  const clean = value.trim();
  if (required && !clean) throw new ApiError(400, `${field} is required.`);
  if (clean.length > maximum) {
    throw new ApiError(400, `${field} must be ${maximum} characters or fewer.`);
  }
  return clean;
}

function enumValue(value, field, allowed, { nullable = false } = {}) {
  if (nullable && (value === null || value === '')) return null;
  if (!allowed.includes(value)) {
    throw new ApiError(400, `${field} must be one of: ${allowed.join(', ')}.`);
  }
  return value;
}

function booleanValue(value, field) {
  if (typeof value !== 'boolean') throw new ApiError(400, `${field} must be true or false.`);
  return value;
}

function taskId() {
  return `t_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function commentId() {
  return `c_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function mentionedIdentities(body) {
  const mentions = new Set();
  for (const match of body.matchAll(/(?:^|\s)@(Ralph|Fable|Codex)\b/gi)) {
    const identity = commentIdentities.find(
      (candidate) => candidate.toLowerCase() === match[1].toLowerCase(),
    );
    if (identity) mentions.add(identity);
  }
  return [...mentions];
}

export function resolveCommentIdentity(authIdentity, requestedIdentity) {
  if (authIdentity !== 'AI') return authIdentity;
  return enumValue(requestedIdentity, 'author', ['Fable', 'Codex']);
}

export function createComment(task, input, author) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ApiError(400, 'Comment data must be an object.');
  }

  const comments = Array.isArray(task.comments) ? task.comments : [];
  if (comments.length >= 500) throw new ApiError(400, 'A task cannot exceed 500 comments.');

  const body = stringValue(input.body, 'body', { required: true, maximum: 2000 });
  let replyTo = null;
  let replyTarget = null;
  if (input.replyTo !== null && input.replyTo !== undefined && input.replyTo !== '') {
    if (typeof input.replyTo !== 'string') throw new ApiError(400, 'replyTo must be text.');
    replyTarget = comments.find((comment) => comment.id === input.replyTo);
    if (!replyTarget) throw new ApiError(400, 'The comment being replied to was not found.');
    replyTo = replyTarget.replyTo || replyTarget.id;
  }

  const mentions = new Set(mentionedIdentities(body));
  if (replyTarget?.author && replyTarget.author !== author) mentions.add(replyTarget.author);
  mentions.delete(author);

  const comment = {
    id: commentId(),
    body,
    author,
    createdAt: new Date().toISOString(),
    replyTo,
    mentions: [...mentions],
    readBy: [author],
  };

  task.comments = [...comments, comment];
  task.updatedAt = comment.createdAt;
  task.updatedBy = author;
  return comment;
}

export function markCommentRead(task, commentIdValue, identity) {
  const comments = Array.isArray(task.comments) ? task.comments : [];
  const comment = comments.find((candidate) => candidate.id === commentIdValue);
  if (!comment) throw new ApiError(404, 'Comment not found.');
  const readBy = Array.isArray(comment.readBy) ? comment.readBy : [];
  if (!readBy.includes(identity)) comment.readBy = [...readBy, identity];
  return comment;
}

export function markAllMentionsRead(board, identity) {
  let marked = 0;
  for (const task of board.tasks) {
    for (const comment of Array.isArray(task.comments) ? task.comments : []) {
      if (
        Array.isArray(comment.mentions) &&
        comment.mentions.includes(identity) &&
        !(Array.isArray(comment.readBy) && comment.readBy.includes(identity))
      ) {
        comment.readBy = [...(Array.isArray(comment.readBy) ? comment.readBy : []), identity];
        marked += 1;
      }
    }
  }
  return marked;
}

export function createTask(input, identity) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ApiError(400, 'Task data must be an object.');
  }

  const now = new Date().toISOString();
  const title = stringValue(input.title, 'title', { required: true, maximum: 500 });
  const defaultPlainTitle = title.length > 160 ? `${title.slice(0, 157)}...` : title;
  return {
    id: taskId(),
    title,
    plainTitle: stringValue(input.plainTitle ?? defaultPlainTitle, 'plainTitle', {
      required: true,
      maximum: 160,
    }),
    purpose: stringValue(input.purpose, 'purpose', { maximum: 500 }),
    goal: enumValue(input.goal ?? 'cloud', 'goal', goalIds),
    note: stringValue(input.note, 'note'),
    status: enumValue(input.status ?? 'todo', 'status', statuses),
    owner: enumValue(input.owner ?? null, 'owner', owners, { nullable: true }),
    tag: enumValue(input.tag ?? 'founder', 'tag', tags),
    archived: false,
    comments: [],
    updatedAt: now,
    updatedBy: identity,
  };
}

export function patchTask(task, input, identity) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ApiError(400, 'Task changes must be an object.');
  }

  const allowedFields = new Set([
    'title',
    'plainTitle',
    'purpose',
    'goal',
    'status',
    'owner',
    'note',
    'tag',
    'archived',
  ]);
  const fields = Object.keys(input);
  if (fields.length === 0) throw new ApiError(400, 'Provide at least one task change.');

  for (const field of fields) {
    if (!allowedFields.has(field)) throw new ApiError(400, `${field} cannot be changed.`);
  }

  const updated = { ...task };
  if ('title' in input) {
    updated.title = stringValue(input.title, 'title', { required: true, maximum: 500 });
  }
  if ('plainTitle' in input) {
    updated.plainTitle = stringValue(input.plainTitle, 'plainTitle', {
      required: true,
      maximum: 160,
    });
  }
  if ('purpose' in input) {
    updated.purpose = stringValue(input.purpose, 'purpose', { maximum: 500 });
  }
  if ('goal' in input) updated.goal = enumValue(input.goal, 'goal', goalIds);
  if ('status' in input) updated.status = enumValue(input.status, 'status', statuses);
  if ('owner' in input) {
    updated.owner = enumValue(input.owner, 'owner', owners, { nullable: true });
  }
  if ('note' in input) updated.note = stringValue(input.note, 'note');
  if ('tag' in input) updated.tag = enumValue(input.tag, 'tag', tags);
  if ('archived' in input) updated.archived = booleanValue(input.archived, 'archived');
  updated.updatedAt = new Date().toISOString();
  updated.updatedBy = identity;
  return updated;
}

export function validateSeedTasks(input, identity) {
  if (!input || !Array.isArray(input.tasks)) {
    throw new ApiError(400, 'Seed data must contain a tasks array.');
  }
  if (input.tasks.length > 500) throw new ApiError(400, 'Seed data cannot exceed 500 tasks.');

  return input.tasks.map((task) => {
    const created = createTask(task, identity);
    if (typeof task.id === 'string' && /^t_[a-zA-Z0-9_-]{3,64}$/.test(task.id)) {
      created.id = task.id;
    }
    return created;
  });
}

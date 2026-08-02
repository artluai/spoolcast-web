import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseTasks } from './seed-lib.mjs';

const taskFile = fileURLToPath(new URL('../../docs/TASKS.md', import.meta.url));

export async function seedBoard({
  boardUrl = process.env.BOARD_URL,
  username = process.env.BOARD_USERNAME || 'agents',
  password = process.env.BOARD_PASSWORD || process.env.BOARD_PASSWORD_AGENTS,
  dryRun = process.argv.includes('--dry-run'),
} = {}) {
  const markdown = await readFile(taskFile, 'utf8');
  const tasks = parseTasks(markdown);

  if (dryRun) {
    process.stdout.write(`${JSON.stringify({ taskCount: tasks.length, tasks }, null, 2)}\n`);
    return { taskCount: tasks.length, dryRun: true };
  }

  if (!boardUrl) throw new Error('Set BOARD_URL to the deployed or local board address.');
  if (!password) throw new Error('Set BOARD_PASSWORD to the agent board password.');

  // The live board is the source of truth and was seeded once on 2026-08-01. Seeding REPLACES
  // the whole board, wiping every status, owner, and discussion. Local dev KV only.
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(boardUrl)) {
    throw new Error(
      'Refusing to seed a non-local board: the live board is the source of truth and seeding wipes it. Use the board API to add or update tasks instead.',
    );
  }
  if (tasks.length === 0) {
    throw new Error('Parsed 0 tasks (docs/TASKS.md is now only a pointer to the board); refusing to seed an empty board.');
  }

  const response = await fetch(`${boardUrl.replace(/\/+$/, '')}/api/board`, {
    method: 'PUT',
    headers: {
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ tasks }),
  });
  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || `Seed request failed (${response.status}).`);
  }

  process.stdout.write(`Seeded ${result.tasks.length} tasks into ${boardUrl}.\n`);
  return { taskCount: result.tasks.length, dryRun: false };
}

const isDirectRun =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`));

if (isDirectRun) {
  seedBoard().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

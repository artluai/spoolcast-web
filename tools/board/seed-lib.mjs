import { createHash } from 'node:crypto';

const statusMap = {
  ' ': 'todo',
  '~': 'in_progress',
  x: 'done',
  X: 'done',
};

const roleTags = {
  FABLE: 'fable',
  CODEX: 'codex',
  RALPH: 'founder',
};

const roleOwners = {
  FABLE: 'Fable',
  CODEX: 'Codex',
  RALPH: 'Ralph',
};

function cleanText(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function stableId(title, lineNumber) {
  const hash = createHash('sha256').update(`${lineNumber}:${title}`).digest('hex').slice(0, 12);
  return `t_${hash}`;
}

function finishTask(current, records) {
  if (!current) return;
  const title = cleanText(current.titleParts.join(' '));
  const status = statusMap[current.marker];
  records.push({
    id: stableId(title, current.lineNumber),
    title,
    plainTitle: current.plain || (title.length > 160 ? `${title.slice(0, 157)}...` : title),
    purpose: current.why || '',
    goal: current.goal,
    note: '',
    status,
    owner: status === 'todo' ? null : roleOwners[current.role] || null,
    tag: roleTags[current.role] || 'founder',
    archived: false,
  });
}

export function parseTasks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const records = [];
  let goal = null;
  let current = null;

  lines.forEach((line, index) => {
    const goalHeading = line.match(/^##\s+.*\(goal:\s*([a-z]+)\)\s*$/);
    if (goalHeading) {
      finishTask(current, records);
      current = null;
      goal = goalHeading[1];
      return;
    }

    if (/^##?\s+/.test(line)) {
      finishTask(current, records);
      current = null;
      goal = null;
      return;
    }

    const checkbox = line.match(
      /^-\s+\[([ ~xX])\]\s+(?:\*\*\[(FABLE|CODEX|RALPH)\]\*\*\s+)?(.+)$/,
    );
    if (checkbox && goal) {
      finishTask(current, records);
      current = {
        marker: checkbox[1],
        role: checkbox[2] || null,
        titleParts: [checkbox[3]],
        goal,
        lineNumber: index + 1,
        plain: '',
        why: '',
      };
      return;
    }

    if (!current) return;

    const detail = line.match(/^\s{2,}-\s+(plain|why):\s+(.+)$/);
    if (detail) {
      current[detail[1]] = cleanText(detail[2]);
      return;
    }

    if (/^\s{2,}\S/.test(line) && !/^\s*-\s/.test(line)) {
      current.titleParts.push(line.trim());
      return;
    }

    if (line.trim() === '') {
      finishTask(current, records);
      current = null;
    }
  });

  finishTask(current, records);
  return records;
}

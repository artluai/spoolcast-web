import { authenticate } from '../../_shared/auth.js';
import { createTask, readBoard, writeBoard } from '../../_shared/board.js';
import { errorResponse, json, readJson } from '../../_shared/http.js';

export async function onRequestPost(context) {
  const auth = await authenticate(context.request, context.env);
  if (auth.response) return auth.response;

  try {
    const input = await readJson(context.request);
    const board = await readBoard(context.env);
    const task = createTask(input, auth.identity);
    board.tasks.push(task);
    await writeBoard(context.env, board);
    return json(task, 201, {
      Location: `/api/tasks/${task.id}`,
      'X-Board-Identity': auth.identity,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

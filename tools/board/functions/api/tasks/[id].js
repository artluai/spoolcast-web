import { authenticate } from '../../_shared/auth.js';
import { patchTask, readBoard, writeBoard } from '../../_shared/board.js';
import { ApiError, errorResponse, json, readJson } from '../../_shared/http.js';

export async function onRequestPatch(context) {
  const auth = await authenticate(context.request, context.env);
  if (auth.response) return auth.response;

  try {
    const input = await readJson(context.request);
    const board = await readBoard(context.env);
    const index = board.tasks.findIndex((task) => task.id === context.params.id);
    if (index === -1) throw new ApiError(404, 'Task not found.');

    const task = patchTask(board.tasks[index], input, auth.identity);
    board.tasks[index] = task;
    await writeBoard(context.env, board);
    return json(task, 200, { 'X-Board-Identity': auth.identity });
  } catch (error) {
    return errorResponse(error);
  }
}

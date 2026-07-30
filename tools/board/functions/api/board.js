import { authenticate } from '../_shared/auth.js';
import { readBoard, validateSeedTasks, writeBoard } from '../_shared/board.js';
import { ApiError, errorResponse, json, readJson } from '../_shared/http.js';
import { goalDefinitions } from '../_shared/goals.js';

export async function onRequestGet(context) {
  const auth = await authenticate(context.request, context.env);
  if (auth.response) return auth.response;

  try {
    const board = await readBoard(context.env);
    return json({ ...board, goals: goalDefinitions }, 200, {
      'X-Board-Identity': auth.identity,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function onRequestPut(context) {
  const auth = await authenticate(context.request, context.env);
  if (auth.response) return auth.response;
  if (auth.identity !== 'AI') {
    return errorResponse(new ApiError(403, 'Only the AI setup token can seed the board.'));
  }

  try {
    const input = await readJson(context.request);
    const tasks = validateSeedTasks(input, auth.identity);
    const board = await writeBoard(context.env, {
      updatedAt: new Date().toISOString(),
      tasks,
    });
    return json(board, 200, { 'X-Board-Identity': auth.identity });
  } catch (error) {
    return errorResponse(error);
  }
}

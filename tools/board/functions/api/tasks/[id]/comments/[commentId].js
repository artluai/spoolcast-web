import { authenticate } from '../../../../_shared/auth.js';
import {
  markCommentRead,
  readBoard,
  resolveCommentIdentity,
  writeBoard,
} from '../../../../_shared/board.js';
import { ApiError, errorResponse, json, readJson } from '../../../../_shared/http.js';

export async function onRequestPatch(context) {
  const auth = await authenticate(context.request, context.env);
  if (auth.response) return auth.response;

  try {
    const input = await readJson(context.request);
    if (input.read !== true) throw new ApiError(400, 'Only read: true is supported.');
    const identity = resolveCommentIdentity(auth.identity, input.identity);
    const board = await readBoard(context.env);
    const task = board.tasks.find((candidate) => candidate.id === context.params.id);
    if (!task) throw new ApiError(404, 'Task not found.');

    const comment = markCommentRead(task, context.params.commentId, identity);
    await writeBoard(context.env, board);
    return json(comment, 200, { 'X-Board-Identity': identity });
  } catch (error) {
    return errorResponse(error);
  }
}

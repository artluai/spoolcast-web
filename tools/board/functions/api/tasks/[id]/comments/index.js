import { authenticate } from '../../../../_shared/auth.js';
import {
  createComment,
  readBoard,
  resolveCommentIdentity,
  writeBoard,
} from '../../../../_shared/board.js';
import { ApiError, errorResponse, json, readJson } from '../../../../_shared/http.js';

export async function onRequestPost(context) {
  const auth = await authenticate(context.request, context.env);
  if (auth.response) return auth.response;

  try {
    const input = await readJson(context.request);
    const author = resolveCommentIdentity(auth.identity, input.author);
    const board = await readBoard(context.env);
    const task = board.tasks.find((candidate) => candidate.id === context.params.id);
    if (!task) throw new ApiError(404, 'Task not found.');

    const comment = createComment(task, input, author);
    await writeBoard(context.env, board);
    return json(comment, 201, {
      Location: `/api/tasks/${task.id}/comments/${comment.id}`,
      'X-Board-Identity': author,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

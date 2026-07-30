import { authenticate } from '../../_shared/auth.js';
import {
  markAllMentionsRead,
  readBoard,
  resolveCommentIdentity,
  writeBoard,
} from '../../_shared/board.js';
import { errorResponse, json, readJson } from '../../_shared/http.js';

export async function onRequestPost(context) {
  const auth = await authenticate(context.request, context.env);
  if (auth.response) return auth.response;

  try {
    const input = await readJson(context.request);
    const identity = resolveCommentIdentity(auth.identity, input.identity);
    const board = await readBoard(context.env);
    const marked = markAllMentionsRead(board, identity);
    await writeBoard(context.env, board);
    return json({ marked }, 200, { 'X-Board-Identity': identity });
  } catch (error) {
    return errorResponse(error);
  }
}

export type StageDraftSaveRequest = {
  action: 'set_stage_output'
  stage_id: string
  path: string
  content: string
}

type StageDraftSaveResponse = {
  ok?: boolean
  data?: { content?: string }
  error?: string
  message?: string
} | null

export type StageDraftSaveResult = {
  ok: boolean
  skipped: boolean
  content?: string
  error?: string
}

/**
 * The browser draft must become engine truth before an AI action reads it.
 * A failed or unconfirmed save is a hard stop: callers must not start the AI.
 */
export async function saveStageDraftBeforeAI({
  dirty,
  stageId,
  path,
  content,
  save,
}: {
  dirty: boolean
  stageId: string
  path: string
  content: string
  save: (request: StageDraftSaveRequest) => Promise<StageDraftSaveResponse>
}): Promise<StageDraftSaveResult> {
  if (!dirty) return { ok: true, skipped: true }

  let response: StageDraftSaveResponse
  try {
    response = await save({
      action: 'set_stage_output',
      stage_id: stageId,
      path,
      content,
    })
  } catch {
    return { ok: false, skipped: false, error: 'Could not reach the engine to save your edits.' }
  }

  if (response?.ok !== true) {
    return {
      ok: false,
      skipped: false,
      error: response?.message || response?.error || 'The engine did not confirm that your edits were saved.',
    }
  }

  return {
    ok: true,
    skipped: false,
    ...(typeof response.data?.content === 'string' ? { content: response.data.content } : {}),
  }
}

import assert from 'node:assert/strict'
import test from 'node:test'
import { saveStageDraftBeforeAI } from '../src/lib/save-before-ai.ts'

test('saves the exact pending draft before an AI action may continue', async () => {
  const calls: unknown[] = []
  const result = await saveStageDraftBeforeAI({
    dirty: true,
    stageId: 'world_kit',
    path: 'working/world-kit.md',
    content: 'black sole only',
    save: async (request) => {
      calls.push(request)
      return { ok: true, data: { content: request.content } }
    },
  })

  assert.deepEqual(calls, [{
    action: 'set_stage_output',
    stage_id: 'world_kit',
    path: 'working/world-kit.md',
    content: 'black sole only',
  }])
  assert.deepEqual(result, { ok: true, skipped: false, content: 'black sole only' })
})

test('returns a hard failure when the engine does not confirm the save', async () => {
  const result = await saveStageDraftBeforeAI({
    dirty: true,
    stageId: 'structure',
    path: 'working/structure.md',
    content: 'new structure',
    save: async () => ({ ok: false, error: 'mirror conflict' }),
  })

  assert.deepEqual(result, {
    ok: false,
    skipped: false,
    error: 'mirror conflict',
  })
})

test('does not write when the browser has no pending edit', async () => {
  let writes = 0
  const result = await saveStageDraftBeforeAI({
    dirty: false,
    stageId: 'visual_pacing',
    path: 'working/visual-pacing-plan.md',
    content: 'already saved',
    save: async () => {
      writes += 1
      return { ok: true }
    },
  })

  assert.equal(writes, 0)
  assert.deepEqual(result, { ok: true, skipped: true })
})

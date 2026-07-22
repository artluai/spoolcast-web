import { create } from 'zustand'
import type * as React from 'react'

// UNSAVED DRAFTS SURVIVE REFRESH. The header says "auto-saved"; before this,
// stageDrafts lived only in memory and a refresh silently discarded every
// unsaved edit (audio prompts included). Drafts now mirror to localStorage
// per session and hydrate on load. Engine saves still happen explicitly.
const draftsStorageKey = () => {
  const m = /\/p\/([^/]+)/.exec(window.location.pathname)
  return `spoolcast-drafts:${m?.[1] ?? 'none'}`
}

const readPersistedDrafts = (): { stageDrafts: Record<string, string>; dirtySteps: Record<string, boolean> } => {
  try {
    const raw = window.localStorage.getItem(draftsStorageKey())
    if (!raw) return { stageDrafts: {}, dirtySteps: {} }
    const parsed = JSON.parse(raw)
    return {
      stageDrafts: parsed?.stageDrafts && typeof parsed.stageDrafts === 'object' ? parsed.stageDrafts : {},
      dirtySteps: parsed?.dirtySteps && typeof parsed.dirtySteps === 'object' ? parsed.dirtySteps : {},
    }
  } catch {
    return { stageDrafts: {}, dirtySteps: {} }
  }
}

let persistTimer = 0
const persistDrafts = (stageDrafts: Record<string, string>, dirtySteps: Record<string, boolean>) => {
  window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => {
    try {
      window.localStorage.setItem(draftsStorageKey(), JSON.stringify({ stageDrafts, dirtySteps }))
    } catch {
      /* storage full/blocked — in-memory drafts still work this session */
    }
  }, 400)
}

// text = the ACTIVE core message (what saves to session.json). ownText = the
// user's own draft, stashed while an AI candidate is active or skip is on, so
// browsing candidates never destroys what they wrote — switching back to
// "Write your own" restores it.
export type Goal = { text: string; mode: '' | 'ai' | 'skip'; ownText?: string }
export type S1 = {
  narrator: string
  style: string
  output: string
  length: number
  projectId: string
  editing: string
  // 'video' | 'image' | 'mix' — how every shot is made. A cost decision (video
  // generation far outprices stills) that also sets each clip's legal duration
  // downstream, so it belongs here at Step 1 rather than at generation.
  // '' means unset: the engine falls back to the template's normal.
  medium: string
}

export type FinalRenderState = 'idle' | 'rendering' | 'done' | 'failed' | 'stale'

type Drafts = { ideaBrief: string; goal: Goal; s1: S1 }
export type StageProcess = {
  stageId: string
  jobId?: string
  status: 'queued' | 'running' | 'done' | 'failed'
  label: string
  error?: string | null
  message?: string | null
  updatedAt?: string
}

interface WorkflowStore extends Drafts {
  dirtySteps: Record<string, boolean>
  // Drafted stage-output content (structure, world kit, visual pacing, ...),
  // keyed by engine stage id. Persisted to the engine via set_stage_output.
  stageDrafts: Record<string, string>
  stageProcesses: Record<string, StageProcess>
  setIdeaBrief: (stepId: string, v: React.SetStateAction<string>) => void
  setGoal: (stepId: string, v: React.SetStateAction<Goal>) => void
  setS1: (stepId: string, v: React.SetStateAction<S1>) => void
  setStageDraft: (stageId: string, v: string) => void
  seedStageDraft: (stageId: string, v: string) => void // prefill from disk WITHOUT marking dirty
  // Multi-file stages (screenplay): drafts stored under a composite key while
  // dirty is still tracked under the real stage id.
  setStageFileDraft: (stageId: string, key: string, v: string) => void
  seedStageFileDraft: (key: string, v: string) => void
  seedDrafts: (d: Partial<Drafts>) => void // initialize from seed WITHOUT marking dirty
  clearDirty: (stepId: string) => void
  isStepDirty: (stepId: string) => boolean
  // AI HAND-OFF in flight: the step it's preparing shows a waiting state and
  // is locked until the draft lands.
  handoff: { stageId: string; label: string } | null
  setHandoff: (h: { stageId: string; label: string } | null) => void
  // Final cut's compile/export state. Lives here (not component state) so the
  // step footer can gate Save/Autopilot on it and it survives step navigation.
  // 'stale' = a compile finished, but the visuals/timing changed afterwards —
  // the video no longer matches and must be re-compiled (ROADMAP item 9).
  finalRender: FinalRenderState
  setFinalRender: (state: FinalRenderState) => void
  // Why the last compile failed — in the store (not component state) so the
  // explanation survives navigation/remounts as long as the failure does.
  finalRenderError: string | null
  setFinalRenderError: (error: string | null) => void
  // Called by anything that changes what the render consumes (regenerated
  // visuals, re-synced audio timing): a finished compile becomes stale.
  staleFinalRender: () => void
  setStageProcess: (stageId: string, process: StageProcess | null) => void
  // Drop cached drafts for a stage so the editor reloads fresh engine content.
  clearStageDrafts: (stageId: string) => void
  // A step editor can expose its undo/redo to the step header. null = no
  // history available on the active step.
  stepUndo: { count: number; run: () => void; redoCount?: number; redo?: () => void } | null
  setStepUndo: (u: { count: number; run: () => void; redoCount?: number; redo?: () => void } | null) => void
  // A step can register work that rides on "Save and continue" (e.g. step 7
  // compiles the shot list + builds generation prompts on the way out).
  advanceHook: (() => void) | null
  setAdvanceHook: (fn: (() => void) | null) => void
  // Everything in this store belongs to ONE session. Switching the route to a
  // different session must drop it all — a draft leaking across sessions would
  // be written into the wrong project's files.
  resetSession: () => void
}

const resolve = <T,>(action: React.SetStateAction<T>, prev: T): T =>
  typeof action === 'function' ? (action as (p: T) => T)(prev) : action

export const useWorkflowStore = create<WorkflowStore>()((set, get) => ({
  ideaBrief: '',
  goal: { text: '', mode: '' },
  s1: {
    narrator: '',
    style: '',
    output: '',
    length: 120,
    projectId: 'untitled-01',
    editing: '',
    medium: '',
  },
  dirtySteps: readPersistedDrafts().dirtySteps,
  stageDrafts: readPersistedDrafts().stageDrafts,
  stageProcesses: {},
  setStageDraft: (stageId, v) =>
    set((state) => {
      const stageDrafts = { ...state.stageDrafts, [stageId]: v }
      const dirtySteps = { ...state.dirtySteps, [stageId]: true }
      persistDrafts(stageDrafts, dirtySteps)
      return { stageDrafts, dirtySteps }
    }),
  seedStageDraft: (stageId, v) =>
    set((state) => ({
      stageDrafts: { ...state.stageDrafts, [stageId]: v },
    })),
  setStageFileDraft: (stageId, key, v) =>
    set((state) => {
      const stageDrafts = { ...state.stageDrafts, [key]: v }
      const dirtySteps = { ...state.dirtySteps, [stageId]: true }
      persistDrafts(stageDrafts, dirtySteps)
      return { stageDrafts, dirtySteps }
    }),
  seedStageFileDraft: (key, v) =>
    set((state) => ({
      stageDrafts: { ...state.stageDrafts, [key]: v },
    })),
  setIdeaBrief: (stepId, v) =>
    set((state) => ({
      ideaBrief: resolve(v, state.ideaBrief),
      dirtySteps: { ...state.dirtySteps, [stepId]: true },
    })),
  setGoal: (stepId, v) =>
    set((state) => ({
      goal: resolve(v, state.goal),
      dirtySteps: { ...state.dirtySteps, [stepId]: true },
    })),
  setS1: (stepId, v) =>
    set((state) => ({
      s1: resolve(v, state.s1),
      dirtySteps: { ...state.dirtySteps, [stepId]: true },
    })),
  seedDrafts: (d) => set(() => ({ ...d })),
  clearDirty: (stepId) =>
    set((state) => ({ dirtySteps: { ...state.dirtySteps, [stepId]: false } })),
  isStepDirty: (stepId) => Boolean(get().dirtySteps[stepId]),
  handoff: null,
  setHandoff: (h) => set(() => ({ handoff: h })),
  finalRender: 'idle',
  setFinalRender: (finalRender) => set(() => ({ finalRender })),
  finalRenderError: null,
  setFinalRenderError: (finalRenderError) => set(() => ({ finalRenderError })),
  staleFinalRender: () =>
    set((state) => (state.finalRender === 'done' ? { finalRender: 'stale' as const } : {})),
  setStageProcess: (stageId, process) =>
    set((state) => {
      const next = { ...state.stageProcesses }
      if (process) next[stageId] = process
      else delete next[stageId]
      return { stageProcesses: next }
    }),
  stepUndo: null,
  setStepUndo: (u) => set(() => ({ stepUndo: u })),
  advanceHook: null,
  setAdvanceHook: (fn) => set(() => ({ advanceHook: fn })),
  resetSession: () => {
    try { window.localStorage.removeItem(draftsStorageKey()) } catch { /* fine */ }
    return set(() => ({
      ideaBrief: '',
      goal: { text: '', mode: '' },
      s1: { narrator: '', style: '', output: '', length: 120, projectId: 'untitled-01', editing: '', medium: '' },
      dirtySteps: {},
      stageDrafts: {},
      stageProcesses: {},
      handoff: null,
      finalRender: 'idle' as const,
      finalRenderError: null,
      stepUndo: null,
    }))
  },
  clearStageDrafts: (stageId) =>
    set((state) => {
      const stageDrafts = Object.fromEntries(
        Object.entries(state.stageDrafts).filter(
          ([k]) => k !== stageId && !k.startsWith(`${stageId}:`),
        ),
      )
      const dirtySteps = { ...state.dirtySteps, [stageId]: false }
      // SYNCHRONOUS write, no debounce: callers clear drafts right before
      // window.location.reload(), and a pending 400ms timer dies with the
      // page — the stale draft would then outlive the reload and shadow the
      // freshly updated file forever.
      window.clearTimeout(persistTimer)
      try {
        window.localStorage.setItem(draftsStorageKey(), JSON.stringify({ stageDrafts, dirtySteps }))
      } catch {
        /* storage blocked — in-memory state is still correct this session */
      }
      return { stageDrafts, dirtySteps }
    }),
}))

import { create } from 'zustand'
import type * as React from 'react'

export type Goal = { text: string; mode: '' | 'ai' | 'skip' }
export type S1 = {
  narrator: string
  style: string
  output: string
  length: number
  projectId: string
  editing: string
}

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
  setStageProcess: (stageId: string, process: StageProcess | null) => void
  // Drop cached drafts for a stage so the editor reloads fresh engine content.
  clearStageDrafts: (stageId: string) => void
  // A step editor can expose its undo/redo to the step header. null = no
  // history available on the active step.
  stepUndo: { count: number; run: () => void; redoCount?: number; redo?: () => void } | null
  setStepUndo: (u: { count: number; run: () => void; redoCount?: number; redo?: () => void } | null) => void
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
  },
  dirtySteps: {},
  stageDrafts: {},
  stageProcesses: {},
  setStageDraft: (stageId, v) =>
    set((state) => ({
      stageDrafts: { ...state.stageDrafts, [stageId]: v },
      dirtySteps: { ...state.dirtySteps, [stageId]: true },
    })),
  seedStageDraft: (stageId, v) =>
    set((state) => ({
      stageDrafts: { ...state.stageDrafts, [stageId]: v },
    })),
  setStageFileDraft: (stageId, key, v) =>
    set((state) => ({
      stageDrafts: { ...state.stageDrafts, [key]: v },
      dirtySteps: { ...state.dirtySteps, [stageId]: true },
    })),
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
  setStageProcess: (stageId, process) =>
    set((state) => {
      const next = { ...state.stageProcesses }
      if (process) next[stageId] = process
      else delete next[stageId]
      return { stageProcesses: next }
    }),
  stepUndo: null,
  setStepUndo: (u) => set(() => ({ stepUndo: u })),
  clearStageDrafts: (stageId) =>
    set((state) => {
      const stageDrafts = Object.fromEntries(
        Object.entries(state.stageDrafts).filter(
          ([k]) => k !== stageId && !k.startsWith(`${stageId}:`),
        ),
      )
      return { stageDrafts, dirtySteps: { ...state.dirtySteps, [stageId]: false } }
    }),
}))

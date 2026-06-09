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

interface WorkflowStore extends Drafts {
  dirtySteps: Record<string, boolean>
  setIdeaBrief: (stepId: string, v: React.SetStateAction<string>) => void
  setGoal: (stepId: string, v: React.SetStateAction<Goal>) => void
  setS1: (stepId: string, v: React.SetStateAction<S1>) => void
  seedDrafts: (d: Partial<Drafts>) => void // initialize from seed WITHOUT marking dirty
  clearDirty: (stepId: string) => void
  isStepDirty: (stepId: string) => boolean
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
}))

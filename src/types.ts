export type Status = 'done' | 'work' | 'later'
export type GateType = 'human' | 'token' | 'audit'
export type GateState =
  | 'approved'
  | 'awaiting'
  | 'consumed'
  | 'not-yet'
  | 'passed'
  | 'failed'
  | 'pending'

export type StageContract = {
  id: string
  label: string
  requires_approval?: boolean
  gate?: string
}

export type Step = {
  id: string
  sourceId?: string
  num: string
  name: string
  blurb: string
  status: Status
  x: number
  y: number
  progress?: { done: number; total: number }
  optional?: boolean
  blockedBy?: string
}

export type Gate = {
  id: string
  type: GateType
  step: string
  pos: 'before' | 'after'
  label: string
  state: GateState
  source: string
}

export type SetupMode = 'series' | 'standalone'
export type ChatState = 'closed' | 'floating' | 'pinned'
export type ChatTab = 'chat' | 'history'

export type OnboardSeed = {
  s1: {
    narrator: string
    style: string
    output: string
    length: number
    projectId: string
    editing: string
  }
  ideaBrief: string
  goal: { text: string; mode: '' | 'ai' | 'skip' }
}

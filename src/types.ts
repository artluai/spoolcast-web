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
  // TEMPLATE-OWNED presentation (docs/format-templates.md "UI hints"): a
  // contract stage may name the UI step that presents it, provide the
  // subtitle shown under the module's CANONICAL name, or fold itself into
  // another step's card — all DATA served by the engine, so user-made
  // templates adapt presentation without frontend changes. Module NAMES stay
  // uniform across templates (users learn the app once); only the subtitle
  // carries the template's meaning ("this one is the hook").
  // blurb = SHORT subtext that must fit the map card; description = the
  // longer explanation shown in the expanded step panel after clicking in.
  ui?: {
    step?: string
    blurb?: string
    description?: string
    fold_into?: string
  }
}

export type Step = {
  id: string
  sourceId?: string
  num: string
  name: string
  blurb: string
  // Template-provided subtitle rendered under the canonical module name on
  // the map (from the contract stage's ui.blurb). Absent = no subtitle line.
  subtitle?: string
  // Template-provided long description, shown at the top of the expanded
  // step panel (from ui.description). Absent = no description line.
  description?: string
  status: Status
  x: number
  y: number
  progress?: { done: number; total: number }
  optional?: boolean
  blockedBy?: string
  // Format fork not decided yet (blank flow): the step renders as a nameless
  // skeleton ghost — no name, no status, no connectors. Absent = normal node.
  fog?: 'ghost'
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

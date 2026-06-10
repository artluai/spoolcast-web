import explainerContract from '../contracts/explainer.json'
import { stepAlias } from '../data/cast'
import type { Gate, StageContract, Status, Step } from '../types'

export function buildStepsFromContract(blank = false, apiStatusData?: any): Step[] {
  const stages = (explainerContract as { stages: StageContract[] }).stages
  // Node positions, in final main-line order. World Kit (05) sits between
  // Structure outline (04) and Screenplay (06); Visual pacing (07) sits between
  // Screenplay and Storyboard (08). Both are real contract stages now, so the
  // graph comes straight from the contract — narration_voice_check is the only
  // stage folded out of the visual map (its audit runs inside Storyboard).
  const positions = [
    [30, 110], // 01 Project setup
    [288, 110], // 02 Video brief (idea + source + core message, merged)
    [546, 110], // 03 Structure outline
    [804, 110], // 04 World Kit
    [1062, 110], // 05 Screenplay
    [1320, 110], // 06 Visual pacing
    [1578, 110], // 07 Storyboard
    [1836, 60], // 08 Narration audio
    [1836, 160], // 09 Visual generation
    [2094, 160], // 10 Visual review
    [2304, 110], // 11 Final render
    [2562, 110], // 12 Captions and cover
    [2562, 210], // 13 Vertical cut (optional branch off Captions)
    [2820, 110], // 14 Video output
  ]
  
  return stages
    .filter((stage) => stage.id !== 'narration_voice_check')
    .map((stage, index) => {
      const alias = stepAlias[stage.id] ?? {
        id: stage.id,
        name: stage.label,
        blurb: stage.gate ?? '',
      }
      
      // Derive status from live API data if available, otherwise default to 'later'
      let status: Status = 'later'
      if (apiStatusData?.workflow_graph?.nodes) {
        const apiNode = apiStatusData.workflow_graph.nodes.find((n: any) => n.id === stage.id)
        if (apiNode) {
          if (apiNode.status === 'passed' || apiNode.status === 'approved') status = 'done'
          else if (apiNode.status === 'running') status = 'work'
          else status = 'later'
        }
      } else if (blank) {
        status = 'later'
      }
      const progress = alias.id === 'pics' && !blank ? { done: 14, total: 22 } : undefined
      const [x, y] = positions[index]
      return {
        id: alias.id,
        sourceId: stage.id,
        name: alias.name,
        blurb: alias.blurb,
        status,
        progress,
        optional: alias.id === 'phone',
        num: String(index + 1).padStart(2, '0'),
        x,
        y,
      } satisfies Step
    })
}

export function buildGates(_blank: boolean = false, apiStatusData?: any): Gate[] {
  const artifacts = apiStatusData?.artifacts || []
  
  // DATA SHAPE ADAPTER: Engine returns nested { approvals: [...] }, but UI expects flat array.
  const approvalsList = Array.isArray(apiStatusData?.approvals) 
    ? apiStatusData.approvals 
    : (apiStatusData?.approvals?.approvals || [])
  
  const isPassed = (pattern: string) => {
    const match = artifacts.find((a: any) => a.pattern === pattern || a.path?.includes(pattern))
    return match?.exists === true
  }

  // HUMAN GATE RULE: a human gate is approved when the engine has either
  // (a) an explicit approval recorded in working/approvals.json for that stage, or
  // (b) marked the stage itself as passed/approved in the workflow graph.
  // This is one rule for ALL human gates — no per-gate hardcoding.
  const engineNodes = apiStatusData?.workflow_graph?.nodes || []
  const humanGateState = (stageId: string): Gate['state'] => {
    const explicitlyApproved = approvalsList.some((a: any) => a.stage_id === stageId)
    const node = engineNodes.find((n: any) => n.id === stageId)
    const stagePassed = node?.status === 'passed' || node?.status === 'approved'
    return explicitlyApproved || stagePassed ? 'approved' : 'awaiting'
  }

  // STRICT RULE: All gates default to pending/awaiting. They ONLY turn green if the engine explicitly confirms it.

  return [
    {
      id: 'g-setup',
      type: 'human',
      step: 'setup',
      pos: 'after',
      label: 'Approve project setup',
      // STRICT: Human gates require explicit approval or engine-confirmed stage pass.
      state: humanGateState('format_setup'),
      source: 'session.json',
    },
    {
      id: 'g-brief',
      type: 'human',
      step: 'idea',
      pos: 'after',
      label: 'Approve the video brief (source + core message)',
      state: humanGateState('input_intake'),
      source: 'working/approvals.json',
    },
    {
      id: 'g-voice',
      type: 'token',
      step: 'script',
      pos: 'before',
      label: 'Narration voice rules force-fed',
      state: isPassed('working/narration-voice-review-v2.json') ? 'consumed' : 'not-yet',
      source: 'working/narration-voice-review-v2.json',
    },
    {
      id: 'g-style',
      type: 'token',
      step: 'shots',
      pos: 'before',
      label: 'Style + character rules force-fed',
      state: isPassed('shot-list/shot-list.json') ? 'consumed' : 'not-yet',
      source: 'working/.rule-gates/style-rules.json',
    },
    {
      id: 'g-shotval',
      type: 'audit',
      step: 'shots',
      pos: 'after',
      label: 'Shot-list + character-registry validation',
      state: isPassed('working/shot-list-validation.passed.json') ? 'passed' : 'pending',
      source: 'validate_shot_list.py',
    },
    {
      id: 'g-narr',
      type: 'audit',
      step: 'voice',
      pos: 'after',
      label: 'Listener/script audits',
      state: isPassed('working/narration-voice-review-v2.json') ? 'passed' : 'pending',
      source: 'working/narration-voice-review-v2.json',
    },
    {
      id: 'g-scene',
      type: 'audit',
      step: 'pics',
      pos: 'after',
      label: 'Scene audit',
      state: isPassed('working/scene-audit.json') ? 'passed' : 'pending',
      source: 'working/scene-audit.json',
    },
    {
      id: 'g-render',
      type: 'audit',
      step: 'build',
      pos: 'after',
      label: 'Render audit',
      state: isPassed('working/render-audit.passed') ? 'passed' : 'pending',
      source: 'working/render-audit.passed',
    },
    {
      id: 'g-pub',
      type: 'human',
      step: 'post',
      pos: 'before',
      label: 'Per-platform publish approval',
      state: humanGateState('publish'),
      source: 'working/approvals.json',
    },
  ]
}

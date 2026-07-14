import { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { FeedbackButton } from './FeedbackButton'
import { useSourceWords, ThinSourceNote } from '../../lib/useSourceWords'
import { useWorkflowStore } from '../../store/workflow'
import { actionUrl, activeSession, fileUrl } from '../../lib/api'
import { ModelPicker } from './ModelPicker'
import { DEFAULT_MODEL_ID, draftReasoning } from '../../lib/draft-models'

const FILE_LISTENER = 'working/listener-draft.md'
const FILE_SCREENPLAY = 'working/screenplay-v3.md'

// Word-level diff (longest-common-subsequence): marks which words of `after`
// are new/changed relative to `before`. Whitespace (incl. paragraph breaks)
// is preserved for rendering; only words are compared.
function diffTokens(before: string, after: string): { tokens: string[]; isWord: boolean[]; marks: boolean[] } | null {
  const A = before.split(/\s+/).filter(Boolean)
  const tokens = after.split(/(\s+)/).filter((t) => t.length > 0)
  const isWord = tokens.map((t) => !/^\s+$/.test(t))
  const B = tokens.filter((_, i) => isWord[i])
  const n = A.length
  const m = B.length
  if (n === 0 || m === 0 || n * m > 4_000_000) return null
  const w = m + 1
  const dp = new Uint16Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * w + j] = A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
  const wordMarks: boolean[] = new Array(m).fill(true)
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      wordMarks[j] = false
      i += 1
      j += 1
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i += 1
    else j += 1
  }
  let wi = 0
  const marks = tokens.map((_, k) => (isWord[k] ? wordMarks[wi++] : false))
  return { tokens, isWord, marks }
}

type AuditView = {
  passed: boolean
  skipped?: boolean
  blocking: { label: string; detail: string }[]
  warnings: { label: string; detail: string }[]
}

type Rev = { label: string; text: string }
type ReviewNote = { severity: string; detail: string; locateDetail?: string }
type TriageFinding = { label: string; detail: string; locateDetail?: string }

/**
 * Step 6 — Screenplay as a REVISION CHAIN:
 *   Initial draft → Review 1 → Review 2 → …
 * The SELECTED revision is the script: it's what both rule checks grade, what
 * gets saved to the engine (both contract files), and what every later step
 * builds on. Each AI pass appends a new revision; older ones collapse to one
 * line and stay selectable. Revision history beyond what's on disk lives in
 * this session only (full history arrives with content versioning).
 */
export function ScreenplayStage({ stageId }: { stageId: string }) {
  const setStageFileDraft = useWorkflowStore((s) => s.setStageFileDraft)
  const seedStageFileDraft = useWorkflowStore((s) => s.seedStageFileDraft)
  // THE REVISION CHAIN LIVES IN THE STORE — the component only reads it.
  // One home, no copy, nothing to lose when you switch steps and come back.
  const CHAIN_KEY = `${stageId}:revchain`
  const chainJson = useWorkflowStore((s) => s.stageDrafts[CHAIN_KEY] ?? '')
  const { revs, sel } = (() => {
    try {
      const p = JSON.parse(chainJson) as { revs?: Rev[]; sel?: number }
      if (Array.isArray(p.revs) && p.revs.length)
        return { revs: p.revs, sel: Math.min(p.sel ?? p.revs.length - 1, p.revs.length - 1) }
    } catch {
      /* empty or invalid → no revisions yet */
    }
    return { revs: [] as Rev[], sel: 0 }
  })()
  const setChain = (nextRevs: Rev[], nextSel: number) =>
    seedStageFileDraft(CHAIN_KEY, JSON.stringify({ revs: nextRevs, sel: nextSel }))
  const [editing, setEditing] = useState(false)
  const [model, setModel] = useState(DEFAULT_MODEL_ID)
  const [err, setErr] = useState<string | null>(null)
  const [confirmSkip, setConfirmSkip] = useState(false)
  const [needRewind, setNeedRewind] = useState<{ feedback: string } | null>(null)
  const [ignored, setIgnored] = useState<Set<string>>(new Set())
  const [hoverIssue, setHoverIssue] = useState<string | null>(null)
  const [showDiff, setShowDiff] = useState(true)
  // THE REVIEW PIPELINE — one button: run the ticked reviews on the selected
  // script, or (from the menu) have the AI revise it first and review that.
  const [checkCode, setCheckCode] = useState(true)
  const [checkAI, setCheckAI] = useState(false)
  const [checkMenu, setCheckMenu] = useState(false)
  const [menuFeedback, setMenuFeedback] = useState('')

  // REVIEW STATE LIVES IN THE STORE, like the chain: a run started here keeps
  // going if you switch steps, and its progress + results are waiting when
  // you come back — navigation never cancels or forgets a review.
  type ReviewState = {
    busy: 'ai' | 'audit' | null
    aiPhase: 'review' | 'adjudicate' | null
    audit: AuditView | null
    auditAt: string | null
    auditRev: number | null
    aiNotes: ReviewNote[] | null
    aiRev: number | null
    aiVerdict: 'pass' | 'needs_work' | null
  }
  const EMPTY_REVIEW: ReviewState = { busy: null, aiPhase: null, audit: null, auditAt: null, auditRev: null, aiNotes: null, aiRev: null, aiVerdict: null }
  const REVIEW_KEY = `${stageId}:reviewstate`
  const reviewJson = useWorkflowStore((s) => s.stageDrafts[REVIEW_KEY] ?? '')
  const rstate: ReviewState = (() => {
    try {
      return { ...EMPTY_REVIEW, ...(JSON.parse(reviewJson) as Partial<ReviewState>) }
    } catch {
      return EMPTY_REVIEW
    }
  })()
  const patchReview = (p: Partial<ReviewState>) => {
    let cur = EMPTY_REVIEW
    try {
      cur = { ...EMPTY_REVIEW, ...(JSON.parse(useWorkflowStore.getState().stageDrafts[REVIEW_KEY] ?? '') as Partial<ReviewState>) }
    } catch {
      /* fresh */
    }
    seedStageFileDraft(REVIEW_KEY, JSON.stringify({ ...cur, ...p }))
  }
  const { busy, aiPhase, audit, auditAt, auditRev, aiNotes, aiRev, aiVerdict } = rstate
  const setBusy = (v: ReviewState['busy']) => patchReview({ busy: v })
  const setAiPhase = (v: ReviewState['aiPhase']) => patchReview({ aiPhase: v })
  const setAudit = (v: AuditView | null) => patchReview({ audit: v })
  const setAuditAt = (v: string | null) => patchReview({ auditAt: v })
  const setAuditRev = (v: number | null) => patchReview({ auditRev: v })
  const setAiNotes = (v: ReviewState['aiNotes']) => patchReview({ aiNotes: v })
  const setAiRev = (v: number | null) => patchReview({ aiRev: v })
  const seededRef = useRef(false)
  const rewindRef = useRef<HTMLDivElement>(null)
  const sourceWords = useSourceWords()
  useEffect(() => {
    if (needRewind) rewindRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [needRewind])

  const current = revs[sel]?.text ?? ''

  // THE SELECTED REVISION IS THE SCRIPT: mirror it into both store keys so the
  // standard save flow persists it to both contract files.
  const syncStore = (text: string) => {
    setStageFileDraft(stageId, `${stageId}:listener`, text)
    setStageFileDraft(stageId, `${stageId}:screenplay`, text)
  }

  // Disk seeding only when the store has NO chain (first visit / after a
  // reload or a start-over). A legacy session where the two files differ
  // becomes two revisions (Initial draft + Review 1).
  useEffect(() => {
    if (revs.length > 0 || seededRef.current) return
    seededRef.current = true
    Promise.all(
      [FILE_LISTENER, FILE_SCREENPLAY].map((p) =>
        fetch(fileUrl(p))
          .then((r) => (r.ok ? r.json() : null))
          .then((out) => (out?.ok && out.data?.exists ? String(out.data.content) : ''))
          .catch(() => ''),
      ),
    ).then(([listener, screenplay]) => {
      const L = listener.trim()
      const S = screenplay.trim()
      let seeded: Rev[] = []
      if (L && S && displayBody(L) !== displayBody(S)) seeded = [{ label: 'Initial draft', text: listener }, { label: 'Review 1', text: screenplay }]
      else if (S || L) seeded = [{ label: 'Initial draft', text: S ? screenplay : listener }]
      if (seeded.length && useWorkflowStore.getState().stageDrafts[CHAIN_KEY] === undefined) {
        setChain(seeded, seeded.length - 1)
        seedStageFileDraft(`${stageId}:listener`, seeded[seeded.length - 1].text)
        seedStageFileDraft(`${stageId}:screenplay`, seeded[seeded.length - 1].text)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revs.length])

  const stats = (text: string) => {
    const body = text
      .split('\n')
      .filter((l) => !l.startsWith('#') && !l.startsWith('Voice source:'))
      .join(' ')
    const words = body.split(/\s+/).filter(Boolean).length
    const secs = Math.round(words / 2.4)
    return { words, time: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` }
  }
  const displayBody = (text: string) =>
    text
      .split('\n')
      .filter((l) => !/^#\s/.test(l) && !/^##\s*Narration\s*$/i.test(l) && !l.startsWith('Voice source:'))
      .join('\n')
      .trim()

  const post = (body: object) =>
    fetch(actionUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: activeSession(), tenant: 'local', ...body }),
    })

  // Persist a revision's text to BOTH contract files — one document, one
  // truth; both checks must always grade the same text.
  const saveText = async (text: string): Promise<boolean> => {
    if (!text.trim()) return true
    for (const path of [FILE_LISTENER, FILE_SCREENPLAY]) {
      const r = await post({ action: 'set_stage_output', stage_id: stageId, path, content: text })
      if (!r.ok) return false
    }
    return true
  }
  const saveCurrent = () => saveText(current)

  // Run the deterministic checks on a text (saved to both files first) and
  // RETURN the result — the caller decides when it appears on screen, so a
  // combined code+AI run can reveal everything at once.
  const computeCodeAudit = async (text: string): Promise<AuditView | null> => {
    if (!(await saveText(text))) {
      setErr('Could not save the script to the engine.')
      return null
    }
    const audits: Record<string, unknown> = {}
    for (const stage of ['screenplay', 'narration'] as const) {
      const r = await post({ action: 'run_audit', stage })
      const out = await r.json().catch(() => null)
      if (!r.ok || out?.ok === false) {
        setErr(out?.message || out?.error || 'A check failed to run.')
        return null
      }
      audits[stage] = { ok: true, ...out.data }
    }
    return readAudits(audits as Parameters<typeof readAudits>[0])
  }


  // Findings must carry their SPECIFICS: which term, which line — without
  // them, neither the user nor the AI fixer can act, and the same finding
  // returns forever. The quoted text also powers hover-locate.
  type RawFinding = { detail?: string; message?: string; type?: string; term?: string; text?: string }
  const detailOf = (f: RawFinding): string => {
    let d = f.detail || f.message || f.type || JSON.stringify(f)
    if (f.term) d += ` — the term: '${f.term}'`
    if (f.text && typeof f.text === 'string') d += ` (in: '${String(f.text).slice(0, 90)}')`
    return d
  }
  const readAudits = (audits: Record<string, { ok?: boolean; passed?: boolean; message?: string; blocking?: RawFinding[]; warnings?: RawFinding[] }>): AuditView | null => {
    const view: AuditView = { passed: true, blocking: [], warnings: [] }
    for (const [k, label] of [['screenplay', 'script'], ['narration', 'voice']] as const) {
      const d = audits[k]
      if (!d?.ok) {
        setErr(d?.message || `${label} check could not run.`)
        return null
      }
      if (!d.passed) view.passed = false
      for (const f of d.blocking || []) view.blocking.push({ label, detail: detailOf(f) })
      for (const f of d.warnings || []) view.warnings.push({ label, detail: detailOf(f) })
    }
    return view
  }

  // PIPELINE STEP 1 — write the next revision (no grading here; the caller
  // runs whichever checkers are configured afterwards).
  const draftRevision = async (feedback = ''): Promise<{ text: string; idx: number } | null> => {
    const initial = revs.length === 0
    if (!initial && !(await saveCurrent())) {
      setErr('Could not save the script to the engine.')
      return null
    }
    const r = await post({
      action: 'draft_stage',
      stage_id: stageId,
      variant: initial ? 'listener' : 'screenplay',
      allow_cost: true,
      model,
      ...(draftReasoning(model) ? { reasoning: draftReasoning(model) } : {}),
      ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
    })
    const out = await r.json().catch(() => null)
    if (!r.ok || out?.ok === false) {
      if (out?.error === 'illegal_action') {
        setNeedRewind({ feedback })
        return null
      }
      setErr(out?.message || out?.error || 'Drafting failed.')
      return null
    }
    const file = initial ? FILE_LISTENER : FILE_SCREENPLAY
    const fr = await fetch(fileUrl(file))
    const fileOut = await fr.json().catch(() => null)
    const text = fileOut?.ok && fileOut.data?.exists ? String(fileOut.data.content) : ''
    if (!text.trim()) {
      setErr('The draft came back empty.')
      return null
    }
    // Append to the FRESH chain from the store (awaits above may have left
    // the closure's copy behind).
    const fresh = (() => {
      try {
        const p = JSON.parse(useWorkflowStore.getState().stageDrafts[CHAIN_KEY] ?? '') as { revs?: Rev[] }
        return Array.isArray(p.revs) ? p.revs : []
      } catch {
        return [] as Rev[]
      }
    })()
    const label = fresh.length === 0 ? 'Initial draft' : `Review ${fresh.length}`
    const idx = fresh.length
    setChain([...fresh, { label, text }], idx)
    setEditing(false)
    syncStore(text)
    setAiNotes(null) // AI notes graded the previous revision
    setAiRev(null)
    return { text, idx }
  }

  // THE ONE REVIEW ACTION: (optionally) revise, then run the configured
  // checkers on the result — revealing all findings together.
  const runReview = async (feedback = '', forceRevise = false): Promise<void> => {
    setCheckMenu(false)
    const revise = forceRevise || revs.length === 0
    const wantCode = checkCode || (!checkCode && !checkAI) // never run nothing
    setErr(null)
    setConfirmSkip(false)
    try {
      let text = current
      let idx = sel
      if (revise) {
        setBusy('ai')
        const res = await draftRevision(feedback)
        if (!res) return
        text = res.text
        idx = res.idx
      }
      setBusy('audit')
      let codeView: AuditView | null = null
      if (wantCode) {
        setAiPhase(checkAI ? 'review' : null)
        codeView = await computeCodeAudit(text)
        if (!checkAI && codeView) {
          setAudit(codeView)
          setAuditAt(new Date().toLocaleTimeString())
          setAuditRev(idx)
        }
      }
      if (checkAI) {
        if (!wantCode && !(await saveText(text))) {
          setErr('Could not save the script to the engine.')
          return
        }
        setAiPhase('review')
        // CONVERGENCE MEMORY: hand the reviewer its previous notes and what
        // the user dismissed — it reviews the changes, it doesn't start over.
        const prevNotes = (aiNotes ?? []).map((n) => n.detail)
        const prevDismissed = prevNotes.filter((d) => ignored.has(`ai:${d}`))
        const r = await post({
          action: 'ai_review',
          allow_cost: true,
          model,
          previous: { notes: prevNotes.filter((d) => !ignored.has(`ai:${d}`)), dismissed: prevDismissed },
        })
        const out = await r.json().catch(() => null)
        const aiOk = r.ok && out?.ok !== false && out?.data?.advisory === true && Array.isArray(out?.data?.findings)
        if (!aiOk) {
          setErr(
            out?.message || out?.error ||
              'The AI review did not run — if the engine was started before this feature, restart it (Ctrl+C, ↑, Enter).',
          )
        }
        if (codeView) {
          setAudit(codeView)
          setAuditAt(new Date().toLocaleTimeString())
          setAuditRev(idx)
        }
        if (aiOk) {
          patchReview({
            aiNotes: out.data.findings,
            aiRev: idx,
            aiVerdict: out.data.verdict === 'pass' ? 'pass' : 'needs_work',
          })
        }
      }
    } catch {
      setErr('Could not reach the engine.')
    } finally {
      setBusy(null)
      setAiPhase(null)
    }
  }

  // ASK AI ABOUT THE CODE FINDINGS: the adjudicator. Confirmed findings move
  // into the AI section with a concrete explanation; false positives are
  // called out and auto-ignored. Metered.
  const adjudicate = async () => {
    if (!codeRemaining.length) return
    setBusy('audit')
    setErr(null)
    try {
      if (!(await saveText(current))) {
        setErr('Could not save the script to the engine.')
        return
      }
      const payload = codeRemaining.map((f) => `[${f.label}] ${f.detail}`)
      setAiPhase('adjudicate')
      const r = await post({ action: 'ai_review', allow_cost: true, findings: payload })
      const out = await r.json().catch(() => null)
      if (!r.ok || out?.ok === false || out?.data?.advisory !== true || !Array.isArray(out?.data?.adjudications)) {
        setErr(out?.message || out?.error || 'The AI could not review the findings — restart the engine if it predates this feature.')
        return
      }
      const notes = [...(aiRev === sel && aiNotes ? aiNotes : [])]
      const nextIgnored = new Set(ignored)
      for (const a of out.data.adjudications as { index: number; verdict: string; note?: string; summary?: string; action?: string }[]) {
        const src = codeRemaining[a.index]
        if (!src) continue
        const fp = a.verdict === 'false_positive'
        const summary = (a.summary || a.note || '').trim()
        const action = (a.action || '').trim()
        notes.push({
          severity: 'warning',
          detail: [
            fp ? 'Likely a false alarm.' : 'Confirmed issue.',
            summary,
            action ? `Next step: ${action}` : '',
          ].filter(Boolean).join(' '),
          locateDetail: src.detail,
        })
        if (fp) nextIgnored.add(fkey(src)) // suggested ignore, reversible like any other
      }
      setAiNotes(notes)
      setAiRev(sel)
      setIgnored(nextIgnored)
    } catch {
      setErr('Could not reach the engine.')
    } finally {
      setBusy(null)
      setAiPhase(null)
    }
  }

  // CHECK: runs whichever checkers are ticked, on the SELECTED revision.
  const skipAudit = async () => {
    setConfirmSkip(false)
    setBusy('audit')
    setErr(null)
    try {
      await saveCurrent()
      const stamp = new Date().toISOString()
      const skipDoc = (what: string) =>
        JSON.stringify({ skipped: true, skipped_at: stamp, note: `User skipped the ${what} check in the UI`, blocking: [], warnings: [{ type: 'skipped', detail: `${what} check was skipped by the user` }] }, null, 2)
      const r1 = await post({ action: 'set_stage_output', stage_id: 'screenplay_plan', path: 'working/screenplay-audit.json', content: skipDoc('script') })
      const r2 = await post({ action: 'set_stage_output', stage_id: 'narration_voice_check', path: 'working/narration-voice-review-v2.json', content: skipDoc('voice') })
      if (!r1.ok || !r2.ok) {
        setErr('Could not record the skip.')
        return
      }
      setAudit({ passed: true, skipped: true, blocking: [], warnings: [] })
      setAuditRev(sel)
    } catch {
      setErr('Could not reach the engine.')
    } finally {
      setBusy(null)
    }
  }

  // Findings triage
  const fkey = (f: { label: string; detail: string }) => `${f.label}:${f.detail}`
  const toggleIgnore = (k: string) =>
    setIgnored((s) => {
      const next = new Set(s)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  const aiFindings = aiRev === sel && aiNotes ? aiNotes.map((f) => ({ label: 'ai', detail: f.detail, locateDetail: f.locateDetail })) : []
  const triage = [...(audit ? audit.blocking : []), ...aiFindings]
  const remainingBlocking = triage.filter((f) => !ignored.has(fkey(f)))
  const ignoredBlocking = triage.filter((f) => ignored.has(fkey(f)))
  const codeRemaining = audit ? audit.blocking.filter((f) => !ignored.has(fkey(f))) : []

  // HOVER-LOCATE: findings usually quote the exact phrase — find it in the
  // script, highlight it in AMBER (distinct from the violet "changed" tint),
  // and scroll it into view so the issue shows with its surrounding context.
  const normQ = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').toLowerCase()
  const locate = (() => {
    if (!hoverIssue) return null
    const f = (triage as TriageFinding[]).find((x) => fkey(x) === hoverIssue)
    if (!f) return null
    const body = displayBody(current)
    const nb = normQ(body)
    for (const m of (f.locateDetail || f.detail).matchAll(/['‘’"“”]([^'‘’"“”]{6,160})['‘’"“”]/g)) {
      const idx = nb.indexOf(normQ(m[1]))
      if (idx >= 0) return { start: idx, end: idx + m[1].length }
    }
    return null
  })()
  const locateRef = useRef<HTMLSpanElement>(null)
  // The script panel scrolls ITSELF: default height shows a good chunk of
  // script with the findings still on screen, and the bottom edge is
  // draggable (resize) to any height you like. Hover-locate scrolls only
  // inside the panel, using the currently visible slice of the panel as the
  // target area so the page itself never jumps.
  const scriptBoxRef = useRef<HTMLDivElement>(null)
  const [scriptOverflows, setScriptOverflows] = useState(false)
  useEffect(() => {
    const box = scriptBoxRef.current
    if (!box) return
    // Default panel height (only when the script is taller than ~half the
    // screen) is set imperatively ONCE — so the user's drag-resize of the
    // bottom edge is never stomped by re-renders. Short scripts fit as-is.
    const cap = Math.round(window.innerHeight * 0.52)
    if (!box.style.height && box.scrollHeight > cap) box.style.height = `${cap}px`
    const padPx = scriptOverflows ? window.innerHeight * 0.18 : 0
    const overflowing = box.scrollHeight - padPx > box.clientHeight + 2
    if (overflowing !== scriptOverflows) setScriptOverflows(overflowing)
  })
  useEffect(() => {
    const box = scriptBoxRef.current
    const el = locateRef.current
    if (!locate || !box || !el) return
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight
    const boxRect = box.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    const visibleTop = Math.max(boxRect.top, 72)
    const visibleBottom = Math.min(boxRect.bottom, viewportHeight - 24)
    const visibleCenter = visibleBottom > visibleTop
      ? visibleTop + (visibleBottom - visibleTop) / 2
      : boxRect.top + box.clientHeight / 2

    box.scrollTop = Math.max(
      0,
      box.scrollTop + (elRect.top + elRect.height / 2) - visibleCenter,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoverIssue, locate?.start])
  const hoverEnter = (k: string) => setHoverIssue(k)
  const hoverLeave = () => setHoverIssue(null)
  const composeAuditFeedback = (fb: string) => {
    const parts: string[] = []
    if (fb.trim()) parts.push(fb.trim())
    if (remainingBlocking.length)
      parts.push('Fix these rule-check findings:\n' + remainingBlocking.map((f) => `- ${f.detail}`).join('\n'))
    const warnRemaining = audit ? audit.warnings.filter((w) => !ignored.has(fkey(w))) : []
    if (warnRemaining.length)
      parts.push('Also address these warnings where it fits naturally:\n' + warnRemaining.map((f) => `- ${f.detail}`).join('\n'))
    if (ignoredBlocking.length)
      parts.push(
        'The user chose to IGNORE these findings — do NOT rework the script for them:\n' +
          ignoredBlocking.map((f) => `- ${f.detail}`).join('\n'),
      )
    return parts.join('\n')
  }

  const ghost: React.CSSProperties = {
    background: 'none', border: '1px solid var(--line, #2a3142)', borderRadius: 6,
    color: 'var(--ink-2)', padding: '6px 12px', cursor: 'pointer', fontSize: 12,
  }
  const section: React.CSSProperties = { padding: '14px 0', borderTop: '1px solid var(--line, #2a3142)' }

  const auditStale = audit && auditRev !== null && auditRev !== sel

  return (
    <div>
      {err && <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10 }}>Engine: {err}</div>}
      {needRewind && (
        <div
          ref={rewindRef}
          style={{ margin: '4px 0 18px', borderLeft: '2px solid var(--amber)', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          <b style={{ fontSize: 13, color: 'var(--amber)' }}>This step is already approved</b>
          <p style={{ color: 'var(--ink-2)', fontSize: 13, margin: 0, lineHeight: 1.5, maxWidth: 560 }}>
            Making a new revision sets this step and everything after it back to pending — you
            review and approve them again as you go.{needRewind.feedback ? ' Your feedback carries over.' : ''}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="save-continue"
              style={{ width: 'auto', padding: '8px 14px' }}
              onClick={async () => {
                const { feedback } = needRewind
                setNeedRewind(null)
                try {
                  const r = await post({ action: 'rewind_stage', stage_id: stageId })
                  const out = await r.json().catch(() => null)
                  if (!r.ok || out?.ok === false) {
                    setErr(out?.message || out?.error || 'Could not set the step back to pending.')
                    return
                  }
                  // The rewind deleted this stage's files — put the selected
                  // revision back first, then run the same instructions.
                  if (!(await saveCurrent())) {
                    setErr('Could not restore the script to the engine after the rewind.')
                    return
                  }
                  setAudit(null)
                  await runReview(feedback, true)
                } catch {
                  setErr('Could not reach the engine.')
                }
              }}
            >
              Set back to pending & make the new revision
            </button>
            <button style={ghost} onClick={() => setNeedRewind(null)}>Never mind, keep it</button>
          </div>
        </div>
      )}

      <div style={{ marginBottom: 4 }}>
        <ThinSourceNote words={sourceWords} />
      </div>

      {revs.length === 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 0' }}>
          <FeedbackButton
            label="Write it"
            busy={busy === 'ai'}
            disabled={!!busy}
            title="AI writes the first draft from your structure and World Kit — uses model credits"
            rulesFocus="story"
            onRun={(fb) => runReview(fb, true)}
          />
          <ModelPicker model={model} onChange={setModel} disabled={!!busy} />
          <button
            style={ghost}
            onClick={() => {
              setChain([{ label: 'Initial draft', text: '' }], 0)
              setEditing(true)
            }}
          >
            or write it yourself
          </button>
        </div>
      ) : null}

      {revs.map((rev, i) => {
        const selected = i === sel
        const s = stats(rev.text)
        if (!selected) {
          // COLLAPSED: one quiet line; click to select (and grade) this revision.
          return (
            <div key={i} style={i === 0 ? { ...section, borderTop: 'none', paddingTop: 4 } : section}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => { setChain(revs, i); setEditing(false); syncStore(rev.text) }}
                onKeyDown={(e) => { if (e.key === 'Enter') { setChain(revs, i); setEditing(false); syncStore(rev.text) } }}
                style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}
                title="Select this revision — it becomes the script the checks grade and later steps use"
              >
                <span style={{ color: 'var(--ink-3)', fontSize: 11 }}>▸</span>
                <h3 style={{ margin: 0, fontSize: 15, color: 'var(--ink-2)', fontWeight: 500 }}>{rev.label}</h3>
                <span style={{ flex: 1 }} />
                <span style={{ color: 'var(--ink-3)', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                  {s.words} words · ~{s.time}
                </span>
              </div>
            </div>
          )
        }
        const prev = i > 0 ? revs[i - 1].text : ''
        const diff = showDiff && prev.trim() && rev.text.trim() && !editing ? diffTokens(displayBody(prev), displayBody(rev.text)) : null
        return (
          <div key={i} style={i === 0 ? { ...section, borderTop: 'none', paddingTop: 4 } : section}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--ink-3)', fontSize: 11 }}>▾</span>
              <h3 style={{ margin: 0, fontSize: 15 }} title="The selected revision — the script">{rev.label}</h3>
              <span style={{ fontSize: 11, color: 'var(--ink-3)', border: '1px solid var(--line, #2a3142)', borderRadius: 99, padding: '1px 8px' }}>
                current script
              </span>
              <span style={{ flex: 1 }} />
              {rev.text.trim() && (
                <span style={{ color: 'var(--ink-3)', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                  {s.words} words · ~{s.time}
                </span>
              )}
            </div>

            {/* The text — dim + spinner while the AI writes the next revision. */}
            <div style={{ position: 'relative' }}>
              {busy === 'ai' ? (
                <div style={{ position: 'absolute', inset: 0, zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, background: 'rgba(10,12,18,.45)', borderRadius: 8, minHeight: 80 }}>
                  <span className="spin" />
                  <span style={{ color: 'var(--ink-1)', fontSize: 13 }}>AI is writing the next revision…</span>
                </div>
              ) : null}
              {/* SCRIPT COLUMN: a centered reading measure with real margins —
                  it should feel like a script page, not a wall of UI text. */}
              <div
                ref={scriptBoxRef}
                style={{
                  margin: '20px 0 0',
                  fontSize: 15,
                  minHeight: 180,
                  overflowY: 'auto',
                  resize: 'vertical',
                  paddingBottom: scriptOverflows ? '18vh' : 0,
                  paddingRight: 10,
                  ...(busy === 'ai' ? { opacity: 0.4, pointerEvents: 'none' } : {}),
                }}
              >
                {editing ? (
                  <textarea
                    autoFocus
                    value={rev.text}
                    placeholder="Write the narration here…"
                    onChange={(e) => {
                      const text = e.target.value
                      setChain(revs.map((r, k) => (k === i ? { ...r, text } : r)), sel)
                      syncStore(text)
                    }}
                    onBlur={() => setEditing(false)}
                    style={{
                      width: '100%', minHeight: 240, marginTop: 10, resize: 'vertical', background: 'transparent',
                      color: 'var(--ink-1, inherit)', border: '1px solid var(--line, #2a3142)', borderRadius: 8,
                      padding: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, lineHeight: 1.55,
                    }}
                  />
                ) : rev.text.trim() ? (
                  locate ? (
                    // LOCATE VIEW: same paragraph typography; the hovered
                    // finding's quoted phrase glows amber.
                    <div className="md-preview" style={{ marginTop: 6 }}>
                      {(() => {
                        const body = displayBody(rev.text)
                        const paras: { text: string; start: number }[] = []
                        let off = 0
                        for (const part of body.split(/(\n\s*\n)/)) {
                          if (!/^\n\s*\n$/.test(part) && part.trim()) paras.push({ text: part, start: off })
                          off += part.length
                        }
                        return paras.map((p, k) => {
                          const pEnd = p.start + p.text.length
                          if (locate.end <= p.start || locate.start >= pEnd) return <p key={k}>{p.text}</p>
                          const s2 = Math.max(locate.start - p.start, 0)
                          const e2 = Math.min(locate.end - p.start, p.text.length)
                          return (
                            <p key={k}>
                              {p.text.slice(0, s2)}
                              {/* Same highlight as the pacing script view (.vp-w.on). */}
                              <span
                                ref={locateRef}
                                style={{
                                  background: 'var(--accent)',
                                  color: '#0a0c12',
                                  borderRadius: 3,
                                  boxShadow: '-2px 0 0 var(--accent), 2px 0 0 var(--accent)',
                                }}
                              >
                                {p.text.slice(s2, e2)}
                              </span>
                              {p.text.slice(e2)}
                            </p>
                          )
                        })
                      })()}
                    </div>
                  ) : diff ? (
                    <div className="md-preview" title="Click to edit · tinted = changed from the previous revision" onClick={() => setEditing(true)} style={{ marginTop: 6, cursor: 'text' }}>
                      {(() => {
                        const paras: React.ReactNode[][] = [[]]
                        diff.tokens.forEach((t, k) => {
                          if (!diff.isWord[k]) {
                            if (/\n\s*\n/.test(t)) paras.push([])
                            else if (paras[paras.length - 1].length) paras[paras.length - 1].push(' ')
                            return
                          }
                          paras[paras.length - 1].push(
                            diff.marks[k] ? (
                              // "Changed from previous" tint — amber, so the
                              // accent highlight stays reserved for locating.
                              <span key={k} style={{ background: 'rgba(255, 193, 94, .18)', borderRadius: 3, color: 'var(--ink)' }}>{t}</span>
                            ) : (
                              t
                            ),
                          )
                        })
                        return paras.filter((p) => p.length).map((p, k) => <p key={k}>{p}</p>)
                      })()}
                    </div>
                  ) : (
                    <div
                      className="md-preview"
                      title="Click to edit"
                      onClick={() => setEditing(true)}
                      style={{ marginTop: 6, cursor: 'text' }}
                      dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(displayBody(rev.text), { async: false }) as string) }}
                    />
                  )
                ) : (
                  <button type="button" onClick={() => setEditing(true)} style={{ background: 'none', border: 'none', padding: 0, marginTop: 10, color: 'var(--ink-3)', fontSize: 13, cursor: 'pointer' }}>
                    ▸ write it here
                  </button>
                )}
              </div>
            </div>

            {/* REVIEW BAR — the controls live next to their effect: status on
                the left, diff toggle + checker on the right, findings below.
                Labels are constant-width so state changes never reflow. */}
            {rev.text.trim() ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 16, borderTop: '1px solid var(--line, #2a3142)', paddingTop: 12 }}>
                {audit && !auditStale ? (
                  <button
                    type="button"
                    title={audit.passed || audit.skipped ? undefined : 'Jump to the issues'}
                    onClick={() => document.getElementById(`audit-findings-${stageId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                    style={{
                      background: 'none', border: 'none', padding: 0,
                      cursor: audit.passed || audit.skipped ? 'default' : 'pointer', fontSize: 13,
                      color: audit.skipped ? 'var(--amber)' : audit.passed ? 'var(--green, #4ade80)' : 'var(--red)',
                    }}
                  >
                    {audit.skipped
                      ? '△ checks skipped'
                      : audit.passed
                        ? audit.warnings.length
                          ? `✓ checks passed · ${audit.warnings.length} warning(s)`
                          : '✓ checks passed'
                        : `✕ ${codeRemaining.length} blocking issue(s)${ignoredBlocking.length ? ` · ${ignoredBlocking.length} ignored` : ''}`}
                  </button>
                ) : (
                  <span style={{ color: 'var(--ink-3)', fontSize: 13 }}>not checked yet</span>
                )}
                <span style={{ flex: 1 }} />
                {i > 0 && (
                  <button
                    style={{ ...ghost, minWidth: 104, color: showDiff ? 'var(--ink)' : 'var(--ink-2)' }}
                    title="Highlight what changed from the previous revision"
                    onClick={() => setShowDiff((v) => !v)}
                  >
                    Changes {showDiff ? 'on' : 'off'}
                  </button>
                )}
                <span style={{ position: 'relative', display: 'inline-flex' }}>
                  <button
                    style={{ ...ghost, borderRadius: '6px 0 0 6px', borderRight: 'none', padding: '6px 8px' }}
                    disabled={!!busy}
                    title="Review options"
                    onClick={() => setCheckMenu((v) => !v)}
                  >
                    ▾
                  </button>
                  <button
                    className="save-continue"
                    style={{ width: 'auto', borderRadius: '0 6px 6px 0', minWidth: 100, padding: '6px 14px', fontSize: 12 }}
                    disabled={!!busy}
                    title={`Reviews this script with: ${[checkCode && 'the rulebook check', checkAI && 'the AI reviewer'].filter(Boolean).join(' + ') || 'nothing selected'}`}
                    onClick={() => runReview('')}
                  >
                    {busy === 'ai' ? 'Revising…' : busy === 'audit' ? 'Checking…' : '✦ Review'}
                  </button>
                  {checkMenu ? (
                    <>
                      <span className="vp-menu-backdrop" onClick={() => setCheckMenu(false)} />
                      <span className="vp-menu" style={{ position: 'absolute', bottom: 'calc(100% + 4px)', right: 0, minWidth: 350 }}>
                        <span className="vp-menu-h">RUN REVIEWS</span>
                        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 12px', cursor: 'pointer', fontSize: 13 }}>
                          <input type="checkbox" checked={checkCode} onChange={(e) => setCheckCode(e.target.checked)} style={{ accentColor: 'var(--ink-2)', marginTop: 2 }} />
                          <span>
                            Rulebook check
                            <span style={{ display: 'block', color: 'var(--ink-3)', fontSize: 11 }}>
                              instant & free — checks the script against the writing rules (structure, undefined terms, opening, lengths)
                            </span>
                          </span>
                        </label>
                        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 12px', cursor: 'pointer', fontSize: 13 }}>
                          <input type="checkbox" checked={checkAI} onChange={(e) => setCheckAI(e.target.checked)} style={{ accentColor: 'var(--ink-2)', marginTop: 2 }} />
                          <span>
                            AI reviewer
                            <span style={{ display: 'block', color: 'var(--ink-3)', fontSize: 11 }}>
                              reads it like a first-time viewer — judgment notes, advisory · uses credits
                            </span>
                          </span>
                        </label>
                        <button type="button" disabled={!checkCode && !checkAI} onClick={() => runReview('')}>
                          Run reviews
                        </button>
                        <span className="vp-menu-div" style={{ display: 'block' }} />
                        <span className="vp-menu-h">RE-DRAFT WITH AI FIRST</span>
                        <textarea
                          rows={2}
                          value={menuFeedback}
                          onChange={(e) => setMenuFeedback(e.target.value)}
                          placeholder="optional: tell the AI what to change…"
                          style={{
                            display: 'block', width: 'calc(100% - 24px)', margin: '8px 12px 6px',
                            background: 'rgba(255,255,255,.02)', color: 'var(--ink-1)',
                            border: '1px dashed var(--line, #2a3142)', borderRadius: 6,
                            padding: '7px 9px', fontSize: 12, resize: 'vertical',
                          }}
                        />
                        <button
                          type="button"
                          title="AI rewrites the script into a new revision, then the reviews above run on it — uses credits"
                          onClick={() => runReview(menuFeedback, true)}
                        >
                          ✦ Re-draft, then run the reviews
                        </button>
                      </span>
                    </>
                  ) : null}
                </span>
              </div>
            ) : null}

            {/* FINDINGS — always about the text above (or marked stale). */}
            {/* AI WORK IN PROGRESS — visible right here, where the results land. */}
            {aiPhase && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, borderLeft: '2px solid var(--accent, #8fa1ff)', padding: '6px 10px' }}>
                <span className="spin" />
                <span style={{ color: 'var(--ink-2)', fontSize: 13 }}>
                  {aiPhase === 'review' ? '◇ AI is reading the script like a first-time viewer…' : '◇ AI is judging the findings against the script…'}
                </span>
              </div>
            )}
            {/* AI REVIEW NOTES — advisory judgment, never gates the step. */}
            {aiFindings.length > 0 && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <p style={{ color: 'var(--ink-3)', fontSize: 12, margin: 0 }}>
                  AI review (a first-time viewer’s judgment — advisory, doesn’t block approval):
                </p>
                {aiFindings.map((f, k) => {
                  const fk = fkey(f)
                  const isIgnored = ignored.has(fk)
                  return (
                    <div
                      key={`ai${k}`}
                      onMouseEnter={() => hoverEnter(fk)}
                      onMouseLeave={hoverLeave}
                      style={{
                        display: 'flex', alignItems: 'baseline', gap: 8,
                        borderLeft: `2px solid ${isIgnored ? 'var(--line, #2a3142)' : 'var(--accent, #8fa1ff)'}`,
                        padding: '2px 10px', fontSize: 13, opacity: isIgnored ? 0.5 : 1,
                      }}
                    >
                      <span style={{ color: isIgnored ? 'var(--ink-3)' : 'var(--accent, #8fa1ff)', whiteSpace: 'nowrap' }}>◇ ai</span>
                      <span style={{ color: 'var(--ink-2)', flex: 1 }}>{f.detail}</span>
                      {hoverIssue === fk || isIgnored ? (
                        <button
                          type="button"
                          style={{ ...ghost, padding: '1px 8px', fontSize: 11, whiteSpace: 'nowrap' }}
                          title={isIgnored ? '“Fix these” will address this again' : '“Fix these” won’t chase this note'}
                          onClick={() => toggleIgnore(fk)}
                        >
                          {isIgnored ? 'Un-ignore' : 'Ignore this issue'}
                        </button>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            )}
            {aiRev === sel && aiNotes && aiNotes.length === 0 ? (
              <p style={{ color: 'var(--ok, #5fbf77)', fontSize: 12, margin: '8px 0 0' }}>
                ◇ AI review: pass — a first-time viewer follows this start to finish. No further runs needed.
              </p>
            ) : aiRev === sel && aiVerdict === 'needs_work' && aiFindings.length > 0 ? (
              <p style={{ color: 'var(--ink-3)', fontSize: 12, margin: '4px 0 0' }}>
                Verdict: needs work — fix or ignore the notes above; the next review checks only what changed.
              </p>
            ) : null}
            {auditStale && audit ? (
              <p style={{ color: 'var(--amber)', fontSize: 12, margin: '10px 0 0' }}>
                The last check graded “{revs[auditRev!]?.label}” — hit Re-check to grade this revision.
              </p>
            ) : null}
            {audit && !auditStale && (audit.blocking.length > 0 || audit.warnings.length > 0) && (
              <>
                <p style={{ color: 'var(--ink-3)', fontSize: 12, margin: '10px 0 0' }}>
                  Checks ran automatically on this revision{auditAt ? ` (${auditAt})` : ''} — these findings are current.
                </p>
                <div id={`audit-findings-${stageId}`} style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {audit.blocking.map((f, k) => {
                    const fk = fkey(f)
                    const isIgnored = ignored.has(fk)
                    return (
                      <div
                        key={`b${k}`}
                        onMouseEnter={() => hoverEnter(fk)}
                        onMouseLeave={hoverLeave}
                        style={{
                          display: 'flex', alignItems: 'baseline', gap: 8,
                          borderLeft: `2px solid ${isIgnored ? 'var(--line, #2a3142)' : 'var(--red)'}`,
                          padding: '2px 10px', fontSize: 13, opacity: isIgnored ? 0.5 : 1,
                        }}
                      >
                        <span style={{ color: isIgnored ? 'var(--ink-3)' : 'var(--red)', whiteSpace: 'nowrap' }}>✕ {f.label}</span>
                        <span style={{ color: 'var(--ink-2)', flex: 1 }}>{f.detail}</span>
                        {hoverIssue === fk || isIgnored ? (
                          <button
                            type="button"
                            style={{ ...ghost, padding: '1px 8px', fontSize: 11, whiteSpace: 'nowrap' }}
                            title={isIgnored ? '“Fix these” will try to fix this again' : '“Fix these” won’t chase this — the check itself still flags it (Skip the checks waives the gate)'}
                            onClick={() => toggleIgnore(fk)}
                          >
                            {isIgnored ? 'Un-ignore' : 'Ignore this issue'}
                          </button>
                        ) : null}
                      </div>
                    )
                  })}
                  {audit.warnings.map((f, k) => (
                    <div key={`w${k}`} style={{ borderLeft: '2px solid var(--amber)', padding: '2px 10px', fontSize: 13 }}>
                      <span style={{ color: 'var(--amber)' }}>△ {f.label}</span>
                      <span style={{ color: 'var(--ink-2)', marginLeft: 8 }}>{f.detail}</span>
                    </div>
                  ))}
                  {codeRemaining.length > 0 && (
                    <div>
                      <button
                        type="button"
                        style={{ ...ghost, marginTop: 4 }}
                        disabled={!!busy}
                        title="The AI reads the script and judges each finding: confirmed ones get a concrete explanation in the AI section; false positives are auto-ignored. Uses model credits."
                        onClick={adjudicate}
                      >
                        ◇ Ask AI about these findings
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
            {audit && !auditStale && audit.passed && !audit.skipped && (
              <p style={{ color: 'var(--ink-3)', fontSize: 13, margin: '8px 0 0' }}>
                Checks pass — the step completes on the next status refresh.
              </p>
            )}
            {rev.text.trim() && !confirmSkip && ((audit && !auditStale && !audit.passed) || aiFindings.some((f) => !ignored.has(fkey(f)))) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
                <FeedbackButton
                  label={ignoredBlocking.length ? 'Fix the rest' : 'Fix these'}
                  busy={busy === 'ai'}
                  disabled={!!busy}
                  title="AI revises this script to address the findings (minus any you ignored) — checks re-run automatically. Uses model credits."
                  rulesFocus="story"
                  onRun={(fb) => runReview(composeAuditFeedback(fb), true)}
                />
                <ModelPicker model={model} onChange={setModel} disabled={!!busy} />
                {audit && !auditStale && !audit.passed ? (
                  <button style={ghost} disabled={!!busy} onClick={() => setConfirmSkip(true)}>
                    Skip the checks
                  </button>
                ) : null}
              </div>
            )}
            {confirmSkip && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
                <span style={{ color: 'var(--amber)', fontSize: 13 }}>
                  ⚠ Skipping means rule violations reach production unchecked — the storyboard and
                  narration are built from this script. The skip is recorded in the audit files.
                </span>
                <button style={{ ...ghost, color: 'var(--amber)', borderColor: 'var(--amber)' }} onClick={skipAudit}>
                  Skip anyway
                </button>
                <button style={ghost} onClick={() => setConfirmSkip(false)}>Cancel</button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

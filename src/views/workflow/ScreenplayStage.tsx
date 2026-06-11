import { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { FeedbackButton } from './FeedbackButton'
import { useSourceWords, ThinSourceNote } from '../../lib/useSourceWords'
import { useWorkflowStore } from '../../store/workflow'

const SESSION = 'spoolcast-dev-log-12'
const API = 'http://localhost:8000/api'

type StationKey = 'listener' | 'screenplay'
const FILES: Record<StationKey, string> = {
  listener: 'working/listener-draft.md',
  screenplay: 'working/screenplay-v3.md',
}

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

/**
 * Step 6 — Screenplay, three flat sections (no nested boxes):
 *   1 · Initial script — AI writes the narration prose (or write it yourself)
 *   2 · Final script   — AI tightens it (or edit by hand)
 *   3 · Audit          — BOTH deterministic rule checks (script rules + voice
 *       rules; the voice check is what flips the T gate). Skippable, with a
 *       warning — the skip is recorded honestly in the audit files.
 */
export function ScreenplayStage({ stageId }: { stageId: string }) {
  const drafts = useWorkflowStore((s) => s.stageDrafts)
  const setStageFileDraft = useWorkflowStore((s) => s.setStageFileDraft)
  const seedStageFileDraft = useWorkflowStore((s) => s.seedStageFileDraft)
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<StationKey | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [audit, setAudit] = useState<AuditView | null>(null)
  const [confirmSkip, setConfirmSkip] = useState(false)
  // The rewind prompt carries the feedback that triggered it — after "set back
  // to pending", the SAME instructions run (losing them silently re-polished
  // generically and reproduced the very findings the user asked to fix).
  const [needRewind, setNeedRewind] = useState<{ st: StationKey; feedback: string } | null>(null)
  const rewindRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (needRewind) rewindRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [needRewind])
  // Station collapse: while the Final script exists, the Draft station folds
  // to one line (expandable) — the user works on one thing at a time.
  const [collapseOverride, setCollapseOverride] = useState<Partial<Record<StationKey, boolean>>>({})
  const isCollapsed = (st: StationKey) =>
    collapseOverride[st] ?? (st === 'listener' && draftOf('screenplay').trim() !== '')
  // Diff highlight: show where the Final script changed from the Draft.
  const [showDiff, setShowDiff] = useState(true)
  // PER-ISSUE IGNORE: ignored findings are excluded from what Re-polish asks
  // the AI to fix (and listed as "leave alone"). The CHECKS still see them —
  // waiving the gate itself stays the explicit "Skip the checks" act.
  const [ignored, setIgnored] = useState<Set<string>>(new Set())
  const [hoverIssue, setHoverIssue] = useState<string | null>(null)
  const fkey = (f: { label: string; detail: string }) => `${f.label}:${f.detail}`
  const toggleIgnore = (k: string) =>
    setIgnored((s) => {
      const next = new Set(s)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  const remainingBlocking = audit ? audit.blocking.filter((f) => !ignored.has(fkey(f))) : []
  const ignoredBlocking = audit ? audit.blocking.filter((f) => ignored.has(fkey(f))) : []
  const composeAuditFeedback = (fb: string) => {
    const parts: string[] = []
    if (fb.trim()) parts.push(fb.trim())
    if (remainingBlocking.length)
      parts.push('Fix these rule-check findings:\n' + remainingBlocking.map((f) => `- ${f.detail}`).join('\n'))
    if (ignoredBlocking.length)
      parts.push(
        'The user chose to IGNORE these findings — do NOT rework the script for them:\n' +
          ignoredBlocking.map((f) => `- ${f.detail}`).join('\n'),
      )
    return parts.join('\n')
  }
  const seededRef = useRef(false)
  const sourceWords = useSourceWords()

  const key = (st: StationKey) => `${stageId}:${st}`
  const draftOf = (st: StationKey) => drafts[key(st)] ?? ''

  // Word count + estimated speaking time (the engine plans at ~2.4 words/sec).
  const stats = (text: string) => {
    const body = text
      .split('\n')
      .filter((l) => !l.startsWith('#') && !l.startsWith('Voice source:'))
      .join(' ')
    const words = body.split(/\s+/).filter(Boolean).length
    const secs = Math.round(words / 2.4)
    return { words, time: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` }
  }

  // Rendered view shows only the narration — the document plumbing (title,
  // voice-source path, section heading) stays in the file but not on screen.
  const displayBody = (text: string) =>
    text
      .split('\n')
      .filter((l) => !/^#\s/.test(l) && !/^##\s*Narration\s*$/i.test(l) && !l.startsWith('Voice source:'))
      .join('\n')
      .trim()

  useEffect(() => {
    if (seededRef.current) return
    seededRef.current = true
    ;(Object.keys(FILES) as StationKey[]).forEach((st) => {
      fetch(`${API}/file?session=${SESSION}&path=${encodeURIComponent(FILES[st])}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((out) => {
          if (out?.ok && out.data?.exists && typeof out.data.content === 'string') {
            const store = useWorkflowStore.getState()
            if ((store.stageDrafts[key(st)] ?? '') === '') seedStageFileDraft(key(st), out.data.content)
          }
        })
        .catch(() => {})
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const post = (body: object) =>
    fetch(`${API}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: SESSION, tenant: 'local', ...body }),
    })

  const saveDraft = async (st: StationKey) => {
    // Read straight from the store: callers may have just set the draft and the
    // component closure can be one render behind.
    const content = useWorkflowStore.getState().stageDrafts[key(st)] ?? ''
    if (!content.trim()) return true
    const r = await post({ action: 'set_stage_output', stage_id: stageId, path: FILES[st], content })
    return r.ok
  }

  const runDraft = async (st: StationKey, feedback = '') => {
    setBusy(st)
    setErr(null)
    try {
      if (st === 'screenplay') await saveDraft('listener')
      const r = await post({
        action: 'draft_stage',
        stage_id: stageId,
        variant: st,
        allow_cost: true,
        ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
      })
      const out = await r.json().catch(() => null)
      if (!r.ok || out?.ok === false) {
        if (out?.error === 'illegal_action') {
          // The engine has moved past this step (stale files / earlier approval).
          setNeedRewind({ st, feedback })
          return
        }
        setErr(out?.message || out?.error || 'Drafting failed.')
        return
      }
      const fr = await fetch(`${API}/file?session=${SESSION}&path=${encodeURIComponent(FILES[st])}`)
      const fileOut = await fr.json().catch(() => null)
      if (fileOut?.ok && fileOut.data?.exists) setStageFileDraft(stageId, key(st), fileOut.data.content)
      // MERGED POLISH+CHECK: the engine audits the polished script in the same
      // operation — results arrive with the draft.
      if (st === 'screenplay' && out?.data?.audits) {
        const view: AuditView = { passed: true, blocking: [], warnings: [] }
        for (const [k, label] of [['screenplay', 'script'], ['narration', 'voice']] as const) {
          const d = out.data.audits[k]
          if (!d?.ok) {
            setErr(d?.message || `${label} check could not run.`)
            setAudit(null)
            return
          }
          if (!d.passed) view.passed = false
          for (const f of d.blocking || []) view.blocking.push({ label, detail: f.detail || f.message || f.type || JSON.stringify(f) })
          for (const f of d.warnings || []) view.warnings.push({ label, detail: f.detail || f.message || f.type || JSON.stringify(f) })
        }
        setAudit(view)
      } else {
        setAudit(null)
      }
    } catch {
      setErr('Could not reach the engine.')
    } finally {
      setBusy(null)
    }
  }

  // BOTH rule checks: script rules first, then narration voice rules (the
  // voice review file is what the T gate on the canvas watches).
  const runAudit = async () => {
    setBusy('audit')
    setErr(null)
    setConfirmSkip(false)
    try {
      const ok1 = await saveDraft('listener')
      const ok2 = await saveDraft('screenplay')
      if (!ok1 || !ok2) {
        setErr('Could not save drafts to the engine.')
        return
      }
      const view: AuditView = { passed: true, blocking: [], warnings: [] }
      for (const [stage, label] of [
        ['screenplay', 'script'],
        ['narration', 'voice'],
      ] as const) {
        const r = await post({ action: 'run_audit', stage })
        const out = await r.json().catch(() => null)
        if (!r.ok || out?.ok === false) {
          setErr(out?.message || out?.error || `${label} check failed to run.`)
          return
        }
        const d = out.data
        if (!d.passed) view.passed = false
        for (const f of d.blocking || []) view.blocking.push({ label, detail: f.detail || f.message || f.type || JSON.stringify(f) })
        for (const f of d.warnings || []) view.warnings.push({ label, detail: f.detail || f.message || f.type || JSON.stringify(f) })
      }
      setAudit(view)
    } catch {
      setErr('Could not reach the engine.')
    } finally {
      setBusy(null)
    }
  }

  // SKIP (recorded honestly): writes both audit files marked as skipped so the
  // protocol records that the checks were waived, never that they passed.
  const skipAudit = async () => {
    setConfirmSkip(false)
    setBusy('audit')
    setErr(null)
    try {
      await saveDraft('listener')
      await saveDraft('screenplay')
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
    } catch {
      setErr('Could not reach the engine.')
    } finally {
      setBusy(null)
    }
  }

  const ghost: React.CSSProperties = {
    background: 'none', border: '1px solid var(--line, #2a3142)', borderRadius: 6,
    color: 'var(--ink-2)', padding: '6px 12px', cursor: 'pointer', fontSize: 12,
  }
  const section: React.CSSProperties = { padding: '16px 0', borderTop: '1px solid var(--line, #2a3142)' }

  const station = (st: StationKey, num: string, title: string, blurb: string, actionLabel: string, disabledReason?: string, footer?: React.ReactNode) => {
    const draft = draftOf(st)
    const enabled = !disabledReason && !busy
    const s = stats(draft)
    const collapsed = isCollapsed(st)
    const chevron = (
      <button
        type="button"
        title={collapsed ? 'Expand' : 'Collapse'}
        onClick={() => setCollapseOverride((o) => ({ ...o, [st]: !collapsed }))}
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--ink-3)', display: 'flex' }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: collapsed ? 'rotate(-90deg)' : 'none', transition: 'transform .15s ease' }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
    )
    if (collapsed) {
      return (
        <div style={num === '1' ? { ...section, borderTop: 'none', paddingTop: 4 } : section}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {chevron}
            <h3 style={{ margin: 0, fontSize: 15, color: 'var(--ink-2)', cursor: 'pointer' }} onClick={() => setCollapseOverride((o) => ({ ...o, [st]: false }))}>
              {num} · {title}
            </h3>
            <span style={{ flex: 1 }} />
            {draft.trim() && (
              <span style={{ color: 'var(--ink-3)', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                {s.words} words · ~{s.time}
              </span>
            )}
          </div>
        </div>
      )
    }
    return (
      <div style={num === '1' ? { ...section, borderTop: 'none', paddingTop: 4 } : section}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {chevron}
          <h3 style={{ margin: 0, fontSize: 15, cursor: 'help' }} title={blurb}>{num} · {title}</h3>
          <span style={{ flex: 1 }} />
          {draft.trim() && (
            <span style={{ color: 'var(--ink-3)', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
              {s.words} words · ~{s.time}
            </span>
          )}
          {st === 'screenplay' && audit && (
            <button
              type="button"
              title={audit.passed || audit.skipped ? undefined : 'Jump to the issues'}
              onClick={() => document.getElementById(`audit-findings-${stageId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
              style={{
                background: 'none', border: 'none', padding: 0,
                cursor: audit.passed || audit.skipped ? 'default' : 'pointer',
                fontSize: 13,
                color: audit.skipped ? 'var(--amber)' : audit.passed ? 'var(--green, #4ade80)' : 'var(--red)',
              }}
            >
              {audit.skipped
                ? '△ checks skipped'
                : audit.passed
                  ? audit.warnings.length
                    ? `✓ checks passed · ${audit.warnings.length} warning(s)`
                    : '✓ checks passed'
                  : `✕ ${remainingBlocking.length} blocking issue(s)${ignoredBlocking.length ? ` · ${ignoredBlocking.length} ignored` : ''}`}
            </button>
          )}
          {st === 'screenplay' && draft.trim() && draftOf('listener').trim() && (
            <button
              style={{ ...ghost, color: showDiff ? 'var(--ink)' : 'var(--ink-2)' }}
              title="Highlight what the polish changed from the draft script"
              onClick={() => setShowDiff((v) => !v)}
            >
              Changes {showDiff ? 'on' : 'off'}
            </button>
          )}
          {st === 'screenplay' && draft.trim() && (
            <button
              style={ghost}
              disabled={!!busy}
              title="Free — saves your edits and re-runs both rule checks"
              onClick={runAudit}
            >
              {busy === 'audit' ? 'Checking…' : 'Re-check'}
            </button>
          )}
          {st === 'screenplay' && draftOf('listener').trim() && (
            <button
              style={ghost}
              disabled={!!busy}
              title="No AI, no cost — takes the draft script exactly as it is, then runs the checks"
              onClick={async () => {
                const copied = draftOf('listener').replace(/^#\s*Listener Draft/i, '# Screenplay v3')
                setStageFileDraft(stageId, key('screenplay'), copied)
                setAudit(null)
                await runAudit()
              }}
            >
              Use draft as-is
            </button>
          )}
          <FeedbackButton
            label={draft.trim() ? `Re-${actionLabel.toLowerCase()}` : actionLabel}
            busy={busy === st}
            disabled={!enabled}
            title={disabledReason || `Uses model credits${draft.trim() ? ' · replaces the current text' : ''}`}
            rulesFocus="story"
            onRun={(fb) => runDraft(st, fb)}
          />
        </div>
        {/* WORK IN PROGRESS: while the AI rewrites this station, say so where
            the user is looking — spinner over the text, content dimmed+locked. */}
        <div style={{ position: 'relative' }}>
          {busy === st ? (
            <div
              style={{
                position: 'absolute', inset: 0, zIndex: 2,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                background: 'rgba(10, 12, 18, .45)', borderRadius: 8, minHeight: 80,
              }}
            >
              <span className="spin" />
              <span style={{ color: 'var(--ink-1)', fontSize: 13 }}>
                {st === 'screenplay' ? 'AI is polishing the script…' : 'AI is writing the draft…'}
              </span>
            </div>
          ) : null}
          <div style={busy === st ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
            {editing === st ? (
              <textarea
                autoFocus
                value={draft}
                placeholder="Write the narration here…"
                onChange={(e) => setStageFileDraft(stageId, key(st), e.target.value)}
                onBlur={() => setEditing(null)}
                style={{
                  width: '100%', minHeight: 240, marginTop: 10, resize: 'vertical', background: 'transparent',
                  color: 'var(--ink-1, inherit)', border: '1px solid var(--line, #2a3142)', borderRadius: 8,
                  padding: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, lineHeight: 1.55,
                }}
              />
            ) : draft.trim() ? (
              (() => {
                const diff =
                  st === 'screenplay' && showDiff && draftOf('listener').trim()
                    ? diffTokens(displayBody(draftOf('listener')), displayBody(draft))
                    : null
                return diff ? (
                  // CHANGES VIEW: the final script with everything that differs
                  // from the draft tinted. Click to edit, as usual.
                  <div
                    title="Click to edit · tinted = changed from the draft script"
                    onClick={() => setEditing(st)}
                    style={{ marginTop: 6, cursor: 'text', fontSize: 14, lineHeight: 1.75, color: 'var(--ink-2)', whiteSpace: 'pre-wrap' }}
                  >
                    {diff.tokens.map((t, k) =>
                      diff.marks[k] ? (
                        <span key={k} style={{ background: 'rgba(143, 161, 255, .18)', borderRadius: 3, color: 'var(--ink)' }}>{t}</span>
                      ) : (
                        <span key={k}>{t}</span>
                      ),
                    )}
                  </div>
                ) : (
                  <div
                    className="md-preview"
                    title="Click to edit"
                    onClick={() => setEditing(st)}
                    style={{ marginTop: 6, cursor: 'text' }}
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(displayBody(draft), { async: false }) as string) }}
                  />
                )
              })()
            ) : (
              <button
                type="button"
                onClick={() => setEditing(st)}
                style={{ background: 'none', border: 'none', padding: 0, marginTop: 10, color: 'var(--ink-3)', fontSize: 13, cursor: 'pointer' }}
              >
                ▸ or write it yourself
              </button>
            )}
          </div>
        </div>
        {footer}
      </div>
    )
  }

  return (
    <div>
      {err && <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10 }}>Engine: {err}</div>}
      {needRewind && (
        <div
          ref={rewindRef}
          style={{
            margin: '4px 0 18px',
            borderLeft: '2px solid var(--amber)',
            padding: '10px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <b style={{ fontSize: 13, color: 'var(--amber)' }}>This step is already approved</b>
          <p style={{ color: 'var(--ink-2)', fontSize: 13, margin: 0, lineHeight: 1.5, maxWidth: 560 }}>
            Making a new draft sets this step and everything after it back to pending — you review
            and approve them again as you go.{needRewind.feedback ? ' Your feedback carries over to the new draft.' : ''}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="save-continue"
              style={{ width: 'auto', padding: '8px 14px' }}
              onClick={async () => {
                const { st, feedback } = needRewind
                setNeedRewind(null)
                try {
                  const r = await post({ action: 'rewind_stage', stage_id: stageId })
                  const out = await r.json().catch(() => null)
                  if (!r.ok || out?.ok === false) {
                    setErr(out?.message || out?.error || 'Could not set the step back to pending.')
                    return
                  }
                  setAudit(null)
                  await runDraft(st, feedback) // SAME instructions, not a generic re-run
                } catch {
                  setErr('Could not reach the engine.')
                }
              }}
            >
              Set back to pending & make the new draft
            </button>
            <button style={ghost} onClick={() => setNeedRewind(null)}>Never mind, keep it</button>
          </div>
        </div>
      )}
      <div style={{ marginBottom: 4 }}>
        <ThinSourceNote words={sourceWords} />
      </div>

      {station('listener', '1', 'Draft script', 'the first full draft — written to work by ear alone', 'Write it')}
      {station(
        'screenplay',
        '2',
        'Final script',
        'polished and rule-checked — the version that gets recorded',
        'Polish it',
        draftOf('listener').trim() ? undefined : 'Write the draft script first',
        // MERGED CHECKS FOOTER: findings, the skip escape hatch, and the pass note
        // all live inside this station — polishing and checking are one thing.
        <>
          {audit && (audit.blocking.length > 0 || audit.warnings.length > 0) && (
            <div id={`audit-findings-${stageId}`} style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {audit.blocking.map((f, i) => {
                const k = fkey(f)
                const isIgnored = ignored.has(k)
                return (
                  <div
                    key={`b${i}`}
                    onMouseEnter={() => setHoverIssue(k)}
                    onMouseLeave={() => setHoverIssue(null)}
                    style={{
                      display: 'flex', alignItems: 'baseline', gap: 8,
                      borderLeft: `2px solid ${isIgnored ? 'var(--line, #2a3142)' : 'var(--red)'}`,
                      padding: '2px 10px', fontSize: 13, opacity: isIgnored ? 0.5 : 1,
                    }}
                  >
                    <span style={{ color: isIgnored ? 'var(--ink-3)' : 'var(--red)', whiteSpace: 'nowrap' }}>✕ {f.label}</span>
                    <span style={{ color: 'var(--ink-2)', flex: 1 }}>{f.detail}</span>
                    {hoverIssue === k || isIgnored ? (
                      <button
                        type="button"
                        style={{ ...ghost, padding: '1px 8px', fontSize: 11, whiteSpace: 'nowrap' }}
                        title={
                          isIgnored
                            ? 'Re-polish will try to fix this again'
                            : 'Re-polish won’t chase this — the check itself still flags it (use Skip the checks to waive the gate)'
                        }
                        onClick={() => toggleIgnore(k)}
                      >
                        {isIgnored ? 'Un-ignore' : 'Ignore this issue'}
                      </button>
                    ) : null}
                  </div>
                )
              })}
              {audit.warnings.map((f, i) => (
                <div key={`w${i}`} style={{ borderLeft: '2px solid var(--amber)', padding: '2px 10px', fontSize: 13 }}>
                  <span style={{ color: 'var(--amber)' }}>△ {f.label}</span>
                  <span style={{ color: 'var(--ink-2)', marginLeft: 8 }}>{f.detail}</span>
                </div>
              ))}
            </div>
          )}
          {audit && audit.passed && !audit.skipped && (
            <p style={{ color: 'var(--ink-3)', fontSize: 13, margin: '8px 0 0' }}>
              Checks pass — the step completes on the next status refresh.
            </p>
          )}
          {draftOf('screenplay').trim() && !confirmSkip && audit && !audit.passed && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
              <FeedbackButton
                label={ignoredBlocking.length ? 'Re-polish (fix the rest)' : 'Re-polish to fix these'}
                busy={busy === 'screenplay'}
                disabled={!!busy && busy !== 'screenplay'}
                title="Re-polishes the script to address the findings above (minus any you ignored) — uses model credits"
                rulesFocus="story"
                onRun={(fb) => runDraft('screenplay', composeAuditFeedback(fb))}
              />
              <button style={ghost} disabled={!!busy} onClick={() => setConfirmSkip(true)}>
                Skip the checks
              </button>
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
        </>,
      )}
    </div>
  )
}

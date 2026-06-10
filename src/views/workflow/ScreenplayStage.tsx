import { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useSourceWords, ThinSourceNote } from '../../lib/useSourceWords'
import { useWorkflowStore } from '../../store/workflow'

const SESSION = 'spoolcast-dev-log-12'
const API = 'http://localhost:8000/api'

type StationKey = 'listener' | 'screenplay'
const FILES: Record<StationKey, string> = {
  listener: 'working/listener-draft.md',
  screenplay: 'working/screenplay-v3.md',
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
    const content = draftOf(st)
    if (!content.trim()) return true
    const r = await post({ action: 'set_stage_output', stage_id: stageId, path: FILES[st], content })
    return r.ok
  }

  const runDraft = async (st: StationKey) => {
    setBusy(st)
    setErr(null)
    try {
      if (st === 'screenplay') await saveDraft('listener')
      const r = await post({ action: 'draft_stage', stage_id: stageId, variant: st, allow_cost: true })
      const out = await r.json().catch(() => null)
      if (!r.ok || out?.ok === false) {
        setErr(out?.message || out?.error || 'Drafting failed.')
        return
      }
      const fr = await fetch(`${API}/file?session=${SESSION}&path=${encodeURIComponent(FILES[st])}`)
      const fileOut = await fr.json().catch(() => null)
      if (fileOut?.ok && fileOut.data?.exists) setStageFileDraft(stageId, key(st), fileOut.data.content)
      setAudit(null)
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
  const aiBtn = (enabled: boolean): { className?: string; style: React.CSSProperties } =>
    enabled
      ? { className: 'save-continue', style: { width: 'auto', padding: '8px 16px' } }
      : { style: { ...ghost, opacity: 0.45, cursor: 'default' } }

  const section: React.CSSProperties = { padding: '16px 0', borderTop: '1px solid var(--line, #2a3142)' }

  const station = (st: StationKey, num: string, title: string, blurb: string, actionLabel: string, disabledReason?: string) => {
    const draft = draftOf(st)
    const enabled = !disabledReason && !busy
    const b = aiBtn(enabled)
    const s = stats(draft)
    return (
      <div style={num === '1' ? { ...section, borderTop: 'none', paddingTop: 4 } : section}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h3 style={{ margin: 0, fontSize: 15, cursor: 'help' }} title={blurb}>{num} · {title}</h3>
          <span style={{ flex: 1 }} />
          {draft.trim() && (
            <span style={{ color: 'var(--ink-3)', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
              {s.words} words · ~{s.time}
            </span>
          )}
          {st === 'screenplay' && draftOf('listener').trim() && (
            <button
              style={ghost}
              disabled={!!busy}
              title="No AI, no cost — takes the draft script exactly as it is"
              onClick={() => {
                const copied = draftOf('listener').replace(/^#\s*Listener Draft/i, '# Screenplay v3')
                setStageFileDraft(stageId, key('screenplay'), copied)
                setAudit(null)
              }}
            >
              Use draft as-is
            </button>
          )}
          <button
            className={b.className}
            style={b.style}
            disabled={!enabled}
            title={disabledReason || `Uses model credits${draft.trim() ? ' · replaces the current text' : ''}`}
            onClick={() => runDraft(st)}
          >
            ✦ {busy === st ? 'Writing…' : draft.trim() ? `Re-${actionLabel.toLowerCase()}` : actionLabel}
          </button>
        </div>
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
          <div
            className="md-preview"
            title="Click to edit"
            onClick={() => setEditing(st)}
            style={{ marginTop: 6, cursor: 'text' }}
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(displayBody(draft), { async: false }) as string) }}
          />
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
    )
  }

  return (
    <div>
      {err && <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10 }}>Engine: {err}</div>}
      <div style={{ marginBottom: 4 }}>
        <ThinSourceNote words={sourceWords} />
      </div>

      {station('listener', '1', 'Draft script', 'the first full draft — written to work by ear alone', 'Write it')}
      {station('screenplay', '2', 'Polished script', 'the version that gets recorded — refine it, or take the draft as-is', 'Polish it',
        draftOf('listener').trim() ? undefined : 'Write the draft script first')}

      {/* 3 · AUDIT — both deterministic rule checks */}
      <div style={section}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h3
            style={{ margin: 0, fontSize: 15, cursor: 'help' }}
            title="Two automatic rule checks (script + narration voice) — free · must pass (or be skipped) before you can continue"
          >
            3 · Audit
          </h3>
          <span style={{ flex: 1 }} />
          {audit && (
            <span style={{ fontSize: 13, color: audit.skipped ? 'var(--amber)' : audit.passed ? 'var(--green, #4ade80)' : 'var(--red)' }}>
              {audit.skipped ? '△ SKIPPED' : audit.passed ? (audit.warnings.length ? `✓ PASSED · ${audit.warnings.length} warning(s)` : '✓ PASSED') : `✕ ${audit.blocking.length} blocking issue(s)`}
            </span>
          )}
          {(() => {
            const ready = !!draftOf('screenplay').trim() && !busy
            const b = aiBtn(ready)
            return (
              <button
                className={b.className}
                style={b.style}
                disabled={!ready}
                title={!draftOf('screenplay').trim() ? 'Produce the polished script first' : 'Saves your edits, then runs both rule checks'}
                onClick={runAudit}
              >
                {busy === 'audit' ? 'Checking…' : 'Run audit'}
              </button>
            )
          })()}
          <button
            style={{ ...ghost, opacity: draftOf('screenplay').trim() && !busy ? 1 : 0.45 }}
            disabled={!draftOf('screenplay').trim() || !!busy}
            onClick={() => setConfirmSkip(true)}
          >
            Skip
          </button>
        </div>
        {confirmSkip && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
            <span style={{ color: 'var(--amber)', fontSize: 13 }}>
              ⚠ Skipping means rule violations reach production unchecked — the storyboard and narration
              are built from this script. The skip is recorded in the audit files.
            </span>
            <button style={{ ...ghost, color: 'var(--amber)', borderColor: 'var(--amber)' }} onClick={skipAudit}>
              Skip anyway
            </button>
            <button style={ghost} onClick={() => setConfirmSkip(false)}>Cancel</button>
          </div>
        )}
        {audit && (audit.blocking.length > 0 || audit.warnings.length > 0) && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {audit.blocking.map((f, i) => (
              <div key={`b${i}`} style={{ borderLeft: '2px solid var(--red)', padding: '2px 10px', fontSize: 13 }}>
                <span style={{ color: 'var(--red)' }}>✕ {f.label}</span>
                <span style={{ color: 'var(--ink-2)', marginLeft: 8 }}>{f.detail}</span>
              </div>
            ))}
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
            Both checks pass — the step completes on the next status refresh.
          </p>
        )}
      </div>
    </div>
  )
}

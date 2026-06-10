import { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useWorkflowStore } from '../../store/workflow'

const SESSION = 'spoolcast-dev-log-12'
const API = 'http://localhost:8000/api'

type StationKey = 'listener' | 'screenplay'
const FILES: Record<StationKey, string> = {
  listener: 'working/listener-draft.md',
  screenplay: 'working/screenplay-v3.md',
}

/**
 * Step 6 — Screenplay, as three stations:
 *   1. Listener draft  — AI writes the narration as prose judged by ear
 *      (auto-creates source-analysis.md first if the rule gate needs it)
 *   2. Final narration — AI tightens the listener draft into screenplay-v3
 *   3. Audit           — the deterministic rule-gated check; the step can only
 *      pass when it's green. Findings are listed with their details.
 * Each station has the rendered-markdown/click-to-edit editor. Edits are saved
 * to the engine when the audit runs (the audit judges what's on disk).
 */
export function ScreenplayStage({ stageId }: { stageId: string }) {
  const drafts = useWorkflowStore((s) => s.stageDrafts)
  const setStageFileDraft = useWorkflowStore((s) => s.setStageFileDraft)
  const seedStageFileDraft = useWorkflowStore((s) => s.seedStageFileDraft)
  const [busy, setBusy] = useState<string | null>(null) // which station is running
  const [editing, setEditing] = useState<StationKey | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [audit, setAudit] = useState<{ passed: boolean; exit: number; blocking: any[]; warnings: any[] } | null>(null)
  const seededRef = useRef(false)

  const key = (st: StationKey) => `${stageId}:${st}`
  const draftOf = (st: StationKey) => drafts[key(st)] ?? ''

  // Prefill both stations from the engine's real files once per mount.
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
      // The screenplay pass reads the listener draft from disk — save edits first.
      if (st === 'screenplay') await saveDraft('listener')
      const r = await post({ action: 'draft_stage', stage_id: stageId, variant: st, allow_cost: true })
      const out = await r.json().catch(() => null)
      if (!r.ok || out?.ok === false) {
        setErr(out?.message || out?.error || 'Drafting failed.')
        return
      }
      const fr = await fetch(`${API}/file?session=${SESSION}&path=${encodeURIComponent(FILES[st])}`)
      const fileOut = await fr.json().catch(() => null)
      if (fileOut?.ok && fileOut.data?.exists) {
        setStageFileDraft(stageId, key(st), fileOut.data.content) // un-reviewed AI output = dirty
      }
      setAudit(null) // content changed — previous audit verdict no longer applies
    } catch {
      setErr('Could not reach the engine.')
    } finally {
      setBusy(null)
    }
  }

  const runAudit = async () => {
    setBusy('audit')
    setErr(null)
    try {
      // The audit judges files on disk — persist both editors first.
      const ok1 = await saveDraft('listener')
      const ok2 = await saveDraft('screenplay')
      if (!ok1 || !ok2) {
        setErr('Could not save drafts to the engine.')
        return
      }
      const r = await post({ action: 'run_audit', stage: 'screenplay' })
      const out = await r.json().catch(() => null)
      if (!r.ok || out?.ok === false) {
        setErr(out?.message || out?.error || 'Audit failed to run.')
        return
      }
      setAudit(out.data)
    } catch {
      setErr('Could not reach the engine.')
    } finally {
      setBusy(null)
    }
  }

  const btn: React.CSSProperties = {
    background: 'none', border: '1px solid var(--line, #2a3142)', borderRadius: 6,
    color: 'var(--ink-2)', padding: '6px 12px', cursor: 'pointer', fontSize: 12,
  }

  const station = (
    st: StationKey,
    num: string,
    title: string,
    blurb: string,
    actionLabel: string,
    disabledReason?: string,
  ) => {
    const draft = draftOf(st)
    return (
      <div className="card" style={{ marginBottom: 12, padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>{num} · {title}</h3>
          <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>{blurb}</span>
          <span style={{ flex: 1 }} />
          <span style={{ color: 'var(--ink-3)', fontSize: 11 }}>uses model credits{draft.trim() ? ' · replaces the text' : ''}</span>
          <button
            style={{ ...btn, opacity: disabledReason || busy ? 0.5 : 1 }}
            disabled={!!disabledReason || !!busy}
            title={disabledReason || 'Runs the AI — uses model credits'}
            onClick={() => runDraft(st)}
          >
            ✦ {busy === st ? 'Writing…' : draft.trim() ? `Re-${actionLabel.toLowerCase()}` : actionLabel}
          </button>
        </div>
        {draft.trim() ? (
          editing === st ? (
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setStageFileDraft(stageId, key(st), e.target.value)}
              onBlur={() => setEditing(null)}
              style={{
                width: '100%', minHeight: 260, marginTop: 10, resize: 'vertical', background: 'transparent',
                color: 'var(--ink-1, inherit)', border: '1px solid var(--line, #2a3142)', borderRadius: 8,
                padding: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, lineHeight: 1.55,
              }}
            />
          ) : (
            <div
              className="md-preview"
              title="Click to edit"
              onClick={() => setEditing(st)}
              style={{ marginTop: 10, border: '1px solid var(--line, #2a3142)', borderRadius: 8, padding: '4px 16px', cursor: 'text' }}
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(draft, { async: false }) as string) }}
            />
          )
        ) : (
          <p style={{ color: 'var(--ink-3)', fontSize: 13, margin: '10px 0 0' }}>
            Nothing yet — use the button above, or click here to write it yourself.
          </p>
        )}
      </div>
    )
  }

  return (
    <div>
      {err && <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10 }}>Engine: {err}</div>}

      {station(
        'listener',
        '1',
        'Initial script',
        'the first full draft — written to work by ear alone',
        'Write it',
      )}
      {station(
        'screenplay',
        '2',
        'Final script',
        'the polished version that gets recorded',
        'Polish it',
        draftOf('listener').trim() ? undefined : 'Write the initial script first',
      )}

      {/* STATION 3 — the deterministic, rule-gated audit */}
      <div className="card" style={{ marginBottom: 12, padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>3 · Final check</h3>
          <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>
            automatic rule check — free · must pass before you can continue
          </span>
          <span style={{ flex: 1 }} />
          {audit && (
            <span style={{ fontSize: 13, color: audit.passed ? 'var(--green, #4ade80)' : audit.exit === 1 ? 'var(--amber)' : 'var(--red)' }}>
              {audit.passed ? '✓ PASSED' : audit.exit === 1 ? `△ ${audit.warnings.length} warning(s)` : `✕ ${audit.blocking.length} blocking issue(s)`}
            </span>
          )}
          <button
            style={{ ...btn, opacity: busy || !draftOf('screenplay').trim() ? 0.5 : 1 }}
            disabled={!!busy || !draftOf('screenplay').trim()}
            title={!draftOf('screenplay').trim() ? 'Produce the final script first' : 'Saves your edits, then runs the rule check'}
            onClick={runAudit}
          >
            {busy === 'audit' ? 'Checking…' : 'Run check'}
          </button>
        </div>
        {audit && (audit.blocking.length > 0 || audit.warnings.length > 0) && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {audit.blocking.map((f: any, i: number) => (
              <div key={`b${i}`} style={{ border: '1px solid var(--red)', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>
                <span style={{ color: 'var(--red)' }}>✕ {f.type || f.check || 'blocking'}</span>
                <span style={{ color: 'var(--ink-2)', marginLeft: 8 }}>{f.detail || f.message || JSON.stringify(f)}</span>
              </div>
            ))}
            {audit.warnings.map((f: any, i: number) => (
              <div key={`w${i}`} style={{ border: '1px solid var(--amber)', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>
                <span style={{ color: 'var(--amber)' }}>△ {f.type || f.check || 'warning'}</span>
                <span style={{ color: 'var(--ink-2)', marginLeft: 8 }}>{f.detail || f.message || JSON.stringify(f)}</span>
              </div>
            ))}
          </div>
        )}
        {audit && audit.passed && (
          <p style={{ color: 'var(--ink-3)', fontSize: 13, margin: '8px 0 0' }}>
            All three screenplay files exist and the rules pass — the step completes on the next status refresh.
          </p>
        )}
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { actionUrl, activeSession, apiUrl } from '../lib/api'

// RECENT SAVES: the automatic snapshots taken before every "start over",
// listed newest-first with one-click restore (the explicit human undo).

type SavePoint = { id: string; created_at?: string; rewound_stage?: string | null; kind?: string; files: number }

const plain = (stageId?: string) => (stageId ? stageId.replace(/_/g, ' ') : 'unknown step')

export function SavePointsModal({ onClose, onToast }: { onClose: () => void; onToast: (m: string) => void }) {
  const [points, setPoints] = useState<SavePoint[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [reloading, setReloading] = useState(false)

  useEffect(() => {
    fetch(apiUrl('save-points', { session: activeSession() }))
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        if (out?.ok && Array.isArray(out.data?.save_points)) setPoints(out.data.save_points)
        else setError('The engine did not return the save points.')
      })
      .catch(() => setError('Could not reach the engine — is it running?'))
  }, [])

  const restore = async (id: string) => {
    setBusy(id)
    try {
      const res = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: activeSession(), tenant: 'local', action: 'restore_save_point', save_point: id }),
      })
      const out = await res.json().catch(() => null)
      if (!res.ok || out?.ok === false) {
        onToast(`Engine: ${out?.message || out?.error || 'could not restore the save point.'}`)
        return
      }
      setReloading(true)
      onToast(`Restored ${out?.data?.restored?.length ?? ''} file(s) — reloading project.`)
      window.setTimeout(() => window.location.reload(), 400)
    } catch {
      onToast('Could not reach the engine.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="modal-scrim">
      <div className="confirm-modal" style={{ minWidth: 460 }}>
        <span className="need">AUTOMATIC</span>
        <h3>Recent saves</h3>
        <p>
          Your manual saves keep the last 10. Auto-saves — every ~10 minutes of activity and
          before every start-over — keep the last 6. Restoring puts those files and approvals back,
          then reloads the project.
        </p>
        {reloading ? <p className="label">Restore complete — reloading project…</p> : null}
        {error ? <p style={{ color: 'var(--red)', fontSize: 13 }}>{error}</p> : null}
        {points === null && !error ? <p className="label">Loading…</p> : null}
        {points !== null && points.length === 0 ? (
          <p style={{ color: 'var(--ink-2)', fontSize: 13 }}>No save points yet — nothing has been started over.</p>
        ) : null}
        {(points ?? []).map((p) => {
          const when = p.created_at ? new Date(p.created_at).toLocaleString() : p.id
          return (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', fontSize: 13 }}>
              <span style={{ color: 'var(--ink)' }}>{when}</span>
              <span style={{ color: 'var(--ink-3)', flex: 1 }}>
                {p.kind === 'manual'
                  ? 'saved by you'
                  : p.rewound_stage
                    ? `before starting over from ${plain(p.rewound_stage)}`
                    : 'auto-save'} · {p.files} file{p.files === 1 ? '' : 's'}
              </span>
              <button
                type="button"
                className="vp-undo"
                disabled={busy !== null || reloading}
                title="Puts these files and approvals back, replacing what's there now"
                onClick={() => restore(p.id)}
              >
                {reloading && busy === p.id ? 'Reloading…' : busy === p.id ? 'Restoring…' : 'Restore'}
              </button>
            </div>
          )
        })}
        <div className="actions">
          <button onClick={onClose} disabled={busy !== null || reloading}>Close</button>
        </div>
      </div>
    </div>
  )
}

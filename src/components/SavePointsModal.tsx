import { useEffect, useState } from 'react'

// RECENT SAVES: the automatic snapshots taken before every "start over",
// listed newest-first with one-click restore (the explicit human undo).

type SavePoint = { id: string; created_at?: string; rewound_stage?: string; files: number }

const plain = (stageId?: string) => (stageId ? stageId.replace(/_/g, ' ') : 'unknown step')

export function SavePointsModal({ onClose, onToast }: { onClose: () => void; onToast: (m: string) => void }) {
  const [points, setPoints] = useState<SavePoint[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    fetch('http://localhost:8000/api/save-points?session=spoolcast-dev-log-12')
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
      const res = await fetch('http://localhost:8000/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: 'spoolcast-dev-log-12', tenant: 'local', action: 'restore_save_point', save_point: id }),
      })
      const out = await res.json().catch(() => null)
      if (!res.ok || out?.ok === false) {
        onToast(`Engine: ${out?.message || out?.error || 'could not restore the save point.'}`)
        return
      }
      onToast(`Restored ${out?.data?.restored?.length ?? ''} file(s) — step statuses update in a moment.`)
      onClose()
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
        <p>A save point is kept every time you start over (the last 5). Restoring puts those files and approvals back.</p>
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
                before starting over from {plain(p.rewound_stage)} · {p.files} file{p.files === 1 ? '' : 's'}
              </span>
              <button
                type="button"
                className="vp-undo"
                disabled={busy !== null}
                title="Puts these files and approvals back, replacing what's there now"
                onClick={() => restore(p.id)}
              >
                {busy === p.id ? 'Restoring…' : 'Restore'}
              </button>
            </div>
          )
        })}
        <div className="actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

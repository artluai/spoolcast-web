import { useEffect, useState } from 'react'
import { actionUrl, apiUrl } from '../lib/api'

// THE SHOW BEHIND THE EPISODES. Clicking the show name in the top bar opens
// this: the series' rules (editorial conventions every episode inherits) and
// its optional contract overlay. Minimal on purpose — two files, two saves.

export function ShowSettingsModal({
  series,
  showName,
  onClose,
  onToast,
}: {
  series: string
  showName: string
  onClose: () => void
  onToast: (m: string) => void
}) {
  const [rules, setRules] = useState<string | null>(null)
  const [overlay, setOverlay] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState<{ rules: boolean; overlay: boolean }>({ rules: false, overlay: false })
  const [busy, setBusy] = useState(false)
  const [overlayOpen, setOverlayOpen] = useState(false)

  useEffect(() => {
    fetch(apiUrl('series', { series }))
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        if (!out?.ok) return setError('The engine did not return the show data.')
        if (!out.data?.exists) return setMissing(true)
        setRules(out.data.rules_md ?? '')
        setOverlay(out.data.overlay_json)
        if (out.data.overlay_json) setOverlayOpen(true)
      })
      .catch(() => setError('Could not reach the engine — is it running?'))
  }, [series])

  const save = async (file: 'rules.md' | 'contract-overlay.json', content: string) => {
    setBusy(true)
    try {
      const res = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: series, tenant: 'local', action: 'set_series_file', series, file, content }),
      })
      const out = await res.json().catch(() => null)
      if (!res.ok || out?.ok === false) {
        onToast(`Engine: ${out?.error || 'could not save.'}`)
        return
      }
      setDirty((d) => (file === 'rules.md' ? { ...d, rules: false } : { ...d, overlay: false }))
      onToast(`Saved ${file} for ${showName}.`)
    } finally {
      setBusy(false)
    }
  }

  const areaStyle: React.CSSProperties = {
    display: 'block', width: '100%', boxSizing: 'border-box', resize: 'vertical', background: 'transparent',
    color: 'var(--ink-2)', border: '1px solid var(--line, #2a3142)', borderRadius: 6,
    padding: '8px 10px', fontSize: 12.5, lineHeight: 1.5, fontFamily: 'var(--mono)', marginTop: 4,
  }
  const label: React.CSSProperties = { fontSize: 10, letterSpacing: '.1em', color: 'var(--ink-3)', fontFamily: 'var(--mono)' }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="confirm-modal" style={{ minWidth: 'min(680px, calc(100vw - 40px))', position: 'relative' }} onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="vp-var-close"
          title="Close"
          onClick={onClose}
          style={{ position: 'absolute', top: 12, right: 12 }}
        >✕</button>
        <span className="need">SHOW</span>
        <h3>{showName}</h3>
        <p>What every episode of this show inherits. Episode work stays in the episode.</p>
        {error ? <p style={{ color: 'var(--red)', fontSize: 13 }}>{error}</p> : null}
        {missing ? <p style={{ color: 'var(--ink-2)', fontSize: 13 }}>This show has no data folder yet.</p> : null}
        {rules === null && !error && !missing ? <p className="label">Loading…</p> : null}

        {rules !== null ? (
          <div style={{ marginTop: 8 }}>
            <span style={label}>RULES — editorial conventions, read by every AI step</span>
            <textarea
              value={rules}
              rows={Math.min(18, Math.max(8, rules.split('\n').length))}
              onChange={(e) => { setRules(e.target.value); setDirty((d) => ({ ...d, rules: true })) }}
              style={areaStyle}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
              <button type="button" className="vp-save" disabled={busy || !dirty.rules} onClick={() => void save('rules.md', rules)}>
                Save rules
              </button>
            </div>
          </div>
        ) : null}

        {rules !== null ? (
          <div style={{ marginTop: 6 }}>
            {overlayOpen ? (
              <>
                <span style={label}>CONTRACT OVERLAY — changes the pipeline itself for this show (advanced)</span>
                <textarea
                  value={overlay ?? ''}
                  rows={8}
                  placeholder={'{\n  "extends": "ad",\n  "stages": {}\n}'}
                  onChange={(e) => { setOverlay(e.target.value); setDirty((d) => ({ ...d, overlay: true })) }}
                  style={areaStyle}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                  <button type="button" className="vp-save" disabled={busy || !dirty.overlay} onClick={() => void save('contract-overlay.json', overlay ?? '')}>
                    Save overlay
                  </button>
                </div>
              </>
            ) : (
              <button
                type="button"
                className="vp-undo"
                title="A JSON patch on the show's contract — add, change, or remove pipeline steps for every episode of this show"
                onClick={() => { setOverlay(overlay ?? '{\n  "extends": "ad",\n  "stages": {}\n}'); setOverlayOpen(true) }}
              >
                ▸ Contract overlay (advanced)
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

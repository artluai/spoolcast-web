import { useEffect, useState } from 'react'

// The REAL account drawer. Everything here reflects the site session
// (/api/auth/me) — no demo data. Plan/credits UI returns when the money
// layer exists; until then the drawer only shows what is true.

type User = { id: number; email: string; handle: string | null; name: string; role: string }

export function ProfileDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [user, setUser] = useState<User | null>(null)
  const [checked, setChecked] = useState(false)
  const [handleDraft, setHandleDraft] = useState('')
  const [handleNote, setHandleNote] = useState('')
  const [editingHandle, setEditingHandle] = useState(false)
  const saveHandle = async () => {
    setHandleNote('')
    const r = await fetch('/api/auth/handle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: handleDraft }),
    }).then((x) => x.json()).catch(() => null)
    if (!r?.ok) {
      setHandleNote(r?.data?.error || 'Could not save the handle.')
      return
    }
    setUser((u) => (u ? { ...u, handle: r.data.handle } : u))
    setEditingHandle(false)
  }
  useEffect(() => {
    if (!open) return
    void fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => setUser(out?.data?.user ?? null))
      .catch(() => setUser(null))
      .finally(() => setChecked(true))
  }, [open])
  const signOut = async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    setUser(null)
    window.location.href = '/watch'
  }
  const label = user?.name || user?.handle || user?.email || ''
  return (
    <>
      <button className={`profile-scrim ${open ? 'open' : ''}`} onClick={onClose} aria-label="Close profile" />
      <aside className={`profile-panel ${open ? 'open' : ''}`}>
        <div className="pp-head">
          <div className="pp-avatar">{(label || '?').slice(0, 1).toUpperCase()}</div>
          <div>
            <b>{user ? label : 'Not signed in'}</b>
            <span>{user ? user.email : ''}</span>
          </div>
          <button onClick={onClose}>×</button>
        </div>
        {user ? (
          <>
            <section>
              <h3>Account</h3>
              {user.handle && !editingHandle ? (
                <p>
                  @{user.handle}{' '}
                  <a
                    className="pp-link"
                    href="#edit-handle"
                    onClick={(e) => { e.preventDefault(); setHandleDraft(user.handle || ''); setEditingHandle(true) }}
                  >
                    change ›
                  </a>
                </p>
              ) : (
                <form
                  className="pp-handle-form"
                  onSubmit={(e) => { e.preventDefault(); void saveHandle() }}
                >
                  <span>@</span>
                  <input
                    value={handleDraft}
                    placeholder="pick-a-handle"
                    onChange={(e) => setHandleDraft(e.target.value.toLowerCase())}
                  />
                  <button type="submit">Save</button>
                  {handleNote && <small className="pp-handle-note">{handleNote}</small>}
                  {!user.handle && <small>Your public page will live at /u/&lt;handle&gt;.</small>}
                </form>
              )}
              <small>
                {user.role === 'admin' ? (
                  <a className="pp-link" href="/admin">Admin — manage global assets ›</a>
                ) : (
                  'Creator account'
                )}
              </small>
            </section>
            <section>
              <h3>Studio</h3>
              <p><a className="pp-link" href="/studio">Settings &amp; rules chain ›</a></p>
              <small>Everything configurable, labeled by the level it comes from.</small>
            </section>
            <section>
              <p><a className="pp-link" href="#signout" onClick={(e) => { e.preventDefault(); void signOut() }}>Sign out ›</a></p>
            </section>
          </>
        ) : checked ? (
          <section>
            <h3>Account</h3>
            <p><a className="pp-link" href="/api/auth/google">Continue with Google ›</a></p>
            <small>One account for watching and creating.</small>
          </section>
        ) : null}
      </aside>
    </>
  )
}

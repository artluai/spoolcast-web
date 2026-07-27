import { useEffect, useState } from 'react'

// The REAL account drawer. Everything here reflects the site session
// (/api/auth/me) — no demo data. Plan/credits UI returns when the money
// layer exists; until then the drawer only shows what is true.

type User = { id: number; email: string; handle: string | null; name: string; role: string }

export function ProfileDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [user, setUser] = useState<User | null>(null)
  const [checked, setChecked] = useState(false)
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
              <p>{user.handle ? `@${user.handle}` : 'No handle yet'}</p>
              <small>
                {user.role === 'admin' ? (
                  <a className="pp-link" href="/admin">Admin — manage global assets ›</a>
                ) : (
                  'Creator account'
                )}
              </small>
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

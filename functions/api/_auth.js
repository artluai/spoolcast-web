// Shared session helpers for Pages Functions. This module exports no
// onRequest handler, so Pages never routes it — it exists to be imported by
// the auth and admin functions instead of duplicating the session lookup.

export const readCookie = (request, name) => {
  const raw = request.headers.get('Cookie') || ''
  const hit = raw.split(/;\s*/).find((c) => c.startsWith(`${name}=`))
  return hit ? hit.slice(name.length + 1) : ''
}

export const sessionUser = async (env, request) => {
  const t = readCookie(request, 'sc_session')
  if (!t) return null
  return env.DB.prepare(
    `SELECT u.* FROM web_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`,
  ).bind(t).first()
}

// The admin gate (roles: site/migrations/002-users.sql). Returns { user } on
// success, { error: Response } otherwise — callers return the error as-is so
// clients can tell "sign in again" (401) from "not an admin" (403).
export const requireAdmin = async (env, request) => {
  const user = await sessionUser(env, request)
  if (!user) {
    return { error: unauthorized('Sign in first — no valid session.', 401) }
  }
  if (user.role !== 'admin') {
    return { error: unauthorized('Admin only.', 403) }
  }
  return { user }
}

const unauthorized = (message, status) =>
  new Response(JSON.stringify({ ok: false, data: { error: message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

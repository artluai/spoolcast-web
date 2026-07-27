// Site-side auth: magic-link login (no passwords). SITE SIDE ONLY — the
// engine has no accounts; see docs/architecture-engine-vs-site.md.
//   POST /api/auth/request  {email}  → email a one-time login link
//   GET  /api/auth/verify?token=…    → set session cookie, redirect to /watch
//   GET  /api/auth/me                → { user } or { user: null }
//   POST /api/auth/logout            → clear the session
//
// Email delivery is pluggable: with env.RESEND_API_KEY set, links go out via
// Resend from env.AUTH_FROM. Without it, ONLY when env.AUTH_DEV_ECHO="1"
// (.dev.vars, never production) the link is echoed in the response for local
// testing; otherwise requests fail loudly instead of pretending to send.

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify({ ok: status < 400, data }), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })

const token = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const readCookie = (request, name) => {
  const raw = request.headers.get('Cookie') || ''
  const hit = raw.split(/;\s*/).find((c) => c.startsWith(`${name}=`))
  return hit ? hit.slice(name.length + 1) : ''
}

const sessionUser = async (env, request) => {
  const t = readCookie(request, 'sc_session')
  if (!t) return null
  return env.DB.prepare(
    `SELECT u.* FROM web_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`,
  ).bind(t).first()
}

export async function onRequest({ env, request, params }) {
  const route = (Array.isArray(params.path) ? params.path : [params.path])[0]
  const url = new URL(request.url)

  if (route === 'request' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}))
    const email = String(body.email || '').trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'Enter a valid email.' }, 400)
    const t = token()
    await env.DB.prepare(
      `INSERT INTO auth_tokens (token, email, expires_at) VALUES (?, ?, datetime('now', '+15 minutes'))`,
    ).bind(t, email).run()
    const link = `${url.origin}/api/auth/verify?token=${t}`
    if (env.RESEND_API_KEY) {
      const sent = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.AUTH_FROM || 'Spoolcast <login@spoolcast.dev>',
          to: [email],
          subject: 'Your Spoolcast sign-in link',
          text: `Sign in to Spoolcast (link is valid for 15 minutes):\n\n${link}\n\nIf you didn't request this, ignore it.`,
        }),
      })
      if (!sent.ok) return json({ error: 'Could not send the email — try again shortly.' }, 502)
      return json({ sent: true })
    }
    if (env.AUTH_DEV_ECHO === '1') return json({ sent: true, dev_link: link })
    return json({ error: 'Email sending is not configured yet.' }, 503)
  }

  if (route === 'verify' && request.method === 'GET') {
    const t = url.searchParams.get('token') || ''
    const row = await env.DB.prepare(
      `SELECT * FROM auth_tokens WHERE token = ? AND used = 0 AND expires_at > datetime('now')`,
    ).bind(t).first()
    if (!row) return new Response('This sign-in link is invalid or expired.', { status: 400 })
    await env.DB.prepare(`UPDATE auth_tokens SET used = 1 WHERE token = ?`).bind(t).run()
    // find-or-create the account; handle stays empty until the user picks one
    await env.DB.prepare(`INSERT OR IGNORE INTO users (email) VALUES (?)`).bind(row.email).run()
    const user = await env.DB.prepare(`SELECT * FROM users WHERE email = ?`).bind(row.email).first()
    const s = token()
    await env.DB.prepare(
      `INSERT INTO web_sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+90 days'))`,
    ).bind(s, user.id).run()
    return new Response(null, {
      status: 302,
      headers: {
        Location: '/watch',
        'Set-Cookie': `sc_session=${s}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=7776000`,
      },
    })
  }

  if (route === 'me' && request.method === 'GET') {
    const user = await sessionUser(env, request)
    return json({
      user: user ? { id: user.id, email: user.email, handle: user.handle, name: user.name, role: user.role } : null,
    })
  }

  if (route === 'logout' && request.method === 'POST') {
    const t = readCookie(request, 'sc_session')
    if (t) await env.DB.prepare(`DELETE FROM web_sessions WHERE token = ?`).bind(t).run()
    return json({ out: true }, 200, {
      'Set-Cookie': 'sc_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    })
  }

  return json({ error: 'unknown route' }, 404)
}

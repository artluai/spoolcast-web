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

import { readCookie, sessionUser } from '../_auth.js'

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify({ ok: status < 400, data }), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })

const token = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const sessionCookie = (token) =>
  `sc_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=7776000`

const startSession = async (env, email) => {
  await env.DB.prepare(`INSERT OR IGNORE INTO users (email) VALUES (?)`).bind(email).run()
  // The admin allowlist lives in env.ADMIN_EMAILS (comma-separated) so a fresh
  // database gives the operator the admin role again on first sign-in.
  const admins = String(env.ADMIN_EMAILS || '')
    .toLowerCase()
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
  if (admins.includes(email)) {
    await env.DB.prepare(`UPDATE users SET role = 'admin' WHERE email = ?`).bind(email).run()
  }
  const user = await env.DB.prepare(`SELECT * FROM users WHERE email = ?`).bind(email).first()
  const s = token()
  await env.DB.prepare(
    `INSERT INTO web_sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+90 days'))`,
  ).bind(s, user.id).run()
  return s
}

export async function onRequest({ env, request, params }) {
  const parts = Array.isArray(params.path) ? params.path : [params.path]
  const route = parts[0]
  const url = new URL(request.url)

  // Google sign-in: /api/auth/google redirects to Google's consent screen;
  // /api/auth/google/callback exchanges the code and starts a session.
  // Needs GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET (Pages env / .dev.vars).
  if (route === 'google' && request.method === 'GET') {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      return new Response('Google sign-in is not configured yet.', { status: 503 })
    }
    const redirect = `${url.origin}/api/auth/google/callback`
    if (parts[1] === 'callback') {
      const state = url.searchParams.get('state') || ''
      if (!state || state !== readCookie(request, 'sc_oauth_state')) {
        return new Response('Sign-in state mismatch — start again from the Sign in button.', { status: 400 })
      }
      const code = url.searchParams.get('code') || ''
      if (!code) return new Response('Google did not return a sign-in code.', { status: 400 })
      const exchanged = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: redirect,
          grant_type: 'authorization_code',
        }),
      }).then((r) => r.json()).catch(() => null)
      // The id_token came straight from Google over TLS, so decoding its
      // payload without signature checks is safe here.
      const payload = exchanged?.id_token?.split('.')?.[1]
      const claims = payload
        ? JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
        : null
      const email = claims?.email_verified ? String(claims.email || '').toLowerCase() : ''
      if (!email) return new Response('Google sign-in failed — no verified email.', { status: 400 })
      const s = await startSession(env, email)
      return new Response(null, {
        status: 302,
        headers: {
          Location: '/watch',
          'Set-Cookie': sessionCookie(s),
        },
      })
    }
    const state = token()
    const consent = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    consent.searchParams.set('client_id', env.GOOGLE_CLIENT_ID)
    consent.searchParams.set('redirect_uri', redirect)
    consent.searchParams.set('response_type', 'code')
    consent.searchParams.set('scope', 'openid email profile')
    consent.searchParams.set('state', state)
    return new Response(null, {
      status: 302,
      headers: {
        Location: consent.toString(),
        'Set-Cookie': `sc_oauth_state=${state}; Path=/api/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      },
    })
  }

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
    const s = await startSession(env, row.email)
    return new Response(null, {
      status: 302,
      headers: { Location: '/watch', 'Set-Cookie': sessionCookie(s) },
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

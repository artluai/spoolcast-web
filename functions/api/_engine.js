import { readCookie, sessionUser } from './_auth.js'

const SAFE_ID = /^[A-Za-z0-9_-]+$/
// Content-root prefixes any signed-in user may read: the shared library
// tiers. Everything else is either sessions/<id>/… or session-relative and
// must ride an owned session.
const SHARED_READ_PREFIXES = ['global/', 'styles/', 'series/', 'shared/', 'templates/', 'archetypes/']
const FORWARDED_RESPONSE_HEADERS = [
  'Accept-Ranges',
  'Content-Disposition',
  'Content-Length',
  'Content-Range',
  'Content-Type',
]

const json = (data, status = 200) =>
  new Response(JSON.stringify({ ok: status < 400, data }), {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Type': 'application/json',
    },
  })

const engine = (env) => {
  const base = String(env.ENGINE_API_URL || '').replace(/\/+$/, '')
  const token = String(env.ENGINE_API_TOKEN || '')
  return base && token ? { base, token } : null
}

const principalHeaders = async (config, userId, now = Date.now()) => {
  const timestamp = String(Math.floor(now / 1000))
  const payload = `v1\n${userId}\n${timestamp}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(config.token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payload),
  )
  const signatureHex = [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return {
    'X-Spoolcast-User': String(userId),
    'X-Spoolcast-Timestamp': timestamp,
    'X-Spoolcast-Signature': signatureHex,
  }
}

const partsOf = (path) => {
  const parts = Array.isArray(path) ? path : [path]
  return parts.filter(Boolean).map(String)
}

const sessionFromContentPath = (value) => {
  const match = String(value || '').match(/^sessions\/([^/]+)(?:\/|$)/)
  return match?.[1] || ''
}

const ownedSession = async (env, userId, session) => {
  if (!SAFE_ID.test(session)) return false
  const row = await env.DB.prepare(
    `SELECT 1 AS owned FROM engine_sessions WHERE session_id = ? AND user_id = ?`,
  ).bind(session, userId).first()
  return Boolean(row)
}

const ownedSessionIds = async (env, userId) => {
  const rows = await env.DB.prepare(
    `SELECT session_id FROM engine_sessions WHERE user_id = ?`,
  ).bind(userId).all()
  return new Set((rows.results || []).map((row) => String(row.session_id)))
}

const responseFromUpstream = (upstream, replacementBody) => {
  const headers = new Headers()
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    if (replacementBody !== undefined && name === 'Content-Length') continue
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  headers.set('Cache-Control', 'private, no-store')
  return new Response(
    replacementBody === undefined ? upstream.body : replacementBody,
    { status: upstream.status, headers },
  )
}

const upstreamFetch = async (config, url, request, body, userId) => {
  const headers = new Headers()
  for (const name of ['Accept', 'Content-Type', 'If-None-Match', 'Range']) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  headers.set('Authorization', `Bearer ${config.token}`)
  for (const [name, value] of Object.entries(await principalHeaders(config, userId))) {
    headers.set(name, value)
  }
  const init = {
    method: request.method,
    headers,
    redirect: 'manual',
  }
  if (!['GET', 'HEAD'].includes(request.method)) init.body = body
  return fetch(url, init).catch(() => null)
}

const jobOwner = async (config, jobId, userId) => {
  if (!/^[a-f0-9]{32}$/.test(jobId)) return { error: json({ error: 'Invalid job id.' }, 400) }
  const headers = new Headers({ Authorization: `Bearer ${config.token}` })
  for (const [name, value] of Object.entries(await principalHeaders(config, userId))) {
    headers.set(name, value)
  }
  const upstream = await fetch(`${config.base}/api/jobs/${jobId}`, {
    headers,
  }).catch(() => null)
  if (!upstream) return { error: json({ error: 'Cloud engine is unreachable.' }, 502) }
  const payload = await upstream.clone().json().catch(() => null)
  if (!upstream.ok || !payload?.data) {
    return { error: responseFromUpstream(upstream) }
  }
  if (String(payload.data.tenant || '') !== String(userId)) {
    return { error: json({ error: 'Job not found.' }, 404) }
  }
  return { upstream, payload }
}

const legacyJobFile = async (config, userId, path) => {
  const match = /^working\/jobs\/([a-f0-9]{32})\.(json|log)$/.exec(path)
  if (!match) return null
  const owner = await jobOwner(config, match[1], userId)
  if (owner.error) return owner.error
  const job = owner.payload.data
  if (match[2] === 'log') return json({ content: String(job.log_tail || '') })
  const state = {
    queued: 'created',
    retrying: 'created',
    running: 'running',
    cancelling: 'running',
    done: 'succeeded',
    cancelled: 'stopped',
    failed: 'failed',
  }[job.status] || 'created'
  return json({
    content: JSON.stringify({
      job_id: job.id,
      job: job.kind,
      session: job.session,
      state,
      exit_code: job.result?.exit_code ?? null,
      error: job.error || null,
      phase: job.phase || null,
      queue_position: job.queue_position ?? null,
      jobs_ahead: job.jobs_ahead ?? 0,
      progress_current: job.progress_current ?? null,
      progress_total: job.progress_total ?? null,
      progress_unit: job.progress_unit || '',
      message: job.message || '',
      created_at: job.created_at,
      started_at: job.started_at,
      updated_at: job.updated_at,
      finished_at: job.finished_at,
    }),
  })
}

export async function proxyEngine({ env, request, path, user }) {
  const config = engine(env)
  if (!config) return json({ error: 'Cloud engine is not configured.' }, 503)

  const parts = partsOf(path)
  if (!parts.length || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    return json({ error: 'Invalid engine route.' }, 400)
  }
  if (parts[0] === 'worker') return json({ error: 'Not found.' }, 404)

  if (parts[0] === 'render-location' && request.method === 'GET') {
    const row = await env.DB.prepare(
      `SELECT value FROM admin_settings WHERE key = 'render_location'`,
    ).first()
    return json({ location: row?.value === 'cloud' ? 'cloud' : 'local' })
  }

  const source = new URL(request.url)
  const requestedPath = source.searchParams.get('path') || ''
  if (
    requestedPath
    && (requestedPath.includes('\\')
      || requestedPath.startsWith('/')
      || requestedPath.split('/').includes('..'))
  ) {
    return json({ error: 'Invalid path.' }, 400)
  }
  const upstreamUrl = new URL(`/api/${parts.join('/')}`, config.base)
  for (const [key, value] of source.searchParams) upstreamUrl.searchParams.append(key, value)
  upstreamUrl.searchParams.set('tenant', String(user.id))

  let parsedBody = null
  let body = request.body
  let action = ''
  if (
    !['GET', 'HEAD'].includes(request.method)
    && request.headers.get('Content-Type')?.toLowerCase().includes('application/json')
  ) {
    parsedBody = await request.json().catch(() => null)
    if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
      return json({ error: 'Invalid JSON payload.' }, 400)
    }
    parsedBody.tenant = String(user.id)
    action = String(parsedBody.action || '')
    if (action === 'manual_publish') {
      // The browser cannot read the HttpOnly site session, and the engine
      // must not gain its own account system. The authenticated site proxy
      // forwards this user's existing site credential only inside this job.
      parsedBody.site_credential = readCookie(request, 'sc_session')
      parsedBody.site_url = source.origin
    }
    body = JSON.stringify(parsedBody)
  }

  if (parts[0] === 'jobs' && parts[1]) {
    const owner = await jobOwner(config, parts[1], user.id)
    if (owner.error) return owner.error
    if (request.method === 'GET' && parts.length === 2) {
      return responseFromUpstream(owner.upstream)
    }
  }

  if (parts[0] === 'sessions' && request.method === 'GET') {
    const upstream = await upstreamFetch(config, upstreamUrl, request, body, user.id)
    if (!upstream) return json({ error: 'Cloud engine is unreachable.' }, 502)
    const payload = await upstream.json().catch(() => null)
    if (!upstream.ok || !payload?.data || !Array.isArray(payload.data.sessions)) {
      return responseFromUpstream(upstream, JSON.stringify(payload || { ok: false }))
    }
    const allowed = await ownedSessionIds(env, user.id)
    payload.data.sessions = payload.data.sessions.filter((item) => allowed.has(String(item.id)))
    return responseFromUpstream(upstream, JSON.stringify(payload))
  }

  const querySession = source.searchParams.get('session') || ''
  const bodySession = String(parsedBody?.session || '')
  const contentSession = sessionFromContentPath(requestedPath)
  const session = bodySession || querySession || contentSession
  let reserved = false

  // A path that names no session (working/…, renders/…) is session-relative
  // upstream, so it must ride an owned session param — except the shared
  // library tiers, which any signed-in user may read.
  const sharedPath = ['GET', 'HEAD'].includes(request.method)
    && SHARED_READ_PREFIXES.some((prefix) => requestedPath.startsWith(prefix))
  if (requestedPath && !sharedPath && !contentSession && !session) {
    return json({ error: 'Invalid path.' }, 400)
  }

  if (action === 'create_session' && request.method === 'POST') {
    if (!SAFE_ID.test(session)) return json({ error: 'Invalid session.' }, 400)
    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO engine_sessions (session_id, user_id) VALUES (?, ?)`,
    ).bind(session, user.id).run()
    if (!result.meta?.changes) return json({ error: 'That project id is already in use.' }, 409)
    reserved = true
  } else {
    // Every session named anywhere in the request must be owned. The old
    // first-match-wins check let a crafted path ride an owned session param.
    for (const ref of new Set([bodySession, querySession, contentSession].filter(Boolean))) {
      if (!(await ownedSession(env, user.id, ref))) {
        return json({ error: 'Project not found.' }, 404)
      }
    }
  }

  if (action === 'render_with_audit') {
    const row = await env.DB.prepare(
      `SELECT value FROM admin_settings WHERE key = 'render_location'`,
    ).first()
    if (row?.value !== 'cloud') {
      return json({ error: 'Cloud rendering is not selected in Admin settings.' }, 409)
    }
  }

  if (parts[0] === 'file' && request.method === 'GET') {
    const legacy = await legacyJobFile(
      config,
      user.id,
      requestedPath,
    )
    if (legacy) return legacy
  }

  const upstream = await upstreamFetch(config, upstreamUrl, request, body, user.id)
  if (!upstream) {
    if (reserved) {
      await env.DB.prepare(
        `DELETE FROM engine_sessions WHERE session_id = ? AND user_id = ?`,
      ).bind(session, user.id).run()
    }
    return json({ error: 'Cloud engine is unreachable.' }, 502)
  }

  if (reserved && !upstream.ok) {
    await env.DB.prepare(
      `DELETE FROM engine_sessions WHERE session_id = ? AND user_id = ?`,
    ).bind(session, user.id).run()
  }
  if (action === 'delete_session' && upstream.ok) {
    await env.DB.prepare(
      `DELETE FROM engine_sessions WHERE session_id = ? AND user_id = ?`,
    ).bind(session, user.id).run()
  }
  return responseFromUpstream(upstream)
}

export async function authenticatedEngineRequest(context) {
  const user = await sessionUser(context.env, context.request)
  if (!user) return json({ error: 'Sign in first — no valid session.' }, 401)
  return proxyEngine({ ...context, user })
}

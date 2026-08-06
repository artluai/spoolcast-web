import { readCookie, sessionUser } from './_auth.js'

const SAFE_ID = /^[A-Za-z0-9_-]+$/
const STABLE_ID = /^[A-Za-z0-9_-]{1,128}$/
const FANOUT_ACTION = 'fan_out_episodes'
const PLAN_FANOUT_ACTION = 'plan_fan_out'
const MAX_FANOUT_EPISODES = 50
const MAX_EPISODE_BRIEF_LENGTH = 20_000
const MAX_FANOUT_MANIFEST_LENGTH = 1_000_000
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
    `SELECT 1 AS owned
       FROM engine_sessions
      WHERE session_id = ? AND user_id = ? AND provisioning_state = 'active'`,
  ).bind(session, userId).first()
  return Boolean(row)
}

const ownedSessionIds = async (env, userId) => {
  const rows = await env.DB.prepare(
    `SELECT session_id
       FROM engine_sessions
      WHERE user_id = ? AND provisioning_state = 'active'`,
  ).bind(userId).all()
  return new Set((rows.results || []).map((row) => String(row.session_id)))
}

const sha256Hex = async (value) => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

const validSeasonNumber = (value) => (
  Number.isInteger(value) && value >= 1 && value <= 99
)

const normalizeFanoutManifest = (value) => {
  if (!Array.isArray(value) || !value.length || value.length > MAX_FANOUT_EPISODES) {
    throw new Error(`manifest must contain 1-${MAX_FANOUT_EPISODES} episodes`)
  }
  const sessionIds = new Set()
  const episodeNumbers = new Set()
  const manifest = value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('each manifest item must be an object')
    }
    const sessionId = String(item.session_id || '').trim()
    const episodeNumber = Number(item.episode_number)
    const brief = item.brief
    if (!STABLE_ID.test(sessionId) || sessionIds.has(sessionId)) {
      throw new Error('manifest session ids must be unique safe ids')
    }
    if (
      !Number.isSafeInteger(episodeNumber)
      || episodeNumber < 1
      || episodeNumbers.has(episodeNumber)
    ) {
      throw new Error('manifest episode numbers must be unique positive integers')
    }
    if (
      typeof brief !== 'string'
      || !brief.trim()
      || brief.length > MAX_EPISODE_BRIEF_LENGTH
    ) {
      throw new Error(`episode briefs must be 1-${MAX_EPISODE_BRIEF_LENGTH} characters`)
    }
    sessionIds.add(sessionId)
    episodeNumbers.add(episodeNumber)
    return {
      session_id: sessionId,
      episode_number: episodeNumber,
      brief,
    }
  })
  const manifestJson = JSON.stringify(manifest)
  if (manifestJson.length > MAX_FANOUT_MANIFEST_LENGTH) {
    throw new Error('manifest is too large')
  }
  return { manifest, manifestJson }
}

const fanoutData = (reservation, state = reservation.provisioningState) => ({
  creation_key: reservation.creationKey,
  manifest_hash: reservation.manifestHash,
  state,
  sessions: reservation.manifest.map((item) => item.session_id),
})

const existingFanoutRowsMatch = (reservation, rows) => {
  if (rows.length !== reservation.manifest.length) return false
  const expected = new Map(
    reservation.manifest.map((item) => [item.session_id, item.episode_number]),
  )
  return rows.every((row) => (
    Number(row.user_id) === Number(reservation.userId)
    && String(row.show_id) === reservation.showId
    && String(row.season_id) === reservation.seasonId
    && String(row.creation_key) === reservation.creationKey
    && String(row.manifest_hash) === reservation.manifestHash
    && expected.get(String(row.session_id)) === Number(row.episode_number)
  ))
}

const existingFanoutCreationMatches = (reservation, existing) => (
  existing
  && Number(existing.user_id) === Number(reservation.userId)
  && String(existing.show_id) === reservation.showId
  && String(existing.season_id) === reservation.seasonId
  && Number(existing.season_number) === reservation.seasonNumber
  && String(existing.manifest_hash) === reservation.manifestHash
  && String(existing.manifest_json) === reservation.manifestJson
)

const pendingFanoutRows = async (env, reservation) => {
  const rows = await env.DB.prepare(
    `SELECT session_id, user_id, show_id, season_id, creation_key,
            episode_number, manifest_hash
       FROM engine_sessions
      WHERE user_id = ? AND creation_key = ?`,
  ).bind(reservation.userId, reservation.creationKey).all()
  return rows.results || []
}

const childReservationStatements = (env, reservation) =>
  reservation.manifest.map((item) => env.DB.prepare(
    `INSERT INTO engine_sessions
       (session_id, user_id, show_id, season_id, provisioning_state,
        creation_key, episode_number, manifest_hash)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).bind(
    item.session_id,
    reservation.userId,
    reservation.showId,
    reservation.seasonId,
    reservation.creationKey,
    item.episode_number,
    reservation.manifestHash,
  ))

const reserveFanout = async (env, userId, payload) => {
  const creationKey = String(payload.creation_key || '').trim()
  const showId = String(payload.show_id || '').trim()
  const seasonId = String(payload.season_id || '').trim()
  const seasonNumber = payload.season_number
  if (![creationKey, showId, seasonId].every((value) => STABLE_ID.test(value))) {
    return { error: json({ error: 'Invalid creation, show, or season id.' }, 400) }
  }
  if (!validSeasonNumber(seasonNumber)) {
    return { error: json({ error: 'season_number must be an integer 1-99.' }, 400) }
  }

  let normalized
  try {
    normalized = normalizeFanoutManifest(payload.manifest)
  } catch (error) {
    return { error: json({ error: error.message }, 400) }
  }
  const manifestHash = await sha256Hex(normalized.manifestJson)

  const show = await env.DB.prepare(
    `SELECT user_id FROM engine_shows WHERE show_id = ?`,
  ).bind(showId).first()
  if (!show || Number(show.user_id) !== Number(userId)) {
    return { error: json({ error: 'Show not found.' }, 404) }
  }
  const season = await env.DB.prepare(
    `SELECT show_id FROM engine_seasons WHERE season_id = ?`,
  ).bind(seasonId).first()
  if (!season || String(season.show_id) !== showId) {
    return { error: json({ error: 'Season not found.' }, 404) }
  }

  const reservation = {
    creationKey,
    showId,
    seasonId,
    seasonNumber,
    userId,
    manifest: normalized.manifest,
    manifestJson: normalized.manifestJson,
    manifestHash,
    provisioningState: 'pending',
  }
  const existing = await env.DB.prepare(
    `SELECT user_id, show_id, season_id, season_number, manifest_json, manifest_hash,
            provisioning_state
       FROM engine_session_creations
      WHERE user_id = ? AND creation_key = ?`,
  ).bind(userId, creationKey).first()

  if (existing) {
    if (!existingFanoutCreationMatches(reservation, existing)) {
      return {
        error: json(
          { error: 'That creation key belongs to a different reservation.' },
          409,
        ),
      }
    }
    reservation.provisioningState = String(existing.provisioning_state)
    if (reservation.provisioningState === 'active') {
      return { reservation, active: true }
    }
    if (reservation.provisioningState === 'released') {
      try {
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE engine_session_creations
                SET provisioning_state = 'pending', updated_at = datetime('now')
              WHERE user_id = ? AND creation_key = ?
                AND provisioning_state = 'released'`,
          ).bind(userId, creationKey),
          ...childReservationStatements(env, reservation),
        ])
      } catch {
        return {
          error: json(
            { error: 'One or more episode ids are already reserved.' },
            409,
          ),
        }
      }
      reservation.provisioningState = 'pending'
      return { reservation, active: false }
    }
    if (reservation.provisioningState !== 'pending') {
      return { error: json({ error: 'Invalid reservation state.' }, 409) }
    }
    if (!existingFanoutRowsMatch(
      reservation,
      await pendingFanoutRows(env, reservation),
    )) {
      return {
        error: json(
          { error: 'The pending reservation does not match its child rows.' },
          409,
        ),
      }
    }
    return { reservation, active: false }
  }

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO engine_session_creations
           (creation_key, user_id, show_id, season_id, season_number,
            manifest_json, manifest_hash, provisioning_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      ).bind(
        creationKey,
        userId,
        showId,
        seasonId,
        seasonNumber,
        normalized.manifestJson,
        manifestHash,
      ),
      ...childReservationStatements(env, reservation),
    ])
  } catch {
    // A concurrent retry may have won the same atomic insert. Treat that as
    // the same pending reservation, never as a burned-id conflict.
    const raced = await env.DB.prepare(
      `SELECT user_id, show_id, season_id, season_number, manifest_json, manifest_hash,
              provisioning_state
         FROM engine_session_creations
        WHERE user_id = ? AND creation_key = ?`,
    ).bind(userId, creationKey).first()
    if (
      existingFanoutCreationMatches(reservation, raced)
      && String(raced.provisioning_state) === 'pending'
      && existingFanoutRowsMatch(
        reservation,
        await pendingFanoutRows(env, reservation),
      )
    ) {
      return { reservation, active: false }
    }
    return {
      error: json(
        { error: 'One or more episode ids are already reserved.' },
        409,
      ),
    }
  }
  return { reservation, active: false }
}

const activateFanout = async (env, reservation) => {
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE engine_session_creations
          SET provisioning_state = 'active', updated_at = datetime('now')
        WHERE user_id = ? AND creation_key = ?
          AND provisioning_state = 'pending'`,
    ).bind(reservation.userId, reservation.creationKey),
    env.DB.prepare(
      `UPDATE engine_sessions
          SET provisioning_state = 'active'
        WHERE user_id = ? AND creation_key = ?
          AND provisioning_state = 'pending'`,
    ).bind(reservation.userId, reservation.creationKey),
  ])
  if (
    Number(results?.[0]?.meta?.changes) !== 1
    || Number(results?.[1]?.meta?.changes) !== reservation.manifest.length
  ) {
    throw new Error('reservation activation was incomplete')
  }
}

const releaseFanout = async (env, reservation) => {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE engine_session_creations
          SET provisioning_state = 'released', updated_at = datetime('now')
        WHERE user_id = ? AND creation_key = ?
          AND provisioning_state = 'pending'`,
    ).bind(reservation.userId, reservation.creationKey),
    env.DB.prepare(
      `DELETE FROM engine_sessions
        WHERE user_id = ? AND creation_key = ?
          AND provisioning_state = 'pending'`,
    ).bind(reservation.userId, reservation.creationKey),
  ])
}

const fanoutResponseMatches = (payload, reservation) => {
  const data = payload?.data
  return data
    && String(data.creation_key) === reservation.creationKey
    && String(data.manifest_hash) === reservation.manifestHash
    && data.state === 'active'
    && Array.isArray(data.sessions)
    && data.sessions.length === reservation.manifest.length
    && data.sessions.every(
      (sessionId, index) =>
        String(sessionId) === reservation.manifest[index].session_id,
    )
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
  let fanoutReservation = null
  if (action === PLAN_FANOUT_ACTION && request.method === 'POST') {
    const showId = String(parsedBody.show_id || '').trim()
    const seasonNumber = parsedBody.season
    if (!STABLE_ID.test(showId)) {
      return json({ error: 'Invalid show id.' }, 400)
    }
    if (!validSeasonNumber(seasonNumber)) {
      return json({ error: 'season must be an integer 1-99.' }, 400)
    }
    const show = await env.DB.prepare(
      `SELECT user_id FROM engine_shows WHERE show_id = ?`,
    ).bind(showId).first()
    if (!show || Number(show.user_id) !== Number(user.id)) {
      return json({ error: 'Show not found.' }, 404)
    }
    parsedBody = {
      action: PLAN_FANOUT_ACTION,
      show_id: showId,
      season: seasonNumber,
      tenant: String(user.id),
    }
    body = JSON.stringify(parsedBody)
  }
  if (action === FANOUT_ACTION && request.method === 'POST') {
    const result = await reserveFanout(env, user.id, parsedBody)
    if (result.error) return result.error
    fanoutReservation = result.reservation
    if (result.active) return json(fanoutData(fanoutReservation, 'active'))
    parsedBody = {
      action: FANOUT_ACTION,
      creation_key: fanoutReservation.creationKey,
      show_id: fanoutReservation.showId,
      season_id: fanoutReservation.seasonId,
      season_number: fanoutReservation.seasonNumber,
      manifest: fanoutReservation.manifest,
      reservation: {
        owner_id: String(user.id),
        creation_key: fanoutReservation.creationKey,
        show_id: fanoutReservation.showId,
        season_id: fanoutReservation.seasonId,
        manifest_hash: fanoutReservation.manifestHash,
      },
      tenant: String(user.id),
    }
    body = JSON.stringify(parsedBody)
  }

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

  if (fanoutReservation) {
    const payload = await upstream.clone().json().catch(() => null)
    if (!upstream.ok) {
      if (payload?.creation_state === 'not_created') {
        await releaseFanout(env, fanoutReservation).catch(() => null)
      }
      return responseFromUpstream(upstream)
    }
    if (!fanoutResponseMatches(payload, fanoutReservation)) {
      return json(
        { error: 'Engine fan-out response did not match the reservation; retry the same creation key.' },
        502,
      )
    }
    try {
      await activateFanout(env, fanoutReservation)
    } catch {
      return json(
        { error: 'Episodes were created but reservation activation is pending; retry the same creation key.' },
        503,
      )
    }
    return responseFromUpstream(upstream)
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

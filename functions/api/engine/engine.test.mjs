import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { afterEach, test } from 'node:test'

import { onRequest } from './[[path]].js'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const mockDb = ({ owned = [], location = 'cloud' } = {}) => {
  const sessions = new Map(owned.map(([session, userId]) => [session, userId]))
  return {
    sessions,
    prepare(sql) {
      let args = []
      return {
        bind(...values) {
          args = values
          return this
        },
        async first() {
          if (sql.includes('FROM web_sessions')) {
            return args[0] === 'valid-session'
              ? { id: 2, email: 'contenttest732@gmail.com', role: 'user' }
              : null
          }
          if (sql.includes('FROM engine_sessions')) {
            return sessions.get(String(args[0])) === args[1] ? { owned: 1 } : null
          }
          if (sql.includes('FROM admin_settings')) return { value: location }
          throw new Error(`Unexpected first(): ${sql}`)
        },
        async all() {
          if (sql.includes('FROM engine_sessions')) {
            return {
              results: [...sessions]
                .filter(([, userId]) => userId === args[0])
                .map(([session_id]) => ({ session_id })),
            }
          }
          throw new Error(`Unexpected all(): ${sql}`)
        },
        async run() {
          if (sql.includes('INSERT OR IGNORE INTO engine_sessions')) {
            const key = String(args[0])
            if (sessions.has(key)) return { meta: { changes: 0 } }
            sessions.set(key, args[1])
            return { meta: { changes: 1 } }
          }
          if (sql.includes('DELETE FROM engine_sessions')) {
            const changed = sessions.get(String(args[0])) === args[1] && sessions.delete(String(args[0]))
            return { meta: { changes: changed ? 1 : 0 } }
          }
          throw new Error(`Unexpected run(): ${sql}`)
        },
      }
    },
  }
}

const mockFanoutDb = ({ showOwner = 2 } = {}) => {
  let sessions = new Map()
  let creations = new Map()
  const shows = new Map([['demo-show', showOwner]])
  const seasons = new Map([['season-1', 'demo-show']])

  const execute = (statement) => {
    const { sql, args } = statement
    if (sql.includes('INSERT INTO engine_session_creations')) {
      const [creationKey, userId, showId, seasonId, manifestJson, manifestHash] = args
      if (creations.has(creationKey)) throw new Error('duplicate creation')
      creations.set(creationKey, {
        creation_key: creationKey,
        user_id: userId,
        show_id: showId,
        season_id: seasonId,
        manifest_json: manifestJson,
        manifest_hash: manifestHash,
        provisioning_state: 'pending',
      })
      return { meta: { changes: 1 } }
    }
    if (sql.includes('INSERT INTO engine_sessions')) {
      const [sessionId, userId, showId, seasonId, creationKey, episodeNumber, manifestHash] = args
      if (sessions.has(sessionId)) throw new Error('duplicate session')
      sessions.set(sessionId, {
        session_id: sessionId,
        user_id: userId,
        show_id: showId,
        season_id: seasonId,
        provisioning_state: 'pending',
        creation_key: creationKey,
        episode_number: episodeNumber,
        manifest_hash: manifestHash,
      })
      return { meta: { changes: 1 } }
    }
    if (sql.includes('UPDATE engine_session_creations')) {
      const creation = creations.get(args[1])
      const activating = sql.includes("SET provisioning_state = 'active'")
      const releasing = sql.includes("SET provisioning_state = 'released'")
      const expected = activating || releasing ? 'pending' : 'released'
      const next = activating ? 'active' : releasing ? 'released' : 'pending'
      if (!creation || creation.provisioning_state !== expected) {
        return { meta: { changes: 0 } }
      }
      creation.provisioning_state = next
      return { meta: { changes: 1 } }
    }
    if (sql.includes('UPDATE engine_sessions')) {
      let changes = 0
      for (const session of sessions.values()) {
        if (
          Number(session.user_id) === Number(args[0])
          && session.creation_key === args[1]
          && session.provisioning_state === 'pending'
        ) {
          session.provisioning_state = 'active'
          changes += 1
        }
      }
      return { meta: { changes } }
    }
    if (sql.includes('DELETE FROM engine_sessions')) {
      let changes = 0
      for (const [id, session] of sessions) {
        if (
          Number(session.user_id) === Number(args[0])
          && session.creation_key === args[1]
          && session.provisioning_state === 'pending'
        ) {
          sessions.delete(id)
          changes += 1
        }
      }
      return { meta: { changes } }
    }
    throw new Error(`Unexpected batch statement: ${sql}`)
  }

  const db = {
    get sessions() {
      return sessions
    },
    get creations() {
      return creations
    },
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...values) {
          this.args = values
          return this
        },
        async first() {
          if (sql.includes('FROM web_sessions')) {
            return this.args[0] === 'valid-session'
              ? { id: 2, email: 'contenttest732@gmail.com', role: 'user' }
              : null
          }
          if (sql.includes('FROM engine_shows')) {
            const owner = shows.get(String(this.args[0]))
            return owner === undefined ? null : { user_id: owner }
          }
          if (sql.includes('FROM engine_seasons')) {
            const showId = seasons.get(String(this.args[0]))
            return showId === undefined ? null : { show_id: showId }
          }
          if (sql.includes('FROM engine_session_creations')) {
            const creation = creations.get(String(this.args[1]))
            return creation
              && Number(creation.user_id) === Number(this.args[0])
              ? creation
              : null
          }
          if (sql.includes('FROM engine_sessions')) {
            const session = sessions.get(String(this.args[0]))
            return session
              && Number(session.user_id) === Number(this.args[1])
              && session.provisioning_state === 'active'
              ? { owned: 1 }
              : null
          }
          throw new Error(`Unexpected first(): ${sql}`)
        },
        async all() {
          if (sql.includes('creation_key = ?')) {
            return {
              results: [...sessions.values()]
                .filter(
                  (session) =>
                    Number(session.user_id) === Number(this.args[0])
                    && session.creation_key === this.args[1],
                ),
            }
          }
          if (sql.includes('FROM engine_sessions')) {
            return {
              results: [...sessions.values()]
                .filter(
                  (session) =>
                    Number(session.user_id) === Number(this.args[0])
                    && session.provisioning_state === 'active',
                ),
            }
          }
          throw new Error(`Unexpected all(): ${sql}`)
        },
      }
      return statement
    },
    async batch(statements) {
      const oldSessions = sessions
      const oldCreations = creations
      sessions = new Map(
        [...sessions].map(([key, value]) => [key, { ...value }]),
      )
      creations = new Map(
        [...creations].map(([key, value]) => [key, { ...value }]),
      )
      try {
        return statements.map(execute)
      } catch (error) {
        sessions = oldSessions
        creations = oldCreations
        throw error
      }
    },
  }
  return db
}

const env = (db) => ({
  DB: db,
  ENGINE_API_URL: 'https://engine.example',
  ENGINE_API_TOKEN: 'server-secret',
})

const request = (path, init = {}) =>
  new Request(`https://site.example/api/engine/${path}`, {
    ...init,
    headers: { Cookie: 'sc_session=valid-session', ...(init.headers || {}) },
  })

const call = (db, path, init = {}) =>
  onRequest({
    env: env(db),
    request: request(path, init),
    params: { path: path.split('?')[0].split('/') },
  })

const assertPrincipal = (headers, userId = '2') => {
  const timestamp = headers.get('X-Spoolcast-Timestamp')
  assert.equal(headers.get('X-Spoolcast-User'), userId)
  assert.match(timestamp, /^\d+$/)
  assert.ok(Math.abs(Date.now() / 1000 - Number(timestamp)) < 10)
  assert.equal(
    headers.get('X-Spoolcast-Signature'),
    createHmac('sha256', 'server-secret')
      .update(`v1\n${userId}\n${timestamp}`)
      .digest('hex'),
  )
}

test('rejects an unsigned browser before contacting Railway', async () => {
  let contacted = false
  globalThis.fetch = async () => {
    contacted = true
    return new Response()
  }
  const response = await onRequest({
    env: env(mockDb()),
    request: new Request('https://site.example/api/engine/sessions'),
    params: { path: ['sessions'] },
  })
  assert.equal(response.status, 401)
  assert.equal(contacted, false)
})

test('filters the hosted session list to projects owned by the signed-in user', async () => {
  const db = mockDb({ owned: [['mine', 2], ['theirs', 1]] })
  globalThis.fetch = async (url, init) => {
    const upstream = new URL(url)
    assert.equal(upstream.searchParams.get('tenant'), '2')
    assert.equal(init.headers.get('Authorization'), 'Bearer server-secret')
    assertPrincipal(init.headers)
    assert.equal(init.headers.has('Cookie'), false)
    return Response.json({
      ok: true,
      data: { sessions: [{ id: 'mine' }, { id: 'theirs' }, { id: 'unclaimed' }] },
    })
  }
  const response = await call(db, 'sessions')
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.deepEqual(payload.data.sessions, [{ id: 'mine' }])
})

test('does not forward a request for another account project', async () => {
  let contacted = false
  globalThis.fetch = async () => {
    contacted = true
    return new Response()
  }
  const response = await call(
    mockDb({ owned: [['theirs', 1]] }),
    'status?session=theirs&tenant=1',
  )
  assert.equal(response.status, 404)
  assert.equal(contacted, false)
})

test('reserves new project ownership and replaces the browser tenant', async () => {
  const db = mockDb()
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(url).searchParams.get('tenant'), '2')
    assertPrincipal(init.headers)
    assert.deepEqual(JSON.parse(init.body), {
      action: 'create_session',
      session: 'new-project',
      tenant: '2',
    })
    return Response.json({ ok: true, data: { session: 'new-project' } })
  }
  const response = await call(db, 'action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'create_session',
      session: 'new-project',
      tenant: 'attacker-controlled',
    }),
  })
  assert.equal(response.status, 200)
  assert.equal(db.sessions.get('new-project'), 2)
})

test('a crafted path cannot ride an owned session param into another project', async () => {
  let contacted = false
  globalThis.fetch = async () => {
    contacted = true
    return new Response()
  }
  const db = mockDb({ owned: [['mine', 2], ['theirs', 1]] })
  const crafted = await call(db, 'file?session=mine&path=sessions/theirs/renders/final.mp4')
  assert.equal(crafted.status, 404)
  assert.equal(contacted, false)

  const relative = await call(db, 'file?path=working/structure.md')
  assert.equal(relative.status, 400)
  assert.equal(contacted, false)
})

test('shared library paths are readable without naming a session', async () => {
  globalThis.fetch = async (_url, init) => {
    assertPrincipal(init.headers)
    return Response.json({ ok: true, data: { content: 'portrait' } })
  }
  const response = await call(mockDb({ owned: [['mine', 2]] }), 'file?path=global/characters/aoi/portrait.png')
  assert.equal(response.status, 200)
})

test('signs the principal on job ownership lookups', async () => {
  const jobId = 'a'.repeat(32)
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(url).pathname, `/api/jobs/${jobId}`)
    assertPrincipal(init.headers)
    return Response.json({ ok: true, data: { id: jobId, tenant: '2' } })
  }
  const response = await call(mockDb(), `jobs/${jobId}`)
  assert.equal(response.status, 200)
})

test('applies the admin cloud-render setting without making creators admins', async () => {
  const localDb = mockDb({ owned: [['mine', 2]], location: 'local' })
  let contacted = false
  globalThis.fetch = async () => {
    contacted = true
    return new Response()
  }
  const response = await call(localDb, 'action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'render_with_audit',
      session: 'mine',
    }),
  })
  assert.equal(response.status, 409)
  assert.equal(contacted, false)

  const location = await call(localDb, 'render-location')
  assert.deepEqual(await location.json(), { ok: true, data: { location: 'local' } })
})

test('forwards the signed-in site credential only inside a manual publish job', async () => {
  const db = mockDb({ owned: [['mine', 2]] })
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(url).pathname, '/api/action')
    assertPrincipal(init.headers)
    assert.equal(init.headers.has('Cookie'), false)
    assert.deepEqual(JSON.parse(init.body), {
      action: 'manual_publish',
      session: 'mine',
      tenant: '2',
      approve: true,
      allow_external: true,
      public: false,
      site_credential: 'valid-session',
      site_url: 'https://site.example',
    })
    return Response.json({ ok: true, data: { job_id: 'a'.repeat(32) } }, { status: 202 })
  }
  const response = await call(db, 'action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'manual_publish',
      session: 'mine',
      approve: true,
      allow_external: true,
      public: false,
      site_credential: 'browser-must-not-control-this',
      site_url: 'https://attacker.example',
    }),
  })
  assert.equal(response.status, 202)
})

const fanoutPayload = (brief = 'Episode one opens the mystery.') => ({
  action: 'fan_out_episodes',
  creation_key: 'season-one-v1',
  show_id: 'demo-show',
  season_id: 'season-1',
  manifest: [
    {
      session_id: 'demo-show-s01e01',
      episode_number: 1,
      brief,
    },
    {
      session_id: 'demo-show-s01e02',
      episode_number: 2,
      brief: 'Episode two reveals the first consequence.',
    },
  ],
})

const postFanout = (db, payload = fanoutPayload()) =>
  call(db, 'action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

test('reserves every fan-out child before forwarding the exact manifest', async () => {
  const db = mockFanoutDb()
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    assertPrincipal(init.headers)
    assert.equal(db.sessions.size, 2)
    assert.ok([...db.sessions.values()].every((row) => row.provisioning_state === 'pending'))
    assert.deepEqual(body.reservation, {
      owner_id: '2',
      creation_key: 'season-one-v1',
      show_id: 'demo-show',
      season_id: 'season-1',
      manifest_hash: body.reservation.manifest_hash,
    })
    assert.match(body.reservation.manifest_hash, /^[a-f0-9]{64}$/)
    assert.deepEqual(body.manifest, fanoutPayload().manifest)
    assert.equal(body.tenant, '2')
    return Response.json({
      ok: true,
      data: {
        creation_key: body.creation_key,
        manifest_hash: body.reservation.manifest_hash,
        state: 'active',
        sessions: body.manifest.map((item) => item.session_id),
      },
    })
  }

  const response = await postFanout(db)

  assert.equal(response.status, 200)
  assert.equal(db.creations.get('season-one-v1').provisioning_state, 'active')
  assert.ok([...db.sessions.values()].every((row) => row.provisioning_state === 'active'))
})

test('same creation key resumes pending rows and rejects a changed manifest', async () => {
  const db = mockFanoutDb()
  let attempts = 0
  globalThis.fetch = async (_url, init) => {
    attempts += 1
    if (attempts === 1) throw new Error('network down after reservation')
    const body = JSON.parse(init.body)
    return Response.json({
      ok: true,
      data: {
        creation_key: body.creation_key,
        manifest_hash: body.reservation.manifest_hash,
        state: 'active',
        sessions: body.manifest.map((item) => item.session_id),
      },
    })
  }

  const first = await postFanout(db)
  assert.equal(first.status, 502)
  assert.equal(db.sessions.size, 2)
  assert.ok([...db.sessions.values()].every((row) => row.provisioning_state === 'pending'))

  const changed = await postFanout(db, fanoutPayload('A changed brief.'))
  assert.equal(changed.status, 409)
  assert.equal(attempts, 1)

  const retry = await postFanout(db)
  assert.equal(retry.status, 200)
  assert.equal(attempts, 2)
  assert.equal(db.sessions.size, 2)
  assert.ok([...db.sessions.values()].every((row) => row.provisioning_state === 'active'))
})

test('confirmed no-write failures release children and exact retries reuse the key', async () => {
  const db = mockFanoutDb()
  let attempts = 0
  globalThis.fetch = async (_url, init) => {
    attempts += 1
    const body = JSON.parse(init.body)
    if (attempts === 1) {
      return Response.json(
        {
          ok: false,
          error: 'Engine rejected before writing',
          creation_state: 'not_created',
        },
        { status: 409 },
      )
    }
    return Response.json({
      ok: true,
      data: {
        creation_key: body.creation_key,
        manifest_hash: body.reservation.manifest_hash,
        state: 'active',
        sessions: body.manifest.map((item) => item.session_id),
      },
    })
  }

  const first = await postFanout(db)
  assert.equal(first.status, 409)
  assert.equal(db.creations.get('season-one-v1').provisioning_state, 'released')
  assert.equal(db.sessions.size, 0)

  const retry = await postFanout(db)
  assert.equal(retry.status, 200)
  assert.equal(attempts, 2)
  assert.equal(db.sessions.size, 2)

  globalThis.fetch = async () => {
    throw new Error('active retry must not contact the engine')
  }
  const activeRetry = await postFanout(db)
  assert.equal(activeRetry.status, 200)
  assert.deepEqual((await activeRetry.json()).data.sessions, [
    'demo-show-s01e01',
    'demo-show-s01e02',
  ])
})

test('fan-out denies an unowned show before reserving or contacting the engine', async () => {
  const db = mockFanoutDb({ showOwner: 1 })
  let contacted = false
  globalThis.fetch = async () => {
    contacted = true
    return new Response()
  }

  const response = await postFanout(db)

  assert.equal(response.status, 404)
  assert.equal(contacted, false)
  assert.equal(db.sessions.size, 0)
  assert.equal(db.creations.size, 0)
})

import assert from 'node:assert/strict'
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
  globalThis.fetch = async () =>
    Response.json({ ok: true, data: { content: 'portrait' } })
  const response = await call(mockDb({ owned: [['mine', 2]] }), 'file?path=global/characters/aoi/portrait.png')
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

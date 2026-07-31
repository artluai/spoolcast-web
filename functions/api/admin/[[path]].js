// Admin-only site API — the first real use of the admin role (roles:
// site/migrations/002-users.sql). Publishes GLOBAL templates as cloud assets
// using the character-library pattern: files in the spoolcast-assets R2
// bucket under templates/<slug>/, one metadata row in D1 (003 migration).
//   POST /api/admin/templates/publish    multipart form:
//        template  template.json (required; its "id" is the slug)
//        file      any extra template files, repeatable (rules.md, …)
//        poster    optional picker art image
//        preview   optional picker preview video
//        Republishing the same slug bumps version, overwrites files, sets live=1.
//   POST /api/admin/templates/unpublish  {slug} → live=0 (row and files kept)
//   POST /api/admin/templates/relist     {slug} → live=1 (no re-upload needed)
//   GET  /api/admin/templates            → every row, including unpublished
//   GET  /api/admin/library              → full cloud inventory: template rows
//        + everything actually in the spoolcast-assets bucket (characters
//        grouped by slug, plus any keys outside the known prefixes)
//   GET  /api/admin/settings/render-location
//   POST /api/admin/settings/render-location  {location: "local"|"cloud"}
//   POST /api/admin/render/start         → authenticated cloud-worker proxy
//   GET  /api/admin/render/{file|info|download}

import { requireAdmin } from '../_auth.js'

// Public base of the spoolcast-assets bucket (same one the character
// library's image_url values and /api/site/templates use).
const ASSETS_BASE = 'https://pub-275d3988223b4b53b851fe856882cec0.r2.dev'

const json = (data, status = 200) =>
  new Response(JSON.stringify({ ok: status < 400, data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const TYPES = {
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}
const ext = (name) => name.slice(name.lastIndexOf('.')).toLowerCase()
const contentType = (name, fallback) => TYPES[ext(name)] || fallback || 'application/octet-stream'
const renderLocation = async (env) => {
  const row = await env.DB.prepare(
    `SELECT value FROM admin_settings WHERE key = 'render_location'`,
  ).first()
  return row?.value === 'cloud' ? 'cloud' : 'local'
}
const renderWorker = (env) => {
  const base = String(env.RENDER_WORKER_URL || '').replace(/\/+$/, '')
  const token = String(env.RENDER_WORKER_TOKEN || '')
  return base && token ? { base, token } : null
}
const workerResponse = async (env, path, init = {}) => {
  const worker = renderWorker(env)
  if (!worker) return json({ error: 'Cloud render worker is not configured.' }, 503)
  const headers = new Headers(init.headers || {})
  headers.set('Authorization', `Bearer ${worker.token}`)
  const upstream = await fetch(`${worker.base}${path}`, { ...init, headers }).catch(() => null)
  if (!upstream) return json({ error: 'Cloud render worker is unreachable.' }, 502)
  const responseHeaders = new Headers()
  for (const name of ['Content-Type', 'Content-Disposition', 'Content-Length', 'Accept-Ranges']) {
    const value = upstream.headers.get(name)
    if (value) responseHeaders.set(name, value)
  }
  responseHeaders.set('Cache-Control', 'private, no-store')
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
}

export async function onRequest({ env, request, params }) {
  const gate = await requireAdmin(env, request)
  if (gate.error) return gate.error
  const admin = gate.user
  const parts = Array.isArray(params.path) ? params.path : [params.path]
  const [route, action] = parts

  const templateRows = async () =>
    (
      await env.DB.prepare(`SELECT * FROM global_templates ORDER BY name`).all()
    ).results.map((t) => ({
      ...t,
      files: JSON.parse(t.files || '[]').map((key) => ({ key, url: `${ASSETS_BASE}/${key}` })),
      poster_url: t.poster_key ? `${ASSETS_BASE}/${t.poster_key}` : '',
      preview_url: t.preview_key ? `${ASSETS_BASE}/${t.preview_key}` : '',
    }))

  if (route === 'templates' && !action && request.method === 'GET') {
    return json({ templates: await templateRows() })
  }

  if (route === 'library' && request.method === 'GET') {
    // The bucket listing is the truth about what's in the cloud — characters
    // have no D1 rows (their metadata lives in the content repo), so they are
    // grouped straight from their keys.
    const objects = []
    let cursor
    do {
      const page = await env.GLOBAL_ASSETS.list({ cursor, limit: 1000 })
      objects.push(...page.objects)
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    const characters = new Map()
    const other = []
    for (const o of objects) {
      const m = o.key.match(/^characters\/([^/]+)\/(.+)$/)
      if (m) {
        const c = characters.get(m[1]) || { slug: m[1], portrait_url: '', files: [] }
        c.files.push({ key: o.key, url: `${ASSETS_BASE}/${o.key}`, size: o.size })
        if (m[2].startsWith('portrait.')) c.portrait_url = `${ASSETS_BASE}/${o.key}`
        characters.set(m[1], c)
      } else if (!o.key.startsWith('templates/')) {
        other.push({ key: o.key, url: `${ASSETS_BASE}/${o.key}`, size: o.size })
      }
    }
    return json({
      templates: await templateRows(),
      characters: [...characters.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
      other,
      rendering: {
        location: await renderLocation(env),
        cloud_configured: Boolean(renderWorker(env)),
      },
    })
  }

  if (route === 'settings' && action === 'render-location') {
    if (request.method === 'GET') {
      return json({
        location: await renderLocation(env),
        cloud_configured: Boolean(renderWorker(env)),
      })
    }
    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}))
      const location = String(body.location || '')
      if (!['local', 'cloud'].includes(location)) {
        return json({ error: 'location must be local or cloud' }, 400)
      }
      if (location === 'cloud' && !renderWorker(env)) {
        return json({ error: 'Cloud render worker is not configured.' }, 409)
      }
      await env.DB.prepare(
        `INSERT INTO admin_settings (key, value, updated_by, updated_at)
         VALUES ('render_location', ?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
           value=excluded.value, updated_by=excluded.updated_by, updated_at=datetime('now')`,
      ).bind(location, admin.id).run()
      return json({ location, cloud_configured: Boolean(renderWorker(env)) })
    }
  }

  if (route === 'render' && action === 'start' && request.method === 'POST') {
    if (await renderLocation(env) !== 'cloud') {
      return json({ error: 'Cloud rendering is not selected in Admin settings.' }, 409)
    }
    const payload = await request.json().catch(() => ({}))
    if (payload.action !== 'render_with_audit') {
      return json({ error: 'The render proxy accepts render_with_audit only.' }, 400)
    }
    return workerResponse(env, '/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }

  if (route === 'render' && ['file', 'info', 'download'].includes(action) && request.method === 'GET') {
    const source = new URL(request.url)
    const session = source.searchParams.get('session') || ''
    if (!/^[A-Za-z0-9_-]+$/.test(session)) return json({ error: 'Invalid session.' }, 400)
    const upstreamPath = action === 'info' ? '/api/render-info' : `/api/${action}`
    const upstream = new URL(upstreamPath, 'https://render-worker.invalid')
    upstream.searchParams.set('session', session)
    if (action !== 'info') {
      const path = source.searchParams.get('path') || ''
      if (!path || path.includes('..')) return json({ error: 'Invalid path.' }, 400)
      upstream.searchParams.set('path', path)
    }
    return workerResponse(env, `${upstream.pathname}${upstream.search}`)
  }

  if (route === 'templates' && action === 'publish' && request.method === 'POST') {
    const form = await request.formData().catch(() => null)
    const tplPart = form?.get('template')
    if (!tplPart || typeof tplPart === 'string') {
      return json({ error: 'Send template.json as the "template" file part.' }, 400)
    }
    const tplText = await tplPart.text()
    let tpl
    try {
      tpl = JSON.parse(tplText)
    } catch {
      return json({ error: 'template.json is not valid JSON.' }, 400)
    }
    const slug = String(tpl.id || '').trim()
    if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(slug)) {
      return json({ error: 'template.json needs an "id": a lowercase slug (a-z, 0-9, -).' }, 400)
    }

    const prefix = `templates/${slug}`
    const files = [`${prefix}/template.json`]
    await env.GLOBAL_ASSETS.put(`${prefix}/template.json`, tplText, {
      httpMetadata: { contentType: 'application/json' },
    })
    for (const part of form.getAll('file')) {
      if (typeof part === 'string') continue
      const name = (part.name || '').split('/').pop()
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(name)) {
        return json({ error: `Bad extra file name: ${part.name}` }, 400)
      }
      if (name === 'template.json') continue
      const key = `${prefix}/${name}`
      await env.GLOBAL_ASSETS.put(key, part, { httpMetadata: { contentType: contentType(name, part.type) } })
      files.push(key)
    }

    const existing = await env.DB.prepare(
      `SELECT version, poster_key, preview_key FROM global_templates WHERE slug = ?`,
    ).bind(slug).first()
    const art = async (field, keyBase) => {
      const part = form.get(field)
      if (!part || typeof part === 'string') return existing?.[`${field}_key`] || ''
      const key = `${prefix}/${keyBase}${ext(part.name || '') || '.png'}`
      await env.GLOBAL_ASSETS.put(key, part, { httpMetadata: { contentType: contentType(part.name || '', part.type) } })
      files.push(key)
      return key
    }
    const posterKey = await art('poster', 'poster')
    const previewKey = await art('preview', 'preview')
    const version = (existing?.version || 0) + 1

    await env.DB.prepare(
      `INSERT INTO global_templates
         (slug, name, description, format, contract, version, r2_prefix, files, poster_key, preview_key, live, published_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(slug) DO UPDATE SET
         name=excluded.name, description=excluded.description, format=excluded.format,
         contract=excluded.contract, version=excluded.version, files=excluded.files,
         poster_key=excluded.poster_key, preview_key=excluded.preview_key, live=1,
         published_by=excluded.published_by, updated_at=datetime('now')`,
    ).bind(
      slug,
      String(tpl.name || slug),
      String(tpl.description || ''),
      String(tpl.format || ''),
      String(tpl.contract || ''),
      version,
      prefix,
      JSON.stringify(files),
      posterKey,
      previewKey,
      admin.id,
    ).run()
    return json({ published: slug, version, files })
  }

  if (route === 'templates' && (action === 'unpublish' || action === 'relist') && request.method === 'POST') {
    const body = await request.json().catch(() => ({}))
    const slug = String(body.slug || '').trim()
    const live = action === 'relist' ? 1 : 0
    const done = await env.DB.prepare(
      `UPDATE global_templates SET live = ?, updated_at = datetime('now') WHERE slug = ?`,
    ).bind(live, slug).run()
    if (!done.meta.changes) return json({ error: `No template with slug "${slug}".` }, 404)
    return json({ [action === 'relist' ? 'relisted' : 'unpublished']: slug })
  }

  return json({ error: 'unknown route' }, 404)
}

// User-owned publishing: the signed-in account pushes a finished video to its
// OWN creator page. Replaces the operator-run site/publish.py path for users.
//   POST /api/publish/video?slug=…&title=…[&description=…&series=…&series_title=…
//        &episode=…&public=0|1]   body = the video file (video/*)
//
// MONEY-READY, not money-built: rows stay priced-nothing; a future unlocks
// table keys on videos.id and the ledger already exists — publishing needs no
// schema rework when credits arrive.
// SIZE LIMIT: the file streams through this function, so uploads are bounded
// by the platform request cap (~100 MB). Bigger uploads move to multipart
// against the bucket later.

import { sessionUser } from '../_auth.js'

const json = (data, status = 200) =>
  new Response(JSON.stringify({ ok: status < 400, data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const slugify = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

export async function onRequestPost({ env, request, params }) {
  const route = (Array.isArray(params.path) ? params.path : [params.path])[0]
  if (route !== 'video') return json({ error: 'unknown route' }, 404)

  const user = await sessionUser(env, request)
  if (!user) return json({ error: 'Sign in first.' }, 401)
  const creator = await env.DB.prepare(`SELECT * FROM creators WHERE user_id = ?`).bind(user.id).first()
  if (!creator) return json({ error: 'Pick a handle first — your public page needs a name.' }, 409)

  const url = new URL(request.url)
  const q = (name) => (url.searchParams.get(name) || '').trim()
  const title = q('title').slice(0, 200)
  const slug = slugify(q('slug') || title)
  if (!title || !slug) return json({ error: 'A title (and slug) is required.' }, 400)
  const contentType = request.headers.get('Content-Type') || ''
  if (!contentType.startsWith('video/')) {
    return json({ error: 'Send the video file as the request body with a video/* content type.' }, 400)
  }
  const isPublic = q('public') === '1' ? 1 : 0
  const episode = /^\d+$/.test(q('episode')) ? Number(q('episode')) : null

  // Series: find-or-create, but only ever the caller's own.
  let seriesId = null
  const seriesSlug = slugify(q('series'))
  if (seriesSlug) {
    const existing = await env.DB.prepare(`SELECT * FROM series WHERE slug = ?`).bind(seriesSlug).first()
    if (existing && existing.creator_id !== creator.id) {
      return json({ error: 'That series belongs to another creator.' }, 403)
    }
    if (existing) {
      seriesId = existing.id
      if (isPublic && !existing.public) {
        await env.DB.prepare(`UPDATE series SET public = 1 WHERE id = ?`).bind(seriesId).run()
      }
    } else {
      const r = await env.DB.prepare(
        `INSERT INTO series (creator_id, slug, title, public) VALUES (?, ?, ?, ?)`,
      ).bind(creator.id, seriesSlug, q('series_title').slice(0, 120) || seriesSlug, isPublic).run()
      seriesId = r.meta.last_row_id
    }
  }

  // A slug can only be re-published by the creator who owns it.
  const existingVideo = await env.DB.prepare(`SELECT * FROM videos WHERE slug = ?`).bind(slug).first()
  if (existingVideo && existingVideo.creator_id !== creator.id) {
    return json({ error: 'That video slug belongs to another creator.' }, 403)
  }

  const ext = contentType.includes('webm') ? '.webm' : '.mp4'
  const key = `videos/${creator.handle}/${seriesSlug || 'videos'}/${slug}${ext}`
  await env.VIDEOS.put(key, request.body, { httpMetadata: { contentType } })

  await env.DB.prepare(
    `INSERT INTO videos (creator_id, series_id, episode, slug, title, description, r2_key, public)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET title=excluded.title, description=excluded.description,
       r2_key=excluded.r2_key, public=excluded.public, series_id=excluded.series_id, episode=excluded.episode`,
  ).bind(creator.id, seriesId, episode, slug, title, q('description').slice(0, 5000), key, isPublic).run()

  return json({ slug, url: `/watch/v/${slug}`, public: isPublic === 1 })
}

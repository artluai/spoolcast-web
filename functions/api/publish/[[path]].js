// User-owned publishing: the signed-in account pushes a finished video to its
// OWN creator page. Replaces the operator-run site/publish.py path for users.
//   POST /api/publish/video?slug=…&title=…[&description=…&series=…&series_title=…
//        &episode=…&public=0|1]   body = the video file (video/*)
// The same route also accepts multipart/form-data with `video`, `poster`,
// `duration_s`, `width`, and `height`. The raw-video shape remains supported
// for existing callers.
//
// MONEY-READY, not money-built: rows stay priced-nothing; a future unlocks
// table keys on videos.id and the ledger already exists — publishing needs no
// schema rework when credits arrive.
// SIZE LIMIT: the file streams through this function, so uploads are bounded
// by the platform request cap (~100 MB). Bigger uploads move to multipart
// against the bucket later.

import { sessionUser } from '../_auth.js'

const MEDIA_BASE = 'https://pub-6903b93eacaf46b08e7b4644251ab085.r2.dev'

const json = (data, status = 200) =>
  new Response(JSON.stringify({ ok: status < 400, data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const slugify = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

const finiteNumber = (value, integer = false) => {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0 || (integer && !Number.isInteger(number))) return null
  return number
}

const uploadFile = (value) =>
  value && typeof value !== 'string' && typeof value.stream === 'function'

const imageExtension = (contentType) => {
  if (contentType.includes('jpeg')) return '.jpg'
  if (contentType.includes('webp')) return '.webp'
  return '.png'
}

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
  const requestContentType = request.headers.get('Content-Type') || ''
  let contentType = requestContentType
  let videoBody = request.body
  let poster = null
  let duration = finiteNumber(q('duration_s'))
  let width = finiteNumber(q('width'), true)
  let height = finiteNumber(q('height'), true)
  if (requestContentType.startsWith('multipart/form-data')) {
    const form = await request.formData().catch(() => null)
    const video = form?.get('video')
    poster = form?.get('poster') || null
    if (!uploadFile(video)) {
      return json({ error: 'Multipart publishes require a video file.' }, 400)
    }
    if (poster && !uploadFile(poster)) {
      return json({ error: 'poster must be an image file.' }, 400)
    }
    contentType = video.type || ''
    videoBody = video.stream()
    duration = finiteNumber(form.get('duration_s')) ?? duration
    width = finiteNumber(form.get('width'), true) ?? width
    height = finiteNumber(form.get('height'), true) ?? height
  }
  if (!contentType.startsWith('video/') || !videoBody) {
    return json({ error: 'Send the video file as the request body with a video/* content type.' }, 400)
  }
  if (poster && !poster.type.startsWith('image/')) {
    return json({ error: 'poster must be an image file.' }, 400)
  }
  const isPublic = q('public') === '1' ? 1 : 0
  const episode = /^\d+$/.test(q('episode')) ? Number(q('episode')) : null
  const seriesTitle = q('series_title').slice(0, 120)
  const seriesDescription = q('series_description').slice(0, 5000)

  // Resolve ownership before writing either object. New rows are inserted
  // after the R2 writes, matching site/publish.py's upload-then-register flow.
  const seriesSlug = slugify(q('series'))
  let existingSeries = null
  if (seriesSlug) {
    existingSeries = await env.DB.prepare(`SELECT * FROM series WHERE slug = ?`).bind(seriesSlug).first()
    if (existingSeries && existingSeries.creator_id !== creator.id) {
      return json({ error: 'That series belongs to another creator.' }, 403)
    }
  }

  // A slug can only be re-published by the creator who owns it.
  const existingVideo = await env.DB.prepare(`SELECT * FROM videos WHERE slug = ?`).bind(slug).first()
  if (existingVideo && existingVideo.creator_id !== creator.id) {
    return json({ error: 'That video slug belongs to another creator.' }, 403)
  }

  const ext = contentType.includes('webm') ? '.webm' : '.mp4'
  const key = `videos/${creator.handle}/${seriesSlug || 'videos'}/${slug}${ext}`
  await env.VIDEOS.put(key, videoBody, { httpMetadata: { contentType } })
  let posterKey = ''
  if (poster) {
    posterKey = `videos/${creator.handle}/${seriesSlug || 'videos'}/${slug}-poster${imageExtension(poster.type)}`
    await env.VIDEOS.put(posterKey, poster.stream(), { httpMetadata: { contentType: poster.type } })
  }

  let seriesId = existingSeries?.id ?? null
  if (seriesSlug) {
    const coverUrl = posterKey ? `${MEDIA_BASE}/${posterKey}` : ''
    if (existingSeries) {
      await env.DB.prepare(
        `UPDATE series
         SET title = COALESCE(NULLIF(?, ''), title),
             description = COALESCE(NULLIF(?, ''), description),
             cover_url = COALESCE(NULLIF(?, ''), cover_url),
             public = CASE WHEN ? = 1 THEN 1 ELSE public END
         WHERE id = ?`,
      ).bind(seriesTitle, seriesDescription, coverUrl, isPublic, existingSeries.id).run()
    } else {
      const result = await env.DB.prepare(
        `INSERT INTO series (creator_id, slug, title, description, cover_url, public)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        creator.id,
        seriesSlug,
        seriesTitle || seriesSlug,
        seriesDescription,
        coverUrl,
        isPublic,
      ).run()
      seriesId = result.meta.last_row_id
    }
  }

  await env.DB.prepare(
    `INSERT INTO videos (
       creator_id, series_id, episode, slug, title, description, r2_key,
       poster_key, duration_s, width, height, public
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET title=excluded.title, description=excluded.description,
       r2_key=excluded.r2_key,
       poster_key=COALESCE(NULLIF(excluded.poster_key, ''), videos.poster_key),
       duration_s=COALESCE(excluded.duration_s, videos.duration_s),
       width=COALESCE(excluded.width, videos.width),
       height=COALESCE(excluded.height, videos.height),
       public=excluded.public, series_id=excluded.series_id, episode=excluded.episode`,
  ).bind(
    creator.id,
    seriesId,
    episode,
    slug,
    title,
    q('description').slice(0, 5000),
    key,
    posterKey,
    duration,
    width,
    height,
    isPublic,
  ).run()

  return json({
    slug,
    url: `/watch/v/${slug}`,
    public: isPublic === 1,
    poster_key: posterKey,
    duration_s: duration,
    width,
    height,
  })
}

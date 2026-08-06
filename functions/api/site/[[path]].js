// Viewer-site API (Cloudflare Pages Functions + D1).
// Public visitors only receive public rows. A signed-in creator can also read
// and manage the private rows on their own page.
//   GET /api/site/home        → { latest: [...], rows: [{ series, videos }] }
//   GET /api/site/u/:handle   → { creator, series: [...], videos: [...] }
//   GET /api/site/s/:slug     → { series, creator, videos: [...] }
//   GET /api/site/v/:slug     → { video, creator, series, siblings: [...] }
//   PATCH /api/site/v/:slug   → toggle the owner's video public/private
//   PATCH /api/site/u/:handle → update the owner's bio and avatar URL
//   GET /api/site/templates   → { templates: [...] } (live global templates)

import { sessionUser } from '../_auth.js'
import { serveSignedVideo, signedVideoUrl } from '../_media.js'

// Global asset library bucket (spoolcast-assets) — same base the character
// library's image_url values use.
const ASSETS_BASE = 'https://pub-275d3988223b4b53b851fe856882cec0.r2.dev'

const json = (data, status = 200, privateResponse = false) =>
  new Response(JSON.stringify({ ok: status < 400, data }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': privateResponse ? 'private, no-store' : 'public, max-age=60',
    },
  })

const publicCreator = ({ user_id: _userId, ...creator }) => creator

const withUrls = async (env, v) =>
  v && {
    ...v,
    media_url: await signedVideoUrl(env, v.r2_key, Boolean(v.public)),
    poster_url: v.poster_key ? await signedVideoUrl(env, v.poster_key, Boolean(v.public)) : '',
  }

const videoKeyFromCover = (coverUrl) => {
  const value = String(coverUrl || '')
  if (value.startsWith('r2:videos/')) return value.slice(3)
  const marker = '.r2.dev/'
  const markerAt = value.indexOf(marker)
  if (markerAt !== -1) {
    const key = value.slice(markerAt + marker.length)
    if (key.startsWith('videos/')) return key
  }
  return ''
}

const withCoverUrl = async (env, series) => {
  if (!series) return series
  const key = videoKeyFromCover(series.cover_url)
  return key
    ? { ...series, cover_url: await signedVideoUrl(env, key, Boolean(series.public)) }
    : series
}

export async function onRequestGet({ env, request, params }) {
  const parts = Array.isArray(params.path) ? params.path : [params.path]
  const [route, arg] = parts
  const db = env.DB

  if (route === 'media') return serveSignedVideo(env, request)

  if (route === 'home') {
    const latest = await Promise.all((
      await db
        .prepare(
          `SELECT v.*, c.handle AS creator_handle, c.name AS creator_name, s.title AS series_title, s.slug AS series_slug
           FROM videos v JOIN creators c ON c.id = v.creator_id
           LEFT JOIN series s ON s.id = v.series_id
           WHERE v.public = 1 ORDER BY v.published_at DESC LIMIT 24`,
        )
        .all()
    ).results.map((video) => withUrls(env, video)))
    const seriesRows = await Promise.all((
      await db
        .prepare(
          `SELECT s.*, c.handle AS creator_handle, c.name AS creator_name
           FROM series s JOIN creators c ON c.id = s.creator_id
           WHERE s.public = 1 ORDER BY s.created_at DESC LIMIT 12`,
        )
        .all()
    ).results.map((series) => withCoverUrl(env, series)))
    const rows = []
    for (const s of seriesRows) {
      const videoRows = (
        await db
          .prepare(
            `SELECT * FROM videos WHERE series_id = ? AND public = 1 ORDER BY episode, published_at LIMIT 20`,
          )
          .bind(s.id)
          .all()
      ).results
      const videos = await Promise.all(videoRows.map((video) => withUrls(env, video)))
      if (videos.length) rows.push({ series: s, videos })
    }
    return json({ latest, rows })
  }

  if (route === 'u' && arg) {
    const creator = await db.prepare(`SELECT * FROM creators WHERE handle = ?`).bind(arg).first()
    if (!creator) return json({ error: 'not found' }, 404)
    const user = await sessionUser(env, request)
    const owner = Boolean(user && creator.user_id === user.id)
    const series = await Promise.all((
      await db
        .prepare(
          `SELECT * FROM series WHERE creator_id = ?${owner ? '' : ' AND public = 1'} ORDER BY created_at DESC`,
        )
        .bind(creator.id)
        .all()
    ).results.map((item) => withCoverUrl(env, item)))
    const videos = await Promise.all((
      await db
        .prepare(
          `SELECT * FROM videos WHERE creator_id = ?${owner ? '' : ' AND public = 1'} ORDER BY published_at DESC LIMIT 60`,
        )
        .bind(creator.id)
        .all()
    ).results.map((video) => withUrls(env, video)))
    return json({ creator: publicCreator(creator), series, videos, owner }, 200, Boolean(user))
  }

  if (route === 's' && arg) {
    const seriesRow = await db.prepare(`SELECT * FROM series WHERE slug = ?`).bind(arg).first()
    if (!seriesRow) return json({ error: 'not found' }, 404)
    const creator = await db.prepare(`SELECT * FROM creators WHERE id = ?`).bind(seriesRow.creator_id).first()
    const user = await sessionUser(env, request)
    const owner = Boolean(user && creator.user_id === user.id)
    if (!seriesRow.public && !owner) return json({ error: 'not found' }, 404, Boolean(user))
    const series = await withCoverUrl(env, seriesRow)
    const videos = await Promise.all((
      await db
        .prepare(
          `SELECT * FROM videos WHERE series_id = ?${owner ? '' : ' AND public = 1'} ORDER BY episode, published_at`,
        )
        .bind(series.id)
        .all()
    ).results.map((video) => withUrls(env, video)))
    return json(
      { series, creator: publicCreator(creator), videos, owner },
      200,
      Boolean(user),
    )
  }

  if (route === 'v' && arg) {
    const video = await db.prepare(`SELECT * FROM videos WHERE slug = ?`).bind(arg).first()
    if (!video) return json({ error: 'not found' }, 404)
    const creator = await db.prepare(`SELECT * FROM creators WHERE id = ?`).bind(video.creator_id).first()
    const user = await sessionUser(env, request)
    const owner = Boolean(user && creator.user_id === user.id)
    if (!video.public && !owner) return json({ error: 'not found' }, 404, Boolean(user))
    const seriesRow = video.series_id
      ? await db.prepare(`SELECT * FROM series WHERE id = ?`).bind(video.series_id).first()
      : null
    const series = await withCoverUrl(env, seriesRow)
    const siblings = video.series_id
      ? await Promise.all((
          await db
            .prepare(
              `SELECT * FROM videos WHERE series_id = ?${owner ? '' : ' AND public = 1'} ORDER BY episode, published_at`,
            )
            .bind(video.series_id)
            .all()
        ).results.map((item) => withUrls(env, item)))
      : []
    return json(
      { video: await withUrls(env, video), creator: publicCreator(creator), series, siblings, owner },
      200,
      Boolean(user),
    )
  }

  if (route === 'templates') {
    const templates = (
      await db
        .prepare(
          `SELECT slug, name, description, format, contract, version, r2_prefix, files,
                  poster_key, preview_key, published_at, updated_at
           FROM global_templates WHERE live = 1 ORDER BY name`,
        )
        .all()
    ).results.map((t) => ({
      ...t,
      files: JSON.parse(t.files || '[]'),
      template_url: `${ASSETS_BASE}/${t.r2_prefix}/template.json`,
      poster_url: t.poster_key ? `${ASSETS_BASE}/${t.poster_key}` : '',
      preview_url: t.preview_key ? `${ASSETS_BASE}/${t.preview_key}` : '',
    }))
    return json({ templates })
  }

  return json({ error: 'unknown route' }, 404)
}

export async function onRequestPatch({ env, request, params }) {
  const parts = Array.isArray(params.path) ? params.path : [params.path]
  const [route, arg] = parts
  if (!arg || !['u', 'v'].includes(route)) return json({ error: 'unknown route' }, 404, true)

  const user = await sessionUser(env, request)
  if (!user) return json({ error: 'Sign in first.' }, 401, true)
  const creator = await env.DB.prepare(`SELECT * FROM creators WHERE user_id = ?`).bind(user.id).first()
  if (!creator) return json({ error: 'Creator profile not found.' }, 404, true)

  if (route === 'u') {
    if (creator.handle !== arg) {
      return json({ error: 'You can only edit your own profile.' }, 403, true)
    }
    const body = await request.json().catch(() => ({}))
    const bio = String(body.bio ?? '').trim().slice(0, 500)
    const avatarUrl = String(body.avatar_url ?? '').trim().slice(0, 2000)
    if (avatarUrl) {
      try {
        const url = new URL(avatarUrl)
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol')
      } catch {
        return json({ error: 'Avatar must be a valid http:// or https:// image URL.' }, 400, true)
      }
    }
    await env.DB.prepare(`UPDATE creators SET bio = ?, avatar_url = ? WHERE id = ?`)
      .bind(bio, avatarUrl, creator.id)
      .run()
    const updated = await env.DB.prepare(`SELECT * FROM creators WHERE id = ?`).bind(creator.id).first()
    return json({ creator: publicCreator(updated) }, 200, true)
  }

  const video = await env.DB.prepare(`SELECT * FROM videos WHERE slug = ?`).bind(arg).first()
  if (!video) return json({ error: 'Video not found.' }, 404, true)
  if (video.creator_id !== creator.id) {
    return json({ error: 'You can only manage your own videos.' }, 403, true)
  }

  const body = await request.json().catch(() => ({}))
  if (typeof body.public !== 'boolean') {
    return json({ error: 'public must be true or false.' }, 400, true)
  }
  const isPublic = body.public ? 1 : 0
  await env.DB.prepare(`UPDATE videos SET public = ? WHERE id = ?`).bind(isPublic, video.id).run()

  // Keep the series shelf honest: it is public while at least one episode is
  // public, and private again when its last public episode is hidden.
  if (video.series_id) {
    await env.DB.prepare(
      `UPDATE series
       SET public = CASE WHEN EXISTS (
         SELECT 1 FROM videos WHERE series_id = ? AND public = 1
       ) THEN 1 ELSE 0 END
       WHERE id = ?`,
    ).bind(video.series_id, video.series_id).run()
  }

  const updated = await env.DB.prepare(`SELECT * FROM videos WHERE id = ?`).bind(video.id).first()
  return json({ video: await withUrls(env, updated) }, 200, true)
}

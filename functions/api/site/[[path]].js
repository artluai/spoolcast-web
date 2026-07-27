// Viewer-site API (Cloudflare Pages Functions + D1).
// Read-only catalog endpoints; only rows with public=1 ever leave this file.
//   GET /api/site/home        → { latest: [...], rows: [{ series, videos }] }
//   GET /api/site/u/:handle   → { creator, series: [...], videos: [...] }
//   GET /api/site/s/:slug     → { series, creator, videos: [...] }
//   GET /api/site/v/:slug     → { video, creator, series, siblings: [...] }

const MEDIA_BASE = 'https://pub-6903b93eacaf46b08e7b4644251ab085.r2.dev'

const json = (data, status = 200) =>
  new Response(JSON.stringify({ ok: status < 400, data }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
  })

const withUrls = (v) =>
  v && {
    ...v,
    media_url: `${MEDIA_BASE}/${v.r2_key}`,
    poster_url: v.poster_key ? `${MEDIA_BASE}/${v.poster_key}` : '',
  }

export async function onRequestGet({ env, params }) {
  const parts = Array.isArray(params.path) ? params.path : [params.path]
  const [route, arg] = parts
  const db = env.DB

  if (route === 'home') {
    const latest = (
      await db
        .prepare(
          `SELECT v.*, c.handle AS creator_handle, c.name AS creator_name, s.title AS series_title, s.slug AS series_slug
           FROM videos v JOIN creators c ON c.id = v.creator_id
           LEFT JOIN series s ON s.id = v.series_id
           WHERE v.public = 1 ORDER BY v.published_at DESC LIMIT 24`,
        )
        .all()
    ).results.map(withUrls)
    const seriesRows = (
      await db
        .prepare(
          `SELECT s.*, c.handle AS creator_handle, c.name AS creator_name
           FROM series s JOIN creators c ON c.id = s.creator_id
           WHERE s.public = 1 ORDER BY s.created_at DESC LIMIT 12`,
        )
        .all()
    ).results
    const rows = []
    for (const s of seriesRows) {
      const videos = (
        await db
          .prepare(
            `SELECT * FROM videos WHERE series_id = ? AND public = 1 ORDER BY episode, published_at LIMIT 20`,
          )
          .bind(s.id)
          .all()
      ).results.map(withUrls)
      if (videos.length) rows.push({ series: s, videos })
    }
    return json({ latest, rows })
  }

  if (route === 'u' && arg) {
    const creator = await db.prepare(`SELECT * FROM creators WHERE handle = ?`).bind(arg).first()
    if (!creator) return json({ error: 'not found' }, 404)
    const series = (
      await db
        .prepare(`SELECT * FROM series WHERE creator_id = ? AND public = 1 ORDER BY created_at DESC`)
        .bind(creator.id)
        .all()
    ).results
    const videos = (
      await db
        .prepare(
          `SELECT * FROM videos WHERE creator_id = ? AND public = 1 ORDER BY published_at DESC LIMIT 60`,
        )
        .bind(creator.id)
        .all()
    ).results.map(withUrls)
    return json({ creator, series, videos })
  }

  if (route === 's' && arg) {
    const series = await db
      .prepare(`SELECT * FROM series WHERE slug = ? AND public = 1`)
      .bind(arg)
      .first()
    if (!series) return json({ error: 'not found' }, 404)
    const creator = await db.prepare(`SELECT * FROM creators WHERE id = ?`).bind(series.creator_id).first()
    const videos = (
      await db
        .prepare(`SELECT * FROM videos WHERE series_id = ? AND public = 1 ORDER BY episode, published_at`)
        .bind(series.id)
        .all()
    ).results.map(withUrls)
    return json({ series, creator, videos })
  }

  if (route === 'v' && arg) {
    const video = await db.prepare(`SELECT * FROM videos WHERE slug = ? AND public = 1`).bind(arg).first()
    if (!video) return json({ error: 'not found' }, 404)
    const creator = await db.prepare(`SELECT * FROM creators WHERE id = ?`).bind(video.creator_id).first()
    const series = video.series_id
      ? await db.prepare(`SELECT * FROM series WHERE id = ?`).bind(video.series_id).first()
      : null
    const siblings = video.series_id
      ? (
          await db
            .prepare(
              `SELECT * FROM videos WHERE series_id = ? AND public = 1 ORDER BY episode, published_at`,
            )
            .bind(video.series_id)
            .all()
        ).results.map(withUrls)
      : []
    return json({ video: withUrls(video), creator, series, siblings })
  }

  return json({ error: 'unknown route' }, 404)
}

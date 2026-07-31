import { useCallback, useEffect, useState } from 'react'

// Admin dashboard (/admin): what is actually in the global cloud library —
// template rows from D1 plus the real contents of the spoolcast-assets
// bucket. The server-side gate is /api/admin/* (requireAdmin); this view only
// mirrors its verdict for the browser. Characters are view-only for now:
// their metadata lives in the content repo and uploads go through the
// engine-side script until the storage seam lands.

type FileRef = { key: string; url: string; size?: number }
type Tpl = {
  slug: string
  name: string
  description: string
  format: string
  contract: string
  version: number
  live: number
  published_at: string
  updated_at: string
  files: FileRef[]
  poster_url: string
  preview_url: string
}
type Chr = { slug: string; portrait_url: string; files: FileRef[] }
type RenderLocation = 'local' | 'cloud'
type Library = {
  templates: Tpl[]
  characters: Chr[]
  other: FileRef[]
  rendering: { location: RenderLocation; cloud_configured: boolean }
}

export default function AdminView() {
  const [lib, setLib] = useState<Library | null>(null)
  const [gate, setGate] = useState<'loading' | 'anon' | 'user' | 'admin' | 'error'>('loading')
  const [busy, setBusy] = useState('')
  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/library')
      if (r.status === 401) return setGate('anon')
      if (r.status === 403) return setGate('user')
      if (!r.ok) return setGate('error')
      setLib((await r.json()).data as Library)
      setGate('admin')
    } catch {
      setGate('error')
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  const setLive = async (slug: string, live: boolean) => {
    setBusy(slug)
    await fetch(`/api/admin/templates/${live ? 'relist' : 'unpublish'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug }),
    }).catch(() => {})
    await load()
    setBusy('')
  }
  const setRenderLocation = async (location: RenderLocation) => {
    setBusy('render-location')
    await fetch('/api/admin/settings/render-location', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location }),
    }).catch(() => {})
    await load()
    setBusy('')
  }

  if (gate === 'loading') return null
  if (gate === 'anon') return <p className="site-empty">Sign in first — this page is for the admin account.</p>
  if (gate === 'user') return <p className="site-empty">Admin only.</p>
  if (gate === 'error' || !lib) return <p className="site-empty">Could not load the library.</p>

  return (
    <>
      <section className="site-hero">
        <h1>Global library</h1>
        <p className="site-hero-desc">
          Everything published to the cloud asset library: templates anyone can start from, and the
          shared character cast. Publish or update a template with site/publish_template.py.
        </p>
      </section>

      <section className="site-row">
        <h2>Rendering <span className="site-by">admin only</span></h2>
        <div className="admin-tpl">
          <div className="admin-tpl-body">
            <b>
              Render final videos on
              <span className={`admin-badge ${lib.rendering.cloud_configured ? 'live' : ''}`}>
                {lib.rendering.cloud_configured ? 'CLOUD READY' : 'CLOUD NOT CONFIGURED'}
              </span>
            </b>
            <p>
              Local uses this Mac exactly as before. Cloud sends Remotion and ffmpeg work to the
              private render worker.
            </p>
          </div>
          {(['local', 'cloud'] as const).map((location) => (
            <button
              key={location}
              type="button"
              className="admin-btn"
              aria-pressed={lib.rendering.location === location}
              disabled={
                busy === 'render-location'
                || lib.rendering.location === location
                || (location === 'cloud' && !lib.rendering.cloud_configured)
              }
              onClick={() => void setRenderLocation(location)}
            >
              {lib.rendering.location === location ? '✓ ' : ''}
              {location === 'local' ? 'This Mac' : 'Cloud'}
            </button>
          ))}
        </div>
      </section>

      <section className="site-row">
        <h2>Templates <span className="site-by">{lib.templates.length}</span></h2>
        {!lib.templates.length && <p className="site-empty">No templates published yet.</p>}
        {lib.templates.map((t) => (
          <div className={`admin-tpl ${t.live ? '' : 'admin-tpl-hidden'}`} key={t.slug}>
            {t.poster_url ? (
              <img className="admin-tpl-art" src={t.poster_url} alt="" />
            ) : (
              <div className="admin-tpl-art admin-tpl-art-blank">{t.name.slice(0, 1)}</div>
            )}
            <div className="admin-tpl-body">
              <b>
                {t.name}
                <span className="site-by">
                  {t.slug} · v{t.version}{t.format ? ` · ${t.format}` : ''}{t.contract ? ` · contract ${t.contract}` : ''}
                </span>
                <span className={`admin-badge ${t.live ? 'live' : ''}`}>{t.live ? 'LIVE' : 'HIDDEN'}</span>
              </b>
              {t.description && <p>{t.description}</p>}
              <span className="admin-files">
                {t.files.map((f) => (
                  <a key={f.key} href={f.url} target="_blank" rel="noreferrer">
                    {f.key.split('/').pop()}
                  </a>
                ))}
              </span>
            </div>
            <button
              className="admin-btn"
              disabled={busy === t.slug}
              onClick={() => void setLive(t.slug, !t.live)}
            >
              {t.live ? 'Unpublish' : 'Relist'}
            </button>
          </div>
        ))}
      </section>

      <section className="site-row admin-cast">
        <h2>
          Characters{' '}
          <span className="site-by">{lib.characters.length} · view-only — managed by the engine-side library for now</span>
        </h2>
        {!lib.characters.length && <p className="site-empty">No characters in the bucket.</p>}
        <div className="site-grid">
          {lib.characters.map((c) => (
            <a
              className="site-card"
              key={c.slug}
              href={c.portrait_url || undefined}
              target="_blank"
              rel="noreferrer"
            >
              {c.portrait_url ? (
                <img src={c.portrait_url} alt={c.slug} loading="lazy" />
              ) : (
                <div className="site-card-blank"><span>{c.slug}</span></div>
              )}
              <div className="site-card-meta">
                <b>{c.slug}</b>
                <span>{c.files.length} file{c.files.length === 1 ? '' : 's'}</span>
              </div>
            </a>
          ))}
        </div>
      </section>

      {lib.other.length > 0 && (
        <section className="site-row">
          <h2>Other files in the bucket <span className="site-by">{lib.other.length}</span></h2>
          <span className="admin-files">
            {lib.other.map((f) => (
              <a key={f.key} href={f.url} target="_blank" rel="noreferrer">{f.key}</a>
            ))}
          </span>
        </section>
      )}
    </>
  )
}

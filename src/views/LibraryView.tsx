import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ASSET_TYPES,
  LIB_CHARS,
  LIB_IMAGES,
  LIB_PROMPTS,
  LIB_TABS,
  LIB_TEMPLATES,
  LIB_VIDEOS,
  LIB_VOICES,
  SHOWS,
  type FlowAsset,
  type LibEpisode,
  type LibShow,
  type TypeKey,
} from '../data/library'

// what an asset is + how it was generated (grounded in the real session layout)
function assetDetail(a: FlowAsset, ep: LibEpisode, show: LibShow): { prompt?: string; rows: [string, string][] } {
  if (a.type === 'Image')
    return {
      prompt: `${show.template} illustration — ${a.name.toLowerCase()}; ${ep.aspect} frame, flat cel shading, no on-image text.`,
      rows: [
        ['Model', 'gpt-image-2 · text-to-image'],
        ['Style', show.template],
        ['Output', `1K · ${ep.aspect} · PNG`],
        ['Source', `${ep.folder}/source/generated-assets/scenes/`],
        ['Episode', ep.name],
      ],
    }
  if (a.type === 'Character')
    return {
      prompt: `Locked character reference — ${a.name}. ${a.sub}. Pinned so every scene renders the same face & outfit.`,
      rows: [
        ['Model', 'nano-banana · reference sheet'],
        ['Style', show.template],
        ['Source', 'character / style references'],
        ['Reused in', `${show.episodes.length} episodes`],
      ],
    }
  if (a.type === 'Video')
    return {
      rows: [
        ['Pipeline', 'Remotion compose → ffmpeg stitch'],
        ['Duration / aspect', a.sub],
        ['Captions', `${ep.folder}/renders/*.srt`],
        ['Source', `${ep.folder}/renders/`],
        ['Episode', ep.name],
      ],
    }
  return {
    prompt: a.body ?? 'Source-of-truth text — hand-edited, then force-fed into the pipeline at the matching gate.',
    rows: [
      ['Kind', a.name],
      ['Location', `${ep.folder}/${a.sub}`],
      ['Episode', ep.name],
    ],
  }
}

function LibraryFlow() {
  // progressive disclosure: nothing downstream is revealed until its parent is picked
  const [tmpl, setTmpl] = useState<string | null>(null)
  const [showId, setShowId] = useState<string | null>(null)
  const [epId, setEpId] = useState<string | null>(null)
  const [assetView, setAssetView] = useState<'all' | 'type'>('all')
  const [openGroup, setOpenGroup] = useState<string>('Video')
  const [sel, setSel] = useState<FlowAsset | null>(null)

  const shows = tmpl ? SHOWS.filter((x) => x.template === tmpl) : []
  const show = shows.find((x) => x.id === showId) ?? null
  const episodes = show?.episodes ?? []
  const ep = episodes.find((x) => x.id === epId) ?? null

  const pickTmpl = (name: string) => {
    setTmpl(name)
    setShowId(null)
    setEpId(null)
    setSel(null)
  }
  const pickShow = (id: string) => {
    setShowId(id)
    setEpId(null)
    setSel(null)
  }
  const pickEp = (id: string) => {
    setEpId(id)
    setSel(null)
  }

  const assets: FlowAsset[] =
    ep && show
      ? [
          { id: `${ep.id}-vid`, type: 'Video', name: 'Compiled render', sub: ep.render, thumb: ep.thumb, ar: ep.aspect },
          ...ep.images.map((i) => ({ id: i.id, type: 'Image', name: i.name, sub: i.meta, thumb: i.thumb, ar: ep.aspect })),
          ...ep.charIds.flatMap((cid) => {
            const c = show.characters.find((x) => x.id === cid)
            return c ? [{ id: `${ep.id}-${c.id}`, type: 'Character', name: c.name, sub: c.meta, thumb: c.thumb, ar: '3 / 4' }] : []
          }),
          ...ep.prompts.map((p) => ({ id: p.id, type: 'Prompt', name: p.name, sub: p.meta, body: p.body })),
        ]
      : []

  const selAssetRef = useRef<HTMLButtonElement | null>(null)
  // each tile is sized by its image's real proportions (no forced aspect ratio)
  const tile = (a: FlowAsset) => {
    const selected = sel?.id === a.id
    return (
      <button
        key={a.id}
        ref={selected ? selAssetRef : undefined}
        className={`lib-asset ${a.thumb ? '' : 'noimg'} ${selected ? 'sel' : ''}`}
        onClick={() => setSel(a)}
      >
        {a.thumb ? <img src={a.thumb} alt="" loading="lazy" /> : null}
        <span className="lib-asset-badge">{a.type}</span>
        <span className="lib-asset-label">
          <b>{a.name}</b>
          <small>{a.sub}</small>
        </span>
      </button>
    )
  }

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const tRef = useRef<HTMLButtonElement | null>(null)
  const pRef = useRef<HTMLButtonElement | null>(null)
  const sRef = useRef<HTMLButtonElement | null>(null)
  const dRef = useRef<HTMLDivElement | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const [edgeSize, setEdgeSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    // coordinates are in scroll-content space (add scroll offset) so connectors
    // stay anchored to their nodes as the canvas scrolls horizontally
    const seg = (a: HTMLElement | null, b: HTMLElement | null) => {
      if (!a || !b) return null
      const wr = wrap.getBoundingClientRect()
      const ar = a.getBoundingClientRect()
      const br = b.getBoundingClientRect()
      const x1 = ar.right - wr.left + wrap.scrollLeft
      const y1 = ar.top + ar.height / 2 - wr.top + wrap.scrollTop
      const x2 = br.left - wr.left + wrap.scrollLeft
      const y2 = br.top + br.height / 2 - wr.top + wrap.scrollTop
      const dx = Math.max(18, (x2 - x1) / 2)
      return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
    }
    const measure = () => {
      setEdgeSize({ w: wrap.scrollWidth, h: wrap.scrollHeight })
      setLines(
        [seg(tRef.current, pRef.current), seg(pRef.current, sRef.current), seg(selAssetRef.current, dRef.current)].filter(
          (x): x is string => Boolean(x),
        ),
      )
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(wrap)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [tmpl, showId, epId, assetView, openGroup, sel])

  const selDetail = sel && ep && show ? assetDetail(sel, ep, show) : null

  return (
    <div className="lib-flow" ref={wrapRef}>
      <svg className="lib-flow-edges" aria-hidden="true" width={edgeSize.w || undefined} height={edgeSize.h || undefined}>
        {lines.map((d, i) => (
          <path key={i} d={d} fill="none" stroke="var(--accent)" strokeWidth="1.5" opacity="0.6" />
        ))}
      </svg>

      <div className="lib-col">
        <span className="lib-col-label">Template</span>
        {LIB_TEMPLATES.map((x) => (
          <button
            key={x.name}
            ref={x.name === tmpl ? tRef : undefined}
            className={`lib-node ${x.name === tmpl ? 'sel' : tmpl ? 'dim' : ''}`}
            onClick={() => pickTmpl(x.name)}
          >
            <span className="lib-node-thumb"><img src={x.thumb} alt="" loading="lazy" /></span>
            <span className="lib-node-meta">
              <span className="lib-node-name">{x.name}</span>
              <span className="lib-node-sub">style</span>
            </span>
          </button>
        ))}
      </div>

      {tmpl ? (
        <div className="lib-col">
          <span className="lib-col-label">Project</span>
          {shows.map((x) => (
            <button
              key={x.id}
              ref={x.id === show?.id ? pRef : undefined}
              className={`lib-node ${x.id === show?.id ? 'sel' : showId ? 'dim' : ''}`}
              onClick={() => pickShow(x.id)}
            >
              <span className="lib-node-thumb"><img src={x.thumb} alt="" loading="lazy" /></span>
              <span className="lib-node-meta">
                <span className="lib-node-name">{x.name}</span>
                <span className="lib-node-sub">{x.episodes.length} episodes</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {show ? (
        <div className="lib-col">
          <span className="lib-col-label">Session</span>
          {episodes.map((x) => (
            <button
              key={x.id}
              ref={x.id === ep?.id ? sRef : undefined}
              className={`lib-node ${x.id === ep?.id ? 'sel' : epId ? 'dim' : ''}`}
              onClick={() => pickEp(x.id)}
            >
              <span className="lib-node-thumb"><img src={x.thumb} alt="" loading="lazy" /></span>
              <span className="lib-node-meta">
                <span className="lib-node-name">{x.name}</span>
                <span className="lib-node-sub">{x.render}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {ep ? (
      <div className="lib-col lib-col-assets-area">
        <div className="lib-assets-bar">
          <span className="lib-col-label">Assets · {assets.length}</span>
          <div className="lib-atoggle">
            <button className={assetView === 'all' ? 'sel' : ''} onClick={() => setAssetView('all')}>All</button>
            <button className={assetView === 'type' ? 'sel' : ''} onClick={() => setAssetView('type')}>By type</button>
          </div>
        </div>
        {assetView === 'all' ? (
          <div className="lib-assets">{assets.map((a) => tile(a))}</div>
        ) : (
          <div className="lib-bytype-cols">
            <div className="lib-col lib-col-types">
              {ASSET_TYPES.map((type) => {
                const items = assets.filter((a) => a.type === type)
                if (!items.length) return null
                const gsel = openGroup === type
                return (
                  <button
                    key={type}
                    className={`lib-node ${gsel ? 'sel' : 'dim'}`}
                    onClick={() => setOpenGroup(type)}
                  >
                    <span className="lib-node-meta">
                      <span className="lib-node-name">{type}s</span>
                      <span className="lib-node-sub">{items.length} items</span>
                    </span>
                  </button>
                )
              })}
            </div>
            {(() => {
              const items = assets.filter((a) => a.type === openGroup)
              return items.length ? (
                <div className="lib-col lib-col-items">
                  <span className="lib-col-label">{openGroup}s · {items.length}</span>
                  <div className="lib-asset-col">{items.map((a) => tile(a))}</div>
                </div>
              ) : null
            })()}
          </div>
        )}
      </div>
      ) : null}

      {sel ? (
        <div className="lib-col lib-col-detail" ref={dRef}>
          <div className="lib-assets-bar">
            <span className="lib-col-label">{sel.type}</span>
            <button className="lib-info-close" onClick={() => setSel(null)} aria-label="Close">✕</button>
          </div>
          {sel.thumb ? (
            <div className="lib-info-preview">
              <img src={sel.thumb} alt="" />
            </div>
          ) : null}
          <h3 className="lib-info-title">{sel.name}</h3>
          <p className="lib-info-sub">{sel.sub}</p>
          {selDetail?.prompt ? (
            <div className="lib-info-block">
              <span className="lib-info-label">{sel.type === 'Prompt' ? 'Text' : 'Prompt'}</span>
              <p className="lib-info-prompt">{selDetail.prompt}</p>
            </div>
          ) : null}
          <div className="lib-info-rows">
            {selDetail?.rows.map(([k, v]) => (
              <div className="lib-info-row" key={k}>
                <b>{k}</b>
                <span>{v}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* trailing empty canvas so you can always scroll well past the last column */}
      <div className="lib-flow-pad" aria-hidden="true" />
    </div>
  )
}

export function LibraryView({ onScrolled }: { onScrolled: (scrolled: boolean) => void }) {
  const [view, setView] = useState<'flow' | 'type'>('flow')
  const [tab, setTab] = useState<TypeKey>('videos')
  const [videoMode, setVideoMode] = useState<'compiled' | 'all'>('compiled')
  const [q, setQ] = useState('')
  useEffect(() => {
    onScrolled(false)
  }, [onScrolled])

  const query = q.trim().toLowerCase()
  const hit = (s: string) => !query || s.toLowerCase().includes(query)

  return (
    <section
      className={`library ${view === 'flow' ? 'is-flow' : ''}`}
      onScrollCapture={(e) => onScrolled((e.target as HTMLElement).scrollTop > 8)}
    >
      <div className="lib-topbar">
        <h1>Asset Library</h1>
        <div className="lib-view">
          <button className={view === 'flow' ? 'sel' : ''} onClick={() => setView('flow')}>
            Flow
          </button>
          <button className={view === 'type' ? 'sel' : ''} onClick={() => setView('type')}>
            By type
          </button>
        </div>
        <div className="search">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.2-4.2" />
          </svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search assets…" />
        </div>
      </div>

      {view === 'flow' ? (
        <LibraryFlow />
      ) : (
        <div className="lib-bytype">
          <div className="inner">
            <div className="lib-tabs">
              {LIB_TABS.map((t) => (
                <button key={t.key} className={`lib-tab ${tab === t.key ? 'sel' : ''}`} onClick={() => setTab(t.key)}>
                  {t.label}
                  <span className="lib-count">{t.count}</span>
                </button>
              ))}
            </div>

            {tab === 'videos' ? (
              <>
                <div className="lib-toggle">
                  <button className={videoMode === 'compiled' ? 'sel' : ''} onClick={() => setVideoMode('compiled')}>
                    Compiled
                  </button>
                  <button className={videoMode === 'all' ? 'sel' : ''} onClick={() => setVideoMode('all')}>
                    All clips
                  </button>
                </div>
                <div className="lib-grid">
                  {(videoMode === 'compiled'
                    ? LIB_VIDEOS.map((v) => ({ id: v.id, name: v.name, meta: v.meta, project: v.project, thumb: v.thumb, badge: `${v.clips.length} clips` }))
                    : LIB_VIDEOS.flatMap((v) => v.clips.map((c) => ({ id: c.id, name: c.name, meta: c.meta, project: v.project, thumb: v.thumb, badge: 'Clip' })))
                  )
                    .filter((a) => hit(`${a.name} ${a.project}`))
                    .map((a) => (
                      <button key={a.id} className="lib-card">
                        <span className="lib-thumb videos">
                          <img src={a.thumb} alt="" loading="lazy" />
                          <span className="lib-play">▶</span>
                          <span className="lib-card-badge">{a.badge}</span>
                        </span>
                        <span className="lib-card-name">{a.name}</span>
                        <span className="lib-card-meta">{a.meta} · {a.project}</span>
                      </button>
                    ))}
                </div>
              </>
            ) : tab === 'images' ? (
              <div className="lib-grid">
                {LIB_IMAGES.filter((a) => hit(`${a.name} ${a.project}`)).map((a) => (
                  <button key={a.id} className="lib-card">
                    <span className="lib-thumb images"><img src={a.thumb} alt="" loading="lazy" /></span>
                    <span className="lib-card-name">{a.name}</span>
                    <span className="lib-card-meta">{a.meta} · {a.project}</span>
                  </button>
                ))}
              </div>
            ) : tab === 'characters' ? (
              <div className="lib-grid">
                {LIB_CHARS.filter((a) => hit(`${a.name} ${a.project}`)).map((a) => (
                  <button key={a.id} className="lib-card">
                    <span className="lib-thumb characters"><img src={a.thumb} alt="" loading="lazy" /></span>
                    <span className="lib-card-name">{a.name}</span>
                    <span className="lib-card-meta">{a.meta} · {a.project}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="lib-list">
                {(tab === 'voices' ? LIB_VOICES : LIB_PROMPTS)
                  .filter((a) => hit(`${a.name} ${a.project}`))
                  .map((a) => (
                    <div key={a.id} className="lib-row">
                      <span className="lib-row-icon">{tab === 'voices' ? '◈' : '❝'}</span>
                      <span className="lib-row-meta">
                        <span className="lib-row-name">{a.name}</span>
                        <span className="lib-row-sub">{a.meta} · {a.project}</span>
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

import { useEffect, useRef, useState } from 'react'
import { PICKER_TEMPLATES, RECENTS, type PickerTemplate } from '../data/picker'
import type { OnboardSeed } from '../types'

// /projects — pick a format template (or subtemplate/series), start blank, or resume.
// Choosing a template imports its format settings (s1) into the workflow.
export function PickerView({
  onStandalone,
  onRecent,
  onTemplate,
  onScrolled,
}: {
  onStandalone: () => void
  onRecent: (kind: 'series' | 'standalone') => void
  onTemplate: (seed: OnboardSeed, series: boolean) => void
  onScrolled: (scrolled: boolean) => void
}) {
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState('')
  // the picker mounts at the top, so the nav bar starts in its floating state
  useEffect(() => {
    onScrolled(false)
  }, [onScrolled])
  const query = q.trim().toLowerCase()
  const matches = (t: PickerTemplate) =>
    !query || `${t.name} ${t.sig} ${t.badge} ${t.sub?.name ?? ''}`.toLowerCase().includes(query)
  const anyShown = PICKER_TEMPLATES.some(matches)

  return (
    <section className="tpl-picker" onScroll={(e) => onScrolled(e.currentTarget.scrollTop > 8)}>
      <div className="inner">
        <div className="head">
          <h1>Start a project</h1>
          <p className="lede">Pick up where you left off, or start something new.</p>
        </div>

        <button className="blank-top solo" onClick={onStandalone}>
          <span className="bt-glyph">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
          <span className="bt-text">
            <span className="bt-title">Standalone — start blank</span>
            <span className="bt-sub">A true one-off. Choose format &amp; style from scratch — no template applied.</span>
          </span>
          <span className="bt-cta">Start blank →</span>
        </button>

        {RECENTS.length ? (
          <>
            <div className="section-label">
              <h2>Pick up where you left off</h2>
              <span className="hint">in-progress videos</span>
            </div>
            <div className="resume-list">
              {RECENTS.map((r) => (
                <ResumeRow
                  key={r.title}
                  title={r.title}
                  sub={r.sub}
                  step={r.step}
                  pct={r.pct}
                  thumb={r.thumb}
                  onClick={() => onRecent(r.kind)}
                />
              ))}
            </div>
          </>
        ) : null}

        <div className="section-label">
          <h2>Choose a template</h2>
          <div className="search">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.2-4.2" />
            </svg>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search format, style, cadence…"
            />
          </div>
        </div>

        <div className="bento">
          {PICKER_TEMPLATES.map((t) => (
            <PickerTile
              key={t.id}
              tpl={t}
              hidden={!matches(t)}
              open={openId === t.id}
              onToggle={() => setOpenId((cur) => (cur === t.id ? '' : t.id))}
              onUse={() => onTemplate(t.seed, false)}
              onSeries={() => onTemplate(t.seed, true)}
            />
          ))}
        </div>
        {!anyShown ? <div className="no-results show">No templates match “{q}”.</div> : null}
      </div>
    </section>
  )
}

function PickerTile({
  tpl,
  hidden,
  open,
  onToggle,
  onUse,
  onSeries,
}: {
  tpl: PickerTemplate
  hidden: boolean
  open: boolean
  onToggle: () => void
  onUse: () => void
  onSeries: () => void
}) {
  const ref = useRef<HTMLVideoElement | null>(null)
  const [playing, setPlaying] = useState(false)
  return (
    <div
      className={`tile ${tpl.cls} ${open ? 'open' : ''} ${playing ? 'playing' : ''}`}
      style={hidden ? { display: 'none' } : undefined}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('.act, .sub-go, .subs-close, .tpl-subs')) return
        const v = ref.current
        if (!v) return
        // tap toggles play / pause
        if (v.paused) {
          v.muted = false
          void v.play().catch(() => {})
          setPlaying(true)
        } else {
          v.pause()
          setPlaying(false)
        }
      }}
    >
      <video ref={ref} src={tpl.video} poster={tpl.poster} preload="metadata" playsInline />
      <span className={`badge tl ${tpl.series ? 'series' : ''}`}>{tpl.badge}</span>
      <span className="badge tr">{tpl.duration}</span>
      <button className="play" aria-label="Play preview">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7z" />
        </svg>
      </button>
      <div className="scrim">
        <div className="t-name">{tpl.name}</div>
        <div className="t-sig">{tpl.sig}</div>
        <div className="acts">
          {tpl.series ? (
            <button className="act" onClick={(e) => { e.stopPropagation(); onToggle() }}>
              <span className="car">▾</span> {tpl.seriesBtn ?? 'Pick up a series'}
            </button>
          ) : null}
          <button className="act primary" onClick={(e) => { e.stopPropagation(); onUse() }}>
            {tpl.useLabel}
          </button>
        </div>
      </div>
      {tpl.sub ? (
        <div className="tpl-subs">
          <div className="subs-head">
            <b>Subtemplates · pick a series</b>
            <button className="subs-close" onClick={(e) => { e.stopPropagation(); onToggle() }}>×</button>
          </div>
          <div className="sub-row">
            <div className="sub-top"><span className="sub-dot" /><b>{tpl.sub.name}</b></div>
            <div className="sub-meta">{tpl.sub.meta}</div>
            <button className="sub-go" onClick={(e) => { e.stopPropagation(); onSeries() }}>{tpl.sub.cta}</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ResumeRow({
  title,
  sub,
  step,
  pct,
  thumb,
  onClick,
}: {
  title: string
  sub: string
  step: string
  pct: number
  thumb?: string
  onClick: () => void
}) {
  return (
    <button className="resume-row" onClick={onClick}>
      {thumb ? (
        <span className="r-thumb">
          <img src={thumb} alt="" loading="lazy" />
        </span>
      ) : null}
      <div className="r-meta">
        <div className="r-title">{title}</div>
        <div className="r-sub">{sub}</div>
      </div>
      <div className="r-prog">
        <span className="r-step">{step}</span>
        <span className="bar"><i style={{ width: `${pct}%` }} /></span>
      </div>
    </button>
  )
}

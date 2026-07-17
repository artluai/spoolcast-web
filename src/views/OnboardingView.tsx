import { useEffect, useRef, useState } from 'react'
import { styleThumbs } from '../data/cast'
import { ONB_EYEBROWS, ONB_LOADER_STEPS, ONB_VID_UGC, ONB_VID_WIDE } from '../data/onboarding'
import type { OnboardSeed } from '../types'

function FogVideoTile({
  selected,
  onClick,
  src,
  tag,
  title,
}: {
  selected: boolean
  onClick: (e: React.MouseEvent) => void
  src: string
  tag: string
  title: string
}) {
  const ref = useRef<HTMLVideoElement | null>(null)
  return (
    <button className={`fog-tile ${selected ? 'sel' : ''}`} onClick={onClick}>
      <span
        className="fog-vbox"
        onMouseEnter={() => {
          const v = ref.current
          if (!v) return
          v.muted = false
          v.volume = 1
          v.currentTime = 0
          void v.play().catch(() => {})
        }}
        onMouseLeave={() => {
          const v = ref.current
          if (!v) return
          v.pause()
          v.muted = true
          v.currentTime = 0
        }}
      >
        {/* #t=0.1 forces the browser to paint the first frame as a still poster */}
        <video ref={ref} src={`${src}#t=0.1`} muted playsInline preload="metadata" />
        <span className="fog-vtag">{tag}</span>
        <span className="fog-vhint">Hover to play</span>
      </span>
      <span className="fog-vtext">
        <b>{title}</b>
      </span>
    </button>
  )
}

// fog-of-war onboarding: one uniform module per question, the chain is always
// present, the current module zooms in while neighbors fade. Walks the user
// through steps 01-03 (format -> identity -> idea -> core message), saves the
// decisions, then lands them on step 04 (with the option to autopilot the rest).
export function OnboardingView({
  onFinish,
}: {
  onFinish: (seed: OnboardSeed, autopilot: boolean) => void
}) {
  const QCOUNT = ONB_EYEBROWS.length
  const [cur, setCur] = useState(0)
  const [canvas, setCanvas] = useState('169')
  const [narrator, setNarrator] = useState('yes')
  const [motion, setMotion] = useState('stills')
  const [length, setLength] = useState(120)
  const [lengthMode, setLengthMode] = useState<'' | 'ai'>('')
  const [style, setStyle] = useState(styleThumbs[0].id)
  const [name, setName] = useState('')
  const [about, setAbout] = useState('')
  const [message, setMessage] = useState('')
  const [messageMode, setMessageMode] = useState<'' | 'ai' | 'skip'>('')
  const [finishing, setFinishing] = useState(false)
  const [finishAuto, setFinishAuto] = useState(false)
  const [loadStep, setLoadStep] = useState(0)
  const [vw, setVw] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1280))
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [navTop, setNavTop] = useState<number | null>(null)

  useEffect(() => {
    const onResize = () => setVw(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // desktop: park the Back/Next buttons just below the current module
  // (offsetHeight/clientHeight are transform-independent, so the .9→1 card scale
  // animation doesn't skew it; ResizeObserver re-measures once layout settles)
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const measure = () => {
      if (vw <= 760) {
        setNavTop(null)
        return
      }
      const card = vp.querySelector('.fog-mod.cur') as HTMLElement | null
      if (!card) return
      // all layout units (offset/client) so it stays consistent — the card is
      // centered in the viewport, so its bottom sits at clientHeight/2 + cardH/2.
      setNavTop(vp.offsetTop + vp.clientHeight / 2 + card.offsetHeight / 2 + 22)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(vp)
    const card = vp.querySelector('.fog-mod.cur') as HTMLElement | null
    if (card) ro.observe(card)
    return () => ro.disconnect()
  }, [cur, vw, QCOUNT])

  const go = (i: number) => setCur(Math.max(0, Math.min(QCOUNT - 1, i)))

  const startFinish = (auto: boolean) => {
    setFinishAuto(auto)
    setLoadStep(0)
    setFinishing(true)
  }

  useEffect(() => {
    if (!finishing) return
    if (loadStep >= ONB_LOADER_STEPS.length) {
      const seed: OnboardSeed = {
        s1: {
          narrator,
          style,
          output: canvas,
          length: lengthMode === 'ai' ? 0 : length,
          projectId: name.trim() || 'untitled-01',
          editing: '',
          // Onboarding doesn't ask — step 1 does, and blank means the
          // template's normal.
          medium: '',
        },
        ideaBrief: about.trim(),
        goal:
          messageMode === 'ai'
            ? { text: '', mode: 'ai' }
            : messageMode === 'skip'
              ? { text: '', mode: 'skip' }
              : { text: message.trim(), mode: '' },
      }
      const t = window.setTimeout(() => onFinish(seed, finishAuto), 360)
      return () => window.clearTimeout(t)
    }
    const t = window.setTimeout(() => setLoadStep((v) => v + 1), 820)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishing, loadStep])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (finishing) return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'ArrowRight' && cur < QCOUNT - 1) setCur((v) => v + 1)
      if (e.key === 'ArrowLeft' && cur > 0) setCur((v) => v - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cur, finishing, QCOUNT])

  // narrator-only styles can't apply to a no-narrator video — keep the seed valid
  const chooseNarrator = (value: string) => {
    setNarrator(value)
    if (value === 'no') {
      const picked = styleThumbs.find((s) => s.id === style)
      if (picked?.narratorOnly) {
        const valid = styleThumbs.find((s) => !s.narratorOnly)
        if (valid) setStyle(valid.id)
      }
    }
  }

  // card width + gap must match the rendered module exactly or the filmstrip
  // mis-centers — drive both the transform and the CSS off the same numbers.
  const isNarrow = vw <= 640
  const CARD_W = isNarrow ? Math.min(Math.round(vw * 0.84), 460) : 560
  const GAP = isNarrow ? 28 : 64
  const offset = -(cur * (CARD_W + GAP) + CARD_W / 2)
  const modClass = (i: number) =>
    `fog-mod ${i === cur ? 'cur' : ''} ${i < cur ? 'done' : ''}`
  const stop = (e: React.MouseEvent) => e.stopPropagation()
  const mins = Math.round((length / 60) * 10) / 10

  return (
    <section className="fog-view">
      <div className="fog-top">
        <div className="fog-bar">
          {ONB_EYEBROWS.map((_, i) => (
            <span key={i} className={i < cur ? 'done' : i === cur ? 'active' : ''} />
          ))}
        </div>
        <div className="fog-count">
          {cur + 1} of {QCOUNT} · {ONB_EYEBROWS[cur].split('·')[1].trim()}
        </div>
      </div>

      <div className="fog-viewport" ref={viewportRef}>
        <div
          className="fog-strip"
          style={
            {
              transform: `translate(${offset}px, -50%)`,
              gap: `${GAP}px`,
              '--fog-card-w': `${CARD_W}px`,
              '--fog-gap': `${GAP}px`,
            } as React.CSSProperties
          }
        >
          {/* 0 — canvas */}
          <div className={modClass(0)} onClick={() => cur !== 0 && go(0)}>
            <div className="fog-eyebrow">{ONB_EYEBROWS[0]}</div>
            <h2 className="fog-q">What shape is this video?</h2>
            <div className="fog-content">
              {[
                ['169', 'A', 'Widescreen', '16:9', ''],
                ['916', 'B', 'Vertical', '9:16', 'r916'],
                ['11', 'C', 'Square', '1:1', 'r11'],
              ].map((o) => (
                <button
                  key={o[0]}
                  className={`fog-opt ${canvas === o[0] ? 'sel' : ''}`}
                  onClick={(e) => {
                    stop(e)
                    setCanvas(o[0])
                  }}
                >
                  <span className="fog-stripe" />
                  <span className="fog-num">{o[1]}</span>
                  <span className={`fog-ratio ${o[4]}`} />
                  <span className="fog-nm">{o[2]}</span>
                  <span className="fog-ds">{o[3]}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 1 — narrator */}
          <div className={modClass(1)} onClick={() => cur !== 1 && go(1)}>
            <div className="fog-eyebrow">{ONB_EYEBROWS[1]}</div>
            <h2 className="fog-q">Is there a narrator?</h2>
            <div className="fog-content">
              <div className="fog-vrow">
                <FogVideoTile
                  selected={narrator === 'yes'}
                  onClick={(e) => {
                    stop(e)
                    chooseNarrator('yes')
                  }}
                  src={ONB_VID_WIDE}
                  tag="NARRATED"
                  title="Yes, a separate narrator tells the story"
                />
                <FogVideoTile
                  selected={narrator === 'no'}
                  onClick={(e) => {
                    stop(e)
                    chooseNarrator('no')
                  }}
                  src={ONB_VID_UGC}
                  tag="IN-VIDEO"
                  title="No, the people in the video do the talking"
                />
              </div>
            </div>
          </div>

          {/* 2 — motion */}
          <div className={modClass(2)} onClick={() => cur !== 2 && go(2)}>
            <div className="fog-eyebrow">{ONB_EYEBROWS[2]}</div>
            <h2 className="fog-q">What do the visuals look like?</h2>
            <div className="fog-content">
              {[
                ['stills', 'A', 'Animated still images', 'cheap · consistent'],
                ['clips', 'B', 'Generated video clips', 'full motion · pricier'],
              ].map((o) => (
                <button
                  key={o[0]}
                  className={`fog-opt ${motion === o[0] ? 'sel' : ''}`}
                  onClick={(e) => {
                    stop(e)
                    setMotion(o[0])
                  }}
                >
                  <span className="fog-stripe" />
                  <span className="fog-num">{o[1]}</span>
                  <span className="fog-nm">{o[2]}</span>
                  <span className="fog-ds">{o[3]}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 3 — length */}
          <div className={modClass(3)} onClick={() => cur !== 3 && go(3)}>
            <div className="fog-eyebrow">{ONB_EYEBROWS[3]}</div>
            <h2 className="fog-q">How long, roughly?</h2>
            <div className="fog-content">
              <div className={`fog-slider-val ${lengthMode === 'ai' ? 'muted' : ''}`}>
                {lengthMode === 'ai' ? (
                  <>Auto <em>(AI sizes it at the structure outline — step 04)</em></>
                ) : (
                  <>~{mins} min <em>({length}s · ~{Math.round(length / 8)} scenes)</em></>
                )}
              </div>
              <input
                type="range"
                min={15}
                max={600}
                step={15}
                value={length}
                disabled={lengthMode === 'ai'}
                onClick={stop}
                onChange={(e) => {
                  setLength(Number(e.target.value))
                  setLengthMode('')
                }}
              />
              <div className="fog-or">or</div>
              <button
                className={`ai-btn ${lengthMode === 'ai' ? 'sel' : ''}`}
                onClick={(e) => {
                  stop(e)
                  setLengthMode((m) => (m === 'ai' ? '' : 'ai'))
                }}
              >
                <span className="ap-spark">✦</span> Let AI decide
              </button>
              <p className="skip-note">
                AI reads everything you've shared and finds the perfect length.
              </p>
            </div>
          </div>

          {/* 4 — style */}
          <div className={modClass(4)} onClick={() => cur !== 4 && go(4)}>
            <div className="fog-eyebrow">{ONB_EYEBROWS[4]}</div>
            <h2 className="fog-q">Pick a visual style.</h2>
            <div className="fog-content">
              <div className="fog-style-grid">
                {styleThumbs.map((st) => {
                  const disabled = narrator === 'no' && st.narratorOnly
                  return (
                    <button
                      key={st.id}
                      disabled={disabled}
                      className={`fog-style-cell ${style === st.id ? 'sel' : ''}`}
                      onClick={(e) => {
                        stop(e)
                        if (!disabled) setStyle(st.id)
                      }}
                    >
                      <span className="fog-pv">
                        {st.img ? <img src={st.img} alt="" /> : null}
                      </span>
                      <span className="fog-lbl">
                        {st.name}
                        {disabled ? <em> · narrator only</em> : null}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          {/* 5 — name */}
          <div className={modClass(5)} onClick={() => cur !== 5 && go(5)}>
            <div className="fog-eyebrow">{ONB_EYEBROWS[5]}</div>
            <h2 className="fog-q">What's the name of this video?</h2>
            <div className="fog-content">
              <input
                className="fog-tb one"
                placeholder="e.g. Spoolcast Dev Log #07 — the UI wrapper"
                value={name}
                onClick={stop}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </div>

          {/* 6 — about */}
          <div className={modClass(6)} onClick={() => cur !== 6 && go(6)}>
            <div className="fog-eyebrow">{ONB_EYEBROWS[6]}</div>
            <h2 className="fog-q">What's this video about?</h2>
            <div className="fog-content">
              <textarea
                className="fog-tb tall"
                placeholder="Be as descriptive as you want — the idea, topic, opinion, or story this should turn into."
                value={about}
                onClick={stop}
                onChange={(e) => setAbout(e.target.value)}
              />
              <button className="fog-attach" onClick={stop} type="button">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M12 5v14" />
                  <path d="M5 12h14" />
                </svg>{' '}
                Attach references &amp; images
              </button>
            </div>
          </div>

          {/* 7 — core message */}
          <div className={modClass(7)} onClick={() => cur !== 7 && go(7)}>
            <div className="fog-eyebrow">{ONB_EYEBROWS[7]}</div>
            <h2 className="fog-q">What's the one core message of this video?</h2>
            <div className="fog-content">
              <textarea
                className={`fog-tb ${messageMode ? 'muted' : ''}`}
                style={{ height: 96 }}
                placeholder="The one thing a viewer should walk away believing."
                value={message}
                onClick={stop}
                onChange={(e) => {
                  setMessage(e.target.value)
                  if (e.target.value) setMessageMode('')
                }}
              />
              <div className="fog-or">or</div>
              <div className="fog-msg-actions">
                <button
                  className={`ai-btn ${messageMode === 'ai' ? 'sel' : ''}`}
                  onClick={(e) => {
                    stop(e)
                    setMessageMode((m) => (m === 'ai' ? '' : 'ai'))
                  }}
                >
                  <span className="ap-spark">✦</span> Let AI decide
                </button>
                <button
                  className={`fog-msg-btn ${messageMode === 'skip' ? 'sel' : ''}`}
                  onClick={(e) => {
                    stop(e)
                    setMessageMode((m) => (m === 'skip' ? '' : 'skip'))
                  }}
                >
                  Skip for now
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {cur === QCOUNT - 1 ? (
        <>
          {/* the two end choices — bottom-right corner on desktop, stacked on mobile */}
          <div className="fog-end">
            <span className="fog-ap-sub">AI finishes the rest — no input needed.</span>
            <div className="fog-end-row">
              <button className="ai-btn" onClick={() => startFinish(true)}>
                <span className="ap-spark">✦</span> Autopilot to the end
              </button>
              <span className="fog-navor">or</span>
              <button className="fog-primary" onClick={() => startFinish(false)}>
                Continue manual setup →
              </button>
            </div>
          </div>
          {/* Back floats below the module like every other step (placeholder balances its x) */}
          <div className="fog-nav last-back" style={navTop != null ? { top: navTop } : undefined}>
            <button className="fog-back" onClick={() => go(cur - 1)}>
              ← Back
            </button>
            <span className="fog-next-ph" aria-hidden="true" />
          </div>
        </>
      ) : (
        <div
          className="fog-nav"
          style={{ width: CARD_W, ...(navTop != null ? { top: navTop } : {}) }}
        >
          <button className="fog-primary" onClick={() => go(cur + 1)}>
            Next →
          </button>
          <button className="fog-back" onClick={() => go(cur - 1)} disabled={cur === 0}>
            ← Back
          </button>
        </div>
      )}

      <div className={`fog-loader ${finishing ? 'show' : ''}`}>
        <div className="fog-loader-card">
          <div className="fog-eyebrow accent">
            {finishAuto ? 'Autopilot engaged' : 'Building your project'}
          </div>
          <h2>{finishAuto ? 'Setting up & taking over…' : 'Setting up the workflow…'}</h2>
          <div className="fog-loader-steps">
            {ONB_LOADER_STEPS.map((s, i) => (
              <div
                key={s}
                className={`fog-lstep ${i < loadStep ? 'ok' : i === loadStep ? 'run' : ''}`}
              >
                <span className="fog-lic">
                  <span className="fog-dot" />
                  <svg className="fog-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </span>
                {s}
              </div>
            ))}
          </div>
          <div className="fog-lbar">
            <i style={{ width: `${Math.round((loadStep / ONB_LOADER_STEPS.length) * 100)}%` }} />
          </div>
        </div>
      </div>
    </section>
  )
}

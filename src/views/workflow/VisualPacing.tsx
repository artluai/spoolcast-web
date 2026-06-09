import { useEffect, useRef, useState } from 'react'
import { sceneFiles, shots } from '../../data/cast'
import { visualPacingPlan, type VPOverlay } from '../../data/demo-shots'
import { asset } from '../../lib/assets'

// Shot-List (step 08): read-only, hierarchical chunk → beat → image view that
// mirrors shot-list.json (base_layer + overlay_layer). It reads the confirmed pacing plan
// directly — editing happens upstream in Visual Pacing, then "exports" here.
export function ShotListPanel() {
  const plan = visualPacingPlan
  const images = plan.chunks.flatMap((c) => c.beats.flatMap((b) => b.images))
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
  return (
    <div className="panel-flat shotlist">
      <div className="ch">
        <h3>Shot list — {plan.chunks.length} chunks · {images.length} images</h3>
        <span>shot-list/shot-list.json</span>
      </div>
      <p className="vp-hint">Read-only — exported from Visual Pacing. Grouped chunk → beat → image, mirroring the JSON. Edit the pacing upstream to change it.</p>
      <div className="vp-chunks">
        {plan.chunks.map((chunk) => (
          <details className="vp-chunk" key={chunk.id}>
            <summary>
              <span className="id">{chunk.id}</span>
              <b>{chunk.title}</b>
              <small>{chunk.range}</small>
              <em>{chunk.beats.reduce((n, b) => n + b.images.length, 0)} img</em>
            </summary>
            <div className="vp-beats">
              {chunk.summary ? <p className="sl-summary">{chunk.summary}</p> : null}
              {chunk.beats.map((beat) => (
                <div className="sl-beat" key={beat.code}>
                  <p className="sl-narr">
                    <span className="sl-beatcode">{beat.code}</span>
                    "{beat.narration}" <small>{beat.range}</small>
                  </p>
                  {beat.images.map((img) => (
                    <div className="sl-img" key={img.id}>
                      <span className="id">{img.id}</span>
                      <span className="sl-words">{img.firstWord} … {img.lastWord}</span>
                      <span className="sl-time vp-mono">{fmt(img.startS)}–{fmt(img.endS)}</span>
                      <span className="sl-what">{img.what}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </div>
  )
}

export function VisualGallery() {
  let imageIndex = 0
  const counts = {
    ready: shots.filter((shot) => shot[4] === 'ok').length,
    generating: shots.filter((shot) => shot[4] === 'work').length,
    pending: shots.filter((shot) => shot[4] === 'pend').length,
  }
  return (
    <div className="card">
      <div className="gal-bar">
        <span><i className="dot ok" />{counts.ready} ready</span>
        <span><i className="dot work" />{counts.generating} generating</span>
        <span><i className="dot pend" />{counts.pending} pending</span>
        <b>22 visuals total · anime · soft</b>
      </div>
      <div className="gallery">
        {shots.map(([id, scene, , , state]) => {
          const file = state === 'ok' ? sceneFiles[imageIndex++ % sceneFiles.length] : ''
          return (
            <div className="gcard" key={id}>
              <div className={`img ${state}`}>
                {file ? <img src={asset(`sessions/spoolcast-dev-log-04/source/generated-assets/scenes/${file}`)} alt="" /> : null}
                <span className="badge">{id}</span>
                <span className={`st ${state}`}>{state === 'ok' ? 'Ready' : state === 'work' ? 'Generating' : 'Pending'}</span>
                <div className="scene">{scene}</div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

type VPPlan = typeof visualPacingPlan
type VPEditDraft = {
  scope: 'image' | 'chunk'
  chunkId: string
  imageId?: string
  afterChunkId?: string
  beforeChunkId?: string
  nearImageId?: string
  insertPos?: 'before' | 'after'
  isNew: boolean
  what: string
  why: string
  hold: string
  refs: string
  title: string
  range: string
  idea: string
}

export function VisualPacingPanel({ blankProject }: { blankProject: boolean }) {
  const [plan, setPlan] = useState<VPPlan>(() => structuredClone(visualPacingPlan))
  const [history, setHistory] = useState<VPPlan[]>([])
  const [menu, setMenu] = useState<{ x: number; y: number; chunkId: string; imageId?: string } | null>(null)
  const [editing, setEditing] = useState<VPEditDraft | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [view, setView] = useState<'table' | 'script'>('table')
  const seqImg = useRef(visualPacingPlan.chunks.reduce((n, c) => n + c.beats.reduce((m, b) => m + b.images.length, 0), 0))
  const seqChunk = useRef(visualPacingPlan.chunks.length)
  // When an edit session opens (from the timeline or the breakdown), scroll the
  // editor into view — the breakdown rows can be far below the editor's spot.
  const editKey = editing ? `${editing.scope}:${editing.imageId ?? editing.chunkId}:${editing.isNew}` : ''
  useEffect(() => {
    if (editKey) document.querySelector('.vp-edit')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [editKey])

  // Flatten to a timeline: each image laid end-to-end, width ∝ its hold time, so
  // every block boundary is a visual change. Each block carries its chunk + beat
  // context so hovering it can scrub the full moment into the detail strip.
  let cursor = 0
  const images = plan.chunks.flatMap((chunk) =>
    chunk.beats.flatMap((beat) =>
      beat.images.map((img) => {
        const holdSec = parseInt(img.hold, 10) || 0
        const start = cursor
        cursor += holdSec
        return { ...img, chunk: chunk.id, chunkTitle: chunk.title, narration: beat.narration, beatRange: beat.range, holdSec, start }
      }),
    ),
  )
  const totalSec = cursor || 1
  const [activeId, setActiveId] = useState(images[0]?.id ?? '')

  if (blankProject) {
    return (
      <div className="stub vp-empty">
        <span>VP</span>
        <h3>No pacing plan yet</h3>
        <p>
          Once the screenplay is locked, the visual pacing pass maps every narration beat to an image —
          what the viewer sees, why it appears then, and how long it holds — before the shot-list is built.
        </p>
        <div className="vp-stats empty">
          <span><b>—</b> images</span>
          <span><b>—</b> opening</span>
          <span><b>—</b> body</span>
          <span><b>—</b> overlays</span>
        </div>
      </div>
    )
  }

  const pct = (sec: number) => (sec / totalSec) * 100
  const active = images.find((img) => img.id === activeId) ?? images[0]
  // Group consecutive images into their chunk spans for the ruler.
  const chunkSpans = plan.chunks.map((chunk) => {
    const imgs = images.filter((img) => img.chunk === chunk.id)
    const start = imgs[0]?.start ?? 0
    const last = imgs[imgs.length - 1]
    return { id: chunk.id, title: chunk.title, start, end: (last?.start ?? 0) + (last?.holdSec ?? 0) }
  })
  // The dense "opening" band covers the first N images (per the plan's count).
  const openImg = images[plan.opening - 1]
  const openingEnd = openImg ? openImg.start + openImg.holdSec : 0
  // Place each overlay centered over the image it triggers on — the layer on top.
  const overlayMarks = plan.overlays
    .map((r) => {
      const host = images.find((img) => img.id === r.anchor)
      return host ? { ...r, center: host.start + host.holdSec / 2 } : null
    })
    .filter(Boolean) as (VPOverlay & { center: number })[]
  const ticks: number[] = []
  for (let s = 0; s <= totalSec; s += 60) ticks.push(s)
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

  // --- editing operations (in-session only; mock app has no backend) ---
  // Every mutation snapshots the prior plan so Undo can step back through edits.
  const mutate = (updater: (p: VPPlan) => VPPlan) => {
    setHistory((h) => [...h, plan].slice(-50))
    setPlan(updater(plan))
  }
  const undo = () => {
    if (history.length === 0) return
    setPlan(history[history.length - 1])
    setHistory((h) => h.slice(0, -1))
    setEditing(null)
    setMenu(null)
  }
  const openMenu = (e: React.MouseEvent, m: { chunkId: string; imageId?: string }) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, ...m })
  }
  const startEditImage = (chunkId: string, imageId: string) => {
    const img = images.find((i) => i.id === imageId)
    if (img) setEditing({ scope: 'image', chunkId, imageId, isNew: false, what: img.what, why: img.why, hold: img.hold, refs: img.refs, title: '', range: '', idea: '' })
    setMenu(null)
  }
  const startEditChunk = (chunkId: string) => {
    const chunk = plan.chunks.find((c) => c.id === chunkId)
    if (chunk) setEditing({ scope: 'chunk', chunkId, isNew: false, what: '', why: '', hold: '', refs: '', title: chunk.title, range: chunk.range, idea: '' })
    setMenu(null)
  }
  const startAddImage = (chunkId: string, opts?: { nearImageId?: string; pos?: 'before' | 'after' }) => {
    const id = `IMG${String(++seqImg.current).padStart(2, '0')}`
    setEditing({ scope: 'image', chunkId, imageId: id, nearImageId: opts?.nearImageId, insertPos: opts?.pos, isNew: true, what: '', why: '', hold: '6s', refs: 'builder', title: '', range: '', idea: '' })
    setMenu(null)
  }
  const startAddChunk = (refChunkId: string, pos: 'before' | 'after') => {
    const id = `C${String(++seqChunk.current).padStart(3, '0')}`
    setEditing({
      scope: 'chunk',
      chunkId: id,
      afterChunkId: pos === 'after' ? refChunkId : undefined,
      beforeChunkId: pos === 'before' ? refChunkId : undefined,
      isNew: true,
      what: '', why: '', hold: '', refs: '', title: '', range: '', idea: '',
    })
    setMenu(null)
  }
  const removeImage = (chunkId: string, imageId: string) => {
    mutate((p) => ({
      ...p,
      chunks: p.chunks.map((c) =>
        c.id !== chunkId ? c : { ...c, beats: c.beats.map((b) => ({ ...b, images: b.images.filter((im) => im.id !== imageId) })).filter((b) => b.images.length > 0) },
      ),
      overlays: p.overlays.filter((r) => r.anchor !== imageId),
    }))
    setMenu(null)
  }
  const removeChunk = (chunkId: string) => {
    const gone = new Set(plan.chunks.find((c) => c.id === chunkId)?.beats.flatMap((b) => b.images.map((im) => im.id)) ?? [])
    mutate((p) => ({ ...p, chunks: p.chunks.filter((c) => c.id !== chunkId), overlays: p.overlays.filter((r) => !gone.has(r.anchor)) }))
    setMenu(null)
  }
  const saveEdit = () => {
    if (!editing) return
    const d = editing
    if (d.scope === 'image') {
      const next = { id: d.imageId!, what: d.what || 'New visual — describe it.', why: d.why, hold: d.hold || '6s', distinct: true, refs: d.refs, firstWord: '', lastWord: '', startS: 0, endS: 0, firstIdx: 0, lastIdx: 0 }
      mutate((p) => ({
        ...p,
        chunks: p.chunks.map((c) => {
          if (c.id !== d.chunkId) return c
          if (d.isNew) {
            if (d.nearImageId) {
              return {
                ...c,
                beats: c.beats.map((b) => {
                  const idx = b.images.findIndex((im) => im.id === d.nearImageId)
                  if (idx < 0) return b
                  const imgs = [...b.images]
                  imgs.splice(d.insertPos === 'before' ? idx : idx + 1, 0, next)
                  return { ...b, images: imgs }
                }),
              }
            }
            const beats = c.beats.length
              ? c.beats.map((b, i) => (i === c.beats.length - 1 ? { ...b, images: [...b.images, next] } : b))
              : [{ code: `${c.id}A`, range: c.range, narration: d.idea || '(new beat)', images: [next] }]
            return { ...c, beats }
          }
          return { ...c, beats: c.beats.map((b) => ({ ...b, images: b.images.map((im) => (im.id === d.imageId ? next : im)) })) }
        }),
      }))
      setActiveId(d.imageId!)
    } else if (d.isNew) {
      const seed = { id: `IMG${String(++seqImg.current).padStart(2, '0')}`, what: 'New visual — right-click it to edit.', why: '', hold: '6s', distinct: true, refs: '', firstWord: '', lastWord: '', startS: 0, endS: 0, firstIdx: 0, lastIdx: 0 }
      const newChunk = { id: d.chunkId, title: d.title || 'New chunk', range: d.range, summary: d.idea || '', words: [] as string[], beats: [{ code: `${d.chunkId}A`, range: d.range, narration: d.idea || '(describe this beat)', images: [seed] }] }
      mutate((p) => {
        const chunks = [...p.chunks]
        let at = chunks.length
        if (d.beforeChunkId) {
          const bi = chunks.findIndex((c) => c.id === d.beforeChunkId)
          if (bi >= 0) at = bi
        } else if (d.afterChunkId) {
          const ai = chunks.findIndex((c) => c.id === d.afterChunkId)
          if (ai >= 0) at = ai + 1
        }
        chunks.splice(at, 0, newChunk)
        return { ...p, chunks }
      })
      setActiveId(seed.id)
    } else {
      mutate((p) => ({ ...p, chunks: p.chunks.map((c) => (c.id === d.chunkId ? { ...c, title: d.title, range: d.range } : c)) }))
    }
    setEditing(null)
  }
  const aiFill = () => {
    if (!editing) return
    setAiBusy(true)
    const idea = editing.idea.trim()
    const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)
    window.setTimeout(() => {
      setEditing((e) => {
        if (!e) return e
        if (e.scope === 'image')
          return {
            ...e,
            what: `${idea ? cap(idea) : 'A new visual moment'} — staged in the ${plan.style} style: builder mid-frame, bold flat color, one clear focal action.`,
            why: `Reinforces ${idea ? `“${idea}”` : 'this beat'} at the cut; distinct from the previous image and readable in about ${e.hold || '6s'}.`,
          }
        return { ...e, title: idea ? cap(idea).slice(0, 40) : 'New chunk' }
      })
      setAiBusy(false)
    }, 700)
  }
  const setDraft = (patch: Partial<VPEditDraft>) => setEditing((d) => (d ? { ...d, ...patch } : d))

  return (
    <div className="vp panel-flat">
      <div className="ch">
        <h3>Visual pacing — {plan.chunks.length} chunks · {images.length} images</h3>
        <span>working/visual-pacing-plan.md</span>
      </div>

      <div className="vp-stats">
        <span><b>{images.length}</b> images</span>
        <span><b>{plan.opening}</b> opening</span>
        <span><b>{plan.body}</b> body</span>
        <span><b>{plan.overlays.length}</b> overlays</span>
        <span><b>{plan.chunks.length}</b> chunks</span>
        <b>{plan.runtime} · {plan.style}</b>
      </div>

      <div className="vp-timeline">
        <div className="vp-tl-row">
          <span className="vp-tl-label">Chunks</span>
          <div className="vp-tl-track ruler">
            {chunkSpans.map((c, i) => (
              <div
                key={c.id}
                className={`vp-ruler-seg ${i % 2 ? 'alt' : ''} ${active && active.chunk === c.id ? 'on' : ''}`}
                style={{ left: `${pct(c.start)}%`, width: `${pct(c.end - c.start)}%` }}
                title={`${c.id} · ${c.title} — right-click to edit`}
                onContextMenu={(e) => openMenu(e, { chunkId: c.id, imageId: images.find((i) => i.chunk === c.id)?.id })}
              >
                <span>{c.id}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="vp-tl-row">
          <span className="vp-tl-label">Visuals</span>
          <div className="vp-tl-track visuals">
            <div className="vp-opening-band" style={{ width: `${pct(openingEnd)}%` }}>
              <span>opening · dense</span>
            </div>
            {images.map((img) => (
              <button
                type="button"
                key={img.id}
                className={`vp-seg ${img.id === activeId ? 'on' : ''}`}
                style={{ left: `${pct(img.start)}%`, width: `${pct(img.holdSec)}%` }}
                onMouseEnter={() => setActiveId(img.id)}
                onFocus={() => setActiveId(img.id)}
                onContextMenu={(e) => openMenu(e, { chunkId: img.chunk, imageId: img.id })}
                title={`${img.id} · ${img.hold} — right-click to edit`}
              >
                <span>{img.id}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="vp-tl-row">
          <span className="vp-tl-label">Overlays</span>
          <div className="vp-tl-track overlays">
            {overlayMarks.length === 0 ? <span className="vp-tl-empty">none</span> : null}
            {overlayMarks.map((r) => (
              <div
                key={r.id}
                className="vp-overlay-mark"
                style={{ left: `${pct(r.center)}%` }}
                title={`${r.id} · "${r.trigger}" · ${r.dur} · ${r.image}`}
              >
                {r.id} · {r.dur}
              </div>
            ))}
          </div>
        </div>

        <div className="vp-tl-row axis">
          <span className="vp-tl-label" />
          <div className="vp-tl-track">
            {ticks.map((t) => (
              <span key={t} className="vp-tick" style={{ left: `${pct(t)}%` }}>{fmt(t)}</span>
            ))}
            <span className="vp-tick end" style={{ left: '100%' }}>{fmt(totalSec)}</span>
          </div>
        </div>
      </div>

      <div className="vp-hintbar">
        <p className="vp-hint">Hover a block to inspect · right-click a block or chunk to edit, add, or remove</p>
        <button type="button" className="vp-undo" onClick={undo} disabled={history.length === 0}>
          ↶ Undo{history.length ? ` (${history.length})` : ''}
        </button>
      </div>

      {editing ? (
        <div className="vp-edit">
          <div className="vp-edit-head">
            <span className="id">{editing.scope === 'image' ? editing.imageId : editing.chunkId}</span>
            <b>{editing.isNew ? 'New' : 'Editing'} {editing.scope}</b>
            {editing.scope === 'image' ? <span className="vp-active-hold">in {editing.chunkId}</span> : null}
          </div>

          {editing.scope === 'chunk' ? (
            <div className="vp-edit-grid">
              <label>Title<input value={editing.title} onChange={(e) => setDraft({ title: e.target.value })} placeholder="Scene title" /></label>
              <label>Time range<input value={editing.range} onChange={(e) => setDraft({ range: e.target.value })} placeholder="e.g. 25–48s" /></label>
            </div>
          ) : (
            <>
              <label className="vp-edit-field">What the viewer sees
                <textarea rows={3} value={editing.what} onChange={(e) => setDraft({ what: e.target.value })} placeholder="Describe the on-screen visual…" />
              </label>
              <label className="vp-edit-field">Why now
                <textarea rows={2} value={editing.why} onChange={(e) => setDraft({ why: e.target.value })} placeholder="Why this image at this beat…" />
              </label>
              <div className="vp-edit-grid">
                <label>Hold<input value={editing.hold} onChange={(e) => setDraft({ hold: e.target.value })} placeholder="6s" /></label>
                <label>References<input value={editing.refs} onChange={(e) => setDraft({ refs: e.target.value })} placeholder="builder, meme-chad" /></label>
              </div>
            </>
          )}

          <div className="vp-ai">
            <input className="vp-ai-input" value={editing.idea} onChange={(e) => setDraft({ idea: e.target.value })} placeholder="…or write an idea and let AI draft it" />
            <button type="button" className="vp-ai-btn" onClick={aiFill} disabled={aiBusy}>{aiBusy ? 'Drafting…' : '✨ AI fill'}</button>
          </div>

          <div className="vp-edit-actions">
            <button type="button" className="vp-save" onClick={saveEdit}>Save</button>
            <button type="button" className="vp-cancel" onClick={() => setEditing(null)}>Cancel</button>
            <span className="vp-edit-note">Mock editor — changes stay in this session</span>
          </div>
        </div>
      ) : null}

      {menu ? (
        <>
          <div className="vp-menu-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null) }} />
          <div className="vp-menu" style={{ left: menu.x, top: menu.y }}>
            <div className="vp-menu-h">{menu.imageId ? `${menu.imageId} · ` : ''}{menu.chunkId}</div>
            <button type="button" onClick={() => startEditImage(menu.chunkId, menu.imageId!)}>Edit image</button>
            <button type="button" onClick={() => startAddImage(menu.chunkId, { nearImageId: menu.imageId, pos: 'before' })}>Add image before</button>
            <button type="button" onClick={() => startAddImage(menu.chunkId, { nearImageId: menu.imageId, pos: 'after' })}>Add image after</button>
            <button type="button" className="danger" onClick={() => removeImage(menu.chunkId, menu.imageId!)}>Remove image</button>
            <div className="vp-menu-div" />
            <button type="button" onClick={() => startEditChunk(menu.chunkId)}>Edit chunk</button>
            <button type="button" onClick={() => startAddChunk(menu.chunkId, 'before')}>Add chunk before</button>
            <button type="button" onClick={() => startAddChunk(menu.chunkId, 'after')}>Add chunk after</button>
            <button type="button" className="danger" onClick={() => removeChunk(menu.chunkId)}>Remove chunk</button>
          </div>
        </>
      ) : null}

      <div className="vp-viewbar">
        <h4 className="vp-sub-h">Pacing</h4>
        <div className="vp-viewtoggle">
          <button type="button" className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}>Table</button>
          <button type="button" className={view === 'script' ? 'on' : ''} onClick={() => setView('script')}>Script</button>
        </div>
      </div>

      {view === 'table' ? (
        <div className="table-wrap">
          <table className="shots vp-pacing">
            <thead>
              <tr><th>Start</th><th>Img</th><th>Chunk</th><th>Visual</th><th>Hold</th><th></th></tr>
            </thead>
            <tbody>
              {images.map((img) => (
                <tr key={img.id} className={img.id === activeId ? 'on' : ''} onMouseEnter={() => setActiveId(img.id)}>
                  <td className="vp-mono">{fmt(img.start)}</td>
                  <td><span className="id">{img.id}</span></td>
                  <td><span className="id">{img.chunk}</span></td>
                  <td>{img.what}</td>
                  <td className="vp-mono">{img.hold}</td>
                  <td className="vp-row-cell"><button type="button" className="vp-row-menu" onClick={(e) => openMenu(e, { chunkId: img.chunk, imageId: img.id })} title="Actions">⋯</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="vp-script">
          {plan.chunks.map((chunk) => {
            const cimgs = chunk.beats.flatMap((b) => b.images)
            return (
              <p className="vp-script-chunk" key={chunk.id}>
                <span className="vp-script-cid">{chunk.id}</span>
                {chunk.words.map((w, i) => {
                  const owner = cimgs.find((im) => i >= im.firstIdx && i <= im.lastIdx)
                  const ov = plan.overlays.find((o) => o.chunk === chunk.id && i >= o.firstIdx && i <= o.lastIdx)
                  const cls = ['vp-w']
                  if (owner) cls.push('img')
                  if (owner && owner.id === activeId) cls.push('on')
                  if (ov) cls.push('ov')
                  return (
                    <span key={i}>
                      {owner && i === owner.firstIdx ? <span className="vp-w-tag" title={owner.what}>{owner.id}</span> : null}
                      {ov && i === ov.firstIdx ? <span className="vp-w-tag ovtag" title={ov.image}>{ov.id}</span> : null}
                      <span
                        className={cls.join(' ')}
                        onMouseEnter={owner ? () => setActiveId(owner.id) : undefined}
                        onClick={owner ? (e) => openMenu(e, { chunkId: chunk.id, imageId: owner.id }) : undefined}
                      >{w}</span>{' '}
                    </span>
                  )
                })}
              </p>
            )
          })}
        </div>
      )}

      <details className="vp-section">
        <summary className="vp-section-sum"><span className="vp-sec-title">Overlays</span><span className="vp-section-count">{plan.overlays.length}</span></summary>
        <div className="table-wrap">
          <table className="shots vp-table">
            <thead>
              <tr><th>ID</th><th>Trigger</th><th>Overlay</th><th>Duration</th><th>Placement</th></tr>
            </thead>
            <tbody>
              {plan.overlays.map((r) => (
                <tr key={r.id}>
                  <td><span className="id">{r.id}</span></td>
                  <td className="narr">"{r.trigger}"</td>
                  <td>{r.image}</td>
                  <td>{r.dur}</td>
                  <td>{r.placement}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

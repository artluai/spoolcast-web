import { useEffect, useRef, useState } from 'react'
import { activeSession, apiUrl, contentUrl, getFileJson, getJson, postAction } from '../../lib/api'
import { DEFAULT_MODEL_ID, draftReasoning } from '../../lib/draft-models'
import { DEFAULT_IMAGE_MODEL_ID, IMAGE_MODELS } from '../../lib/image-models'
import { ModelPicker } from './ModelPicker'

// WORLD KIT CASTING PANEL — one kit item's reference image. Two labeled paths:
//   GENERATE (from the item's notes; options: model, canvas ratio, character
//   sheet, AI-improved prompt, image ingredients) — or ADD YOUR OWN (upload /
//   pick from the session). Every result is a kept version; the filmstrip is
//   the history and clicking picks the active one. Describe-with-AI appears
//   only for images that didn't come from a prompt.

type RefVersion = {
  id: string
  kind: 'generated' | 'uploaded' | 'mapped'
  file?: string
  path?: string
  prompt?: string
  model?: string
  at?: string
}
type RefManifest = { versions: RefVersion[]; active: string | null }
type PoolImage = { path: string; name: string; size: number; ref?: string }

const KIND_BADGE: Record<RefVersion['kind'], string> = {
  generated: '✦ gen',
  uploaded: '↑ upload',
  mapped: '↦ mapped',
}

export function RefImagePanel({
  refId,
  notes,
  kind = '',
  onDescribed,
  onToast,
}: {
  refId: string
  notes: string
  kind?: string
  onDescribed: (text: string) => void
  onToast: (message: string) => void
}) {
  const [manifest, setManifest] = useState<RefManifest | null>(null)
  const [imgModel, setImgModel] = useState(DEFAULT_IMAGE_MODEL_ID)
  const [txtModel, setTxtModel] = useState(DEFAULT_MODEL_ID)
  const [detailed, setDetailed] = useState('')
  const [promptSource, setPromptSource] = useState<'notes' | 'detailed'>('notes')
  const [generating, setGenerating] = useState(false)
  const [detailing, setDetailing] = useState(false)
  const [describing, setDescribing] = useState(false)
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [pool, setPool] = useState<PoolImage[] | null>(null)
  // Masters are full scenes; the character-sheet toggle only fits ingredients.
  const isMaster = /master/i.test(kind)
  const [sheet, setSheet] = useState(() => !/master/i.test(kind) && /char|person|talent|creator/i.test(kind))
  // Canvas ratio for THIS generation ('auto' = the video's ratio). A wide
  // character sheet inside a vertical video is normal.
  const [ratio, setRatio] = useState('auto')
  const [dims, setDims] = useState('')
  // Ingredients: images that ride along with the prompt (how masters compose).
  const [attachOpen, setAttachOpen] = useState(false)
  const [attachPool, setAttachPool] = useState<PoolImage[] | null>(null)
  const [attached, setAttached] = useState<string[]>([])
  const fileRef = useRef<HTMLInputElement | null>(null)
  const timerRef = useRef<number | null>(null)

  const manifestPath = `source/world-kit-refs/${refId}/manifest.json`
  const loadManifest = () =>
    getFileJson<RefManifest>(manifestPath).then((m) => setManifest(m ?? { versions: [], active: null }))

  useEffect(() => {
    setManifest(null)
    setDetailed('')
    setPromptSource('notes')
    setAttached([])
    setAttachOpen(false)
    setGalleryOpen(false)
    setDims('')
    loadManifest()
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refId])

  const versionUrl = (v: RefVersion) =>
    v.kind === 'mapped' ? contentUrl(v.path ?? '') : contentUrl(`source/world-kit-refs/${refId}/${v.file ?? ''}`)
  const versionRelPath = (v: RefVersion) =>
    v.kind === 'mapped' ? (v.path ?? '') : `source/world-kit-refs/${refId}/${v.file ?? ''}`

  const versions = manifest?.versions ?? []
  const active = versions.find((v) => v.id === manifest?.active) ?? null

  const pollJob = (jobId: string) => {
    const tick = async () => {
      const state = await getFileJson<{ state?: string }>(`working/jobs/${jobId}.json`)
      if (state?.state === 'succeeded') {
        setGenerating(false)
        await loadManifest()
        onToast('Reference generated — it joined this item’s history.')
        return
      }
      if (state?.state && ['failed', 'stopped', 'lost'].includes(state.state)) {
        setGenerating(false)
        onToast('Reference generation failed — see the job log, then try again.')
        return
      }
      timerRef.current = window.setTimeout(tick, 4000)
    }
    timerRef.current = window.setTimeout(tick, 4000)
  }

  const generate = async () => {
    let prompt = (promptSource === 'detailed' && detailed.trim() ? detailed : notes).trim()
    if (!prompt) {
      onToast('Write a prompt description first — that’s what the image is generated from.')
      return
    }
    if (sheet && !isMaster) {
      prompt += ', isolated on a clean neutral studio background, character reference sheet, no background scene'
    }
    setGenerating(true)
    const out = await postAction<{ stdout?: string }>({
      action: 'generate_worldkit_ref',
      ref: refId,
      prompt,
      model: imgModel,
      ...(attached.length ? { ref_images: attached } : {}),
      ...(ratio !== 'auto' ? { aspect_ratio: ratio } : {}),
      allow_cost: true,
    })
    const already = /already running as (\S+)/.exec(out?.details || '')?.[1]
    const jobId = already ?? /job (\S+)/.exec(out?.data?.stdout || '')?.[1] ?? null
    if (!out || (!out.ok && !already) || !jobId) {
      setGenerating(false)
      onToast(out ? `Engine: ${out.error || out.message || 'could not start generation.'}` : 'The engine is not reachable.')
      return
    }
    pollJob(jobId)
  }

  const detailPrompt = async () => {
    if (!notes.trim()) {
      onToast('Write a short description first — the AI improves it.')
      return
    }
    setDetailing(true)
    const out = await postAction<{ text?: string }>({
      action: 'expand_ref_prompt',
      text: notes,
      model: txtModel,
      ...(draftReasoning(txtModel) ? { reasoning: draftReasoning(txtModel) } : {}),
      allow_cost: true,
    })
    setDetailing(false)
    if (out?.ok && out.data?.text) {
      setDetailed(out.data.text)
      setPromptSource('detailed')
    } else {
      onToast(`Engine: ${out?.error || out?.message || 'could not improve the prompt.'}`)
    }
  }

  const describe = async () => {
    if (!active) return
    setDescribing(true)
    const out = await postAction<{ text?: string }>({
      action: 'describe_ref_image',
      path: versionRelPath(active),
      allow_cost: true,
    })
    setDescribing(false)
    if (out?.ok && out.data?.text) {
      onDescribed(out.data.text)
      onToast('Description written into the item’s notes.')
    } else {
      onToast(`Engine: ${out?.error || out?.message || 'could not describe the image.'}`)
    }
  }

  const upload = async (file: File) => {
    const b64 = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
      r.onerror = reject
      r.readAsDataURL(file)
    })
    const out = await postAction({ action: 'add_ref_image', ref: refId, filename: file.name, content: b64 })
    if (out?.ok) {
      await loadManifest()
      onToast('Image added to this item’s history.')
    } else {
      onToast(`Engine: ${out?.error || 'upload failed.'}`)
    }
  }

  const openAttach = async () => {
    setAttachOpen((v) => !v)
    if (attachPool === null) {
      const out = await getJson<{ ok?: boolean; data?: { images?: PoolImage[] } }>(
        apiUrl('source-images', { session: activeSession(), include_refs: 1 }),
      )
      setAttachPool((out?.data?.images ?? []).filter((i) => !i.path.includes(`world-kit-refs/${refId}/`)))
    }
  }

  const openGallery = async () => {
    setGalleryOpen((v) => !v)
    if (pool === null) {
      const out = await getJson<{ ok?: boolean; data?: { images?: PoolImage[] } }>(
        apiUrl('source-images', { session: activeSession() }),
      )
      setPool(out?.data?.images ?? [])
    }
  }

  const mapImage = async (path: string) => {
    const out = await postAction({ action: 'map_ref_image', ref: refId, path })
    if (out?.ok) {
      setGalleryOpen(false)
      await loadManifest()
      onToast('Image added to this item’s history.')
    } else {
      onToast(`Engine: ${out?.error || 'could not use that image.'}`)
    }
  }

  const pick = async (v: RefVersion) => {
    if (manifest?.active === v.id) return
    setManifest((m) => (m ? { ...m, active: v.id } : m))
    const out = await postAction({ action: 'set_ref_active', ref: refId, id: v.id })
    if (!out?.ok) {
      onToast(`Engine: ${out?.error || 'could not set the reference.'}`)
      await loadManifest()
    }
  }

  const small: React.CSSProperties = {
    background: 'var(--bg-3)', border: '1px solid var(--line-2)', color: 'var(--ink-2)',
    borderRadius: 6, padding: '7px 12px', fontSize: 12, cursor: 'pointer',
  }
  const clusterLabel: React.CSSProperties = {
    fontSize: 10, letterSpacing: '.1em', color: 'var(--ink-3)', fontFamily: 'var(--mono)',
  }

  return (
    <div style={{ borderTop: '1px dashed var(--line, #2a3142)', marginTop: 10, paddingTop: 12 }}>
      {/* VIEW — the item's current image and its history */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: 14 }}>
        {active ? (
          <div style={{ width: 190, flex: 'none' }}>
            <img
              src={versionUrl(active)}
              alt=""
              onLoad={(e) => setDims(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)}
              style={{ width: 190, height: 'auto', display: 'block', borderRadius: 10, border: '1px solid var(--accent)' }}
            />
            <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>
              current image · {KIND_BADGE[active.kind]}{dims ? ` · ${dims}` : ''}
            </div>
            {active.kind !== 'generated' && (
              <button
                type="button"
                style={{ ...small, marginTop: 6, padding: '5px 10px', fontSize: 11.5 }}
                disabled={describing}
                onClick={describe}
              >
                {describing ? (<><span className="spin" /> Describing…</>) : '✦ Describe with AI → notes'}
              </button>
            )}
          </div>
        ) : (
          <div
            style={{
              width: 190, height: 190, flex: 'none', borderRadius: 10, border: '1px dashed var(--line, #2a3142)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-3)', fontSize: 12,
              textAlign: 'center', padding: 10,
            }}
          >
            {manifest === null ? 'Loading…' : 'No image yet — create one below.'}
          </div>
        )}
        {versions.length > 1 && (
          <div style={{ flex: '1 1 200px' }}>
            <div style={{ ...clusterLabel, marginBottom: 6 }}>HISTORY — CLICK TO SWITCH</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignContent: 'flex-start' }}>
              {versions.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => pick(v)}
                  title={`${v.id} · ${v.kind}${v.model ? ` · ${v.model}` : ''}${v.prompt ? `\n\n${v.prompt.slice(0, 300)}` : ''}`}
                  style={{
                    padding: 0, borderRadius: 8, overflow: 'hidden', cursor: 'pointer', position: 'relative',
                    border: manifest?.active === v.id ? '2px solid var(--accent)' : '1px solid var(--line, #2a3142)',
                    background: 'none',
                  }}
                >
                  <img src={versionUrl(v)} alt="" style={{ height: 64, width: 'auto', maxWidth: 128, display: 'block' }} />
                  <span
                    style={{
                      position: 'absolute', left: 0, right: 0, bottom: 0, fontSize: 9, lineHeight: '14px',
                      background: 'rgba(5,6,8,.72)', color: 'var(--ink-3)', textAlign: 'center',
                    }}
                  >
                    {KIND_BADGE[v.kind]}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* CREATE — everything that makes a new version, in its own box */}
      <div style={{ border: '1px solid var(--line, #2a3142)', borderRadius: 10, padding: '12px 14px' }}>
        <div style={{ ...clusterLabel, marginBottom: 8 }}>CREATE A NEW VERSION</div>
        {isMaster && (
          <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: '0 0 10px', lineHeight: 1.5 }}>
            A master shot is the approved scene your clips will start from. Add your cast and
            environment images as reference images, describe the moment in the notes, and generate.
          </p>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
          <button type="button" className="core-create" disabled={generating} onClick={generate}>
            {generating ? (<><span className="spin" /> Generating…</>) : '✦ Generate from the notes'}
          </button>
          <ModelPicker model={imgModel} onChange={setImgModel} disabled={generating} models={IMAGE_MODELS} primary={IMAGE_MODELS} />
          <select
            value={ratio}
            onChange={(e) => setRatio(e.target.value)}
            title="Canvas ratio for this generation"
            style={{ background: 'var(--bg-3)', color: 'var(--ink-2)', border: '1px solid var(--line-2)', borderRadius: 6, padding: '7px 8px', fontSize: 12, fontFamily: 'var(--mono)' }}
          >
            <option value="auto">ratio: video</option>
            <option value="1:1">1:1</option>
            <option value="16:9">16:9</option>
            <option value="9:16">9:16</option>
            <option value="4:3">4:3</option>
            <option value="3:4">3:4</option>
          </select>
          {!isMaster && (
            <label style={{ fontSize: 12, color: 'var(--ink-2)', display: 'inline-flex', gap: 5, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={sheet} onChange={(e) => setSheet(e.target.checked)} />
              character sheet, blank background
            </label>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
          <button type="button" style={small} disabled={detailing} onClick={detailPrompt}>
            {detailing ? (<><span className="spin" /> Improving…</>) : '✎ Improve prompt with AI'}
          </button>
          {(detailing || detailed.trim() !== '') && (
            <ModelPicker model={txtModel} onChange={setTxtModel} disabled={detailing} />
          )}
          <button type="button" style={small} onClick={openAttach}>
            🖇 Reference images{attached.length ? ` (${attached.length})` : ''} {attachOpen ? '▴' : '▾'}
          </button>
          {detailed.trim() !== '' && (
            <label style={{ fontSize: 12, color: 'var(--ink-3)', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              generate from
              <select
                value={promptSource}
                onChange={(e) => setPromptSource(e.target.value as 'notes' | 'detailed')}
                style={{ background: 'transparent', color: 'var(--ink-2)', border: '1px solid var(--line-2)', borderRadius: 6, padding: '4px 6px', fontSize: 12 }}
              >
                <option value="detailed">improved prompt</option>
                <option value="notes">original notes</option>
              </select>
            </label>
          )}
        </div>
        {detailed.trim() !== '' && (
          <textarea
            value={detailed}
            onChange={(e) => setDetailed(e.target.value)}
            rows={4}
            style={{
              width: '100%', resize: 'vertical', background: 'rgba(255,255,255,.02)', color: 'var(--ink-2)',
              border: '1px solid var(--line, #2a3142)', borderRadius: 6, padding: '8px 10px', fontSize: 12.5, lineHeight: 1.5,
              marginBottom: 6, boxSizing: 'border-box',
            }}
          />
        )}
        {attached.length > 0 && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
            {attached.map((path) => (
              <span key={path} style={{ position: 'relative', display: 'inline-block' }}>
                <img src={contentUrl(path)} alt="" style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--accent)', display: 'block' }} />
                <button
                  type="button"
                  title="Remove reference image"
                  onClick={() => setAttached((a) => a.filter((x) => x !== path))}
                  style={{ position: 'absolute', top: -6, right: -6, width: 16, height: 16, lineHeight: '13px', padding: 0, borderRadius: 8, background: 'var(--bg-3)', border: '1px solid var(--line-2)', color: 'var(--ink-2)', fontSize: 10, cursor: 'pointer' }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {attachOpen && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', border: '1px dashed var(--line, #2a3142)', borderRadius: 8, padding: 8, marginBottom: 8 }}>
            {attachPool === null ? (
              <span style={{ fontSize: 12, color: 'var(--ink-3)' }}><span className="spin" /> Loading…</span>
            ) : attachPool.length === 0 ? (
              <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>No other images in this session yet.</span>
            ) : (
              attachPool.map((img) => (
                <button
                  key={img.path}
                  type="button"
                  title={img.name}
                  onClick={() =>
                    setAttached((a) =>
                      a.includes(img.path) ? a.filter((x) => x !== img.path) : a.length < 4 ? [...a, img.path] : a,
                    )
                  }
                  style={{
                    padding: 0, borderRadius: 8, overflow: 'hidden', cursor: 'pointer', background: 'none',
                    border: attached.includes(img.path) ? '2px solid var(--accent)' : '1px solid var(--line, #2a3142)',
                  }}
                >
                  <img src={contentUrl(img.path)} alt="" style={{ width: 76, height: 76, objectFit: 'cover', display: 'block' }} />
                </button>
              ))
            )}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', borderTop: '1px dashed var(--line, #2a3142)', paddingTop: 10, marginTop: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>or add your own:</span>
          <button type="button" style={small} onClick={() => fileRef.current?.click()}>↑ Upload</button>
          <button type="button" style={small} onClick={() => void openGallery()}>↦ Pick from session {galleryOpen ? '▴' : '▾'}</button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void upload(f)
              e.target.value = ''
            }}
          />
        </div>
        {galleryOpen && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', border: '1px dashed var(--line, #2a3142)', borderRadius: 8, padding: 8, marginTop: 8 }}>
            {pool === null ? (
              <span style={{ fontSize: 12, color: 'var(--ink-3)' }}><span className="spin" /> Loading session images…</span>
            ) : pool.length === 0 ? (
              <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>No images in this session yet — upload some in Video idea (source material).</span>
            ) : (
              pool.map((img) => (
                <button
                  key={img.path}
                  type="button"
                  title={img.path}
                  onClick={() => mapImage(img.path)}
                  style={{ padding: 0, border: '1px solid var(--line, #2a3142)', borderRadius: 8, overflow: 'hidden', cursor: 'pointer', background: 'none' }}
                >
                  <img src={contentUrl(img.path)} alt="" style={{ width: 76, height: 76, objectFit: 'cover', display: 'block' }} />
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}

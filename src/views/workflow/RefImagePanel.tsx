import { useEffect, useRef, useState } from 'react'
import { activeSession, apiUrl, contentUrl, getFileJson, getJson, postAction } from '../../lib/api'
import { DEFAULT_MODEL_ID, draftReasoning } from '../../lib/draft-models'
import { DEFAULT_IMAGE_MODEL_ID, IMAGE_MODELS } from '../../lib/image-models'
import { ModelPicker } from './ModelPicker'

// WORLD KIT CASTING PANEL — the reference image machinery for one kit item:
//   · generate a candidate from the item's notes OR an AI-detailed prompt
//   · upload your own image, or map one already in the session (intake assets)
//   · EVERY version is kept (source/world-kit-refs/<ref>/manifest.json);
//     the filmstrip is the history and clicking a version picks the active one
//   · describe-with-AI turns the active image back into prompt-style notes
// Paid actions are labeled; generation runs as a durable engine job.

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
type PoolImage = { path: string; name: string; size: number }

const KIND_BADGE: Record<RefVersion['kind'], string> = {
  generated: '✦ gen',
  uploaded: '↑ upload',
  mapped: '↦ mapped',
}

export function RefImagePanel({
  refId,
  notes,
  onDescribed,
  onToast,
}: {
  refId: string
  notes: string
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
  const fileRef = useRef<HTMLInputElement | null>(null)
  const timerRef = useRef<number | null>(null)

  const manifestPath = `source/world-kit-refs/${refId}/manifest.json`
  const loadManifest = () =>
    getFileJson<RefManifest>(manifestPath).then((m) => setManifest(m ?? { versions: [], active: null }))

  useEffect(() => {
    setManifest(null)
    setDetailed('')
    setPromptSource('notes')
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

  // ---- generate (durable job, polled) ------------------------------------
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
    const prompt = (promptSource === 'detailed' && detailed.trim() ? detailed : notes).trim()
    if (!prompt) {
      onToast('Write a prompt description first — that’s what the image is generated from.')
      return
    }
    setGenerating(true)
    const out = await postAction<{ stdout?: string }>({
      action: 'generate_worldkit_ref',
      ref: refId,
      prompt,
      model: imgModel,
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

  // ---- detail the prompt (paid text call) ---------------------------------
  const detailPrompt = async () => {
    if (!notes.trim()) {
      onToast('Write a short description first — the AI expands it.')
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
      onToast(`Engine: ${out?.error || out?.message || 'could not expand the prompt.'}`)
    }
  }

  // ---- describe active image → notes (paid vision call) -------------------
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

  // ---- upload / map --------------------------------------------------------
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
      onToast('Mapped — the image joined this item’s history.')
    } else {
      onToast(`Engine: ${out?.error || 'could not map the image.'}`)
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

  return (
    <div style={{ borderTop: '1px dashed var(--line, #2a3142)', marginTop: 10, paddingTop: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 8 }}>REFERENCE IMAGE</div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* ACTIVE reference */}
        {active ? (
          <div style={{ width: 168, flex: 'none' }}>
            <img
              src={versionUrl(active)}
              alt=""
              style={{ width: 168, height: 168, objectFit: 'cover', borderRadius: 10, border: '1px solid var(--accent)' }}
            />
            <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>
              active · {KIND_BADGE[active.kind]}
            </div>
          </div>
        ) : (
          <div
            style={{
              width: 168, height: 168, flex: 'none', borderRadius: 10, border: '1px dashed var(--line, #2a3142)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-3)', fontSize: 12,
              textAlign: 'center', padding: 10,
            }}
          >
            {manifest === null ? 'Loading…' : 'No reference yet — generate, upload, or map one.'}
          </div>
        )}

        <div style={{ flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* HISTORY filmstrip: every version, click to pick */}
          {versions.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
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
                  <img src={versionUrl(v)} alt="" style={{ width: 64, height: 64, objectFit: 'cover', display: 'block' }} />
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
          )}

          {/* GENERATE row */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" className="core-create" disabled={generating} onClick={generate}>
              {generating ? (<><span className="spin" /> Generating…</>) : '✦ Generate'}
            </button>
            <ModelPicker model={imgModel} onChange={setImgModel} disabled={generating} models={IMAGE_MODELS} primary={IMAGE_MODELS} />
            {detailed.trim() ? (
              <label style={{ fontSize: 12, color: 'var(--ink-3)', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                from
                <select
                  value={promptSource}
                  onChange={(e) => setPromptSource(e.target.value as 'notes' | 'detailed')}
                  style={{ background: 'transparent', color: 'var(--ink-2)', border: '1px solid var(--line-2)', borderRadius: 6, padding: '4px 6px', fontSize: 12 }}
                >
                  <option value="detailed">detailed prompt</option>
                  <option value="notes">original notes</option>
                </select>
              </label>
            ) : (
              <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>from the notes above · uses image credits</span>
            )}
          </div>

          {/* DETAILED PROMPT: AI-expanded, editable, used by Generate when selected */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" style={small} disabled={detailing} onClick={detailPrompt}>
              {detailing ? (<><span className="spin" /> Detailing…</>) : '✦ Make detailed image prompt'}
            </button>
            <ModelPicker model={txtModel} onChange={setTxtModel} disabled={detailing} />
            <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>uses text credits</span>
          </div>
          {detailed.trim() !== '' && (
            <textarea
              value={detailed}
              onChange={(e) => setDetailed(e.target.value)}
              rows={4}
              style={{
                width: '100%', resize: 'vertical', background: 'rgba(255,255,255,.02)', color: 'var(--ink-2)',
                border: '1px solid var(--line, #2a3142)', borderRadius: 6, padding: '8px 10px', fontSize: 12.5, lineHeight: 1.5,
              }}
            />
          )}

          {/* UPLOAD / MAP / DESCRIBE row */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" style={small} onClick={() => fileRef.current?.click()}>↑ Upload image</button>
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
            <button type="button" style={small} onClick={openGallery}>
              ↦ Map existing {galleryOpen ? '▴' : '▾'}
            </button>
            {active && (
              <button type="button" style={small} disabled={describing} onClick={describe}>
                {describing ? (<><span className="spin" /> Describing…</>) : '✦ Describe image → notes'}
              </button>
            )}
          </div>

          {/* MAP GALLERY: the session's uploaded/intake images */}
          {galleryOpen && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', border: '1px dashed var(--line, #2a3142)', borderRadius: 8, padding: 8 }}>
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
    </div>
  )
}

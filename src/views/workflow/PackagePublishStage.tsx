import { useEffect, useRef, useState } from 'react'
import { Pill } from '../../components/common/Pill'
import { activeSession, contentUrl, downloadUrl, fileUrl, getFileJson, getJson, postAction, urlOk } from '../../lib/api'
import { useWorkflowStore } from '../../store/workflow'
import { FeedbackButton } from './FeedbackButton'
import { ModelPicker } from './ModelPicker'
import { DEFAULT_MODEL_ID, draftReasoning } from '../../lib/draft-models'

// Word-timed upload captions produced by the engine's build_timepoints job
// (ROADMAP item 8): aligns each chunk's narration to its mp3 with Whisper,
// persists audio/<chunk>.timepoints.json, and assembles this SRT from it.
const srtPath = () => `renders/${activeSession()}-upload.srt`
const srtName = () => `${activeSession()}-upload.srt`

// Publish metadata drafted by the engine (draft_video_meta job → OpenRouter):
// title, description, and N distinct thumbnail candidate prompts.
const META_PATH = 'working/video-meta.json'
// Thumbnail candidates land in renders/thumbnail-options/ (one per drafted
// prompt); the picked one is finalized to the canonical cover slot the
// packaging stage expects.
const thumbPath = () => `renders/${activeSession()}-thumbnail.png`
const MAX_THUMBS = 6
const thumbOptionPath = (v: number) => `renders/thumbnail-options/${activeSession()}-thumb-v${v}.png`

// Step 12 — Package & publish: the closing screen. Video download, captions,
// title/description drafting, and thumbnail generation are REAL (engine jobs
// via the api.ts seam). Editor exports stay mock until the packaging backend
// (ROADMAP item 9). Publishing/upload is deliberately absent: locally you
// download and upload yourself; platform connectors are ROADMAP item 10, and
// the per-platform approval gate stays on the map.

type GenState = 'idle' | 'working' | 'ready'
type VideoMeta = { title?: string; description?: string; thumbnail_prompt?: string; thumbnail_prompts?: string[] }
type ThumbState = {
  gen: GenState
  versions: number[] // candidate versions found on disk (1-based)
  chosen: number | null // version finalized as the cover this session
  cover: boolean // canonical cover file exists
  finalizing: number | null
  bust: number // cache-buster for candidate images after a re-generate
}

export function PackagePublishStage({ onToast }: { onToast: (message: string) => void }) {
  // The compiled master from Final cut (real download once a compile is done —
  // step gating means users normally can't reach here before one exists).
  const finalRender = useWorkflowStore((s) => s.finalRender)
  const downloadVideo = () => {
    if (finalRender !== 'done') {
      onToast('No finished video yet — compile it on the Final cut step first.')
      return
    }
    const link = document.createElement('a')
    link.href = downloadUrl(`renders/${activeSession()}-1.0x.mp4`)
    link.download = `${activeSession()}-1.0x.mp4`
    link.click()
  }

  // One shared shape for every engine job this screen starts: submit the heavy
  // action, then poll the durable job's state file until it settles.
  const jobTimersRef = useRef<number[]>([])
  const runEngineJob = async (
    body: Record<string, unknown>,
    onSettled: (succeeded: boolean) => void,
  ) => {
    const out = await postAction<{ stdout?: string }>(body)
    const alreadyRunning = /already running as (\S+)/.exec(out?.details || '')?.[1]
    const jobId = alreadyRunning ?? /job (\S+)/.exec(out?.data?.stdout || '')?.[1] ?? null
    if (!out || (!out.ok && !alreadyRunning) || !jobId) {
      onToast(out ? 'The engine could not start the job.' : 'The engine is not reachable — is the local API running?')
      onSettled(false)
      return
    }
    const timer = window.setInterval(() => {
      void (async () => {
        const job = await getFileJson<{ state?: string }>(`working/jobs/${jobId}.json`)
        if (!job || job.state === 'running' || job.state === 'created') return
        window.clearInterval(timer)
        jobTimersRef.current = jobTimersRef.current.filter((t) => t !== timer)
        onSettled(job.state === 'succeeded')
      })()
    }, 2500)
    jobTimersRef.current.push(timer)
  }

  // Captions: probe for the engine-produced SRT; offer to generate it (a real
  // Whisper-alignment job) when it doesn't exist yet.
  const [captionsState, setCaptionsState] = useState<'unknown' | 'missing' | 'generating' | 'ready'>('unknown')
  useEffect(() => {
    let alive = true
    getJson<{ ok?: boolean }>(fileUrl(srtPath())).then((out) => {
      if (alive) setCaptionsState(out?.ok ? 'ready' : 'missing')
    })
    const timers = jobTimersRef.current
    return () => {
      alive = false
      timers.forEach((t) => window.clearInterval(t))
    }
  }, [])

  const generateCaptions = () => {
    setCaptionsState('generating')
    void runEngineJob({ action: 'build_timepoints' }, (succeeded) => {
      setCaptionsState(succeeded ? 'ready' : 'missing')
      onToast(succeeded
        ? 'Captions generated — word-timed from the narration audio.'
        : 'Caption generation failed — check the engine log under working/jobs/.')
    })
  }

  const downloadCaptions = () => {
    const link = document.createElement('a')
    link.href = downloadUrl(srtPath())
    link.download = srtName()
    link.click()
  }

  // Title & description: REAL — the draft_video_meta job (OpenRouter, drafted
  // from the script + core message + series rules) writes working/video-meta.json;
  // fields are editable after. The ▾ carries optional guidance to the model.
  const [metaGen, setMetaGen] = useState<GenState>('idle')
  const [metaModel, setMetaModel] = useState(DEFAULT_MODEL_ID)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [thumb, setThumb] = useState<ThumbState>({ gen: 'idle', versions: [], chosen: null, cover: false, finalizing: null, bust: 0 })
  const [thumbCount, setThumbCount] = useState(3)
  const hasMetaRef = useRef(false)
  const loadMeta = async (announce: boolean) => {
    const meta = await getFileJson<VideoMeta>(META_PATH)
    if (!meta?.title) return false
    setTitle(meta.title)
    setDescription(meta.description || '')
    hasMetaRef.current = true
    setMetaGen('ready')
    if (announce) onToast('Title & description drafted from the script — edit freely.')
    return true
  }
  // A previous visit may already have drafted metadata / candidates / a cover —
  // pick them all up.
  useEffect(() => {
    let alive = true
    getFileJson<VideoMeta>(META_PATH).then((meta) => {
      if (!alive || !meta?.title) return
      setTitle(meta.title)
      setDescription(meta.description || '')
      hasMetaRef.current = true
      setMetaGen('ready')
    })
    Promise.all([
      urlOk(contentUrl(thumbPath())),
      ...Array.from({ length: MAX_THUMBS }, (_, i) => urlOk(contentUrl(thumbOptionPath(i + 1)))),
    ]).then(([cover, ...options]) => {
      if (!alive) return
      const versions = options.flatMap((ok, i) => (ok ? [i + 1] : []))
      if (cover || versions.length) {
        setThumb({ gen: versions.length ? 'ready' : 'idle', versions, chosen: null, cover, finalizing: null, bust: Date.now() })
      }
    })
    return () => { alive = false }
  }, [])
  const generateMeta = (guidance: string) => {
    setMetaGen('working')
    const extra = [
      '--model', metaModel,
      ...(draftReasoning(metaModel) ? ['--reasoning', draftReasoning(metaModel)!] : []),
      ...(guidance.trim() ? ['--guidance', guidance.trim()] : []),
    ]
    void runEngineJob({ action: 'draft_video_meta', extra_args: extra }, (succeeded) => {
      if (!succeeded) {
        setMetaGen((prev) => (prev === 'working' ? 'idle' : prev))
        onToast('Drafting failed — check the engine log under working/jobs/.')
        return
      }
      void loadMeta(true)
    })
  }

  // Thumbnails: REAL — the engine renders one image per drafted candidate
  // prompt (generate_thumbnails.py → kie.ai) into renders/thumbnail-options/;
  // clicking a candidate finalizes it as the canonical cover (a copy, free).
  const generateThumbs = (guidance: string) => {
    if (!hasMetaRef.current) {
      onToast('Generate the title & description first — it also drafts the thumbnail concepts.')
      return
    }
    setThumb((prev) => ({ ...prev, gen: 'working' }))
    const extra = ['--count', String(thumbCount), ...(guidance.trim() ? ['--guidance', guidance.trim()] : [])]
    void runEngineJob({ action: 'thumbnails', extra_args: extra }, (succeeded) => {
      if (!succeeded) {
        setThumb((prev) => ({ ...prev, gen: prev.versions.length ? 'ready' : 'idle' }))
        onToast('Thumbnail generation failed — check the engine log under working/jobs/.')
        return
      }
      void (async () => {
        const found = await Promise.all(
          Array.from({ length: MAX_THUMBS }, (_, i) => urlOk(contentUrl(thumbOptionPath(i + 1)))),
        )
        const versions = found.flatMap((ok, i) => (ok ? [i + 1] : []))
        setThumb((prev) => ({ ...prev, gen: 'ready', versions, chosen: null, bust: Date.now() }))
        onToast(`${versions.length} cover candidate${versions.length === 1 ? '' : 's'} generated — click one to make it the cover.`)
      })()
    })
  }

  // Clicking a candidate opens it at full size first (feed-size tiles hide
  // detail); "Use as cover" inside the preview does the actual pick.
  const [previewVersion, setPreviewVersion] = useState<number | null>(null)
  const chooseCover = (version: number) => {
    setPreviewVersion(null)
    setThumb((prev) => ({ ...prev, finalizing: version }))
    void runEngineJob({ action: 'thumbnails', extra_args: ['--finalize', String(version)] }, (succeeded) => {
      setThumb((prev) => ({
        ...prev,
        finalizing: null,
        chosen: succeeded ? version : prev.chosen,
        cover: succeeded ? true : prev.cover,
      }))
      onToast(succeeded ? `Candidate v${version} is now the cover.` : 'Could not set the cover — check the engine log.')
    })
  }

  return (
    <div className="pkg-stage">
      <section className="pkg-section">
        <span className="eyebrow">Output file</span>
        <div className="pkg-actions">
          <button type="button" onClick={downloadVideo}>
            Download video
          </button>
          <span className="pkg-meta">{activeSession()}-1.0x.mp4 · 1920×1080 · from the Final cut export</span>
        </div>
      </section>

      <section className="pkg-section">
        <span className="eyebrow">Captions</span>
        <div className="pkg-actions">
          {captionsState === 'ready' ? (
            <button type="button" onClick={downloadCaptions}>Download captions (.srt)</button>
          ) : (
            <button type="button" onClick={generateCaptions} disabled={captionsState !== 'missing'}>
              {captionsState === 'generating' ? (<><span className="spin" /> Generating…</>) : 'Generate captions (.srt)'}
            </button>
          )}
          <span className="pkg-meta">
            {captionsState === 'ready'
              ? `${srtName()} · word-timed from the narration audio`
              : 'aligns each narration chunk word-by-word (runs locally, a few minutes)'}
          </span>
        </div>
      </section>

      <section className="pkg-section">
        <span className="eyebrow">Title &amp; description</span>
        <div className="pkg-gen-row">
          <FeedbackButton
            label={metaGen === 'ready' ? 'Re-generate title & description' : 'Generate title & description'}
            busy={metaGen === 'working'}
            busyLabel="Drafting…"
            title="Drafts from the script and series rules — uses model credits"
            placeholder="Optional guidance — e.g. “lead with the failure story”, “no jargon in the title”…"
            onRun={generateMeta}
          />
          <ModelPicker model={metaModel} onChange={setMetaModel} disabled={metaGen === 'working'} />
          {metaGen === 'idle' ? (
            <span className="pkg-meta">drafted from the script &amp; series rules · ▾ adds guidance</span>
          ) : null}
        </div>
        {metaGen === 'ready' ? (
          <div className="pkg-fields">
            <label className="st-field">
              <span>Video title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="st-field">
              <span>Description</span>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} />
            </label>
          </div>
        ) : null}
      </section>

      <section className="pkg-section">
        <span className="eyebrow">Thumbnail</span>
        <div className="pkg-gen-row">
          <FeedbackButton
            label={thumb.versions.length ? 'Re-generate thumbnails' : 'Generate thumbnails'}
            busy={thumb.gen === 'working'}
            busyLabel="Generating…"
            title="Renders one cover candidate per drafted concept — uses image-model credits"
            placeholder="Optional guidance applied to every candidate — e.g. “use the whiteboard scene”, “big readable text”…"
            onRun={generateThumbs}
          />
          <label className="pkg-count">
            <select value={thumbCount} onChange={(e) => setThumbCount(Number(e.target.value))} disabled={thumb.gen === 'working'}>
              {Array.from({ length: MAX_THUMBS }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            candidates
          </label>
          {thumb.gen !== 'ready' ? (
            <span className="pkg-meta">one image per drafted concept · accurate + attention-grabbing per series rules</span>
          ) : null}
        </div>
        {thumb.versions.length ? (
          <>
            <div className="s1-style-grid pkg-thumbs">
              {thumb.versions.map((version) => (
                <Pill
                  key={version}
                  className="thumb-pill wide"
                  selected={thumb.chosen === version}
                  disabled={thumb.finalizing != null}
                  onClick={() => setPreviewVersion(version)}
                >
                  <span className="preview">
                    <img src={`${contentUrl(thumbOptionPath(version))}&v=${thumb.bust}`} alt="" />
                  </span>
                  <span className="name">
                    {thumb.finalizing === version
                      ? 'Setting cover…'
                      : `Candidate v${version}${thumb.chosen === version ? ' · cover' : ''}`}
                  </span>
                </Pill>
              ))}
            </div>
            <p className="pkg-note">
              {thumb.cover
                ? `Cover set: ${activeSession()}-thumbnail.png — click a candidate to view it full-size or change the cover.`
                : 'Click a candidate to view it full-size and set it as the cover.'}
            </p>
          </>
        ) : null}
        {previewVersion != null ? (
          <div className="modal-scrim" onClick={(e) => { if (e.target === e.currentTarget) setPreviewVersion(null) }}>
            <div className="confirm-modal pkg-thumb-modal">
              <img
                src={`${contentUrl(thumbOptionPath(previewVersion))}&v=${thumb.bust}`}
                alt={`Thumbnail candidate v${previewVersion} at full size`}
              />
              <div className="actions">
                <span className="pkg-meta">candidate v{previewVersion} · 1920×1080</span>
                <span style={{ flex: 1 }} />
                <button onClick={() => setPreviewVersion(null)}>Close</button>
                <button className="primary" disabled={thumb.finalizing != null} onClick={() => chooseCover(previewVersion)}>
                  {thumb.chosen === previewVersion ? 'Already the cover' : 'Use as cover'}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </section>

      {/* EXPORT FOR EDITOR — hidden for now: the FCPXML/bundle exports are a
          real backend capability (ROADMAP item 9's editor hand-off), and mock
          buttons here add noise. Bring the section back with that work. */}
    </div>
  )
}

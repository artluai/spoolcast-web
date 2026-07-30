import { useEffect, useRef, useState } from 'react'
import { Pill } from '../../components/common/Pill'
import { activeSession, contentUrl, downloadUrl, fileUrl, getFileJson, getJson, postAction, seriesUrl, urlOk } from '../../lib/api'
import { useWorkflowStore } from '../../store/workflow'
import { DEFAULT_MODEL_ID, draftReasoning } from '../../lib/draft-models'
import { RulesPanel } from './RulesPanel'

// Advanced generation options: what else to draft and where the video ships.
// These become draft_video_meta CLI flags; the drafted extras come back in
// working/video-meta.json alongside title/description.
const PLATFORMS = [
  { id: 'youtube', label: 'YouTube' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'x', label: 'X' },
] as const

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
type VideoMeta = {
  title?: string
  description?: string
  synopsis?: string
  tags?: string[]
  target_platforms?: string[]
  platforms?: Record<string, { title?: string; description?: string }>
  thumbnail_prompt?: string
  thumbnail_prompts?: string[]
}
type ThumbState = {
  gen: GenState
  versions: number[] // candidate versions found on disk (1-based)
  chosen: number | null // version finalized as the cover this session
  cover: boolean // canonical cover file exists
  finalizing: number | null
  bust: number // cache-buster for candidate images after a re-generate
}
type PublishSessionConfig = {
  series?: string
  series_title?: string
  series_description?: string
  episode?: number | string
  episode_number?: number | string
}
type SeriesDefaults = {
  name?: string
  description?: string
}

const MULTIPART_THRESHOLD = 90 * 1024 * 1024
const MULTIPART_PART_SIZE = 8 * 1024 * 1024

const videoShape = (blob: Blob) => new Promise<{ duration: number; width: number; height: number }>((resolve, reject) => {
  const video = document.createElement('video')
  const objectUrl = URL.createObjectURL(blob)
  const cleanup = () => {
    URL.revokeObjectURL(objectUrl)
    video.removeAttribute('src')
  }
  video.preload = 'metadata'
  video.onloadedmetadata = () => {
    const shape = {
      duration: video.duration,
      width: video.videoWidth,
      height: video.videoHeight,
    }
    cleanup()
    if (!Number.isFinite(shape.duration) || shape.duration <= 0 || !shape.width || !shape.height) {
      reject(new Error('Could not read the finished render’s duration and dimensions.'))
      return
    }
    resolve(shape)
  }
  video.onerror = () => {
    cleanup()
    reject(new Error('Could not read the finished render’s duration and dimensions.'))
  }
  video.src = objectUrl
})

const publishMetadata = (
  poster: Blob,
  shape: { duration: number; width: number; height: number },
) => {
  const form = new FormData()
  form.append('poster', poster, `${activeSession()}-thumbnail.png`)
  form.append('duration_s', String(shape.duration))
  form.append('width', String(shape.width))
  form.append('height', String(shape.height))
  return form
}

const responseJson = async (response: Response) => {
  const out = await response.json().catch(() => null)
  if (!response.ok || !out?.ok) {
    throw new Error(out?.data?.error || 'The site did not accept the upload.')
  }
  return out
}

const publishLargeVideo = async (
  video: Blob,
  poster: Blob,
  shape: { duration: number; width: number; height: number },
  query: URLSearchParams,
) => {
  const multipartQuery = new URLSearchParams(query)
  multipartQuery.set('content_type', video.type || 'video/mp4')
  let uploadId = ''
  try {
    const started = await responseJson(await fetch(
      `/api/publish/video/multipart/start?${multipartQuery}`,
      { method: 'POST' },
    ))
    uploadId = started.data.upload_id
    const parts: Array<{ partNumber: number; etag: string }> = []
    for (let offset = 0, partNumber = 1; offset < video.size; offset += MULTIPART_PART_SIZE, partNumber += 1) {
      const partQuery = new URLSearchParams(multipartQuery)
      partQuery.set('upload_id', uploadId)
      partQuery.set('part_number', String(partNumber))
      const uploaded = await responseJson(await fetch(
        `/api/publish/video/multipart/part?${partQuery}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: video.slice(offset, offset + MULTIPART_PART_SIZE),
        },
      ))
      parts.push(uploaded.data)
    }
    const completeQuery = new URLSearchParams(multipartQuery)
    completeQuery.set('upload_id', uploadId)
    const form = publishMetadata(poster, shape)
    form.append('parts', JSON.stringify(parts))
    return await responseJson(await fetch(
      `/api/publish/video/multipart/complete?${completeQuery}`,
      { method: 'POST', body: form },
    ))
  } catch (error) {
    if (uploadId) {
      const abortQuery = new URLSearchParams(multipartQuery)
      abortQuery.set('upload_id', uploadId)
      await fetch(`/api/publish/video/multipart/abort?${abortQuery}`, { method: 'POST' }).catch(() => null)
    }
    throw error
  }
}

export function PackagePublishStage({
  stageId,
  onToast,
}: {
  stageId: string
  onToast: (message: string) => void
}) {
  const registerStepAIAction = useWorkflowStore((s) => s.registerStepAIAction)
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
  const [metaModel] = useState(DEFAULT_MODEL_ID)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [synopsis, setSynopsis] = useState('')
  const [tags, setTags] = useState('')
  const [platformMeta, setPlatformMeta] = useState<Record<string, { title?: string; description?: string }>>({})
  // Advanced generation options (persisted per browser — they describe the
  // user's publishing habits, not one video).
  const [advOpen, setAdvOpen] = useState(false)
  const [wantSynopsis, setWantSynopsis] = useState(() => localStorage.getItem('pkgAdvSynopsis') === '1')
  const [wantTags, setWantTags] = useState(() => localStorage.getItem('pkgAdvTags') === '1')
  const [targets, setTargets] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('pkgAdvTargets') || '[]') } catch { return [] }
  })
  const [perPlatform, setPerPlatform] = useState(() => localStorage.getItem('pkgAdvPerPlatform') === '1')
  useEffect(() => {
    localStorage.setItem('pkgAdvSynopsis', wantSynopsis ? '1' : '0')
    localStorage.setItem('pkgAdvTags', wantTags ? '1' : '0')
    localStorage.setItem('pkgAdvTargets', JSON.stringify(targets))
    localStorage.setItem('pkgAdvPerPlatform', perPlatform ? '1' : '0')
  }, [wantSynopsis, wantTags, targets, perPlatform])
  const [thumb, setThumb] = useState<ThumbState>({ gen: 'idle', versions: [], chosen: null, cover: false, finalizing: null, bust: 0 })
  const [thumbCount, setThumbCount] = useState(3)
  const hasMetaRef = useRef(false)
  const applyMeta = (meta: VideoMeta) => {
    setTitle(meta.title || '')
    setDescription(meta.description || '')
    setSynopsis(meta.synopsis || '')
    setTags((meta.tags || []).join(', '))
    setPlatformMeta(meta.platforms || {})
    hasMetaRef.current = true
    setMetaGen('ready')
  }
  const loadMeta = async (announce: boolean) => {
    const meta = await getFileJson<VideoMeta>(META_PATH)
    if (!meta?.title) return false
    applyMeta(meta)
    if (announce) onToast('Title & description drafted from the script — edit freely.')
    return true
  }
  // A previous visit may already have drafted metadata / candidates / a cover —
  // pick them all up.
  useEffect(() => {
    let alive = true
    getFileJson<VideoMeta>(META_PATH).then((meta) => {
      if (!alive || !meta?.title) return
      applyMeta(meta)
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
  const generateMeta = (guidance: string, requestedModel = metaModel) => {
    setMetaGen('working')
    const extrasList = [...(wantSynopsis ? ['synopsis'] : []), ...(wantTags ? ['tags'] : [])]
    const extra = [
      '--model', requestedModel,
      ...(draftReasoning(requestedModel) ? ['--reasoning', draftReasoning(requestedModel)!] : []),
      ...(guidance.trim() ? ['--guidance', guidance.trim()] : []),
      ...(extrasList.length ? ['--extras', extrasList.join(',')] : []),
      ...(targets.length ? ['--platforms', targets.join(',')] : []),
      ...(targets.length && perPlatform ? ['--per-platform'] : []),
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

  // PUBLISH TO SPOOLCAST: push the finished render to the signed-in account's
  // creator page via the site API (/api/publish/video). Works when the editor
  // is served from the site origin (pages dev / production); under plain vite
  // the API isn't there and the button reports that instead of pretending.
  const [pubState, setPubState] = useState<'idle' | 'working' | 'done'>('idle')
  const [pubPublic, setPubPublic] = useState(false)
  const [pubNote, setPubNote] = useState('')
  const publishToSite = async () => {
    if (!title.trim()) {
      onToast('Draft or type a title first — the site listing needs one.')
      return
    }
    setPubState('working')
    setPubNote('')
    try {
      const me = await fetch('/api/auth/me').then((r) => (r.ok ? r.json() : null)).catch(() => null)
      if (!me?.data?.user) throw new Error('Sign in on the site first (avatar in the header).')
      const [videoResponse, posterResponse, cfg] = await Promise.all([
        fetch(downloadUrl(`renders/${activeSession()}-1.0x.mp4`)),
        fetch(downloadUrl(thumbPath())),
        getFileJson<PublishSessionConfig>('session.json'),
      ])
      if (!videoResponse.ok) throw new Error('Could not read the finished render from the engine.')
      if (!posterResponse.ok) throw new Error('Choose a thumbnail first — the published video needs a poster.')
      const video = await videoResponse.blob()
      const poster = await posterResponse.blob()
      const shape = await videoShape(video)
      const series = String(cfg?.series || '').trim()
      const seriesOut = series
        ? await getJson<{ data?: { defaults_json?: string | null } }>(seriesUrl(series))
        : null
      let seriesDefaults: SeriesDefaults = {}
      try {
        seriesDefaults = JSON.parse(seriesOut?.data?.defaults_json || '{}') as SeriesDefaults
      } catch {
        seriesDefaults = {}
      }
      const rawEpisode = cfg?.episode ?? cfg?.episode_number
      const episode = Number(rawEpisode)
      const hasEpisode = Number.isInteger(episode) && episode > 0
      const seriesTitle = String(cfg?.series_title || seriesDefaults.name || '').trim()
      const seriesDescription = String(
        cfg?.series_description || seriesDefaults.description || '',
      ).trim()
      const query = new URLSearchParams({
        slug: activeSession(),
        title: title.trim(),
        description,
        public: pubPublic ? '1' : '0',
        ...(hasEpisode ? { episode: String(episode) } : {}),
        ...(series ? {
          series,
          series_title: seriesTitle || series.replace(/-/g, ' '),
          ...(seriesDescription ? { series_description: seriesDescription } : {}),
        } : {}),
      })
      let out
      if (video.size > MULTIPART_THRESHOLD) {
        out = await publishLargeVideo(video, poster, shape, query)
      } else {
        const form = publishMetadata(poster, shape)
        form.append('video', video, `${activeSession()}-1.0x.mp4`)
        out = await responseJson(await fetch(`/api/publish/video?${query}`, {
          method: 'POST',
          body: form,
        }))
      }
      setPubState('done')
      setPubNote(`Live at ${out.data.url}${out.data.public ? '' : ' (private — flip it public any time)'}`)
      onToast('Published to your Spoolcast page.')
    } catch (error) {
      setPubState('idle')
      setPubNote(error instanceof Error ? error.message : 'Publishing failed.')
    }
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

  useEffect(() => {
    const hasMeta = Boolean(title.trim())
    const hasThumbs = thumb.versions.length > 0
    registerStepAIAction(stageId, {
      stageId,
      label: !hasMeta
        ? 'Complete step with AI'
        : !hasThumbs
          ? 'Generate thumbnails with AI'
          : 'Publishing assets ready',
      busy: metaGen === 'working' || thumb.gen === 'working',
      disabled: hasThumbs,
      disabledReason: hasThumbs
        ? 'Review the generated details and choose a cover'
        : undefined,
      usesTextModel: !hasMeta,
      acceptsInstructions: true,
      run: ({ instructions, model }) => {
        if (!hasMeta) generateMeta(instructions, model)
        else generateThumbs(instructions)
      },
    })
    return () => registerStepAIAction(stageId, null)
    // The shared action advances the package in order: metadata first, then
    // cover candidates. Captions remain their explicit local utility.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    metaGen,
    registerStepAIAction,
    stageId,
    thumb.gen,
    thumb.versions.length,
    title,
  ])

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
          <button type="button" disabled={metaGen === 'working'} onClick={() => generateMeta('')}>
            {metaGen === 'working'
              ? (<><span className="spin" /> Drafting…</>)
              : metaGen === 'ready' ? '✦ Regenerate title & description' : '✦ Generate title & description'}
          </button>
          <span className="pkg-meta">drafted from the script, series rules, and the rules below</span>
        </div>
        {/* ADVANCED: what else gets drafted and where the video ships. The
            choices feed the next generation run, not the saved file. */}
        <button
          type="button"
          className="utility-disclosure-toggle"
          aria-expanded={advOpen}
          onClick={() => setAdvOpen((v) => !v)}
        >
          <span>{advOpen ? '▾' : '▸'}</span> ADVANCED — extras &amp; platforms
        </button>
        {advOpen ? (
          <div className="pkg-advanced">
            <label className="pkg-check">
              <input type="checkbox" checked={wantSynopsis} onChange={(e) => setWantSynopsis(e.target.checked)} />
              Also generate a synopsis
            </label>
            <label className="pkg-check">
              <input type="checkbox" checked={wantTags} onChange={(e) => setWantTags(e.target.checked)} />
              Also generate search tags
            </label>
            <div className="pkg-platforms">
              <span className="pkg-meta">Ships to:</span>
              {PLATFORMS.map((p) => (
                <label className="pkg-check" key={p.id}>
                  <input
                    type="checkbox"
                    checked={targets.includes(p.id)}
                    onChange={(e) =>
                      setTargets((cur) => (e.target.checked ? [...cur, p.id] : cur.filter((t) => t !== p.id)))
                    }
                  />
                  {p.label}
                </label>
              ))}
            </div>
            <label className="pkg-check" title="Draft a separate title and description tuned to each checked platform">
              <input
                type="checkbox"
                checked={perPlatform}
                disabled={!targets.length}
                onChange={(e) => setPerPlatform(e.target.checked)}
              />
              Separate text per platform
            </label>
          </div>
        ) : null}
        <RulesPanel
          step="package_widescreen"
          forAction="draft_video_meta"
          addToken="packaging-copy"
          title="RULES FOR TITLE & DESCRIPTION"
          onToast={onToast}
        />
        {/* The prose rulebooks are separate inputs the drafter also obeys —
            named here so nobody hunts for why output follows unseen rules. */}
        <p className="pkg-rulebooks">
          Also applies: <b>Global</b> rulebook SHIPPING.md “Packaging” (read-only) ·{' '}
          <b>Series</b> rulebook “Packaging” section (edit in Show settings) — the series
          section wins where they overlap.
        </p>
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
            {synopsis ? (
              <label className="st-field">
                <span>Synopsis</span>
                <textarea value={synopsis} onChange={(e) => setSynopsis(e.target.value)} rows={3} />
              </label>
            ) : null}
            {tags ? (
              <label className="st-field">
                <span>Tags</span>
                <input value={tags} onChange={(e) => setTags(e.target.value)} />
              </label>
            ) : null}
            {Object.entries(platformMeta).map(([pid, m]) => (
              <div className="pkg-platform-block" key={pid}>
                <span className="eyebrow">{PLATFORMS.find((p) => p.id === pid)?.label ?? pid}</span>
                <label className="st-field">
                  <span>Title</span>
                  <input
                    value={m.title || ''}
                    onChange={(e) => setPlatformMeta((cur) => ({ ...cur, [pid]: { ...cur[pid], title: e.target.value } }))}
                  />
                </label>
                <label className="st-field">
                  <span>Description</span>
                  <textarea
                    value={m.description || ''}
                    rows={3}
                    onChange={(e) => setPlatformMeta((cur) => ({ ...cur, [pid]: { ...cur[pid], description: e.target.value } }))}
                  />
                </label>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="pkg-section">
        <span className="eyebrow">Thumbnail</span>
        <div className="pkg-gen-row">
          <button type="button" disabled={thumb.gen === 'working'} onClick={() => generateThumbs('')}>
            {thumb.gen === 'working'
              ? (<><span className="spin" /> Generating…</>)
              : thumb.versions.length ? '✦ Regenerate thumbnails' : '✦ Generate thumbnails'}
          </button>
          <label className="pkg-count">
            <select className="sc-select" value={thumbCount} onChange={(e) => setThumbCount(Number(e.target.value))} disabled={thumb.gen === 'working'}>
              {Array.from({ length: MAX_THUMBS }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            candidates
          </label>
          {thumb.gen !== 'ready' ? (
            <span className="pkg-meta">one image per drafted concept</span>
          ) : null}
        </div>
        <RulesPanel
          step="package_widescreen"
          forAction="generate_thumbnails"
          addToken="thumbnail"
          title="RULES FOR THUMBNAILS"
          onToast={onToast}
        />
        <p className="pkg-rulebooks">
          Also applies: <b>Global</b> thumbnail rules in SHIPPING.md (read-only) ·{' '}
          <b>Series</b> visual language from its “Packaging” section.
        </p>
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

      <section className="pkg-section">
        <span className="eyebrow">Publish to Spoolcast</span>
        <div className="pkg-actions">
          <label className="pkg-check">
            <input type="checkbox" checked={pubPublic} onChange={(e) => setPubPublic(e.target.checked)} />
            Public on my page
          </label>
          <button type="button" disabled={pubState === 'working'} onClick={() => void publishToSite()}>
            {pubState === 'working' ? (<><span className="spin" /> Uploading…</>) : pubState === 'done' ? 'Publish again' : 'Publish'}
          </button>
          <span className="pkg-meta">
            {pubNote || 'Uploads the finished render to your creator page under your account.'}
          </span>
        </div>
      </section>

      {/* EXPORT FOR EDITOR — hidden for now: the FCPXML/bundle exports are a
          real backend capability (ROADMAP item 9's editor hand-off), and mock
          buttons here add noise. Bring the section back with that work. */}
    </div>
  )
}

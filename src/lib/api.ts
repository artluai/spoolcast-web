// The single seam between the front-end and the engine/back-end.
//
// Everything that talks to the server should resolve URLs and identity through
// here, so that moving from "local engine on :8000" to a real deployed backend
// (and later: object-storage/CDN media, low-quality preview proxies, multi-tenant
// per-user sessions) is a configuration change — not a refactor across dozens of
// call sites.
//
// Defaults reproduce today's local-dev behavior EXACTLY. Production uses the
// signed-in, same-origin Pages proxy so the Railway bearer token never reaches
// browser JavaScript. Override per environment only when deliberately needed:
//   VITE_API_BASE      = https://api.yourhost.com/api
//   VITE_SESSION       = <session id>   (dev fallback only — the real session
//                                        comes from the /p/:id route)
//   VITE_TENANT        = <tenant>
//   VITE_MEDIA_PREVIEW = 1                        (request LQ preview proxies)
//
// The migration is COMPLETE: no file outside this one may build an engine URL
// by hand or name a session id. New server calls import from here, always.

const env = import.meta.env as Record<string, string | undefined>

export const API_BASE = (
  env.VITE_API_BASE
  ?? (import.meta.env.PROD ? '/api/engine' : 'http://localhost:8000/api')
).replace(/\/+$/, '')

// Identity. The active session comes from the ROUTE (/p/:id) — the workflow
// shell calls setActiveSession() on entry, before any session-scoped fetch.
// '/p/new' (the mock blank flow) has NO engine session: helpers emit
// session-less requests the engine politely rejects, so the blank flow can
// never read from — or worse, write into — a real project. VITE_SESSION
// survives only as a dev fallback for code paths outside a session route.
const DEFAULT_SESSION = env.VITE_SESSION ?? 'spoolcast-dev-log-12'
let ACTIVE_SESSION = DEFAULT_SESSION
export function setActiveSession(id: string | null | undefined): void {
  ACTIVE_SESSION = id === 'new' ? '' : (id ?? DEFAULT_SESSION)
}
export function activeSession(): string {
  return ACTIVE_SESSION
}
export const TENANT = env.VITE_TENANT ?? 'local'
export type RenderLocation = 'local' | 'cloud'

// When the backend can serve low-quality preview proxies, flip this on; the preview
// player then requests the lighter feed while full-quality stays available for
// download/export. Off by default so today's requests are byte-for-byte unchanged.
const MEDIA_PREVIEW_ENABLED = env.VITE_MEDIA_PREVIEW === '1'

type QueryValue = string | number | boolean | undefined | null
const queryString = (params: Record<string, QueryValue>) =>
  Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join('&')

/** Build an absolute engine URL: `${API_BASE}/<path>?<params>`. */
export const apiUrl = (path: string, params: Record<string, QueryValue> = {}) => {
  const query = queryString(params)
  return `${API_BASE}/${path.replace(/^\/+/, '')}${query ? `?${query}` : ''}`
}

/** A session-scoped working file (returns the `{ ok, data: { content } }` envelope). */
export const fileUrl = (path: string, session = activeSession()) => apiUrl('file', { session, path })

/** Session status. */
export const statusUrl = (session = activeSession()) => apiUrl('status', { session, tenant: TENANT })
/** Current/previous audited render receipts for this session. */
export const renderInfoUrl = (session = activeSession()) => apiUrl('render-info', { session })

/** Short work goes here; long or paid work goes through {@link jobsUrl}. */
export const actionUrl = () => apiUrl('action')
export const jobsUrl = (jobId?: string) => (jobId ? apiUrl(`jobs/${jobId}`) : apiUrl('jobs'))
export const researchJobStorageKey = (session = activeSession()) => `spoolcast:research-job:${session}`
export const SESSION_CONFIGURATION_CHANGED = 'spoolcast:session-configuration-changed'

/** Tell mounted session views to re-read session.json and the engine contract.
 *  The event carries no copied configuration: the engine remains the truth. */
export function notifySessionConfigurationChanged(session = activeSession()): void {
  window.dispatchEvent(new CustomEvent(SESSION_CONFIGURATION_CHANGED, {
    detail: { session },
  }))
}

// Entry spine: the real project list, the template registry, and the session's
// contract — the workflow builds its steps from THIS, not a bundled mirror.
export const sessionsUrl = () => apiUrl('sessions')
export const seriesUrl = (series?: string) => apiUrl('series', { series })
export const templatesUrl = () => apiUrl('templates')
export const contractUrl = (session = activeSession()) => apiUrl('contract', { session })

/** Raw byte download of a session file (e.g. exported xlsx, narration audio). */
export const downloadUrl = (path: string, session = activeSession()) => apiUrl('download', { session, path })

// Media variant is INTENT, not behavior (yet): the preview player asks for
// 'preview', export/download asks for 'full'. Today both resolve identically; once
// the backend serves LQ proxies (and Range-capable CDN media) only this mapping
// changes, because every call site is already labeled with what it actually needs.
export type MediaVariant = 'full' | 'preview'

/** URL for a piece of media owned by a specific session. */
export const sessionContentUrl = (
  sessionRelPath: string,
  session: string,
  variant: MediaVariant = 'full',
) => {
  const clean = sessionRelPath.trim().replace(/^\/+/, '')
  if (!clean) return ''
  const wantsPreview = MEDIA_PREVIEW_ENABLED && variant === 'preview'
  return apiUrl('content', {
    path: `sessions/${session}/${clean}`,
    quality: wantsPreview ? 'preview' : undefined,
  })
}

/** URL for a piece of media in the active session. */
export const contentUrl = (sessionRelPath: string, variant: MediaVariant = 'full') =>
  sessionContentUrl(sessionRelPath, activeSession(), variant)

/** URL for a GLOBAL library asset (content-root relative, e.g.
 *  `global/characters/mika/portrait.png`). Global assets live outside any
 *  session, so unlike `contentUrl` the path is NOT session-prefixed. */
export const globalContentUrl = (contentRelPath: string) => {
  const clean = contentRelPath.trim().replace(/^\/+/, '')
  if (!clean) return ''
  return apiUrl('content', { path: clean })
}

/** Narration audio for a chunk. */
export const audioUrl = (chunkId: string) => downloadUrl(`source/audio/${chunkId}.mp3`)

/** POST an engine action (short work; long or paid work goes through jobs).
 *  Session/tenant are filled in; pass `action` plus any action-specific fields.
 *  Returns the parsed response envelope, or null when the engine is unreachable. */
export async function postAction<T = unknown>(
  body: Record<string, unknown>,
): Promise<{ ok?: boolean; data?: T; error?: string; message?: string; details?: string } | null> {
  try {
    const res = await fetch(actionUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: activeSession(), tenant: TENANT, ...body }),
    })
    return (await res.json()) as { ok?: boolean; data?: T; error?: string; message?: string; details?: string }
  } catch {
    return null
  }
}

type ActionResponse<T> = {
  ok?: boolean
  data?: T
  error?: string
  message?: string
  details?: string
}

export type FanoutManifestItem = {
  session_id: string
  episode_number: number
  brief: string
}

export type FanoutPlan = {
  manifest: FanoutManifestItem[]
  manifest_hash: string
  existing: string[]
  warnings: string[]
}

/** Ask the engine to derive the exact no-write fan-out manifest from the
 * approved season plan. This show-level action deliberately names no session. */
export async function planFanOut(
  showId: string,
  season: number,
): Promise<ActionResponse<FanoutPlan> | null> {
  try {
    const res = await fetch(actionUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'plan_fan_out',
        show_id: showId,
        season,
      }),
    })
    return (await res.json()) as ActionResponse<FanoutPlan>
  } catch {
    return null
  }
}

/** The admin's global render choice, readable by every signed-in creator.
 * Failure is deliberately local-first so today's single-machine flow stays
 * unchanged when the hosted proxy is absent. */
export async function adminRenderLocation(): Promise<RenderLocation> {
  try {
    const res = await fetch(apiUrl('render-location'), { cache: 'no-store' })
    if (!res.ok) return 'local'
    const out = (await res.json()) as { data?: { location?: RenderLocation } }
    return out.data?.location === 'cloud' ? 'cloud' : 'local'
  } catch {
    return 'local'
  }
}

/** Start final rendering on the selected target. In production postAction()
 * already goes through the signed-in Pages proxy; only the admin controls the
 * global location setting. */
export async function postRenderAction<T = unknown>(
  location: RenderLocation,
  body: Record<string, unknown>,
): Promise<ActionResponse<T> | null> {
  if (location === 'local') return postAction<T>(body)
  return postAction<T>(body)
}

export const renderTargetFileUrl = (
  _location: RenderLocation,
  path: string,
  session = activeSession(),
) => fileUrl(path, session)

export const renderTargetInfoUrl = (
  _location: RenderLocation,
  session = activeSession(),
) => renderInfoUrl(session)

export const renderTargetDownloadUrl = (
  _location: RenderLocation,
  path: string,
  session = activeSession(),
) => downloadUrl(path, session)

/** Upload the user's own take (raw bytes, no base64 — videos are tens of MB)
 *  straight into a shot's active media slot. `shot` is the PERMANENT shot id;
 *  the engine archives the slot's current take to history first. */
export async function uploadTake(
  shot: string,
  file: File,
): Promise<{ ok?: boolean; data?: { path?: string; kind?: string }; error?: string } | null> {
  try {
    const res = await fetch(apiUrl('upload-take', { session: activeSession(), shot, filename: file.name }), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    })
    return (await res.json()) as { ok?: boolean; data?: { path?: string; kind?: string }; error?: string }
  } catch {
    return null
  }
}

/** Add a local image/video to the Final Cut Workspace without placing it. */
export async function uploadFinalCutAsset(
  file: File,
): Promise<{
  ok?: boolean
  data?: { final_cut?: unknown; asset?: { id?: string } }
  error?: string
} | null> {
  try {
    const res = await fetch(apiUrl('upload-final-cut-asset', {
      session: activeSession(),
      filename: file.name,
    }), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    })
    return (await res.json()) as {
      ok?: boolean
      data?: { final_cut?: unknown; asset?: { id?: string } }
      error?: string
    }
  } catch {
    return null
  }
}

/** Existence probe: does a GET of this URL succeed? (body discarded) */
export async function urlOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { cache: 'no-store' })
    return res.ok
  } catch {
    return false
  }
}

/** GET JSON, returning null on any failure. */
export async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url)
    return res.ok ? ((await res.json()) as T) : null
  } catch {
    return null
  }
}

/** Read a working file and parse its JSON content (the `{ ok, data: { content } }` envelope). */
export async function getFileJson<T>(path: string, session = activeSession()): Promise<T | null> {
  const out = await getJson<{ ok?: boolean; data?: { content?: string } }>(fileUrl(path, session))
  if (!out?.ok || !out.data?.content) return null
  try {
    return JSON.parse(out.data.content) as T
  } catch {
    return null
  }
}

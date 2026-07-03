// The single seam between the front-end and the engine/back-end.
//
// Everything that talks to the server should resolve URLs and identity through
// here, so that moving from "local engine on :8000" to a real deployed backend
// (and later: object-storage/CDN media, low-quality preview proxies, multi-tenant
// per-user sessions) is a configuration change — not a refactor across dozens of
// call sites.
//
// Defaults reproduce today's local-dev behavior EXACTLY. Override per environment
// with Vite env vars (e.g. a `.env.production` or the host's env):
//   VITE_API_BASE      = https://api.yourhost.com/api
//   VITE_SESSION       = <session id>            (until sessions come from auth)
//   VITE_TENANT        = <tenant>
//   VITE_MEDIA_PREVIEW = 1                        (request LQ preview proxies)
//
// Migration is opportunistic: new code imports from here; existing hardcoded
// `http://localhost:8000/...` calls get migrated when a file is next touched.

const env = import.meta.env as Record<string, string | undefined>

export const API_BASE = (env.VITE_API_BASE ?? 'http://localhost:8000/api').replace(/\/+$/, '')

// Identity. Today a single local session; later this becomes a per-user / per-project
// value sourced from auth/context. Centralized so that change happens in one place.
export const SESSION = env.VITE_SESSION ?? 'spoolcast-dev-log-12'
export const TENANT = env.VITE_TENANT ?? 'local'

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
export const fileUrl = (path: string, session = SESSION) => apiUrl('file', { session, path })

/** Session status. */
export const statusUrl = (session = SESSION) => apiUrl('status', { session, tenant: TENANT })

/** Short work goes here; long or paid work goes through {@link jobsUrl}. */
export const actionUrl = () => apiUrl('action')
export const jobsUrl = (jobId?: string) => (jobId ? apiUrl(`jobs/${jobId}`) : apiUrl('jobs'))

/** Raw byte download of a session file (e.g. exported xlsx, narration audio). */
export const downloadUrl = (path: string, session = SESSION) => apiUrl('download', { session, path })

// Media variant is INTENT, not behavior (yet): the preview player asks for
// 'preview', export/download asks for 'full'. Today both resolve identically; once
// the backend serves LQ proxies (and Range-capable CDN media) only this mapping
// changes, because every call site is already labeled with what it actually needs.
export type MediaVariant = 'full' | 'preview'

/** URL for a piece of session media (relative to the session's content root). */
export const contentUrl = (sessionRelPath: string, variant: MediaVariant = 'full') => {
  const clean = sessionRelPath.trim().replace(/^\/+/, '')
  if (!clean) return ''
  const wantsPreview = MEDIA_PREVIEW_ENABLED && variant === 'preview'
  return apiUrl('content', {
    path: `sessions/${SESSION}/${clean}`,
    quality: wantsPreview ? 'preview' : undefined,
  })
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
      body: JSON.stringify({ session: SESSION, tenant: TENANT, ...body }),
    })
    return (await res.json()) as { ok?: boolean; data?: T; error?: string; message?: string; details?: string }
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
export async function getFileJson<T>(path: string, session = SESSION): Promise<T | null> {
  const out = await getJson<{ ok?: boolean; data?: { content?: string } }>(fileUrl(path, session))
  if (!out?.ok || !out.data?.content) return null
  try {
    return JSON.parse(out.data.content) as T
  } catch {
    return null
  }
}

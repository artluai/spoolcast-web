const encoder = new TextEncoder()

const PRIVATE_TTL_SECONDS = 10 * 60
const PUBLIC_TTL_SECONDS = 60 * 60

const signingSecret = (env) => String(env.MEDIA_SIGNING_SECRET || '').trim()

const signingKey = async (env, usage) => {
  const secret = signingSecret(env)
  if (!secret) throw new Error('MEDIA_SIGNING_SECRET is not configured')
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  )
}

const bytesToHex = (bytes) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

const hexToBytes = (hex) => {
  if (!/^[a-f0-9]{64}$/.test(hex)) return null
  return Uint8Array.from(hex.match(/.{2}/g), (byte) => Number.parseInt(byte, 16))
}

const payload = (key, expires) => `v1\nvideos\n${expires}\n${key}`

export const signedVideoUrl = async (env, key, isPublic = false, now = Date.now()) => {
  if (!key) return ''
  const expires = Math.floor(now / 1000) + (isPublic ? PUBLIC_TTL_SECONDS : PRIVATE_TTL_SECONDS)
  const keyObject = await signingKey(env, 'sign')
  const signature = bytesToHex(
    await crypto.subtle.sign('HMAC', keyObject, encoder.encode(payload(key, expires))),
  )
  const query = new URLSearchParams({ key, expires: String(expires), signature })
  return `/api/site/media?${query}`
}

export const verifiedVideoKey = async (env, request, now = Date.now()) => {
  const url = new URL(request.url)
  const key = url.searchParams.get('key') || ''
  const expiresText = url.searchParams.get('expires') || ''
  const signature = hexToBytes(url.searchParams.get('signature') || '')
  const expires = Number(expiresText)
  if (
    !key.startsWith('videos/') ||
    key.includes('..') ||
    !Number.isSafeInteger(expires) ||
    expires <= Math.floor(now / 1000) ||
    !signature
  ) {
    return ''
  }
  const keyObject = await signingKey(env, 'verify')
  const valid = await crypto.subtle.verify(
    'HMAC',
    keyObject,
    signature,
    encoder.encode(payload(key, expires)),
  )
  return valid ? key : ''
}

const rangedHeaders = (object, request) => {
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('Accept-Ranges', 'bytes')
  headers.set('ETag', object.httpEtag)
  headers.set('Cache-Control', 'private, no-store')
  if (request.headers.has('Range') && object.range) {
    const offset = object.range.offset || 0
    const length = object.range.length || object.size
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`)
    headers.set('Content-Length', String(length))
  } else {
    headers.set('Content-Length', String(object.size))
  }
  return headers
}

export const serveSignedVideo = async (env, request) => {
  let key
  try {
    key = await verifiedVideoKey(env, request)
  } catch {
    return new Response('Media signing is unavailable.', {
      status: 503,
      headers: { 'Cache-Control': 'private, no-store' },
    })
  }
  if (!key) {
    return new Response('Not found.', {
      status: 404,
      headers: { 'Cache-Control': 'private, no-store' },
    })
  }

  let object
  try {
    object = await env.VIDEOS.get(key, {
      onlyIf: request.headers,
      range: request.headers,
    })
  } catch {
    return new Response('Requested range is not satisfiable.', {
      status: 416,
      headers: { 'Cache-Control': 'private, no-store' },
    })
  }
  if (!object) return new Response('Not found.', { status: 404 })
  const hasBody = 'body' in object
  return new Response(hasBody ? object.body : undefined, {
    status: hasBody ? (request.headers.has('Range') ? 206 : 200) : 412,
    headers: rangedHeaders(object, request),
  })
}

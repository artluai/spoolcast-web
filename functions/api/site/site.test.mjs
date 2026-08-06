import assert from 'node:assert/strict'
import test from 'node:test'

import { signedVideoUrl, verifiedVideoKey } from '../_media.js'
import { onRequestGet } from './[[path]].js'

const video = {
  id: 12,
  creator_id: 3,
  series_id: null,
  slug: 'private-video',
  title: 'Private video',
  r2_key: 'videos/owner/videos/private-video.mp4',
  poster_key: 'videos/owner/videos/private-video-poster.jpg',
  public: 0,
}
const creator = { id: 3, user_id: 7, handle: 'owner', name: 'Owner' }
const user = { id: 7, email: 'owner@example.com' }

const database = () => ({
  prepare(sql) {
    return {
      bind() {
        return this
      },
      async first() {
        if (sql.includes('FROM videos WHERE slug')) return video
        if (sql.includes('FROM creators WHERE id')) return creator
        if (sql.includes('FROM web_sessions')) return user
        return null
      },
    }
  },
})

const objectStore = () => {
  const calls = []
  return {
    calls,
    async get(key, options) {
      calls.push({ key, options })
      const ranged = options.range.get('Range')
      const body = ranged ? Uint8Array.of(1) : Uint8Array.of(1, 2, 3, 4)
      return {
        body,
        size: 4,
        range: ranged ? { offset: 0, length: 1 } : undefined,
        httpEtag: '"etag"',
        writeHttpMetadata(headers) {
          headers.set('Content-Type', 'video/mp4')
        },
      }
    },
  }
}

const context = (env, request, path) => ({
  env,
  request,
  params: { path },
})

test('private metadata mints a short-lived URL only for the signed-in owner', async () => {
  const videos = objectStore()
  const env = {
    DB: database(),
    VIDEOS: videos,
    MEDIA_SIGNING_SECRET: 'test-signing-secret',
  }

  const anonymous = await onRequestGet(context(
    env,
    new Request('https://site.test/api/site/v/private-video'),
    ['v', 'private-video'],
  ))
  assert.equal(anonymous.status, 404)

  const owner = await onRequestGet(context(
    env,
    new Request('https://site.test/api/site/v/private-video', {
      headers: { Cookie: 'sc_session=owner-session' },
    }),
    ['v', 'private-video'],
  ))
  assert.equal(owner.status, 200)
  const payload = await owner.json()
  assert.equal(payload.data.owner, true)
  assert.match(payload.data.video.media_url, /^\/api\/site\/media\?/)

  const playbackUrl = new URL(payload.data.video.media_url, 'https://site.test')
  const playback = await onRequestGet(context(
    env,
    new Request(playbackUrl, { headers: { Range: 'bytes=0-0' } }),
    ['media'],
  ))
  assert.equal(playback.status, 206)
  assert.equal(playback.headers.get('Content-Range'), 'bytes 0-0/4')
  assert.equal((await playback.arrayBuffer()).byteLength, 1)
  assert.equal(videos.calls[0].key, video.r2_key)
})

test('unsigned, tampered, and expired video URLs fail closed', async () => {
  const videos = objectStore()
  const env = {
    DB: database(),
    VIDEOS: videos,
    MEDIA_SIGNING_SECRET: 'test-signing-secret',
  }

  const unsigned = await onRequestGet(context(
    env,
    new Request('https://site.test/api/site/media?key=videos/owner/videos/private-video.mp4'),
    ['media'],
  ))
  assert.equal(unsigned.status, 404)

  const signed = await signedVideoUrl(env, video.r2_key, false, 1_000_000)
  const tampered = new URL(signed, 'https://site.test')
  tampered.searchParams.set('key', 'videos/owner/videos/other.mp4')
  const tamperedResponse = await onRequestGet(context(
    env,
    new Request(tampered),
    ['media'],
  ))
  assert.equal(tamperedResponse.status, 404)

  const expired = new Request(new URL(signed, 'https://site.test'))
  assert.equal(await verifiedVideoKey(env, expired, 2_000_000), '')
  assert.equal(videos.calls.length, 0)
})

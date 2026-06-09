import { asset } from '../lib/assets'

// Global asset library (/library), mapped to the real spoolcast-content layout:
// Show (series/ or shows/) → Episode (a session folder) → assets (renders/,
// generated-assets/scenes, frames shots, working/ screenplay, characters).
export type LibClip = { id: string; name: string; meta: string }
export type LibImage = { id: string; name: string; meta: string; thumb: string }
export type LibText = { id: string; name: string; meta: string; body?: string }
export type LibChar = { id: string; name: string; meta: string; thumb: string }
export type LibEpisode = {
  id: string
  name: string
  folder: string
  thumb: string
  render: string
  aspect: string
  clips: LibClip[]
  images: LibImage[]
  prompts: LibText[]
  charIds: string[]
}
export type LibShow = {
  id: string
  name: string
  template: string
  thumb: string
  voice: LibText
  characters: LibChar[]
  episodes: LibEpisode[]
}

export const DEVLOG_THUMB = asset('sessions/spoolcast-dev-log-06/source/generated-assets/thumbnails/thumb-v2-three-answers.png')
export const devScene = (n: string) => asset(`sessions/spoolcast-dev-log-06/source/generated-assets/scenes/${n}.png`)

export const SHOWS: LibShow[] = [
  {
    id: 'devlog', name: 'spoolcast dev-log', template: 'Wojak · GPT-image', thumb: DEVLOG_THUMB,
    voice: { id: 'v-puck', name: 'Google TTS · Puck', meta: 'series narration voice' },
    characters: [
      { id: 'builder', name: 'The builder', meta: 'Narrator · hooded wojak', thumb: devScene('C29') },
      { id: 'ai', name: 'The AI', meta: 'Cracked-face wojak', thumb: asset('styles/wojak-gpt2/references/ai-figure.png') },
      { id: 'chad', name: 'Chad', meta: 'Confident-mode insert', thumb: asset('styles/wojak-comic/references/chad.png') },
    ],
    episodes: [
      {
        id: 'dl06', name: 'Dev Log #06', folder: 'sessions/spoolcast-dev-log-06', thumb: DEVLOG_THUMB, render: '4:08 · 16:9 · MP4', aspect: '16 / 9',
        clips: [
          { id: 'dl06-b1', name: 'B1 · cold open', meta: 'shot' },
          { id: 'dl06-c1', name: 'C1 · context', meta: 'shot' },
          { id: 'dl06-c14', name: 'C14 · cast handling', meta: 'shot' },
        ],
        images: [
          { id: 'dl06-b1i', name: 'Scene B1', meta: '1K · PNG', thumb: devScene('B1') },
          { id: 'dl06-c1i', name: 'Scene C1', meta: '1K · PNG', thumb: devScene('C1') },
          { id: 'dl06-c14i', name: 'Scene C14', meta: '1K · PNG', thumb: devScene('C14') },
          { id: 'dl06-c29i', name: 'Scene C29', meta: '1K · PNG', thumb: devScene('C29') },
        ],
        prompts: [
          { id: 'dl06-p1', name: 'Screenplay v2', meta: 'working/', body: 'Spine: practical, dry, slightly deadpan. This pass tightens the wrong-diagnoses act so each one is "partly right, structurally incomplete" rather than wrong. Cold open keeps every line plain English, no jargon. Spoolcast context intro stays under a minute. Ending holds ≥2.5s of silence (settle-and-hold).' },
          { id: 'dl06-p2', name: 'Shot list · 44 shots', meta: 'shot-list.json', body: 'spoolcast-dev-log-06 — devlog about AI lying about progress and the tracker that fixed it. Audience: AI-curious non-coders. Cold-open shape: Hook → Objection → Context. Receipt visuals consumer-recognizable (phone tracker / checklist / sticky note), NOT terminal screenshots. 16:9 · 30fps · 44 shots.' },
          { id: 'dl06-p3', name: 'Core message', meta: 'session.json', body: 'AI agents handling long-running work need a mechanical job tracker as the source of truth. Without one, the agent guesses from logs, partial files, and stale shells — and the guesses sound confident even when they\'re wrong.' },
        ],
        charIds: ['builder', 'ai', 'chad'],
      },
      {
        id: 'dl05', name: 'Dev Log #05', folder: 'sessions/spoolcast-dev-log-05', thumb: asset('styles/wojak-comic/references/chad.png'), render: '3:52 · 16:9 · MP4', aspect: '16 / 9',
        clips: [
          { id: 'dl05-b1', name: 'B1 · cold open', meta: 'shot' },
          { id: 'dl05-c1', name: 'C1 · the pivot', meta: 'shot' },
        ],
        images: [{ id: 'dl05-c1i', name: 'Scene C1', meta: '1K · PNG', thumb: devScene('C1') }],
        prompts: [{ id: 'dl05-p1', name: 'Screenplay v1', meta: 'working/', body: 'First-pass draft — the original "wrong diagnosis 1/2/3/4" cadence, later reframed in v2.' }],
        charIds: ['builder', 'chad'],
      },
    ],
  },
  {
    id: 'news', name: 'faux7-news', template: 'Anime · Bleach key-art', thumb: '/news-poster.jpg',
    voice: { id: 'v-anchor', name: 'ElevenLabs · anchor', meta: 'show narration voice' },
    characters: [
      { id: 'musk', name: 'Musk', meta: 'Recurring foil', thumb: asset('shows/news-anime-bot/characters/musk.png') },
      { id: 'altman', name: 'Altman', meta: 'Tech-founder register', thumb: asset('shows/news-anime-bot/characters/altman.png') },
      { id: 'huang', name: 'Huang', meta: 'Platform-vendor register', thumb: asset('shows/news-anime-bot/characters/huang.png') },
    ],
    episodes: [
      {
        id: 'n0528', name: 'Episode · May 28', folder: 'shows/news-anime-bot/sessions/2026-05-28', thumb: '/news-poster.jpg', render: '1:21 · 9:16 · MP4', aspect: '9 / 16',
        clips: [
          { id: 'n-c1', name: 'Headline', meta: 'clip' },
          { id: 'n-c2', name: 'Reaction · Musk', meta: 'clip' },
          { id: 'n-c3', name: 'Sign-off', meta: 'clip' },
        ],
        images: [{ id: 'n-i1', name: 'Key-art · Altman', meta: 'PNG', thumb: asset('shows/news-anime-bot/characters/altman.png') }],
        prompts: [
          { id: 'n-p1', name: 'script.md', meta: 'episode/', body: 'faux7 satire desk read — headline, reaction cutaways, sign-off. 9:16, burned-in captions, Bleach key-art look.' },
          { id: 'n-p2', name: 'cast.txt', meta: 'session', body: 'Episode cast — Musk (recurring foil), Altman, Huang. Pinned character references so faces stay consistent.' },
        ],
        charIds: ['musk', 'altman', 'huang'],
      },
    ],
  },
  {
    id: 'standalone', name: 'standalone', template: 'Mixed · one-offs', thumb: '/explainer-poster.jpg',
    voice: { id: 'v-neutral', name: 'Google TTS · neutral', meta: 'per-video voice' },
    characters: [],
    episodes: [
      {
        id: 'expl', name: 'Stick-figure explainer', folder: 'sessions/spoolcast-explainer', thumb: '/explainer-poster.jpg', render: '0:22 · 16:9 · MP4', aspect: '16 / 9',
        clips: [{ id: 'e-c1', name: 'Hook', meta: 'shot' }],
        images: [{ id: 'e-i1', name: 'Doodle frame', meta: 'PNG', thumb: '/explainer-poster.jpg' }],
        prompts: [{ id: 'e-p1', name: 'Screenplay', meta: 'working/', body: 'Stick-figure explainer — hand-drawn doodle style, single hook + explainer beat, 16:9.' }],
        charIds: [],
      },
    ],
  },
]

// distinct style templates (column 1 of the flow)
export const LIB_TEMPLATES = [...new Map(SHOWS.map((s) => [s.template, s.thumb])).entries()].map(([name, thumb]) => ({ name, thumb }))

// derived flat lists for the by-type browser
export const LIB_VIDEOS = SHOWS.flatMap((sh) =>
  sh.episodes.map((ep) => ({ id: ep.id, name: ep.name, project: sh.name, meta: ep.render, thumb: ep.thumb, clips: ep.clips })),
)
export const LIB_IMAGES = SHOWS.flatMap((sh) => sh.episodes.flatMap((ep) => ep.images.map((i) => ({ ...i, project: sh.name }))))
export const LIB_CHARS = SHOWS.flatMap((sh) => sh.characters.map((c) => ({ ...c, project: sh.name })))
export const LIB_VOICES = SHOWS.map((sh) => ({ id: sh.voice.id, name: sh.voice.name, project: sh.name, meta: sh.voice.meta }))
export const LIB_PROMPTS = SHOWS.flatMap((sh) => sh.episodes.flatMap((ep) => ep.prompts.map((t) => ({ ...t, project: sh.name }))))

export type TypeKey = 'videos' | 'images' | 'characters' | 'voices' | 'prompts'
export const LIB_TABS: { key: TypeKey; label: string; count: number }[] = [
  { key: 'videos', label: 'Videos', count: LIB_VIDEOS.length },
  { key: 'images', label: 'Images', count: LIB_IMAGES.length },
  { key: 'characters', label: 'Characters', count: LIB_CHARS.length },
  { key: 'voices', label: 'Voices', count: LIB_VOICES.length },
  { key: 'prompts', label: 'Prompts', count: LIB_PROMPTS.length },
]

// each project's assets split across two generation sessions (mock)
// Flow view — lineage columns: Template → Project → Session → Assets, with
// connectors between the selected node in each column. Unselected branches dim.
export type FlowAsset = { id: string; type: string; name: string; sub: string; thumb?: string; ar?: string; body?: string }
export const ASSET_TYPES = ['Video', 'Image', 'Character', 'Prompt']

// rough grid span by aspect → landscape wide, portrait tall, ~equal area (Tetris)

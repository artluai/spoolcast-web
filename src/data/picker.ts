import { asset } from '../lib/assets'
import type { OnboardSeed } from '../types'

export type PickerTemplate = {
  id: string
  cls: string
  poster: string
  video: string
  badge: string
  series: boolean
  seriesBtn?: string
  duration: string
  name: string
  sig: string
  useLabel: string
  sub: { name: string; meta: string; cta: string } | null
  seed: OnboardSeed
}

export const PICKER_TEMPLATES: PickerTemplate[] = [
  {
    id: 'dev',
    cls: 't-dev',
    poster: asset('sessions/spoolcast-dev-log-06/source/generated-assets/thumbnails/thumb-v2-three-answers.png'),
    video: asset('sessions/spoolcast-dev-log-06/renders/spoolcast-dev-log-06-1.0x.mp4'),
    badge: '1 series · weekly',
    series: true,
    duration: '4:08',
    name: 'Spoolcast dev-log',
    sig: '16:9 · narrated (TTS Schedar) · anime soft · animated stills',
    useLabel: 'Use base template →',
    sub: {
      name: 'Dev Log — weekly',
      meta: '10 episodes · cold-open intro & style locked · last: Dev Log #10',
      cta: 'Start episode #11 →',
    },
    seed: {
      s1: { narrator: 'yes', style: 'anime', output: '169', length: 248, projectId: 'spoolcast-dev-log-11', editing: '' },
      ideaBrief: '',
      goal: { text: '', mode: '' },
    },
  },
  {
    id: 'news',
    cls: 't-news',
    poster: '/news-poster.jpg',
    video: asset('shows/news-anime-bot/sessions/2026-05-28/episode/out/episode-15.mp4'),
    badge: '1 series · daily',
    series: true,
    seriesBtn: 'Series',
    duration: '1:21',
    name: 'Anime news',
    sig: '9:16 · narrated + cast · Bleach key-art anime · generated clips',
    useLabel: 'Use base →',
    sub: {
      name: 'faux7-news — daily',
      meta: '15 episodes · 11-character cast · last: Episode 15 (May 28)',
      cta: 'Start episode #16 →',
    },
    seed: {
      s1: { narrator: 'yes', style: 'anime', output: '916', length: 90, projectId: 'faux7-news-16', editing: '' },
      ideaBrief: '',
      goal: { text: '', mode: '' },
    },
  },
  {
    id: 'ugc',
    cls: 't-ugc',
    poster: '/ugc-poster.jpg',
    video: '/ugc-sample.mp4',
    badge: 'base template',
    series: false,
    duration: '0:56',
    name: 'UGC explainer',
    sig: '9:16 · in-video audio · photoreal · generated clips',
    useLabel: 'Use this template →',
    sub: null,
    seed: {
      s1: { narrator: 'no', style: 'realistic', output: '916', length: 56, projectId: 'ugc-explainer', editing: '' },
      ideaBrief: '',
      goal: { text: '', mode: '' },
    },
  },
  {
    id: 'expl',
    cls: 't-explainer',
    poster: '/explainer-poster.jpg',
    video: asset('sessions/spoolcast-explainer/source/external-assets/pilot-proof-22s.mp4'),
    badge: 'base template',
    series: false,
    duration: '0:22',
    name: 'Stick-figure explainer',
    sig: '16:9 · narrated · hand-drawn doodles (C&H / XKCD) · animated stills',
    useLabel: 'Use this template →',
    sub: null,
    seed: {
      s1: { narrator: 'yes', style: 'handdrawn', output: '169', length: 240, projectId: 'stick-figure-explainer', editing: '' },
      ideaBrief: '',
      goal: { text: '', mode: '' },
    },
  },
]

// In-progress projects — shown FIRST on /projects so returning users resume fast.
export const RECENTS: {
  title: string
  sub: string
  step: string
  pct: number
  kind: 'series' | 'standalone'
  thumb: string
}[] = [
  {
    title: 'Dev Log #06',
    sub: 'spoolcast dev-log · 2h ago',
    step: '09 / 14',
    pct: 58,
    kind: 'series',
    thumb: asset('sessions/spoolcast-dev-log-06/source/generated-assets/thumbnails/thumb-v2-three-answers.png'),
  },
  {
    title: 'News drop · May 14',
    sub: 'faux7-news · yesterday',
    step: '13 / 14',
    pct: 92,
    kind: 'series',
    thumb: '/news-poster.jpg',
  },
  {
    title: 'Founder mode, explained',
    sub: 'standalone · 3d ago',
    step: '04 / 14',
    pct: 23,
    kind: 'standalone',
    thumb: '/explainer-poster.jpg',
  },
]

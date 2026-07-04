import { asset } from '../lib/assets'

// PRESENTATION for engine templates (GET /api/templates): tile art the engine
// doesn't know about, keyed by template id. A template with no entry here
// still renders — name + description, no preview video.
export type TemplateArt = {
  cls: string
  poster?: string
  video?: string
  duration?: string
}

export const TEMPLATE_ART: Record<string, TemplateArt> = {
  explainer: {
    cls: 't-dev',
    poster: asset('sessions/spoolcast-dev-log-06/source/generated-assets/thumbnails/thumb-v2-three-answers.png'),
    video: asset('sessions/spoolcast-dev-log-06/renders/spoolcast-dev-log-06-1.0x.mp4'),
    duration: '4:08',
  },
  // Vertical tile (9:16, like t-news); poster/preview arrive once the first
  // real ad ships (ROADMAP item 13's proof session).
  ad: {
    cls: 't-ad',
  },
}

import { asset } from '../lib/assets'

// World Kit "Share" scope hierarchy, narrow -> wide:
//   Episode  <  Show / subtemplate  <  Format template
// IMPORTANT: "Format template" is the whole-series PIPELINE format (e.g. the
// Remotion illustration format, or the Anime news bot format) — NOT the image
// / visual style (that's "Style Anchor", owned by Step 01). Keyed by show.
export const FORMAT_TEMPLATE_NAMES: Record<string, string> = {
  'spoolcast dev log': 'Remotion illustration',
  'faux7-news': 'Anime news bot',
}

// World Kit subsections — the visual-reference planning model. Cast is one of
// them; nothing here implies a fixed "1 character + 1 environment" recipe.
// Share scope values stay single words; the dropdown labels name the actual
// show / template so it's clear where a reference gets shared to.
export const WORLD_KIT_SCOPES = ['Episode', 'Show', 'Template'] as const

export type WorldKitSection = {
  id: string
  name: string
  desc: string
  scope: string
  cast?: boolean
  locked?: boolean
  image?: string
  caption?: string
  items?: string[]
}

export const WORLD_KIT_SECTIONS: WorldKitSection[] = [
  // Style Anchor is owned by Project setup (Step 01) — shown here read-only.
  { id: 'style', name: 'Style Anchor', desc: 'Set in Project setup — locked here.', scope: 'Template', locked: true, image: asset('styles/wojak-comic/references/chad.png'), caption: 'Wojak comic' },
  { id: 'cast', name: 'Cast', desc: 'Characters who appear. Manifest: cast.txt.', scope: 'Show', cast: true },
  { id: 'env', name: 'Environments', desc: 'Locations and backdrops.', scope: 'Show', items: ['Hooded-desk home office', 'Whiteboard wall', 'Night-city skyline'] },
  { id: 'props', name: 'Props / Objects', desc: 'Recurring objects and held items.', scope: 'Episode', items: ['"OUCH!" mug', 'Job-tracker board', 'Mechanical keyboard'] },
  { id: 'docs', name: 'Documents / Screens', desc: 'On-screen UI, documents, and charts.', scope: 'Episode', items: ['shot-list.json table', 'session.json core_message', 'Terminal log'] },
  { id: 'motion', name: 'Motion / Camera References', desc: 'Camera moves and motion cues.', scope: 'Template', items: ['Slow push-in', 'Static medium', 'Whip-pan to reaction'] },
  { id: 'beat', name: 'Beat-Specific References', desc: 'One-off refs scoped to a single beat.', scope: 'Episode', items: ['B1 — "THE SYMPTOM" title card', 'C14 — four thought-bubble inserts'] },
]

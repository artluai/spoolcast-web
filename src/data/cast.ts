import { asset } from '../lib/assets'

export const styleThumbs = [
  {
    id: 'wojak',
    name: 'Wojak',
    img: asset('styles/wojak-comic/references/chad.png'),
    narratorOnly: true,
  },
  {
    id: 'anime',
    name: 'Anime',
    img: asset('shows/news-anime-bot/characters/musk.png'),
    narratorOnly: true,
  },
  { id: 'realistic', name: 'Photoreal' },
  { id: 'handdrawn', name: 'Hand-drawn', narratorOnly: true },
  { id: 'mocku', name: 'Mockumentary' },
  { id: 'custom', name: 'Make my own', badge: 'CUSTOM' },
]

// Session `series` id → show name (the castByShow key). A session with no
// series — or an unknown one — has no show behind it and gets the honest
// empty 'standalone' identity, never another show's cast.
export const showBySeries: Record<string, string> = {
  'spoolcast-devlog': 'spoolcast dev log',
}

export const castByShow = {
  'spoolcast dev log': {
    style: 'wojak-gpt2',
    chars: [
      {
        ref: 'builder',
        name: 'The builder',
        role: 'Hooded mid-wojak narrator. First-person voice. Doomer-leaning early, neutral late.',
        img: asset(
          'sessions/spoolcast-dev-log-06/source/generated-assets/scenes/C29.png',
        ),
        episodes: 6,
        lastUsed: 'Dev Log #06',
      },
      {
        ref: 'ai-figure',
        name: 'The AI',
        role: 'Cracked-face wojak with AI ink-stamp forehead. Cream hoodie. Flat-affect throughout.',
        img: asset('styles/wojak-gpt2/references/ai-figure.png'),
        episodes: 6,
        lastUsed: 'Dev Log #06',
      },
      {
        ref: 'meme-chad',
        name: 'Chad',
        role: 'Locked meme-chad reference. Confident-mode contrast beats, thumbs-up reactions, and when the script wants a chad-mode insert.',
        img: asset('styles/wojak-comic/references/chad.png'),
        episodes: 3,
        lastUsed: 'Dev Log #09',
      },
    ],
  },
  // A blank/standalone project has no show behind it: empty cast, no style.
  // Keeps the World Kit page honest instead of falling back to the devlog's.
  'standalone': {
    style: '',
    chars: [],
  },
  'faux7-news': {
    style: 'anime / nano-banana',
    chars: [
      {
        ref: 'musk',
        name: 'Musk',
        role: 'Recurring foil. Edgy reaction shots.',
        img: asset('shows/news-anime-bot/characters/musk.png'),
        episodes: 4,
        lastUsed: '2026-05-14',
      },
      {
        ref: 'altman',
        name: 'Altman',
        role: 'Lab-coat tech founder register.',
        img: asset('shows/news-anime-bot/characters/altman.png'),
        episodes: 5,
        lastUsed: '2026-05-14',
      },
      {
        ref: 'huang',
        name: 'Huang',
        role: 'Leather-jacket platform-vendor register.',
        img: asset('shows/news-anime-bot/characters/huang.png'),
        episodes: 3,
        lastUsed: '2026-05-09',
      },
    ],
  },
}

export const shots = [
  ['C01', 'Cold open', 'Hero shot of editor with terminal output overlay.', '0:06', 'ok'],
  ['C02', 'Problem framing', 'Diagram of the three bottlenecks.', '0:08', 'ok'],
  ['C03', 'Issue 1', 'Waveform expanding sequentially across timeline.', '0:07', 'ok'],
  ['C04', 'Issue 2', 'Loading bar repeatedly resetting to zero.', '0:06', 'ok'],
  ['C05', 'Issue 3', 'Network graph with a glowing hallucinated edge.', '0:07', 'ok'],
  ['C06', 'Solution intro', 'Schematic of the contract structure.', '0:09', 'ok'],
  ['C07', 'Implementation', 'Stage diagram with status indicators lighting up.', '0:08', 'ok'],
  ['C08', 'Render path', 'Two parallel tracks merging into a render node.', '0:07', 'ok'],
  ['C09', 'Audit demo', 'Magnifier scanning a JSON audit report.', '0:08', 'ok'],
  ['C10', 'Approval gates', 'Approval ledger with timestamps and notes.', '0:07', 'ok'],
  ['C11', 'Mobile branch', 'Branching node tree, mobile path dashed.', '0:07', 'ok'],
  ['C12', 'Job runner', 'Terminal showing tailed log lines.', '0:06', 'ok'],
  ['C13', 'UI direction', 'Node graph with disabled-action affordances.', '0:08', 'ok'],
  ['C14', 'Cast handling', 'Character grid with selection state.', '0:08', 'ok'],
  ['C15', 'Build path', 'Remotion timeline composing layers.', '0:07', 'work'],
  ['C16', 'Audit sentinel', 'File-system tree with a green sentinel marker.', '0:06', 'pend'],
  ['C17', 'Caption pass', 'SRT file scrolling alongside thumbnail preview.', '0:06', 'pend'],
  ['C18', 'Mobile crop', '16:9 frame collapsing into 9:16 with subject lock.', '0:08', 'pend'],
  ['C19', 'Cost summary', 'Cost breakdown chart.', '0:07', 'pend'],
  ['C20', 'Lessons learned', 'Highlighted action list with disabled siblings.', '0:08', 'pend'],
  ['C21', "What's next", 'Sketch of the upcoming UI mockup.', '0:07', 'pend'],
  ['C22', 'Outro', 'End card with channel handle.', '0:09', 'pend'],
] as const

export const sceneFiles = [
  'C1.png',
  'C2.png',
  'C10.png',
  'C11.png',
  'C12.png',
  'C13.png',
  'C15.png',
  'C16.png',
  'C20.png',
  'C21.png',
  'C22.png',
  'C26.png',
  'C30.png',
  'C31.png',
]

export const outline: [string, string, string][] = []

export const stepAlias: Record<string, { id: string; name: string; blurb: string }> = {
  format_setup: {
    id: 'setup',
    name: 'Project setup',
    blurb: 'Project name, visual style, and budget.',
  },
  input_intake: {
    id: 'idea',
    name: 'Video idea',
    blurb: 'What the video is about, plus notes and references.',
  },
  story_lock: {
    id: 'goal',
    name: 'Core message',
    blurb: 'Lock the single-sentence angle before scripting.',
  },
  structure: {
    id: 'plan',
    name: 'Structure outline',
    blurb: 'High-level structural arc.',
  },
  world_kit: {
    id: 'worldkit',
    name: 'World Kit',
    blurb: 'Plan the visual references — style anchor, cast, environments, props, and beat-specific refs.',
  },
  screenplay_plan: {
    id: 'script',
    name: 'Screenplay',
    blurb: 'First narration draft.',
  },
  visual_pacing: {
    id: 'pacing',
    name: 'Visual pacing',
    blurb: 'Plan per-chunk visual moments, image count, and b-roll/meme/reaction candidates.',
  },
  shot_list_json: {
    id: 'shots',
    name: 'Compile Shot List',
    blurb: 'Compile the pacing plan into the structured JSON render contract.',
  },
  narration_audio: {
    id: 'voice',
    name: 'Narration audio',
    blurb: 'Synthesized narration from the script.',
  },
  visual_assets: {
    id: 'pics',
    name: 'Visual generation',
    blurb: 'AI-rendered visuals for each shot.',
  },
  asset_audit: {
    id: 'check',
    name: 'Final cut',
    blurb: 'Review the generated visuals and compile the final video.',
  },
  // The engine's package_widescreen / mobile_variant / publish stages are folded
  // into this one UI step (see HIDDEN_STAGES in workflow-graph.ts).
  preprocess_review_render: {
    id: 'build',
    name: 'Package & publish',
    blurb: 'Captions, title & description, thumbnail, and upload.',
  },
}

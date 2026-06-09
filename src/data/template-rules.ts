// The basic carry-over checklist handles the obvious reusable setup (format,
// style, structure, cast). This section captures the soft, creative show
// behavior that only exists as prompt fragments / patterns in the first video:
// overlays, title cards, caption + humor style, recurring memes, motifs, etc.
// AI suggestions are NEVER saved automatically — a rule is only saved once the
// user keeps it (or adds one by hand).
export type TplRule = {
  id: number
  category: string
  text: string
  source?: string
}

export const SCAN_SUGGESTIONS: Omit<TplRule, 'id'>[] = [
  {
    category: 'Ending style',
    text: 'End each video with a notification-style teaser card for the next episode.',
    source: 'Source: Storyboard · Beat 12',
  },
  {
    category: 'Humor',
    text: 'Dry, deadpan narration — undercut every serious claim with a one-line aside.',
    source: 'Source: Screenplay · Scene 4',
  },
  {
    category: 'Overlay',
    text: 'Keep the persistent “DEV LOG” title bar in the top-left for the full runtime.',
    source: 'Source: Final output · 0:00–end',
  },
  {
    category: 'Caption style',
    text: 'Burned-in captions, two lines max, bottom-center, bold weight.',
    source: 'Source: Captions and cover',
  },
  {
    category: 'Meme',
    text: 'Reuse the “contract-locked” running gag whenever the engine is mentioned.',
    source: 'Source: Screenplay · Scene 7',
  },
]

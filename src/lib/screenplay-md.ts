// Parse/serialize working/screenplay-v3.md — including the CLIP-BASED format.
//
// Legacy (all existing sessions):    # title / [Voice source:] / ## Narration / prose
// Clip-based (wordless & mixed):     …same, PLUS a `## Clips` table:
//   | # | On screen | Spoken line | Shot |
// Shot is 'video' | 'image' — the medium, which decides the clip's legal
// duration (a video clip is bound to its model's range, a still is not) and so
// must be settled here, before pacing. Clip tables written before the column
// existed parse with shot '' ; the engine's shot_medium.py resolves that
// against the project policy, so never invent a default in the UI.
// When clips exist they are the source of truth; the Narration section is
// REGENERATED from the non-empty spoken lines on every serialize, so every
// prose consumer (audits, voice, pacing drafter) keeps reading spoken text.
// The engine mirror of this format lives in scripts/draft_screenplay.py
// (render_clips_file) — keep them in sync.

export type ShotMedium = 'video' | 'image'
// group: the visual-consistency group — clips sharing it share one MASTER
// reference so they match. '' = one-off.
export type Clip = { screen: string; line: string; shot: ShotMedium | ''; group: string }

export type ScreenplayDoc = {
  title: string
  voiceLine: string // full "Voice source: …" line or ''
  narration: string // prose body (legacy editing surface)
  clips: Clip[] | null // null = legacy prose screenplay
}

export function parseScreenplay(text: string): ScreenplayDoc {
  const lines = text.split('\n')
  let title = ''
  let voiceLine = ''
  const narration: string[] = []
  let clips: Clip[] | null = null
  let section: 'narration' | 'clips' | null = null

  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith('# ') && !title) {
      title = line.slice(2).trim()
      continue
    }
    if (/^##\s+narration/i.test(line)) {
      section = 'narration'
      continue
    }
    if (/^##\s+clips/i.test(line)) {
      section = 'clips'
      clips = clips ?? []
      continue
    }
    if (line.startsWith('#')) {
      section = null
      continue
    }
    if (/^voice source:/i.test(line)) {
      voiceLine = line
      continue
    }
    if (section === 'narration') {
      narration.push(raw)
      continue
    }
    if (section === 'clips' && line.startsWith('|')) {
      const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
      if (cells.length < 3) continue
      if (/^#$/.test(cells[0]) || /^-+$/.test(cells[0])) continue // header/separator
      const shot = (cells[3] ?? '').toLowerCase()
      clips!.push({
        screen: cells[1] ?? '',
        line: cells[2] ?? '',
        // '' for pre-column tables — resolved against the project policy, not here.
        shot: shot === 'video' || shot === 'image' ? shot : '',
        group: (cells[4] ?? '').toLowerCase(),
      })
    }
  }
  return { title, voiceLine, narration: narration.join('\n').trim(), clips }
}

const cell = (t: string) => t.replace(/\s+/g, ' ').replace(/\|/g, '/').trim()

export function serializeScreenplay(doc: ScreenplayDoc): string {
  const voice = doc.voiceLine ? `${doc.voiceLine}\n\n` : ''
  if (doc.clips === null) {
    return `# ${doc.title}\n\n${voice}## Narration\n\n${doc.narration}\n`
  }
  const narration = doc.clips
    .map((c) => c.line.trim())
    .filter(Boolean)
    .join('\n\n')
  const rows = doc.clips
    .map((c, i) => `| ${i + 1} | ${cell(c.screen)} | ${cell(c.line)} | ${c.shot} | ${cell(c.group)} |`)
    .join('\n')
  return (
    `# ${doc.title}\n\n${voice}## Narration\n\n${narration}\n\n` +
    `## Clips\n\n| # | On screen | Spoken line | Shot | Group |\n|---|---|---|---|---|\n${rows}\n`
  )
}

// One-way conversion for legacy prose: each paragraph becomes a clip's spoken
// line with an empty on-screen description (the user or the AI fills those).
export function proseToClips(doc: ScreenplayDoc): ScreenplayDoc {
  const paras = doc.narration.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean)
  return { ...doc, clips: paras.map((p) => ({ screen: '', line: p, shot: '' as const, group: '' })) }
}

export function spokenWordCount(text: string): number {
  const doc = parseScreenplay(text)
  const spoken = doc.clips ? doc.clips.map((c) => c.line).join(' ') : doc.narration
  return (spoken.match(/\b[\w'’-]+\b/g) ?? []).length
}

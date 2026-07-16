// Parse/serialize working/screenplay-v3.md — including the CLIP-BASED format.
//
// Legacy (all existing sessions):    # title / [Voice source:] / ## Narration / prose
// Clip-based (wordless & mixed):     …same, PLUS a `## Clips` table:
//   | # | On screen | Spoken line |
// When clips exist they are the source of truth; the Narration section is
// REGENERATED from the non-empty spoken lines on every serialize, so every
// prose consumer (audits, voice, pacing drafter) keeps reading spoken text.
// The engine mirror of this format lives in scripts/draft_screenplay.py
// (render_clips_file) — keep them in sync.

export type Clip = { screen: string; line: string }

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
      clips!.push({ screen: cells[1] ?? '', line: cells[2] ?? '' })
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
  const rows = doc.clips.map((c, i) => `| ${i + 1} | ${cell(c.screen)} | ${cell(c.line)} |`).join('\n')
  return (
    `# ${doc.title}\n\n${voice}## Narration\n\n${narration}\n\n` +
    `## Clips\n\n| # | On screen | Spoken line |\n|---|---|---|\n${rows}\n`
  )
}

// One-way conversion for legacy prose: each paragraph becomes a clip's spoken
// line with an empty on-screen description (the user or the AI fills those).
export function proseToClips(doc: ScreenplayDoc): ScreenplayDoc {
  const paras = doc.narration.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean)
  return { ...doc, clips: paras.map((p) => ({ screen: '', line: p })) }
}

export function spokenWordCount(text: string): number {
  const doc = parseScreenplay(text)
  const spoken = doc.clips ? doc.clips.map((c) => c.line).join(' ') : doc.narration
  return (spoken.match(/\b[\w'’-]+\b/g) ?? []).length
}

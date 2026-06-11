// Parse/serialize the visual-pacing-plan.md house format (same philosophy as
// worldkit-md.ts: the structured editor is a VIEW over the markdown draft the
// engine reads — every edit round-trips through serialize, so save/approve/
// dirty-tracking stay untouched).
//
// Format (strict, but written to stay human-readable):
//   # Visual Pacing Plan — <session>
//   ## Meta                       → field/value table (Style, Target length, Timing)
//   ## C001 — <Title> (0–22s)     → chunk; the (range) is DERIVED and ignored on parse
//   Summary: <one line>
//   **Beat 001A**: "<narration>"
//   | Img | Hold | Refs | What | Why now |   → one image table per beat
//   ## Overlays                   → ID | Anchor | Trigger phrase | Overlay | Hold | Placement
//
// All timings are estimates until real narration audio exists (step 09):
// narration words ÷ 2.5 words/sec, image holds laid end-to-end inside a beat.
// Stats (counts, densities, runtime) are ALWAYS computed, never stored — a
// stored summary goes stale the moment someone edits.

export type PacingImage = { id: string; holdS: number; refs: string; what: string; why: string }
export type PacingBeat = { code: string; narration: string; images: PacingImage[] }
export type PacingChunk = { id: string; title: string; summary: string; beats: PacingBeat[] }
export type PacingOverlay = {
  id: string
  anchor: string // image id the overlay sits on top of
  trigger: string // the spoken phrase that fires it
  what: string
  holdS: number
  placement: string
}
// A SECTION is a named time window with density targets ("opening: 9 images").
// Sections are directives the human sets and the AI drafter must honor —
// budgets are enforced as caps in code on redraft. toS 'end' = video end.
export type PacingSection = {
  name: string
  fromS: number
  toS: number | 'end'
  imageBudget: number | null
  overlayBudget: number | null
}

export type PacingPlan = {
  title: string
  meta: Record<string, string>
  sections: PacingSection[] // empty = defaults apply (opening 0–45s, body 45–end)
  chunks: PacingChunk[]
  overlays: PacingOverlay[]
}

export const WORDS_PER_SEC = 2.5 // matches validate_shot_list.py TTS_WORDS_PER_SEC

const BEAT_RE = /^\*\*Beat\s+([A-Za-z0-9]+)\*\*(?:\s*\([^)]*\))?\s*:\s*(.*)$/
const RANGE_SUFFIX_RE = /\s*\([^()]*\)\s*$/

const parseRow = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())

const isSeparatorRow = (cells: string[]) => cells.every((c) => /^:?-{2,}:?$/.test(c))

export const parseHold = (s: string): number => {
  const m = String(s).match(/([\d.]+)/)
  const n = m ? parseFloat(m[1]) : NaN
  return Number.isFinite(n) ? n : 0
}

const fmtHold = (s: number): string => `${(Math.round(s * 10) / 10).toFixed(1)}s`

const unquote = (s: string): string => {
  const t = s.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('“') && t.endsWith('”')))
    return t.slice(1, -1)
  return t
}

export function parsePacingPlan(md: string): PacingPlan {
  const lines = md.split('\n')
  const plan: PacingPlan = { title: '', meta: {}, sections: [], chunks: [], overlays: [] }

  type Section = { kind: 'meta' | 'overlays' | 'sections' | 'chunk'; chunk?: PacingChunk }
  let section: Section | null = null
  let beat: PacingBeat | null = null
  let tableCols: string[] | null = null

  const col = (cols: string[], row: string[], name: string): string => {
    const i = cols.findIndex((c) => c.toLowerCase() === name.toLowerCase())
    return i >= 0 && i < row.length ? row[i] : ''
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    const t = line.trim()

    if (line.startsWith('# ') && !plan.title) {
      plan.title = line.slice(2).trim()
      continue
    }
    if (line.startsWith('## ')) {
      const h = line.slice(3).trim()
      beat = null
      tableCols = null
      const m = h.match(/^(C\d+)\s+—\s+(.*)$/)
      if (/^meta$/i.test(h)) {
        section = { kind: 'meta' }
      } else if (/^overlays$/i.test(h)) {
        section = { kind: 'overlays' }
      } else if (/^sections$/i.test(h)) {
        section = { kind: 'sections' }
      } else if (m) {
        const chunk: PacingChunk = {
          id: m[1],
          title: m[2].replace(RANGE_SUFFIX_RE, '').trim(),
          summary: '',
          beats: [],
        }
        plan.chunks.push(chunk)
        section = { kind: 'chunk', chunk }
      } else {
        section = null // unknown section — ignored
      }
      continue
    }
    if (!section) continue

    if (section.kind === 'chunk' && t.toLowerCase().startsWith('summary:')) {
      section.chunk!.summary = t.slice('summary:'.length).trim()
      continue
    }
    const beatMatch = BEAT_RE.exec(t)
    if (section.kind === 'chunk' && beatMatch) {
      beat = { code: beatMatch[1], narration: unquote(beatMatch[2]), images: [] }
      section.chunk!.beats.push(beat)
      tableCols = null
      continue
    }

    if (t.startsWith('|')) {
      const cells = parseRow(t)
      if (!tableCols) {
        tableCols = cells
        continue
      }
      if (isSeparatorRow(cells)) continue
      const cols = tableCols
      if (section.kind === 'meta') {
        const key = col(cols, cells, 'Field') || cells[0]
        const val = col(cols, cells, 'Value') || cells[1] || ''
        if (key) plan.meta[key] = val
      } else if (section.kind === 'sections') {
        const toRaw = col(cols, cells, 'To').trim().toLowerCase()
        const budget = (s: string): number | null => {
          const n = parseInt(s, 10)
          return Number.isFinite(n) && n >= 0 ? n : null
        }
        plan.sections.push({
          name: col(cols, cells, 'Name') || cells[0] || 'section',
          fromS: parseHold(col(cols, cells, 'From')),
          toS: toRaw === 'end' || toRaw === '' ? 'end' : parseHold(toRaw),
          imageBudget: budget(col(cols, cells, 'Image budget')),
          overlayBudget: budget(col(cols, cells, 'Overlay budget')),
        })
      } else if (section.kind === 'overlays') {
        plan.overlays.push({
          id: col(cols, cells, 'ID') || cells[0] || '',
          anchor: col(cols, cells, 'Anchor'),
          trigger: unquote(col(cols, cells, 'Trigger phrase') || col(cols, cells, 'Trigger')),
          what: col(cols, cells, 'Overlay'),
          holdS: parseHold(col(cols, cells, 'Hold')),
          placement: col(cols, cells, 'Placement') || 'centered',
        })
      } else if (section.kind === 'chunk' && beat) {
        beat.images.push({
          id: col(cols, cells, 'Img') || col(cols, cells, 'ID') || cells[0] || '',
          holdS: parseHold(col(cols, cells, 'Hold')),
          refs: col(cols, cells, 'Refs'),
          what: col(cols, cells, 'What'),
          why: col(cols, cells, 'Why now') || col(cols, cells, 'Why'),
        })
      }
      continue
    }
    // Any other prose line: tolerated and dropped (keeps the parser forgiving).
    if (t === '') tableCols = section.kind === 'chunk' ? tableCols : null
  }
  return plan
}

// --- derived timing & stats (computed, never stored) ---

export type TimedImage = PacingImage & {
  chunkId: string
  chunkTitle: string
  beatCode: string
  narration: string
  startS: number
}

export function timelineOf(plan: PacingPlan): TimedImage[] {
  let cursor = 0
  const out: TimedImage[] = []
  for (const c of plan.chunks)
    for (const b of c.beats)
      for (const img of b.images) {
        out.push({ ...img, chunkId: c.id, chunkTitle: c.title, beatCode: b.code, narration: b.narration, startS: cursor })
        cursor += img.holdS
      }
  return out
}

export const planDurationS = (plan: PacingPlan): number =>
  plan.chunks.reduce((n, c) => n + c.beats.reduce((m, b) => m + b.images.reduce((k, i) => k + i.holdS, 0), 0), 0)

export type PacingStats = {
  images: number
  chunks: number
  overlays: number
  runtimeS: number
  openingImages: number // images starting inside the first 45s (the retention window)
  bodyImages: number
  openingSecPerImage: number
  bodySecPerImage: number
}

export const OPENING_WINDOW_S = 45

export function pacingStats(plan: PacingPlan): PacingStats {
  const tl = timelineOf(plan)
  const runtimeS = planDurationS(plan)
  const opening = tl.filter((i) => i.startS < OPENING_WINDOW_S)
  const body = tl.length - opening.length
  const openingSpan = Math.min(runtimeS, OPENING_WINDOW_S)
  return {
    images: tl.length,
    chunks: plan.chunks.length,
    overlays: plan.overlays.length,
    runtimeS,
    openingImages: opening.length,
    bodyImages: body,
    openingSecPerImage: opening.length ? openingSpan / opening.length : 0,
    bodySecPerImage: body ? (runtimeS - openingSpan) / body : 0,
  }
}

export const fmtClock = (s: number): string =>
  `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

// Resolved sections with concrete end times and live counts. When the plan
// stores no sections, the house defaults apply (opening 0–45s, body 45–end)
// without being written to the file until the user edits them.
export type ResolvedSection = {
  name: string
  fromS: number
  toS: number
  imageBudget: number | null
  overlayBudget: number | null
  imageCount: number
  overlayCount: number
}

export function resolvedSections(plan: PacingPlan): ResolvedSection[] {
  const runtime = planDurationS(plan)
  const raw: PacingSection[] = plan.sections.length
    ? plan.sections
    : runtime > OPENING_WINDOW_S
      ? [
          { name: 'opening', fromS: 0, toS: OPENING_WINDOW_S, imageBudget: null, overlayBudget: null },
          { name: 'body', fromS: OPENING_WINDOW_S, toS: 'end', imageBudget: null, overlayBudget: null },
        ]
      : [{ name: 'opening', fromS: 0, toS: 'end', imageBudget: null, overlayBudget: null }]
  const tl = timelineOf(plan)
  return raw.map((s) => {
    const toS = s.toS === 'end' ? runtime : Math.min(s.toS, runtime)
    const inWindow = tl.filter((i) => i.startS >= s.fromS && i.startS < toS)
    const ids = new Set(inWindow.map((i) => i.id))
    return {
      name: s.name,
      fromS: s.fromS,
      toS,
      imageBudget: s.imageBudget,
      overlayBudget: s.overlayBudget,
      imageCount: inWindow.length,
      overlayCount: plan.overlays.filter((o) => ids.has(o.anchor)).length,
    }
  })
}

// --- serialize (canonical form; chunk ranges are re-derived every time) ---

const cell = (s: string): string => s.replace(/\|/g, '/').replace(/\n+/g, ' ').trim()

export function serializePacingPlan(plan: PacingPlan): string {
  const parts: string[] = [`# ${plan.title || 'Visual Pacing Plan'}`]

  parts.push('', '## Meta', '', '| Field | Value |', '|---|---|')
  for (const [k, v] of Object.entries(plan.meta)) parts.push(`| ${cell(k)} | ${cell(v)} |`)

  if (plan.sections.length > 0) {
    parts.push('', '## Sections', '')
    parts.push('| Name | From | To | Image budget | Overlay budget |', '|---|---|---|---|---|')
    for (const s of plan.sections)
      parts.push(
        `| ${cell(s.name)} | ${Math.round(s.fromS)}s | ${s.toS === 'end' ? 'end' : `${Math.round(s.toS)}s`} ` +
          `| ${s.imageBudget ?? '—'} | ${s.overlayBudget ?? '—'} |`,
      )
  }

  let cursor = 0
  for (const c of plan.chunks) {
    const chunkLen = c.beats.reduce((m, b) => m + b.images.reduce((k, i) => k + i.holdS, 0), 0)
    const range = `(${Math.round(cursor)}–${Math.round(cursor + chunkLen)}s)`
    cursor += chunkLen
    parts.push('', `## ${c.id} — ${cell(c.title)} ${range}`, '')
    if (c.summary) parts.push(`Summary: ${cell(c.summary)}`, '')
    for (const b of c.beats) {
      parts.push(`**Beat ${b.code}**: "${b.narration.replace(/"/g, '”')}"`, '')
      parts.push('| Img | Hold | Refs | What | Why now |', '|---|---|---|---|---|')
      for (const i of b.images)
        parts.push(`| ${cell(i.id)} | ${fmtHold(i.holdS)} | ${cell(i.refs) || '—'} | ${cell(i.what)} | ${cell(i.why)} |`)
      parts.push('')
    }
  }

  parts.push('## Overlays', '')
  parts.push('| ID | Anchor | Trigger phrase | Overlay | Hold | Placement |', '|---|---|---|---|---|---|')
  for (const o of plan.overlays)
    parts.push(
      `| ${cell(o.id)} | ${cell(o.anchor)} | "${o.trigger.replace(/"/g, '”')}" | ${cell(o.what)} | ${fmtHold(o.holdS)} | ${cell(o.placement)} |`,
    )

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

// A plan parses "well-formed" when it has at least one chunk and every chunk
// has at least one beat with at least one image. Used by the editor to decide
// structured view vs raw-markdown fallback.
export const planIsWellFormed = (plan: PacingPlan): boolean =>
  plan.chunks.length > 0 &&
  plan.chunks.every((c) => c.beats.length > 0 && c.beats.every((b) => b.images.length > 0))

// Next free image id (I01, I02… — house style from dev-log-11).
export function nextImageId(plan: PacingPlan): string {
  let max = 0
  for (const c of plan.chunks)
    for (const b of c.beats)
      for (const i of b.images) {
        const m = i.id.match(/(\d+)$/)
        if (m) max = Math.max(max, parseInt(m[1], 10))
      }
  return `I${String(max + 1).padStart(2, '0')}`
}

export function nextChunkId(plan: PacingPlan): string {
  let max = 0
  for (const c of plan.chunks) {
    const m = c.id.match(/(\d+)$/)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return `C${String(max + 1).padStart(3, '0')}`
}

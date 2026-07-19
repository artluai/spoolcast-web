import { parseWorldKit, serializeWorldKit } from './worldkit-md'
import { useWorkflowStore } from '../store/workflow'

// ONE SOURCE OF TRUTH FOR THE KIT. The mapping board, shot list, and
// generation step read the kit from the ENGINE (world-kit.md on disk), but
// step 5 edits live in the DRAFT until saved — links added there were
// invisible everywhere else. This overlay merges the draft's table data
// (kind, linked to, variant of, group, notes) over the engine payload, and
// adds draft-only rows (new audio objects) as image-less entries. Freshest
// truth wins; images still come from the engine (the draft has none).

export type KitEntry = {
  name: string
  kind: string
  notes: string
  image_path: string
  linked_to?: string
  variant_of?: string
  group?: string
  source?: string
  [k: string]: unknown
}

const col = (columns: string[], re: RegExp) => columns.findIndex((c) => re.test(c))

export function mergeKitWithDraft<T extends KitEntry>(kit: T[], draftMd: string): T[] {
  const md = (draftMd || '').trim()
  if (!md) return kit
  let doc
  try {
    doc = parseWorldKit(md)
  } catch {
    return kit
  }
  const byName = new Map<string, T>(kit.map((k) => [k.name, { ...k }]))
  const seen = new Set<string>()
  for (const sec of doc.sections) {
    if (sec.kind !== 'table') continue
    const iRef = col(sec.columns, /^ref$/i)
    if (iRef < 0) continue
    const iKind = col(sec.columns, /^kind$/i)
    const iLinked = col(sec.columns, /linked/i)
    const iVar = col(sec.columns, /variant/i)
    const iGroup = col(sec.columns, /^group$/i)
    const iSource = col(sec.columns, /^source$/i)
    const iNotes = col(sec.columns, /notes|description|beats/i)
    for (const row of sec.rows) {
      const name = (row[iRef] || '').trim()
      if (!name || name === '—' || seen.has(name)) continue
      seen.add(name)
      const patch: Partial<KitEntry> = {}
      if (iKind >= 0 && row[iKind]?.trim()) patch.kind = row[iKind].trim().toLowerCase()
      if (iLinked >= 0) patch.linked_to = (row[iLinked] || '').trim()
      if (iVar >= 0) patch.variant_of = (row[iVar] || '').trim()
      if (iGroup >= 0) patch.group = (row[iGroup] || '').trim()
      if (iSource >= 0) patch.source = (row[iSource] || '').trim()
      if (iNotes >= 0 && row[iNotes]?.trim()) patch.notes = row[iNotes].trim()
      const existing = byName.get(name)
      if (existing) byName.set(name, { ...existing, ...patch })
      else byName.set(name, { name, kind: 'reference', notes: '', image_path: '', ...patch } as T)
    }
  }
  // Rows deleted in the draft disappear here too — same source, same truth.
  return [...byName.values()].filter((k) => seen.has(k.name) || !k.name)
}

/** The unsaved step-5 draft markdown, or '' when none. */
export function useWorldKitDraft(): string {
  return useWorkflowStore((s) => s.stageDrafts['world_kit'] ?? '')
}

/**
 * Mirror a board-side audio link edit into the unsaved step-5 draft, so the
 * two edit routes never fight: the board writes the FILE (set_audio_link),
 * and when a draft exists the same cell changes there too — otherwise the
 * stale draft would overlay the fresh file and the edit would look ignored.
 */
export function patchDraftAudioLink(audioName: string, linkedTo: string): void {
  const store = useWorkflowStore.getState()
  const md = (store.stageDrafts['world_kit'] ?? '').trim()
  if (!md) return
  try {
    const doc = parseWorldKit(md)
    let changed = false
    for (const sec of doc.sections) {
      if (sec.kind !== 'table') continue
      const iRef = col(sec.columns, /^ref$/i)
      const iLinked = col(sec.columns, /linked/i)
      if (iRef < 0 || iLinked < 0) continue
      for (const row of sec.rows) {
        if ((row[iRef] || '').trim() === audioName) {
          row[iLinked] = linkedTo
          changed = true
        }
      }
    }
    if (changed) store.setStageDraft('world_kit', serializeWorldKit(doc))
  } catch {
    /* unparseable draft — the file edit still lands; draft resolves on save */
  }
}

/**
 * Mirror a backward shot-refs edit (attach/detach/first-frame from step 9)
 * into the unsaved PACING draft, same reason as the audio-link mirror: the
 * engine edits the plan FILE, and a live draft would otherwise overlay it
 * with the stale cell.
 */
export function patchDraftShotRefs(imageId: string, name: string, opts?: { detach?: boolean; firstFrame?: boolean }): void {
  const store = useWorkflowStore.getState()
  const md = store.stageDrafts['visual_pacing'] ?? ''
  if (!md.trim()) return
  const lines = md.split('\n')
  const rowRe = new RegExp(`^\\|\\s*${imageId}\\s*\\|`)
  let changed = false
  for (let i = 0; i < lines.length; i++) {
    const st = lines[i].trim()
    if (!rowRe.test(st)) continue
    const cells = st.replace(/^\|/, '').replace(/\|$/, '').split('|')
    if (cells.length < 3) continue
    let names = cells[2].split(',').map((n) => n.trim()).filter((n) => n && n !== '—' && n !== '-')
    const bare = names.map((n) => n.replace(/^\^/, ''))
    if (opts?.detach) {
      names = names.filter((n) => n.replace(/^\^/, '') !== name)
    } else {
      if (!bare.includes(name)) names.push(name)
      if (opts?.firstFrame) names = names.map((n) => n.replace(/^\^/, '')).map((n) => (n === name ? `^${n}` : n))
    }
    cells[2] = ` ${names.join(', ')} `
    lines[i] = `| ${cells.map((c) => c.trim()).join(' | ')} |`
    changed = true
    break
  }
  if (changed) store.setStageDraft('visual_pacing', lines.join('\n'))
}

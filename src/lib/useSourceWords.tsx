import { useEffect, useState } from 'react'
import { fileUrl } from './api'

/**
 * Word count of the session's cataloged source material — counted from
 * working/asset-inventory.md, because that is literally what the AI drafters
 * read. Thin source = thin (or invented) drafts, so the UI warns near every
 * AI drafting button when this number is low.
 */
export function useSourceWords(): number | null {
  const [words, setWords] = useState<number | null>(null)
  useEffect(() => {
    fetch(fileUrl('working/asset-inventory.md'))
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        if (out?.ok && out.data?.exists && typeof out.data.content === 'string') {
          // Count only the inlined text contents, not the table/header plumbing.
          const body = out.data.content
            .split('\n')
            .filter((l: string) => !l.startsWith('|') && !l.startsWith('#') && !l.startsWith('Generated:') && !l.startsWith('Session:') && l.trim() !== '```')
            .join(' ')
          setWords(body.split(/\s+/).filter(Boolean).length)
        } else {
          setWords(0)
        }
      })
      .catch(() => setWords(null))
  }, [])
  return words
}

export const THIN_SOURCE_LIMIT = 200

export function ThinSourceNote({ words }: { words: number | null }) {
  // Dismissible, and the dismissal sticks for the session's browser — the
  // warning earns its keep once, not on every visit to every step.
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem('sc-thin-note-hidden') === '1' } catch { return false }
  })
  if (hidden || words === null || words >= THIN_SOURCE_LIMIT) return null
  return (
    <span style={{ color: 'var(--amber)', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      ⚠ drafting from only {words} words of source — results may be thin. Add material in the Video idea step.
      <button
        type="button"
        title="Hide this note"
        onClick={() => {
          setHidden(true)
          try { localStorage.setItem('sc-thin-note-hidden', '1') } catch { /* private mode */ }
        }}
        style={{ background: 'none', border: '1px solid var(--line-2)', color: 'var(--ink-3)', borderRadius: 5, fontSize: 10, lineHeight: 1, padding: '2px 6px', cursor: 'pointer' }}
      >
        ×
      </button>
    </span>
  )
}

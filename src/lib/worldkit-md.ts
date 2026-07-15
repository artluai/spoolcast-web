// Parse/serialize the world-kit.md house format (## sections containing either
// a markdown table or prose). The structured editor is a VIEW over the same
// markdown draft the engine reads — every edit round-trips through serialize,
// so save/approve/dirty-tracking stay untouched.

export type WKSection =
  | { heading: string; kind: 'table'; columns: string[]; rows: string[][] }
  | { heading: string; kind: 'text'; text: string }

export type WKDoc = { title: string; sections: WKSection[] }

// Cells are single markdown-table lines; real newlines ride as <br> (the
// standard markdown-table escape) and are decoded back for the editor.
const parseRow = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim().replace(/<br\s*\/?>/gi, '\n'))

export function parseWorldKit(md: string): WKDoc {
  const lines = md.split('\n')
  let title = ''
  const sections: WKSection[] = []
  let heading: string | null = null
  let buf: string[] = []

  const flush = () => {
    if (heading === null) return
    const tableLines: string[] = []
    const proseLines: string[] = []
    let inTable = false
    for (const l of buf) {
      if (l.trim().startsWith('|')) {
        inTable = true
        tableLines.push(l)
      } else if (!inTable || l.trim() !== '') {
        if (!l.trim().startsWith('|')) proseLines.push(l)
      }
    }
    if (tableLines.length >= 2) {
      const columns = parseRow(tableLines[0])
      const rows = tableLines
        .slice(2) // skip header + separator
        .map(parseRow)
        .map((r) => {
          const row = r.slice(0, columns.length)
          while (row.length < columns.length) row.push('')
          return row
        })
      sections.push({ heading, kind: 'table', columns, rows })
    } else {
      sections.push({ heading, kind: 'text', text: buf.join('\n').trim() })
    }
    heading = null
    buf = []
  }

  for (const line of lines) {
    if (line.startsWith('# ') && !title && heading === null) {
      title = line.slice(2).trim()
      continue
    }
    if (line.startsWith('## ')) {
      flush()
      heading = line.slice(3).trim()
      continue
    }
    if (heading !== null) buf.push(line)
  }
  flush()
  return { title, sections }
}

export function serializeWorldKit(doc: WKDoc): string {
  const parts: string[] = [`# ${doc.title || 'World Kit'}`]
  for (const s of doc.sections) {
    parts.push('', `## ${s.heading}`, '')
    if (s.kind === 'table') {
      parts.push(`| ${s.columns.join(' | ')} |`)
      parts.push(`|${s.columns.map(() => '---').join('|')}|`)
      for (const r of s.rows) parts.push(`| ${r.map((c) => c.replace(/\|/g, '/').replace(/\n+/g, '<br>')).join(' | ')} |`)
    } else if (s.text) {
      parts.push(s.text)
    }
  }
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

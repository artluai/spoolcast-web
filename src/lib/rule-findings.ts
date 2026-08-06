export type RuleFinding = {
  kind?: string
  rule_id?: string
  message?: string
}

export function ruleFindingMessage(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value
    .map((item) => (
      item && typeof item === 'object'
        ? String((item as RuleFinding).message || '').trim()
        : ''
    ))
    .filter(Boolean)
    .join(' ')
}

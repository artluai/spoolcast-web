// Append a user-written rule to one of the rulebooks, from anywhere in the
// UI. Rules land under a "## User-added rules" section at the end of the
// file — the same file every AI drafter reads fresh on its next run, so the
// rule applies immediately. Returns true or an error message.

export const SERIES_RULES_ID = 'series:spoolcast-devlog:rules' // session-id debt, like elsewhere

export async function appendUserRule(ruleId: string, text: string): Promise<true | string> {
  const clean = text.trim().replace(/\s*\n+\s*/g, ' ')
  if (!clean) return 'The rule is empty.'
  try {
    const r = await fetch('http://localhost:8000/api/rules?session=spoolcast-dev-log-12')
    const out = await r.json().catch(() => null)
    const rule = out?.ok ? (out.data?.rules || []).find((x: { id: string }) => x.id === ruleId) : null
    if (!rule) return 'Could not load the rulebook from the engine.'
    const header = '## User-added rules'
    let content: string = String(rule.content).replace(/\s+$/, '')
    content += content.includes(header)
      ? `\n- ${clean}\n`
      : `\n\n${header}\n\nRules added from the app — every AI draft works under these.\n\n- ${clean}\n`
    const save = await fetch('http://localhost:8000/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: 'spoolcast-dev-log-12',
        tenant: 'local',
        action: 'set_rule_file',
        rule_id: ruleId,
        content,
      }),
    })
    const saved = await save.json().catch(() => null)
    if (!save.ok || saved?.ok === false) return saved?.message || saved?.error || 'Could not save the rule.'
    return true
  } catch {
    return 'Could not reach the engine.'
  }
}

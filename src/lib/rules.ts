// Append a user-written rule to one of the rulebooks, from anywhere in the
// UI. Rules land under a "## User-added rules" section at the end of the
// file — the same file every AI drafter reads fresh on its next run, so the
// rule applies immediately. Returns true or an error message.

import { actionUrl, activeSession, apiUrl } from './api'

export const SERIES_RULES_ID = 'series:spoolcast-devlog:rules' // session-id debt, like elsewhere

export const USER_RULES_HEADER = '## User-added rules'

export type RuleResult = { ok: true; content: string } | { ok: false; error: string }

// Save a full rulebook (used by per-rule edit/remove in the wiki).
export async function saveRuleContent(ruleId: string, content: string): Promise<RuleResult> {
  return saveRuleFile(ruleId, content)
}

async function saveRuleFile(ruleId: string, content: string): Promise<RuleResult> {
  const save = await fetch(actionUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session: activeSession(),
      tenant: 'local',
      action: 'set_rule_file',
      rule_id: ruleId,
      content,
    }),
  })
  const saved = await save.json().catch(() => null)
  if (!save.ok || saved?.ok === false)
    return { ok: false, error: saved?.message || saved?.error || 'Could not save the rulebook.' }
  return { ok: true, content }
}

async function loadRuleContent(ruleId: string): Promise<string | null> {
  const r = await fetch(apiUrl('rules', { session: activeSession() }))
  const out = await r.json().catch(() => null)
  const rule = out?.ok ? (out.data?.rules || []).find((x: { id: string }) => x.id === ruleId) : null
  return rule ? String(rule.content) : null
}

export async function appendUserRule(ruleId: string, text: string): Promise<RuleResult> {
  // Rules state the principle; specific worked examples get copied verbatim
  // into drafts, so "(e.g. …)" / "(for example …)" parentheticals are stripped.
  const clean = text
    .trim()
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s*\((?:e\.g\.|eg\.|for example|example)[^)]*\)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (!clean) return { ok: false, error: 'The rule is empty.' }
  try {
    const current = await loadRuleContent(ruleId)
    if (current === null) return { ok: false, error: 'Could not load the rulebook from the engine.' }
    const today = new Date().toISOString().slice(0, 10)
    const entry = `- ${clean} *(added ${today})*`
    let content = current.replace(/\s+$/, '')
    content += content.includes(USER_RULES_HEADER)
      ? `\n${entry}\n`
      : `\n\n${USER_RULES_HEADER}\n\nRules added from the app — every AI draft works under these.\n\n${entry}\n`
    return await saveRuleFile(ruleId, content)
  } catch {
    return { ok: false, error: 'Could not reach the engine.' }
  }
}

// "Set to default": remove the whole User-added rules section (it is always
// the last section, because this lib only ever appends it at the end).
export async function removeUserRules(ruleId: string): Promise<RuleResult> {
  try {
    const current = await loadRuleContent(ruleId)
    if (current === null) return { ok: false, error: 'Could not load the rulebook from the engine.' }
    const idx = current.indexOf(USER_RULES_HEADER)
    if (idx < 0) return { ok: false, error: 'This rulebook has no user-added rules.' }
    const content = current.slice(0, idx).replace(/\s+$/, '') + '\n'
    return await saveRuleFile(ruleId, content)
  } catch {
    return { ok: false, error: 'Could not reach the engine.' }
  }
}

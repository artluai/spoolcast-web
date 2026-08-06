import { useEffect, useMemo, useState } from 'react'
import { postAction } from '../lib/api'

export type RuleScope = 'global' | 'user' | 'template' | 'series' | 'video'

type Permission = { available: boolean; can_edit: boolean; reason?: string }
type RuleChainItem = {
  scope: RuleScope
  operation: 'add' | 'override' | 'disable' | 're-enable'
  changes?: Record<string, unknown>
  reason?: string
  legacy?: boolean
}
export type ResolvedRule = {
  id: string
  text: string
  applies_to: string[]
  enabled: boolean
  reason?: string
  origin_scope: RuleScope
  effective_scope: RuleScope
  chain: RuleChainItem[]
}

type RulesPayload = {
  rules?: ResolvedRule[]
  permissions?: Record<RuleScope, Permission>
  context?: { template?: string; series?: string; video?: string; step?: string }
}

const SCOPE_LABEL: Record<RuleScope, string> = {
  global: 'Global',
  user: 'My account',
  template: 'Template',
  series: 'Series',
  video: 'This video',
}

const SCOPE_ORDER: RuleScope[] = ['global', 'user', 'template', 'series', 'video']

const slugify = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 42) || 'rule'

function ChoiceMenu<T extends string>({
  label,
  value,
  choices,
  onChange,
  bare = false,
}: {
  label: string
  value: T
  choices: { value: T; label: string; note?: string; disabled?: boolean }[]
  onChange: (value: T) => void
  // Badge form: the button shows only the active value (used as each rule's
  // level tag); the opened menu still carries the full label as its header.
  bare?: boolean
}) {
  const [open, setOpen] = useState(false)
  const active = choices.find((choice) => choice.value === value)
  return (
    <span className={`rule-choice-wrap${bare ? ' bare' : ''}`}>
      <button
        type="button"
        className="vp-menu-btn rule-choice-btn"
        aria-expanded={open}
        title={bare ? label : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        {bare ? <>{active?.label ?? value} ▾</> : <>{label}: {active?.label ?? value} ▾</>}
      </button>
      {open ? (
        <>
          <span className="vp-menu-backdrop" onClick={() => setOpen(false)} />
          <span className="vp-menu rule-choice-menu">
            <span className="vp-menu-h">{label.toUpperCase()}</span>
            {choices.map((choice) => (
              <button
                type="button"
                key={choice.value}
                className={choice.value === value ? 'on' : ''}
                disabled={choice.disabled}
                onClick={() => {
                  onChange(choice.value)
                  setOpen(false)
                }}
              >
                <span className="vg-select-choice">
                  <span className={`vg-menu-check ${choice.value === value ? 'on' : ''}`} />
                  {choice.label}
                </span>
                {choice.note ? <small>{choice.note}</small> : null}
              </button>
            ))}
          </span>
        </>
      ) : null}
    </span>
  )
}

export function ResolvedRules({
  step,
  forAction,
  addToken,
  compact = false,
  hidden = false,
  onCountChange,
  onToast,
}: {
  step?: string
  // Narrow to ONE writing action's rule audience (engine get_rules
  // for_action) — e.g. the publish step's title/desc panel vs its thumbnail
  // panel share a stage but keep separate rule sets.
  forAction?: string
  // The applies_to token new/edited rules get by default (e.g.
  // 'packaging-copy'), so panel-added rules stay inside this audience.
  addToken?: string
  compact?: boolean
  hidden?: boolean
  onCountChange?: (count: number) => void
  onToast?: (message: string) => void
}) {
  const [rules, setRules] = useState<ResolvedRule[] | null>(null)
  const [permissions, setPermissions] = useState<Record<RuleScope, Permission> | null>(null)
  const [context, setContext] = useState<RulesPayload['context']>({})
  const [error, setError] = useState('')
  const [targetScope, setTargetScope] = useState<RuleScope>('video')
  const [targetApplies, setTargetApplies] = useState(addToken ?? (step ? `stage:${step}` : 'writing'))
  const [newText, setNewText] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string; applies: string } | null>(null)
  const [disabling, setDisabling] = useState<{ id: string; reason: string } | null>(null)
  const [busyId, setBusyId] = useState('')
  const [historyFor, setHistoryFor] = useState('')
  const [suggesting, setSuggesting] = useState(false)
  const [suggestions, setSuggestions] = useState<{ id: string; text: string }[]>([])

  const load = async () => {
    const out = await postAction<RulesPayload>({
      action: 'get_rules',
      ...(step ? { step } : {}),
      ...(forAction ? { for_action: forAction } : {}),
    })
    if (!out?.ok) {
      setError(out?.error || 'Could not load rules from the engine.')
      return
    }
    const nextRules = out.data?.rules ?? []
    const nextPermissions = out.data?.permissions ?? null
    setRules(nextRules)
    setPermissions(nextPermissions)
    setContext(out.data?.context ?? {})
    setError('')
    onCountChange?.(nextRules.filter((rule) => rule.enabled).length)
    if (nextPermissions && !nextPermissions[targetScope]?.can_edit) {
      const fallback = [...SCOPE_ORDER].reverse().find((scope) => nextPermissions[scope]?.can_edit)
      if (fallback) setTargetScope(fallback)
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  const scopeChoices = useMemo(
    () =>
      SCOPE_ORDER.map((scope) => {
        const permission = permissions?.[scope]
        const detail =
          scope === 'template' && context?.template
            ? context.template
            : scope === 'series' && context?.series
              ? context.series
              : permission?.reason
        return {
          value: scope,
          label: SCOPE_LABEL[scope],
          note: detail,
          disabled: !permission?.available || !permission?.can_edit,
        }
      }),
    [context, permissions],
  )

  const applicabilityChoices = useMemo(() => {
    const values = new Set<string>(['writing'])
    if (step) values.add(`stage:${step}`)
    for (const rule of rules ?? []) {
      for (const value of rule.applies_to) values.add(value)
    }
    return [...values].map((value) => ({
      value,
      label: value === 'writing' ? 'Writing' : value.startsWith('stage:') ? value.slice(6).replaceAll('_', ' ') : value,
    }))
  }, [rules, step])

  const mutate = async (payload: Record<string, unknown>, id: string) => {
    setBusyId(id)
    const out = await postAction<RulesPayload>(payload)
    setBusyId('')
    if (!out?.ok) {
      const message = out?.message || out?.error || 'Could not save the rule.'
      setError(message)
      onToast?.(`Engine: ${message}`)
      return false
    }
    await load()
    return true
  }

  const saveEdit = async () => {
    if (!editing?.text.trim()) return
    const ok = await mutate({
      action: 'set_rule',
      scope: targetScope,
      id: editing.id,
      text: editing.text.trim(),
      applies_to: [editing.applies],
    }, editing.id)
    if (ok) setEditing(null)
  }

  const addRule = async (text = newText) => {
    const clean = text.trim()
    if (!clean) return
    const suffix = globalThis.crypto?.randomUUID?.().slice(0, 7) ?? String(Date.now()).slice(-7)
    const id = `${slugify(clean)}-${suffix}`.slice(0, 60)
    const ok = await mutate({
      action: 'set_rule',
      scope: targetScope,
      id,
      text: clean,
      applies_to: [targetApplies],
    }, id)
    if (ok) setNewText('')
  }

  const setRuleState = async (rule: ResolvedRule, state: 'enabled' | 'disabled', reason = '') => {
    const ok = await mutate({
      action: 'set_rule_state',
      scope: targetScope,
      id: rule.id,
      state,
      reason: reason || (state === 'enabled' ? `Re-enabled for ${SCOPE_LABEL[targetScope]}.` : ''),
    }, rule.id)
    if (ok) setDisabling(null)
  }

  // "Change this rule's level": take control of the rule at the chosen layer
  // by writing it there with its current wording — the same override semantics
  // as the panel-wide selector, scoped to one rule.
  const moveRule = async (rule: ResolvedRule, scope: RuleScope) => {
    if (scope === rule.effective_scope) return
    await mutate({
      action: 'set_rule',
      scope,
      id: rule.id,
      text: rule.text,
      applies_to: rule.applies_to.length ? rule.applies_to : [targetApplies],
    }, rule.id)
  }

  const resetSelectedOverride = async (rule: ResolvedRule) => {
    await mutate({
      action: 'delete_rule_override',
      scope: targetScope,
      id: rule.id,
    }, rule.id)
  }

  const suggest = async () => {
    if (!step) return
    setSuggesting(true)
    const out = await postAction<{ suggestions?: { id: string; text: string }[] }>({
      action: 'suggest_rules',
      step,
      allow_cost: true,
    })
    setSuggesting(false)
    if (out?.ok) setSuggestions(out.data?.suggestions ?? [])
    else onToast?.(`Engine: ${out?.error || out?.message || 'could not suggest rules.'}`)
  }

  if (hidden) return null
  if (rules === null) return <div className="resolved-rules-loading"><span className="spin" /> Loading rules…</div>

  return (
    <div className={`resolved-rules ${compact ? 'compact' : ''}`}>
      {error ? <p className="resolved-rules-error">{error}</p> : null}
      <div className="resolved-rules-tools">
        <ChoiceMenu label="Changes apply to" value={targetScope} choices={scopeChoices} onChange={setTargetScope} />
        <ChoiceMenu label="Applies to" value={targetApplies} choices={applicabilityChoices} onChange={setTargetApplies} />
        <span className="resolved-rules-help">
          Parent defaults stay intact. Changes here create an override at the selected layer.
        </span>
      </div>

      <div className="resolved-rules-list">
        {rules.length === 0 ? (
          <p className="resolved-rules-empty">No effective rules match this context yet.</p>
        ) : rules.map((rule) => {
          const selectedIndex = SCOPE_ORDER.indexOf(targetScope)
          const originIndex = SCOPE_ORDER.indexOf(rule.origin_scope)
          const effectiveIndex = SCOPE_ORDER.indexOf(rule.effective_scope)
          const canOverride =
            selectedIndex >= originIndex
            && selectedIndex >= effectiveIndex
            && permissions?.[targetScope]?.can_edit
          const hasSelectedOverride = rule.chain.some((item) => item.scope === targetScope)
          return (
            <div key={rule.id} className={`resolved-rule-row ${rule.enabled ? '' : 'disabled'}`}>
              <input
                type="checkbox"
                checked={rule.enabled}
                disabled={!canOverride || busyId === rule.id}
                title={
                  rule.enabled
                    ? `Disable with a reason for ${SCOPE_LABEL[targetScope]}`
                    : `Explicitly re-enable for ${SCOPE_LABEL[targetScope]}`
                }
                onChange={(event) => {
                  if (event.target.checked) void setRuleState(rule, 'enabled')
                  else setDisabling({ id: rule.id, reason: '' })
                }}
              />
              <div className="resolved-rule-main">
                {editing?.id === rule.id ? (
                  <div className="resolved-rule-edit">
                    <textarea
                      autoFocus
                      rows={2}
                      value={editing.text}
                      onChange={(event) => setEditing({ ...editing, text: event.target.value })}
                    />
                    <div className="resolved-rule-edit-actions">
                      <ChoiceMenu
                        label="Applies to"
                        value={editing.applies}
                        choices={applicabilityChoices}
                        onChange={(value) => setEditing({ ...editing, applies: value })}
                      />
                      <button type="button" className="vp-undo" disabled={!editing.text.trim() || busyId === rule.id} onClick={() => void saveEdit()}>
                        Save override
                      </button>
                      <button type="button" className="vp-undo" onClick={() => setEditing(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="resolved-rule-line">
                      <button
                        type="button"
                        className="resolved-rule-text"
                        disabled={!canOverride}
                        title={canOverride ? `Edit by creating a ${SCOPE_LABEL[targetScope]} override` : permissions?.[targetScope]?.reason}
                        onClick={() => setEditing({
                          id: rule.id,
                          text: rule.text,
                          applies: rule.applies_to[0] ?? targetApplies,
                        })}
                      >
                        {rule.text}
                      </button>
                      <span className="resolved-rule-level">
                        <ChoiceMenu
                          bare
                          label="Rule level"
                          value={rule.effective_scope}
                          choices={scopeChoices}
                          onChange={(scope) => void moveRule(rule, scope)}
                        />
                        {/* Provenance earns UI only when there is a story: a
                            single-entry chain is just "this layer wrote it",
                            so no affordance and no row is spent. */}
                        {rule.chain.length > 1 || hasSelectedOverride ? (
                          <button
                            type="button"
                            className="resolved-rule-history"
                            title="Where this rule's wording came from"
                            onClick={() => setHistoryFor(historyFor === rule.id ? '' : rule.id)}
                          >
                            {historyFor === rule.id ? '▾' : '▸'}
                          </button>
                        ) : null}
                      </span>
                    </div>
                    {!rule.enabled ? (
                      <p className="resolved-rule-reason">
                        Disabled{rule.reason ? `: ${rule.reason}` : '.'}
                      </p>
                    ) : null}
                    {historyFor === rule.id ? (
                      <div className="resolved-rule-chain">
                        {rule.chain.map((item, index) => (
                          <span key={`${item.scope}-${index}`}>
                            {SCOPE_LABEL[item.scope]} {item.operation.replace('-', ' ')}
                            {item.reason ? ` — ${item.reason}` : ''}
                          </span>
                        ))}
                        {hasSelectedOverride && permissions?.[targetScope]?.can_edit ? (
                          <button
                            type="button"
                            className="vp-undo"
                            disabled={busyId === rule.id}
                            onClick={() => void resetSelectedOverride(rule)}
                          >
                            Reset {SCOPE_LABEL[targetScope]} change
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                )}
                {disabling?.id === rule.id ? (
                  <div className="resolved-rule-disable">
                    <input
                      autoFocus
                      value={disabling.reason}
                      onChange={(event) => setDisabling({ ...disabling, reason: event.target.value })}
                      placeholder={`Why is this disabled for ${SCOPE_LABEL[targetScope]}?`}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && disabling.reason.trim()) {
                          void setRuleState(rule, 'disabled', disabling.reason.trim())
                        }
                        if (event.key === 'Escape') setDisabling(null)
                      }}
                    />
                    <button
                      type="button"
                      className="vp-undo"
                      disabled={!disabling.reason.trim() || busyId === rule.id}
                      onClick={() => void setRuleState(rule, 'disabled', disabling.reason.trim())}
                    >
                      Disable rule
                    </button>
                    <button type="button" className="vp-undo" onClick={() => setDisabling(null)}>Cancel</button>
                  </div>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>

      <div className="resolved-rule-add">
        <input
          value={newText}
          onChange={(event) => setNewText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && newText.trim()) void addRule()
          }}
          placeholder={step ? 'Add a rule for this step…' : 'Add an effective writing rule…'}
        />
        <button type="button" className="vp-undo" disabled={!newText.trim() || Boolean(busyId)} onClick={() => void addRule()}>
          ＋ Add rule
        </button>
        {step ? (
          <button type="button" className="save-continue resolved-rule-suggest" disabled={suggesting} onClick={() => void suggest()}>
            {suggesting ? <><span className="spin" /> Suggesting…</> : '✦ Suggest rules with AI'}
          </button>
        ) : null}
      </div>

      {suggestions.length ? (
        <div className="resolved-rule-suggestions">
          <span className="vp-menu-h">SUGGESTIONS — ADD THE ONES YOU WANT</span>
          {suggestions.map((suggestion) => (
            <div key={suggestion.id}>
              <span>{suggestion.text}</span>
              <button
                type="button"
                className="vp-undo"
                onClick={async () => {
                  await addRule(suggestion.text)
                  setSuggestions((current) => current.filter((item) => item.id !== suggestion.id))
                }}
              >
                ＋ Add
              </button>
              <button type="button" className="resolved-rule-dismiss" onClick={() => setSuggestions((current) => current.filter((item) => item.id !== suggestion.id))}>×</button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

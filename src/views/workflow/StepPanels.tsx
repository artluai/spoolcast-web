import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { Pill } from '../../components/common/Pill'
import { asset } from '../../lib/assets'
import { actionUrl, activeSession, apiUrl, contentUrl, fileUrl, globalContentUrl, jobsUrl, notifySessionConfigurationChanged, postAction, researchJobStorageKey, seriesUrl, statusUrl, templatesUrl, TENANT } from '../../lib/api'
import { DEFAULT_MODEL_ID, draftReasoning } from '../../lib/draft-models'
import { appendUserRule } from '../../lib/rules'
import { ruleFindingMessage, type RuleFinding } from '../../lib/rule-findings'
import { styleThumbs } from '../../data/cast'
import { TEMPLATE_ART } from '../../data/picker'
import { INHERITED_COMPONENTS, SCAN_SUGGESTIONS, type TplRule } from '../../data/template-rules'
import { useWorkflowStore, type Goal, type S1 } from '../../store/workflow'
import { ModelPicker } from './ModelPicker'

const VOICE_RULES_ID = 'series:spoolcast-devlog:voice'
const WORLD_KIT_PRONUNCIATION_HEADER = '## Pronunciation / TTS Rules'

function parsePronunciationLines(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*-\s*`?([^`=\-:>]+?)`?\s*(?:->|=>|=|:)\s*`?([^`]+?)`?\s*$/)
    if (!match) continue
    const word = match[1].trim()
    const alias = match[2].trim()
    if (word && alias) out[word] = alias
  }
  return out
}

function upsertWorldKitPronunciationRule(content: string, word: string, alias: string) {
  const line = `- \`${word}\` -> \`${alias}\``
  const trimmed = content.replace(/\s+$/, '')
  const headerIndex = trimmed.indexOf(WORLD_KIT_PRONUNCIATION_HEADER)
  if (headerIndex < 0) {
    return `${trimmed}\n\n${WORLD_KIT_PRONUNCIATION_HEADER}\n${line}\n`
  }
  const before = trimmed.slice(0, headerIndex)
  const section = trimmed.slice(headerIndex)
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const existing = new RegExp(`^-\\s*\`?${escaped}\`?\\s*(?:->|=>|=|:).*$`, 'm')
  const nextSection = existing.test(section) ? section.replace(existing, line) : `${section}\n${line}`
  return `${before}${nextSection}\n`
}

// Closing card of the last step (Package & publish): once the video exists,
// offer to immortalize its setup. The kind is predetermined — a brand-new/
// standalone video saves a NEW format template; a video that came from an
// existing series saves a SUBTEMPLATE (a new episode pattern). If the format
// never diverged from what it started from, there's nothing new to save, so
// the action is greyed out.
export function SaveTemplateContent({
  origin,
  formatDirty,
  onToast,
}: {
  origin: 'blank' | 'template' | 'series'
  formatDirty: boolean
  onToast: (message: string) => void
}) {
  const s1 = useWorkflowStore((s) => s.s1)
  const kind: 'template' | 'subtemplate' = origin === 'series' ? 'subtemplate' : 'template'
  // a brand-new video is always worth saving as a template; otherwise only once
  // the inherited format has actually been changed.
  const canSave = origin === 'blank' || formatDirty
  const kindLabel = kind === 'subtemplate' ? 'series template' : 'reusable template'
  const [name, setName] = useState(s1.projectId || '')
  const [locks, setLocks] = useState<Record<string, boolean>>({
    format: true,
    style: true,
    structure: kind === 'subtemplate',
    worldkit: kind === 'subtemplate',
  })
  const lockRows: [string, string][] = [
    ['format', 'Format & canvas'],
    ['style', 'Visual style'],
    ['structure', 'Structure outline'],
    ['worldkit', 'World Kit'],
  ]
  return (
    <div className="save-tpl">
      <div className="save-tpl-card">
        <span className="eyebrow">REUSE THIS SETUP</span>
        <h3>Save as a {kindLabel}</h3>
        <p>
          {canSave
            ? kind === 'subtemplate'
              ? 'Save this as a new episode pattern under the series — pick what every future episode inherits.'
              : 'Save this video’s format so your next project can start from it instead of from scratch.'
            : 'Nothing has changed from the template yet — edit the format, structure, or cast to save a new version.'}
        </p>
        {canSave ? (
          <div className="st-detail">
            <label className="st-field">
              <span>{kind === 'subtemplate' ? 'Subtemplate name' : 'Template name'}</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={kind === 'subtemplate' ? 'e.g. Morning drop' : 'e.g. Spoolcast dev-log'}
              />
            </label>
            <div className="st-locks-wrap">
              <span className="st-locks-label">What carries over to every new video</span>
              <div className="st-locks">
                {lockRows.map(([k, label]) => (
                  <label key={k} className="st-lock">
                    <input
                      type="checkbox"
                      checked={locks[k]}
                      onChange={(e) => setLocks((l) => ({ ...l, [k]: e.target.checked }))}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              <span className="st-locks-hint">Unchecked items stay open — chosen fresh for each new video.</span>
            </div>
            <AdditionalTemplateRules />
          </div>
        ) : null}
        <button
          className="st-save"
          disabled={!canSave || !name.trim()}
          onClick={() => {
            if (!canSave || !name.trim()) return
            onToast(`Saved “${name.trim()}” as a ${kindLabel}.`)
          }}
        >
          Save {kind === 'subtemplate' ? 'subtemplate' : 'template'} →
        </button>
      </div>
    </div>
  )
}

export function AdditionalTemplateRules() {
  const idRef = useRef(0)
  const nextId = () => (idRef.current += 1)
  const [rules, setRules] = useState<TplRule[]>([])
  const [open, setOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [manual, setManual] = useState('')
  const [focus, setFocus] = useState('')
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null)

  // each rule's text is an editable, auto-growing textarea — tap in to edit.
  const grow = (el: HTMLTextAreaElement | null) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  // any rule shown here is carried into the template on Save — there's no
  // separate confirm step; removing one (the ✕) is the only opt-out.
  const addRules = (incoming: Omit<TplRule, 'id'>[]) =>
    setRules((prev) => {
      const have = new Set(prev.map((r) => r.text))
      const fresh = incoming.filter((r) => !have.has(r.text)).map((r) => ({ ...r, id: nextId() }))
      return [...prev, ...fresh]
    })

  const addManual = () => {
    const text = manual.trim()
    if (!text) return
    setRules((prev) => [...prev, { id: nextId(), category: 'Custom', text }])
    setManual('')
  }

  const scanFocused = () => {
    const term = focus.trim()
    if (!term) return
    addRules([
      {
        category: 'Humor',
        text: `Lean into ${term} — keep the tone consistent with the pilot.`,
        source: 'Source: Screenplay · Scene 2',
      },
      {
        category: 'Visual motif',
        text: `Carry the ${term} motif into title cards and recurring beats.`,
        source: 'Source: Storyboard · Beat 6',
      },
    ])
    setFocus('')
  }

  return (
    <div className={`tpl-rules ${open ? 'open' : ''}`}>
      <button className="tpl-rules-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="st-locks-label">Additional template rules</span>
        <svg
          className={`tpl-chevron ${open ? 'open' : ''}`}
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {!open ? null : (
        <>
          <p className="tpl-rules-lede">
            Reusable show behavior the checklist can’t capture — humor, overlays, captions,
            recurring memes, motifs.
          </p>

          <div className="tpl-input-row">
            <input
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addManual()
              }}
              placeholder="Example: End each video with a notification-style teaser card."
            />
            <button className="tpl-btn" disabled={!manual.trim()} onClick={addManual}>
              Add rule
            </button>
          </div>

          <div className="tpl-or-sep">or</div>

          <button
            className={`ai-btn tpl-ai-toggle ${aiOpen ? 'sel' : ''}`}
            onClick={() => setAiOpen((o) => !o)}
            aria-expanded={aiOpen}
          >
            <span className="ap-spark">✦</span> Let AI decide
            <svg
              className={`tpl-chevron ${aiOpen ? 'open' : ''}`}
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          {aiOpen ? (
            <div className="tpl-scan">
              <button className="tpl-scan-btn" onClick={() => addRules(SCAN_SUGGESTIONS)}>
                <span className="ap-spark">✦</span> Scan project for reusable rules
              </button>
              <span className="scan-note">
                AI reviews the structure, screenplay, storyboard, cast, and final output, then
                suggests rules to carry forward.
              </span>
              <span className="tpl-or-line">or focus on something specific</span>
              <div className="tpl-input-row">
                <input
                  value={focus}
                  onChange={(e) => setFocus(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') scanFocused()
                  }}
                  placeholder="Example: dark humor, title cards, recurring memes"
                />
                <button className="tpl-btn ai" disabled={!focus.trim()} onClick={scanFocused}>
                  <span className="ap-spark">✦</span> Scan with focus
                </button>
              </div>
            </div>
          ) : null}

      {rules.length ? (
        <div className="tpl-rule-list">
          {rules.map((r) => (
            <div key={r.id} className="tpl-rule">
              <div className="tpl-rule-top">
                <span className="tpl-rule-cat">{r.category}</span>
                <button
                  className="tpl-rule-x"
                  aria-label="Remove rule"
                  onClick={() => setConfirmRemove(r.id)}
                >
                  ✕
                </button>
              </div>
              <textarea
                className="tpl-rule-field"
                value={r.text}
                rows={1}
                ref={grow}
                onChange={(e) => {
                  grow(e.target)
                  setRules((prev) =>
                    prev.map((x) => (x.id === r.id ? { ...x, text: e.target.value } : x)),
                  )
                }}
              />
              {r.source ? <span className="tpl-rule-src">{r.source}</span> : null}
            </div>
          ))}
            </div>
          ) : null}

          {confirmRemove != null ? (
            <div className="modal-scrim" onClick={() => setConfirmRemove(null)}>
              <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
                <h3>Remove this rule?</h3>
                <p>It won’t be carried forward into the template. This can’t be undone.</p>
                <div className="actions">
                  <button onClick={() => setConfirmRemove(null)}>Cancel</button>
                  <button
                    className="primary"
                    onClick={() => {
                      setRules((prev) => prev.filter((x) => x.id !== confirmRemove))
                      setConfirmRemove(null)
                    }}
                  >
                    Remove rule
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

// Inherited show elements, surfaced inside Step 01 (Project setup) — NOT a
// workflow node. A series shows what it inherited from its template (each
// element On/Off, or Locked); a standalone shows an empty state pointing at
// the save-as-template step. Toggling an inherited element warns first, since
// it overrides the template for this one episode.

export function TemplateComponents({
  inherited,
  templateName,
}: {
  inherited?: boolean
  templateName?: string
}) {
  const [comps, setComps] = useState(INHERITED_COMPONENTS)
  const [pending, setPending] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  const pendingComp = comps.find((c) => c.key === pending)
  return (
    <div className={`tc-card ${open ? 'open' : ''}`}>
      <button className="tc-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="eyebrow">Template components</span>
        <svg
          className={`tpl-chevron ${open ? 'open' : ''}`}
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {!open ? null : !inherited ? (
        <>
          <p className="tc-empty-title">No template components yet.</p>
          <p className="tc-empty-sub">
            Reusable show elements — title bar, end card, watermark, caption style — are added when
            you save this video as a template (the final step).
          </p>
        </>
      ) : (
        <>
          <p className="tc-inherited">
            Inherited from <b>{templateName}</b>
          </p>
          <div className="tc-list">
            {comps.map((c) => (
              <div className="tc-row" key={c.key}>
                <span className="tc-label">{c.label}</span>
                {c.locked ? (
                  <span className="tc-chip locked">Locked</span>
                ) : (
                  <button
                    className={`tc-toggle ${c.on ? 'on' : 'off'}`}
                    aria-pressed={c.on}
                    onClick={() => setPending(c.key)}
                  >
                    {c.on ? 'On' : 'Off'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      {pendingComp ? (
        <div className="modal-scrim" onClick={() => setPending(null)}>
          <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Override an inherited component?</h3>
            <p>
              Turning <b>{pendingComp.label}</b> {pendingComp.on ? 'off' : 'on'} changes it for this
              episode only — the {templateName} template stays as it is.
            </p>
            <div className="actions">
              <button onClick={() => setPending(null)}>Cancel</button>
              <button
                className="primary"
                onClick={() => {
                  setComps((prev) =>
                    prev.map((x) => (x.key === pending ? { ...x, on: !x.on } : x)),
                  )
                  setPending(null)
                }}
              >
                Change for this episode
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ONE voice catalog, shared by the narration step and the show-tier Series
// setup panel — never a second list.
const audioDemo = (path: string) => `/@fs/Users/ralphxu/Documents/Projects/spoolcast-content/${path}`
export const NARRATION_VOICES = [
  {
    id: 'google-schedar',
    provider: 'google',
    name: 'Schedar',
    value: 'schedar',
    detail: 'Existing news-anime TTS voice',
    demo: audioDemo('shows/news-anime-bot/sessions/2026-04-29/episode/audio-voice-ab/Schedar.mp3'),
  },
  {
    id: 'google-puck',
    provider: 'google',
    name: 'Puck',
    value: 'Puck',
    detail: 'Found in Dev Log 03 session settings',
    demo: audioDemo('shows/news-anime-bot/sessions/2026-04-29/episode/audio-puck-archive/04-cfo-magnified-invoice.mp3'),
  },
  {
    id: 'edge-andrew',
    provider: 'edge',
    name: 'Andrew',
    value: 'en-US-AndrewNeural',
    detail: 'Current dev-log-12 voice',
    demo: audioDemo('sessions/spoolcast-dev-log-11/source/audio/C001.mp3'),
  },
  {
    id: 'edge-guy',
    provider: 'edge',
    name: 'Guy',
    value: 'en-US-GuyNeural',
    detail: 'Microsoft Edge voice option',
    demo: '',
  },
  {
    id: 'elevenlabs-library',
    provider: 'elevenlabs',
    name: 'Library voice',
    value: 'elevenlabs-library',
    detail: 'Connect an ElevenLabs voice ID',
    demo: '',
  },
] as const

export function NarrationContent() {
  type AudioArtifact = {
    stage_id?: string
    pattern?: string
    matches?: number
  }
  type AudioChunk = {
    id: string
    title: string
    narration: string
    generated: boolean
  }
  type ShotBeat = { id?: string; narration?: string; [key: string]: unknown }
  type ShotChunk = { id?: string; scene_title?: string; summary?: string; beats?: ShotBeat[] }
  const countNarratedChunks = (chunks: ShotChunk[] = []) =>
    chunks.filter((chunk) =>
      (chunk?.beats || []).some((beat) => String(beat?.narration || '').trim()),
    ).length
  const stageId = 'narration_audio'
  const session = activeSession()
  const stageProcess = useWorkflowStore((s) => s.stageProcesses[stageId] ?? null)
  const setStageProcess = useWorkflowStore((s) => s.setStageProcess)
  const registerStepAIAction = useWorkflowStore((s) => s.registerStepAIAction)
  const defaultProvider = 'edge'
  const defaultVoice = 'edge-andrew'
  const defaultSpeed = 1.0
  const minSpeed = 0.5
  const maxSpeed = 3.0
  const providers = [
    {
      id: 'google',
      name: 'Google TTS',
      timing: 'provider word timings',
      detail: 'Google voices, word timings from provider',
    },
    {
      id: 'edge',
      name: 'Microsoft Edge',
      timing: 'aligned after narration',
      detail: 'Current explainer default engine',
    },
    {
      id: 'elevenlabs',
      name: 'ElevenLabs',
      timing: 'provider word timings',
      detail: 'External voice library',
    },
  ] as const
  const voices = NARRATION_VOICES
  const [provider, setProvider] = useState<(typeof providers)[number]['id']>(defaultProvider)
  const [providerMenu, setProviderMenu] = useState(false)
  const providerMenuRef = useRef<HTMLSpanElement>(null)
  const [speed, setSpeed] = useState(defaultSpeed)
  const [currentDefaultSpeed, setCurrentDefaultSpeed] = useState(defaultSpeed)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [audioChunks, setAudioChunks] = useState<AudioChunk[]>([])
  const [pronunciations, setPronunciations] = useState<Record<string, string>>({})
  const [worldKitContent, setWorldKitContent] = useState('')
  const [seriesPronunciationText, setSeriesPronunciationText] = useState('')
  const [pronWord, setPronWord] = useState('')
  const [pronAlias, setPronAlias] = useState('')
  const [savePronToTemplate, setSavePronToTemplate] = useState(false)
  const [pronMessage, setPronMessage] = useState<string | null>(null)
  const [editingChunkId, setEditingChunkId] = useState<string | null>(null)
  const [chunkDraft, setChunkDraft] = useState('')
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiBusyChunkId, setAiBusyChunkId] = useState<string | null>(null)
  const [savingChunkId, setSavingChunkId] = useState<string | null>(null)
  const [regeneratingChunkId, setRegeneratingChunkId] = useState<string | null>(null)
  const [audioVersions, setAudioVersions] = useState<Record<string, number>>({})
  const [expandedChunkIds, setExpandedChunkIds] = useState<string[]>([])
  const audioExpandTouchedRef = useRef(false)
  const [chunkMessages, setChunkMessages] = useState<Record<string, string>>({})
  const [runError, setRunError] = useState<string | null>(null)
  const visibleVoices = voices.filter((v) => v.provider === provider)
  const [voiceId, setVoiceId] = useState<(typeof voices)[number]['id']>(defaultVoice)
  const [currentDefaultVoice, setCurrentDefaultVoice] = useState<(typeof voices)[number]['id']>(defaultVoice)
  const activeProvider = providers.find((p) => p.id === provider) ?? providers[0]
  const activeVoice = voices.find((v) => v.id === voiceId && v.provider === provider) ?? visibleVoices[0]
  const currentDefaultProvider = voices.find((v) => v.id === currentDefaultVoice)?.provider ?? defaultProvider
  const activeProcess = !!stageProcess && ['queued', 'running'].includes(stageProcess.status)
  const updateSpeed = (nextSpeed: string) => setSpeed(Number(nextSpeed))
  const audioSrc = (chunkId: string) =>
    apiUrl('download', { session, path: `source/audio/${chunkId}.mp3`, v: audioVersions[chunkId] || 0 })
  const startChunkEdit = (chunk: AudioChunk) => {
    setEditingChunkId(chunk.id)
    setChunkDraft(chunk.narration)
    setAiPrompt('')
    setChunkMessages((prev) => ({ ...prev, [chunk.id]: '' }))
    if (!expandedChunkIds.includes(chunk.id)) {
      setExpandedChunkIds((prev) => [...prev, chunk.id])
    }
  }
  const setChunkExpanded = (chunkId: string, open: boolean) => {
    audioExpandTouchedRef.current = true
    setExpandedChunkIds((prev) => (
      open
        ? prev.includes(chunkId) ? prev : [...prev, chunkId]
        : prev.filter((id) => id !== chunkId)
    ))
  }
  const sentenceParts = (text: string) => {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean) return []
    const parts = clean.match(/[^.!?]+[.!?]?/g)?.map((part) => part.trim()).filter(Boolean)
    return parts && parts.length ? parts : [clean]
  }
  const distributeNarration = (text: string, beats: ShotBeat[] = []) => {
    const baseBeats = beats.length ? beats : [{ id: 'A', narration: '' }]
    const parts = sentenceParts(text)
    if (!parts.length) return baseBeats.map((beat) => ({ ...beat, narration: '' }))
    const buckets = baseBeats.map(() => [] as string[])
    parts.forEach((part, index) => {
      buckets[Math.min(index, buckets.length - 1)].push(part)
    })
    return baseBeats.map((beat, index) => ({
      ...beat,
      narration: buckets[index].join(' ').trim(),
    }))
  }
  const saveChunkNarration = async (chunkId: string, narration: string) => {
    const clean = narration.replace(/\s+/g, ' ').trim()
    if (!clean) {
      setRunError('Narration cannot be empty.')
      return false
    }
    setSavingChunkId(chunkId)
    setRunError(null)
    try {
      const fileRes = await fetch(fileUrl('shot-list/shot-list.json'))
      const fileOut = await fileRes.json().catch(() => null)
      const shotList = fileOut?.data?.content ? JSON.parse(fileOut.data.content) : null
      const chunks = Array.isArray(shotList?.chunks) ? shotList.chunks : []
      let found = false
      shotList.chunks = chunks.map((chunk: ShotChunk) => {
        if (String(chunk.id) !== chunkId) return chunk
        found = true
        return { ...chunk, beats: distributeNarration(clean, chunk.beats) }
      })
      if (!found) throw new Error(`Could not find ${chunkId} in shot-list.json.`)
      const saveRes = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session,
          tenant: 'local',
          action: 'set_stage_output',
          stage_id: 'shot_list_json',
          path: 'shot-list/shot-list.json',
          content: JSON.stringify(shotList, null, 2) + '\n',
        }),
      })
      const saveOut = await saveRes.json().catch(() => null)
      if (!saveRes.ok || saveOut?.ok === false) {
        throw new Error(saveOut?.message || saveOut?.error || 'Could not save shot-list.json.')
      }
      setEditingChunkId(null)
      setChunkDraft('')
      await loadProgress()
      return true
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Could not save narration.')
      return false
    } finally {
      setSavingChunkId(null)
    }
  }
  const reviseChunkWithAi = async (chunk: AudioChunk) => {
    const instruction = aiPrompt.trim()
    if (!instruction) {
      setChunkMessages((prev) => ({ ...prev, [chunk.id]: 'Write what you want AI to change first.' }))
      return
    }
    setAiBusyChunkId(chunk.id)
    setRunError(null)
    setChunkMessages((prev) => ({ ...prev, [chunk.id]: '' }))
    try {
      const res = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session,
          tenant: 'local',
          action: 'rewrite_chunk_narration',
          allow_cost: true,
          chunk_id: chunk.id,
          current_narration: chunkDraft || chunk.narration,
          instruction,
        }),
      })
      const out = await res.json().catch(() => null)
      if (!res.ok || out?.ok === false) {
        throw new Error(out?.message || out?.error || 'AI rewrite failed.')
      }
      setChunkDraft(String(out?.data?.narration || '').trim())
      const warning = ruleFindingMessage(out?.data?.rule_findings)
      setChunkMessages((prev) => ({
        ...prev,
        [chunk.id]: warning
          ? `Rule check: ${warning} The AI rewrite is still ready to review and save.`
          : 'AI rewrite ready. Review it, then save or regenerate audio.',
      }))
    } catch (err) {
      setChunkMessages((prev) => ({
        ...prev,
        [chunk.id]: err instanceof Error ? err.message : 'Could not rewrite this chunk.',
      }))
    } finally {
      setAiBusyChunkId(null)
    }
  }
  const loadProgress = async () => {
    const [statusRes, shotRes] = await Promise.all([
      fetch(statusUrl()),
      fetch(fileUrl('shot-list/shot-list.json')),
    ])
    const statusOut = await statusRes.json().catch(() => null)
    const shotOut = await shotRes.json().catch(() => null)
    const audioArtifact = ((statusOut?.data?.artifacts || []) as AudioArtifact[]).find(
      (a) => a.stage_id === stageId && a.pattern === 'source/audio/*.mp3',
    )
    let total: number
    let chunks: AudioChunk[] = []
    try {
      const shotList = shotOut?.data?.content ? JSON.parse(shotOut.data.content) : null
      total = countNarratedChunks(shotList?.chunks)
      chunks = ((shotList?.chunks || []) as ShotChunk[])
        .filter((chunk) => (chunk?.beats || []).some((beat) => String(beat?.narration || '').trim()))
        .map((chunk, index) => ({
          id: String(chunk.id || `C${String(index + 1).padStart(3, '0')}`),
          title: String(chunk.scene_title || chunk.summary || chunk.id || `Chunk ${index + 1}`),
          narration: (chunk.beats || [])
            .map((beat) => String(beat?.narration || '').trim())
            .filter(Boolean)
            .join(' '),
          generated: false,
        }))
    } catch {
      total = 0
    }
    const done = Number(audioArtifact?.matches || 0)
    setProgress({ done, total })
    const nextChunks = chunks.map((chunk, index) => ({ ...chunk, generated: done >= total || index < done }))
    setAudioChunks(nextChunks)
    if (done > 0 && !audioExpandTouchedRef.current) {
      setExpandedChunkIds(nextChunks.filter((chunk) => chunk.generated).map((chunk) => chunk.id))
    }
  }
  const saveTtsSettings = async (nextPronunciations = pronunciations) => {
    const res = await fetch(actionUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session,
        tenant: 'local',
        action: 'set_session_fields',
        fields: {
          tts_voice: activeVoice?.value,
          tts_playback_rate: Number(speed.toFixed(1)),
          pronunciations: nextPronunciations,
        },
      }),
    })
    const out = await res.json().catch(() => null)
    if (!res.ok || out?.ok === false) {
      throw new Error(out?.message || out?.error || 'Could not save TTS settings.')
    }
  }
  const loadNarrationSettings = async () => {
    const [sessionRes, worldKitRes, rulesRes] = await Promise.all([
      fetch(fileUrl('session.json')),
      fetch(fileUrl('working/world-kit.md')),
      fetch(apiUrl('rules', { session, tenant: TENANT })),
    ])
    const sessionOut = await sessionRes.json().catch(() => null)
    const worldKitOut = await worldKitRes.json().catch(() => null)
    const rulesOut = await rulesRes.json().catch(() => null)
    if (sessionOut?.data?.content) {
      const cfg = JSON.parse(sessionOut.data.content)
      const voice = voices.find((v) => v.value === cfg.tts_voice)
      if (voice) {
        setProvider(voice.provider)
        setVoiceId(voice.id)
        setCurrentDefaultVoice(voice.id)
      }
      const rate = Number(cfg.tts_playback_rate)
      if (Number.isFinite(rate)) {
        setSpeed(rate)
        setCurrentDefaultSpeed(rate)
      }
      if (cfg.pronunciations && typeof cfg.pronunciations === 'object') {
        setPronunciations(cfg.pronunciations)
      }
    }
    const kit = String(worldKitOut?.data?.content || '')
    if (kit) {
      setWorldKitContent(kit)
      const kitRules = parsePronunciationLines(kit)
      if (Object.keys(kitRules).length) setPronunciations((prev) => ({ ...kitRules, ...prev }))
    }
    const voiceRule = rulesOut?.ok
      ? (rulesOut.data?.rules || []).find((rule: { id?: string }) => rule.id === VOICE_RULES_ID)
      : null
    if (voiceRule?.content) {
      const content = String(voiceRule.content)
      const idx = content.indexOf('## Pronunciation Wording')
      setSeriesPronunciationText((idx >= 0 ? content.slice(idx) : content).slice(0, 520))
    }
  }
  useEffect(() => {
    const initial = window.setTimeout(() => {
      void loadProgress().catch(() => {})
    }, 0)
    const interval = activeProcess
      ? window.setInterval(() => {
          void loadProgress().catch(() => {})
        }, 5000)
      : null
    return () => {
      window.clearTimeout(initial)
      if (interval != null) window.clearInterval(interval)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProcess])
  useEffect(() => {
    void loadNarrationSettings().catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!providerMenu) return
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && providerMenuRef.current?.contains(target)) return
      setProviderMenu(false)
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick)
  }, [providerMenu])
  useEffect(() => {
    if (!stageProcess?.jobId || !activeProcess) return
    let cancelled = false
    const pollJob = async () => {
      try {
        const res = await fetch(fileUrl(`working/jobs/${stageProcess.jobId}.json`))
        const out = await res.json().catch(() => null)
        const content = out?.data?.content ? JSON.parse(out.data.content) : null
        const state = String(content?.state || '')
        if (!cancelled && ['succeeded', 'failed', 'stopped', 'lost'].includes(state)) {
          await loadProgress()
          if (state === 'succeeded') {
            const stamp = Date.now()
            setAudioVersions((prev) => (
              regeneratingChunkId
                ? { ...prev, [regeneratingChunkId]: stamp }
                : {
                    ...prev,
                    ...Object.fromEntries(audioChunks.map((chunk) => [chunk.id, stamp])),
                  }
            ))
          }
          setRegeneratingChunkId(null)
          if (state === 'succeeded') {
            setStageProcess(stageId, null)
          } else {
            setRunError(content?.error || `Audio job ${state}.`)
            setStageProcess(stageId, { ...stageProcess, status: 'failed', error: content?.error || state })
          }
        }
      } catch {
        // The progress poll still runs; a missing job file should not break the panel.
      }
    }
    void pollJob()
    const timer = window.setInterval(() => {
      void pollJob()
    }, 3000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageProcess?.jobId, activeProcess])
  const selectProvider = (nextProvider: (typeof providers)[number]['id']) => {
    setProvider(nextProvider)
    setProviderMenu(false)
    const nextVoice = voices.find((v) => v.provider === nextProvider)
    if (nextVoice) setVoiceId(nextVoice.id)
  }
  const speedFill = `${((speed - minSpeed) / (maxSpeed - minSpeed)) * 100}%`
  const progressPct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0
  const audioComplete = progress.total > 0 && progress.done >= progress.total
  const speedChangedFromDefault = Math.abs(speed - currentDefaultSpeed) > 0.001
  const generateAudio = async (onlyChunkId?: string) => {
    setRunError(null)
    const chunkLabel = onlyChunkId ? `${onlyChunkId} narration audio` : 'narration audio chunks'
    if (onlyChunkId) setRegeneratingChunkId(onlyChunkId)
    setStageProcess(stageId, {
      stageId,
      status: 'queued',
      label: `Generating ${chunkLabel}…`,
      updatedAt: new Date().toISOString(),
    })
    try {
      await saveTtsSettings()
      const res = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session,
          tenant: 'local',
          action: 'batch_tts',
          allow_cost: true,
          extra_args: onlyChunkId ? ['--only', onlyChunkId, '--force'] : undefined,
        }),
      })
      const out = await res.json().catch(() => null)
      if (!res.ok || out?.ok === false) {
        const message = out?.message || out?.details || out?.error || 'Could not start narration audio generation.'
        setRunError(message)
        setRegeneratingChunkId(null)
        setStageProcess(stageId, null)
        return
      }
      const stdout = String(out?.data?.stdout || '')
      const jobId = stdout.match(/started\s+\S+\s+job\s+([^\s]+)/)?.[1]
      setStageProcess(stageId, {
        stageId,
        jobId,
        status: 'running',
        label: `Generating ${chunkLabel}…`,
        updatedAt: new Date().toISOString(),
      })
      await loadProgress()
    } catch {
      setRunError('Could not reach the engine.')
      setRegeneratingChunkId(null)
      setStageProcess(stageId, null)
    }
  }
  useEffect(() => {
    registerStepAIAction(stageId, {
      stageId,
      label: audioComplete ? 'Narration audio ready' : 'Complete step with AI',
      busy: activeProcess,
      disabled: progress.total === 0 || audioComplete,
      disabledReason: progress.total === 0
        ? 'Complete the shot list first'
        : 'Narration audio is already complete',
      usesTextModel: false,
      acceptsInstructions: false,
      run: () => generateAudio(),
    })
    return () => registerStepAIAction(stageId, null)
    // generateAudio deliberately stays local to this panel; re-register when
    // the durable progress/busy state changes so the header remains accurate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProcess, audioComplete, progress.total, registerStepAIAction, stageId])
  const addPronunciationRule = async () => {
    const word = pronWord.trim()
    const alias = pronAlias.trim()
    setPronMessage(null)
    if (!word || !alias) {
      setPronMessage('Add the written term and how it should be spoken.')
      return
    }
    if (alias.includes('.')) {
      setPronMessage('The spoken version cannot use periods. TTS may read them as “dot”.')
      return
    }
    const nextPronunciations = { ...pronunciations, [word]: alias }
    try {
      await saveTtsSettings(nextPronunciations)
      const nextWorldKit = upsertWorldKitPronunciationRule(
        worldKitContent || `# World Kit — ${session}\n`,
        word,
        alias,
      )
      const worldRes = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session,
          tenant: 'local',
          action: 'set_stage_output',
          stage_id: 'world_kit',
          path: 'working/world-kit.md',
          content: nextWorldKit,
        }),
      })
      const worldOut = await worldRes.json().catch(() => null)
      if (!worldRes.ok || worldOut?.ok === false) {
        throw new Error(worldOut?.message || worldOut?.error || 'Could not save the World Kit.')
      }
      if (savePronToTemplate) {
        const result = await appendUserRule(VOICE_RULES_ID, `Pronounce ${word} as ${alias}.`)
        if (!result.ok) throw new Error(result.error)
      }
      setPronunciations(nextPronunciations)
      setWorldKitContent(nextWorldKit)
      setPronWord('')
      setPronAlias('')
      setPronMessage(savePronToTemplate ? 'Saved to World Kit and the series voice rules.' : 'Saved to this episode’s World Kit.')
    } catch (err) {
      setPronMessage(err instanceof Error ? err.message : 'Could not save pronunciation rule.')
    }
  }
  return (
    <div className="voice-panel panel-flat">
      <div className="ch" style={{ borderBottom: 'none', paddingBottom: 0 }}>
        <h3>Narration audio</h3>
        <span>{activeProvider.timing}</span>
      </div>
      <div className="voice-picker-row">
        <label className="voice-menu-field">
          <span className="voice-control-label">Engine</span>
          <span className="voice-menu-anchor" ref={providerMenuRef}>
            <button type="button" className="vp-menu-btn voice-menu-btn" onClick={() => setProviderMenu((v) => !v)}>
              {activeProvider.name}{provider === currentDefaultProvider ? ' · default' : ''} ▾
            </button>
            {providerMenu ? (
              <>
                <span className="vp-menu-backdrop" onClick={() => setProviderMenu(false)} />
                <span
                  className="vp-menu voice-provider-menu"
                  style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, minWidth: 260 }}
                >
                  <span className="vp-menu-h">ENGINE</span>
                  {providers.map((p) => (
                    <button key={p.id} type="button" onClick={() => selectProvider(p.id)}>
                      <span className="voice-provider-menu-main">
                        {p.name}{p.id === currentDefaultProvider ? ' · default' : ''}
                      </span>
                      <span>{p.detail}</span>
                    </button>
                  ))}
                </span>
              </>
            ) : null}
          </span>
        </label>
        <label className="voice-speed-control">
          <span className="voice-control-label">Speed</span>
          <input
            className="sleek-range"
            type="range"
            min={minSpeed}
            max={maxSpeed}
            step="0.1"
            value={speed}
            onInput={(e) => updateSpeed(e.currentTarget.value)}
            onChange={(e) => updateSpeed(e.currentTarget.value)}
            style={{ '--fill': speedFill } as CSSProperties}
          />
          <span className="voice-speed-value">
            <b>{speed.toFixed(1)}x</b>
            {speedChangedFromDefault ? (
              <button type="button" className="vp-undo" onClick={() => setCurrentDefaultSpeed(speed)}>
                Set as default
              </button>
            ) : null}
          </span>
        </label>
      </div>
      <div className="voice-list">
        {visibleVoices.map((voice) => (
          <div
            key={voice.id}
            role="button"
            tabIndex={0}
            className={`voice-row ${activeVoice?.id === voice.id ? 'on' : ''}`}
            onClick={() => setVoiceId(voice.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setVoiceId(voice.id)
              }
            }}
          >
            <span className="voice-row-main">
              <span className="voice-row-title">
                <b>{voice.name}</b>
                {voice.id === currentDefaultVoice ? <span className="voice-default">Default</span> : null}
                {activeVoice?.id === voice.id && voice.id !== currentDefaultVoice ? (
                  <button
                    type="button"
                    className="vp-undo"
                    onClick={(e) => {
                      e.stopPropagation()
                      setCurrentDefaultVoice(voice.id)
                    }}
                  >
                    Set as default
                  </button>
                ) : null}
              </span>
              <small>{voice.value}</small>
            </span>
            <span className="voice-row-detail">
              {voice.detail}
            </span>
            {voice.demo ? (
              <audio
                controls
                preload="none"
                src={voice.demo}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="voice-demo-empty">demo not loaded</span>
            )}
          </div>
        ))}
      </div>
      <div className="voice-selected">
        <span className="id">{activeVoice?.value}</span>
        <span>{speed.toFixed(1)}x</span>
        <span>{provider === 'edge' ? 'word timings will be aligned after audio generation' : 'word timings are expected from the provider'}</span>
      </div>
      <div className="voice-pron">
        <div className="voice-pron-head">
          <span>
            <b>Pronunciation rules</b>
            <small>Saved to the World Kit. Template rules are visible in Project Wiki.</small>
          </span>
          <a className="vp-undo" href="/p/dev-log-12/rules?focus=voice">Open voice rules →</a>
        </div>
        <div className="voice-pron-rules">
          {Object.keys(pronunciations).length ? (
            Object.entries(pronunciations).map(([word, alias]) => (
              <span key={word} className="voice-pron-chip">
                <b>{word}</b>
                <small>{alias}</small>
              </span>
            ))
          ) : (
            <span className="voice-demo-empty">No episode pronunciation rules yet.</span>
          )}
        </div>
        <div className="voice-pron-add">
          <label>
            <span>Written term</span>
            <input value={pronWord} onChange={(e) => setPronWord(e.target.value)} placeholder="AI" />
          </label>
          <label>
            <span>Spoken as</span>
            <input value={pronAlias} onChange={(e) => setPronAlias(e.target.value)} placeholder="ay eye" />
          </label>
          <label className="voice-pron-check">
            <input
              type="checkbox"
              checked={savePronToTemplate}
              onChange={(e) => setSavePronToTemplate(e.target.checked)}
            />
            <span>Save to series voice rules too</span>
          </label>
          <button type="button" className="vp-undo" onClick={addPronunciationRule}>Add rule</button>
        </div>
        {seriesPronunciationText ? (
          <details className="voice-pron-existing">
            <summary>Existing template pronunciation guidance</summary>
            <p>{seriesPronunciationText}…</p>
          </details>
        ) : null}
        {pronMessage ? <p className="voice-error">{pronMessage}</p> : null}
      </div>
      <div className="voice-runbar">
        <span className="voice-run-progress">
          <span className="voice-run-status">
            {progress.total ? `${progress.done}/${progress.total} audio chunks generated` : 'Waiting for shot-list chunks'}
          </span>
          {progress.total ? (
            <span className={`progress ${audioComplete ? 'done' : ''}`}>
              <i style={{ width: `${progressPct}%` }} />
            </span>
          ) : null}
        </span>
      </div>
      {audioChunks.length ? (
        <div className="voice-audio-list">
          <div className="voice-audio-head">
            <b>Generated audio chunks</b>
            <span>{progress.done}/{progress.total}</span>
            <button
              type="button"
              className="vp-undo"
              onClick={() => {
                audioExpandTouchedRef.current = true
                setExpandedChunkIds(
                  expandedChunkIds.length === audioChunks.length ? [] : audioChunks.map((chunk) => chunk.id),
                )
              }}
            >
              {expandedChunkIds.length === audioChunks.length ? 'Collapse all' : 'Expand all'}
            </button>
          </div>
          {audioChunks.map((chunk) => {
            const chunkRegenerating = regeneratingChunkId === chunk.id && activeProcess
            return (
            <details
              className={`voice-audio-row ${chunkRegenerating ? 'regenerating' : ''}`}
              key={chunk.id}
              open={expandedChunkIds.includes(chunk.id)}
              onToggle={(event) => setChunkExpanded(chunk.id, event.currentTarget.open)}
            >
              <summary>
                <span className="id">{chunk.id}</span>
                <b>{chunk.title}</b>
                <small>{chunkRegenerating ? 'regenerating' : chunk.generated ? 'generated' : 'pending'}</small>
              </summary>
              {editingChunkId === chunk.id ? (
                <div className="vp-edit voice-chunk-edit">
                  <label className="vp-edit-field">Narration for {chunk.id}
                    <textarea
                      rows={4}
                      value={chunkDraft}
                      onChange={(e) => setChunkDraft(e.target.value)}
                      placeholder="Rewrite the spoken narration for this chunk…"
                    />
                  </label>
                  <div className="vp-ai">
                    <input
                      className="vp-ai-input"
                      value={aiPrompt}
                      onChange={(e) => setAiPrompt(e.target.value)}
                      placeholder="Ask AI how to revise this chunk, e.g. make it more layman terms but keep it accurate"
                    />
                    <button
                      type="button"
                      className="vp-ai-btn"
                      onClick={() => reviseChunkWithAi(chunk)}
                      disabled={aiBusyChunkId === chunk.id}
                    >
                      {aiBusyChunkId === chunk.id ? 'Revising…' : '✦ AI rewrite'}
                    </button>
                  </div>
                  <div className="vp-edit-actions">
                    <button
                      type="button"
                      className="vp-save"
                      disabled={savingChunkId === chunk.id}
                      onClick={() => saveChunkNarration(chunk.id, chunkDraft)}
                    >
                      {savingChunkId === chunk.id ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      type="button"
                      className="vp-save"
                      disabled={savingChunkId === chunk.id || activeProcess}
                      onClick={async () => {
                        const ok = await saveChunkNarration(chunk.id, chunkDraft)
                        if (ok) await generateAudio(chunk.id)
                      }}
                    >
                      {savingChunkId === chunk.id ? 'Saving…' : chunkRegenerating ? (<><span className="spin" /> Regenerating…</>) : 'Save + regenerate audio'}
                    </button>
                    <button
                      type="button"
                      className="vp-cancel"
                      onClick={() => {
                        setEditingChunkId(null)
                        setChunkDraft('')
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                  {chunkMessages[chunk.id] ? (
                    <p
                      className="voice-chunk-note"
                      style={chunkMessages[chunk.id].startsWith('Rule check:') ? { color: 'var(--amber)' } : undefined}
                    >
                      {chunkMessages[chunk.id]}
                    </p>
                  ) : null}
                </div>
              ) : (
                <button
                  type="button"
                  className="voice-audio-script"
                  onClick={() => startChunkEdit(chunk)}
                  title="Click to edit this chunk’s narration"
                >
                  “{chunk.narration}”
                </button>
              )}
              <div className="voice-audio-actions">
                {chunk.generated ? (
                  <audio
                    key={`${chunk.id}-${audioVersions[chunk.id] || 0}`}
                    className={chunkRegenerating ? 'disabled' : ''}
                    controls
                    preload="none"
                    src={audioSrc(chunk.id)}
                    aria-disabled={chunkRegenerating}
                  />
                ) : <span className="voice-demo-empty">audio not generated yet</span>}
                <button
                  type="button"
                  className="vp-undo"
                  disabled={activeProcess}
                  onClick={() => generateAudio(chunk.id)}
                >
                  {chunkRegenerating ? (<><span className="spin" /> Regenerating…</>) : 'Regenerate this chunk'}
                </button>
              </div>
            </details>
            )
          })}
        </div>
      ) : null}
      {runError ? <p className="voice-error">Engine: {runError}</p> : null}
    </div>
  )
}

function Step01DoneRow({
  field,
  title,
  value,
  onEdit,
}: {
  field: string
  title: string
  value: string
  onEdit?: (field: string) => void
}) {
  const interactive = Boolean(onEdit)
  return (
    <button
      type="button"
      className={`s1-question done ${interactive ? 'done-head' : 'done-static'}`}
      onClick={() => onEdit?.(field)}
      disabled={!interactive}
    >
      <div className="s1-q-head">
        <span className="s1-q-title">{title}</span>
        <span className="s1-q-summary">{value}</span>
        {interactive ? <span className="s1-edit">EDIT</span> : null}
      </div>
    </button>
  )
}

type SetupSuggestion = {
  target_length_s?: number
  aspect_ratio?: string
  shot_medium?: string
}

function useSetupAISuggestion(stepId: string) {
  const registerStepAIAction = useWorkflowStore((s) => s.registerStepAIAction)
  const storeSetS1 = useWorkflowStore((s) => s.setS1)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState('')

  const suggest = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const response = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: activeSession(),
          tenant: TENANT,
          action: 'suggest_setup',
          allow_cost: true,
        }),
      })
      const out = await response.json().catch(() => null)
      if (!response.ok || out?.ok === false) {
        setError(out?.message || out?.error || 'Could not suggest the project setup.')
        return
      }
      const suggestion = (out?.data || {}) as SetupSuggestion
      storeSetS1(stepId, (current) => {
        const output =
          suggestion.aspect_ratio === '9:16'
            ? '916'
            : suggestion.aspect_ratio === '16:9'
              ? '169'
              : suggestion.aspect_ratio === '1:1'
                ? '11'
                : current.output
        const length = Number(suggestion.target_length_s)
        const medium = ['video', 'image', 'mix'].includes(String(suggestion.shot_medium))
          ? String(suggestion.shot_medium)
          : current.medium
        return {
          ...current,
          output,
          length: Number.isFinite(length) && length > 0 ? length : current.length,
          medium,
          editing: '',
        }
      })
    } catch {
      setError('Could not reach the engine.')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [stepId, storeSetS1])

  useEffect(() => {
    registerStepAIAction(stepId, {
      stageId: stepId,
      label: 'Complete step with AI',
      busy,
      busyLabel: 'Choosing project settings…',
      usesTextModel: false,
      acceptsInstructions: false,
      run: suggest,
    })
    return () => registerStepAIAction(stepId, null)
  }, [busy, registerStepAIAction, stepId, suggest])

  return error
}

export function Step01Flow({ stepId }: { stepId: string }) {
  const s1 = useWorkflowStore((s) => s.s1)
  const storeSetS1 = useWorkflowStore((s) => s.setS1)
  const setupAIError = useSetupAISuggestion(stepId)
  const setS1: React.Dispatch<React.SetStateAction<S1>> = (updater) => storeSetS1(stepId, updater)
  const active =
    s1.editing ||
    (!s1.narrator ? 'narrator' : !s1.style ? 'style' : !s1.output ? 'output' : !s1.medium ? 'medium' : '')
  const setField = (field: string, value: string | number) =>
    setS1((current) => ({ ...current, [field]: value, editing: '' }))
  const editField = (field: string) =>
    setS1((current) => ({ ...current, editing: field }))

  return (
    <div className="s1-flow">
      {s1.narrator && active !== 'narrator' ? (
        <Step01DoneRow
          field="narrator"
          title="Narrator"
          value={s1.narrator === 'yes' ? 'Narrator (TTS)' : 'In-video audio'}
          onEdit={editField}
        />
      ) : (
        <div className="s1-question active">
          <div className="s1-q-head">
            <span className="s1-q-title">Is there a narrator?</span>
          </div>
          <div className="s1-pills">
            <Pill selected={s1.narrator === 'yes'} onClick={() => setField('narrator', 'yes')}>
              <span className="opt-num">A</span>
              <span className="name">Yes, narrator reads it</span>
              <a>example →</a>
            </Pill>
            <Pill selected={s1.narrator === 'no'} onClick={() => setField('narrator', 'no')}>
              <span className="opt-num">B</span>
              <span className="name">No, audio with the video</span>
              <a>example →</a>
            </Pill>
          </div>
        </div>
      )}
      {s1.narrator ? (
        s1.style && active !== 'style' ? (
          <Step01DoneRow
            field="style"
            title="Style"
            value={styleThumbs.find((style) => style.id === s1.style)?.name ?? s1.style}
            onEdit={editField}
          />
        ) : (
          <div className="s1-question active">
            <div className="s1-q-head">
              <span className="s1-q-title">Pick a starting style</span>
            </div>
            <div className="s1-style-grid">
              {styleThumbs.map((style) => {
                const disabled = s1.narrator === 'no' && style.narratorOnly
                return (
                  <Pill
                    key={style.id}
                    className="thumb-pill small"
                    selected={s1.style === style.id}
                    disabled={disabled}
                    onClick={() => setField('style', style.id)}
                  >
                    <span className="preview">
                      {style.img ? <img src={style.img} alt="" /> : <span className="person-icon" />}
                      {style.badge ? <b>{style.badge}</b> : null}
                    </span>
                    <span className="name">{style.name}</span>
                    {disabled ? <span className="lock-text">narrator only</span> : null}
                  </Pill>
                )
              })}
            </div>
          </div>
        )
      ) : null}
      {s1.style ? (
        s1.output && active !== 'output' ? (
          <Step01DoneRow
            field="output"
            title="Output"
            value={s1.output === '916' ? '9:16 vertical' : s1.output === '169' ? '16:9 widescreen' : '1:1 square'}
            onEdit={editField}
          />
        ) : (
          <div className="s1-question active">
            <div className="s1-q-head">
              <span className="s1-q-title">Where will this play?</span>
            </div>
            <div className="s1-pills">
              {[
                ['169', 'A', 'Widescreen', '16:9'],
                ['916', 'B', 'Vertical', '9:16'],
                ['11', 'C', 'Square', '1:1'],
              ].map((item) => (
                <Pill key={item[0]} selected={s1.output === item[0]} onClick={() => setField('output', item[0])}>
                  <span className="opt-num">{item[1]}</span>
                  <span className="name">{item[2]}</span>
                  <span className="desc">{item[3]}</span>
                </Pill>
              ))}
            </div>
          </div>
        )
      ) : null}
      {s1.output ? (
        s1.medium && active !== 'medium' ? (
          <Step01DoneRow
            field="medium"
            title="Shots"
            value={
              s1.medium === 'video' ? 'Generated video' : s1.medium === 'image' ? 'Still images' : 'Mix of both'
            }
            onEdit={editField}
          />
        ) : (
          <div className="s1-question active">
            <div className="s1-q-head">
              <span className="s1-q-title">How is it shot?</span>
            </div>
            <div className="s1-pills">
              {[
                ['video', 'A', 'Video', 'motion — costs the most'],
                ['image', 'B', 'Stills', 'held frames — cheapest'],
                ['mix', 'C', 'Mix', 'per shot, you decide at step 06'],
              ].map((item) => (
                <Pill key={item[0]} selected={s1.medium === item[0]} onClick={() => setField('medium', item[0])}>
                  <span className="opt-num">{item[1]}</span>
                  <span className="name">{item[2]}</span>
                  <span className="desc">{item[3]}</span>
                </Pill>
              ))}
            </div>
          </div>
        )
      ) : null}
      {s1.medium ? (
        active === 'length' ? (
          <div className="s1-question active s1-length-q">
            <div className="s1-q-head">
              <span className="s1-q-title">How long?</span>
              <button className="s1-edit" onClick={() => setS1((c) => ({ ...c, editing: '' }))}>
                DONE
              </button>
            </div>
            <div className={`s1-length-val ${s1.length === 0 ? 'muted' : ''}`}>
              {s1.length === 0 ? (
                <>Auto <em>· set at the structure outline (step 04)</em></>
              ) : (
                <>
                  ~{Math.round((s1.length / 60) * 10) / 10} min{' '}
                  <em>({s1.length}s · ~{Math.round(s1.length / 8)} scenes)</em>
                </>
              )}
            </div>
            <input
              type="range"
              min={15}
              max={600}
              step={15}
              value={s1.length || 120}
              disabled={s1.length === 0}
              onChange={(event) => setS1((c) => ({ ...c, length: Number(event.target.value) }))}
            />
            <button
              className={`ai-btn ${s1.length === 0 ? 'sel' : ''}`}
              onClick={() => setS1((c) => ({ ...c, length: c.length === 0 ? 120 : 0 }))}
            >
              <span className="ap-spark">✦</span> Let AI decide
            </button>
          </div>
        ) : (
          <Step01DoneRow
            field="length"
            title="How long"
            value={
              s1.length === 0
                ? 'Auto · set at step 04'
                : `~${Math.round((s1.length / 60) * 10) / 10} min · ${Math.round(s1.length / 8)} scenes`
            }
            onEdit={editField}
          />
        )
      ) : null}
      {s1.output ? (
        <div className="s1-question active project-id">
          <div className="s1-q-head">
            <span className="s1-q-title">Name this project</span>
          </div>
          <input
            value={s1.projectId}
            onChange={(event) => setS1((current) => ({ ...current, projectId: event.target.value }))}
          />
        </div>
      ) : null}
      {setupAIError ? <p className="voice-error">Engine: {setupAIError}</p> : null}
    </div>
  )
}

type SourceFile = { id: string; name: string; meta: string; kind: 'doc' | 'clock' | 'image'; desc: string }

// TEMPLATE AT STEP 1, order-interchangeable: an UNDECIDED session (created
// without a template, running on the base contract) picks here — by hand, or
// "let AI pick" from the idea already written. Invisible once decided; the
// engine's lock rule refuses changes after work starts, so this bar only
// ever appears while changing is still legal.
export function TemplatePickerBar({
  idea = '',
  current = '',
  chosenBySeries = false,
  seriesName = '',
  lockedReason = '',
  onApplied,
}: {
  idea?: string
  current?: string
  chosenBySeries?: boolean
  seriesName?: string
  lockedReason?: string
  onApplied?: (template: string) => void
}) {
  type Tpl = {
    id: string
    name?: string
    description?: string
    thumbnail?: string
  }
  const [tpls, setTpls] = useState<Tpl[]>([])
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')
  const thumbnailUrl = (path: string) =>
    /^https?:\/\//i.test(path) ? path : globalContentUrl(path)
  useEffect(() => {
    let live = true
    fetch(templatesUrl())
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((reg) => {
      if (!live) return
      setTpls(reg?.data?.templates ?? [])
    })
    return () => {
      live = false
    }
  }, [])
  if (tpls.length === 0) return null

  const post = async (body: Record<string, unknown>) => {
    const r = await fetch(actionUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: activeSession(), tenant: 'local', ...body }),
    })
    return r.json().catch(() => null)
  }
  const persistIdea = async () => {
    if (!idea.trim()) return true
    const content = btoa(unescape(encodeURIComponent(`# Video idea\n\n${idea.trim()}\n`)))
    const out = await post({ action: 'upload_file', filename: 'idea-brief.md', content })
    if (out?.ok) return true
    setNote(out?.message || out?.error || 'Could not save the idea before using the template.')
    return false
  }
  const apply = async (id: string, castId = '', ideaAlreadySaved = false) => {
    if (!id || id === current) return
    setBusy(id)
    setNote('')
    if (!ideaAlreadySaved && !(await persistIdea())) {
      setBusy('')
      return
    }
    const out = await post({ action: 'apply_template', template: id })
    if (out?.ok && castId) {
      // The suggested creator rides along with the template so "apply" means
      // what the card says. Best-effort: the kit may not exist yet this early,
      // in which case the user picks at step 5 — never block the template.
      await post({ action: 'use_global_asset', slug: castId })
    }
    if (out?.ok) {
      onApplied?.(String(out?.data?.template || id))
      notifySessionConfigurationChanged()
      setBusy('')
    } else {
      setNote(out?.message || out?.error || 'Could not apply the template.')
      setBusy('')
    }
  }
  const suggest = async () => {
    setBusy('suggest')
    setNote('')
    if (!(await persistIdea())) {
      setBusy('')
      return
    }
    const out = await post({ action: 'suggest_template', allow_cost: true })
    if (out?.ok && out?.data?.template) {
      const meta = out.data.character_meta
      await apply(String(out.data.template), String(meta?.id || ''), true)
      return
    } else {
      setNote(out?.message || out?.error || 'Could not get a suggestion — is the idea written yet?')
    }
    setBusy('')
  }
  return (
    <div className="step1-choice-group">
      <div className="step1-choice-head">
        <h3>Template</h3>
        <span>
          {lockedReason
            ? 'Locked after later work started'
            : chosenBySeries && current
              ? `Included with ${displayId(seriesName || 'your series')}`
              : 'Choose the workflow for this video'}
        </span>
      </div>
      <div className="step1-choice-row">
        {tpls.map((t) => {
          const thumbnail = t.thumbnail
            ? thumbnailUrl(t.thumbnail)
            : TEMPLATE_ART[t.id]?.poster || ''
          return (
            <button
              key={t.id}
              type="button"
              className={`step1-choice-card ${current === t.id ? 'sel' : ''}`}
              disabled={!!busy || !!lockedReason || (chosenBySeries && !!current && current !== t.id)}
              title={t.description || t.id}
              aria-pressed={current === t.id}
              onClick={() => void apply(t.id)}
            >
              <span className={`step1-choice-thumb ${thumbnail ? '' : 'empty'}`}>
                {thumbnail ? <img src={thumbnail} alt="" onError={(event) => { event.currentTarget.style.display = 'none' }} /> : null}
              </span>
              <span className="step1-choice-copy">
                <b>{busy === t.id ? <><span className="spin" /> Applying…</> : (t.name || displayId(t.id))}</b>
                {t.description ? <span>{t.description}</span> : null}
              </span>
            </button>
          )
        })}
        {(!chosenBySeries || !current) && !lockedReason ? (
          <button
            type="button"
            className="step1-choice-card ai"
            disabled={!!busy}
            onClick={() => void suggest()}
          >
            <span className="step1-choice-thumb ai">✦</span>
            <span className="step1-choice-copy">
              <b>{busy === 'suggest' ? 'Reading the idea…' : 'Let AI choose'}</b>
              <span>Pick the best template from your idea</span>
            </span>
          </button>
        ) : null}
      </div>
      {note ? <p className="vp-hint" style={{ margin: '10px 0 0' }}>{note}</p> : null}
    </div>
  )
}

type StepOneKitItem = {
  name: string
  image_path?: string
  global_path?: string
  image_scope?: string
  scope?: string
  selected_in_step_1?: boolean
  selected_directly?: boolean
}

type StepOneKitAttachment = {
  id: string
  name: string
  src: string
  meta: string
}

type StepOneSeries = {
  id: string
  name?: string
  template?: string
  thumbnail?: string
}

const displayId = (id: string) =>
  id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')

const seriesIdFromName = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const featuringNames = (idea: string) => {
  const line = idea.split(/\r?\n/).find((entry) => /^\s*Featuring\s*:/i.test(entry))
  return (line?.replace(/^\s*Featuring\s*:\s*/i, '') || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
}

const withFeaturingNames = (idea: string, names: string[]) => {
  const withoutFeaturing = idea
    .split(/\r?\n/)
    .filter((line) => !/^\s*Featuring\s*:/i.test(line))
    .join('\n')
    .trimEnd()
  if (!names.length) return withoutFeaturing
  return `${withoutFeaturing}${withoutFeaturing ? '\n\n' : ''}Featuring: ${names.join(', ')}`
}

function StepOneAdvanced({
  idea,
  onIdeaChange,
  onKitSelectionChange,
}: {
  idea: string
  onIdeaChange: (value: string) => void
  onKitSelectionChange: (items: StepOneKitAttachment[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [template, setTemplate] = useState('')
  const [series, setSeries] = useState('')
  const [seriesOptions, setSeriesOptions] = useState<StepOneSeries[]>([])
  const [joiningSeries, setJoiningSeries] = useState('')
  const [creatingSeries, setCreatingSeries] = useState(false)
  const [newSeriesName, setNewSeriesName] = useState('')
  const [seriesError, setSeriesError] = useState('')
  const [lockedReason, setLockedReason] = useState('')
  const [webResearch, setWebResearch] = useState<boolean | null>(null)
  const [kit, setKit] = useState<StepOneKitItem[]>([])
  const [kitLoading, setKitLoading] = useState(true)
  const [kitSyncReady, setKitSyncReady] = useState(false)

  const saveKitSelection = useCallback(async (refs: string[]) => {
    const response = await fetch(actionUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: activeSession(),
        tenant: 'local',
        action: 'set_step1_world_kit_refs',
        refs,
      }),
    }).catch(() => null)
    const out = response ? await response.json().catch(() => null) : null
    if (!response?.ok || out?.ok === false) {
      throw new Error(out?.message || out?.error || 'Could not save the selected World Kit references.')
    }
  }, [])

  useEffect(() => {
    let live = true
    Promise.all([
      fetch(fileUrl('session.json')).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(seriesUrl()).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: activeSession(),
          tenant: 'local',
          action: 'template_lock_status',
        }),
      }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([sessionOut, seriesOut, lockOut]) => {
      if (!live) return
      try {
        const cfg = JSON.parse(sessionOut?.data?.content || '{}')
        setTemplate(String(cfg.template || ''))
        setSeries(String(cfg.series || ''))
        setWebResearch(cfg.allow_web_research !== false)
      } catch {
        setWebResearch(true)
      }
      setLockedReason(String(lockOut?.data?.reason || ''))
      const options = seriesOut?.data?.series
      setSeriesOptions(Array.isArray(options) ? options : [])
    })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    if (!series) {
      setKit([])
      setKitLoading(false)
      setKitSyncReady(false)
      return
    }
    let live = true
    setKit([])
    setKitLoading(true)
    setKitSyncReady(false)
    fetch(apiUrl('source-images', { session: activeSession(), include_refs: 1 }))
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        if (!live) return
        const items = out?.data?.kit
        const persistedRefs = Array.isArray(items)
          ? items
              .filter((item: StepOneKitItem) => (
                item.selected_in_step_1 && item.selected_directly
              ))
              .map((item: StepOneKitItem) => item.name)
          : []
        if (persistedRefs.length) {
          const nextIdea = withFeaturingNames(idea, persistedRefs)
          if (nextIdea !== idea) onIdeaChange(nextIdea)
        }
        setKit(
          Array.isArray(items)
            ? items.filter((item: StepOneKitItem) => (
                item.image_scope === 'show'
                || /show|template/i.test(String(item.scope || ''))
              ))
            : [],
        )
        setKitSyncReady(Array.isArray(items))
      })
      .catch(() => {
        if (live) setKit([])
      })
      .finally(() => {
        if (live) setKitLoading(false)
      })
    return () => {
      live = false
    }
  }, [series])

  const joinSeries = async (seriesId: string) => {
    if (!seriesId || joiningSeries || seriesId === series) return
    setJoiningSeries(seriesId)
    setSeriesError('')
    const response = await fetch(actionUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: activeSession(),
        tenant: 'local',
        action: 'join_series',
        series: seriesId,
      }),
    }).catch(() => null)
    const out = response ? await response.json().catch(() => null) : null
    setJoiningSeries('')
    if (response?.ok && out?.ok) {
      setKit([])
      onIdeaChange(withFeaturingNames(idea, []))
      void saveKitSelection([]).catch(() => {})
      setSeries(String(out?.data?.series || seriesId))
      setTemplate(String(out?.data?.template || ''))
      notifySessionConfigurationChanged()
    } else {
      setSeriesError(out?.message || out?.error || 'Could not join this series.')
    }
  }

  const leaveSeries = async () => {
    if (!series || joiningSeries) return
    setJoiningSeries('__standalone')
    setSeriesError('')
    const response = await fetch(actionUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: activeSession(),
        tenant: 'local',
        action: 'leave_series',
      }),
    }).catch(() => null)
    const out = response ? await response.json().catch(() => null) : null
    setJoiningSeries('')
    if (response?.ok && out?.ok) {
      setKit([])
      onIdeaChange(withFeaturingNames(idea, []))
      void saveKitSelection([]).catch(() => {})
      setSeries('')
      setTemplate(String(out?.data?.template || ''))
      notifySessionConfigurationChanged()
    } else {
      setSeriesError(out?.message || out?.error || 'Could not make this project standalone.')
    }
  }

  const createSeries = async () => {
    const seriesId = seriesIdFromName(newSeriesName)
    if (!seriesId || joiningSeries) return
    setJoiningSeries('__new')
    setSeriesError('')
    const response = await fetch(actionUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: activeSession(),
        tenant: 'local',
        action: 'create_series_from_project',
        series: seriesId,
      }),
    }).catch(() => null)
    const out = response ? await response.json().catch(() => null) : null
    setJoiningSeries('')
    if (response?.ok && out?.ok) {
      const nextSeries = String(out?.data?.series || seriesId)
      setKit([])
      onIdeaChange(withFeaturingNames(idea, []))
      void saveKitSelection([]).catch(() => {})
      setSeries(nextSeries)
      setTemplate(String(out?.data?.template || template))
      setSeriesOptions((current) => (
        current.some((option) => option.id === nextSeries)
          ? current
          : [...current, {
              id: nextSeries,
              name: newSeriesName.trim() || displayId(nextSeries),
              template: String(out?.data?.template || template),
            }]
      ))
      setCreatingSeries(false)
      setNewSeriesName('')
      notifySessionConfigurationChanged()
    } else {
      setSeriesError(out?.message || out?.error || 'Could not create this series.')
    }
  }

  const toggleWebResearch = async (next: boolean) => {
    setWebResearch(next)
    await fetch(actionUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: activeSession(),
        tenant: 'local',
        action: 'set_session_fields',
        fields: { allow_web_research: next },
      }),
    }).catch(() => {})
  }

  const selectedFeatures = featuringNames(idea)
  const selectedSet = new Set(selectedFeatures)
  const selectedFeatureKey = selectedFeatures.join('\u0000')
  const imageKit = kit.filter((item) => item.name && (item.global_path || item.image_path))
  const seriesThumbnailUrl = (path: string) =>
    /^https?:\/\//i.test(path) ? path : globalContentUrl(path)
  useEffect(() => {
    const selectedNames = new Set(featuringNames(idea))
    onKitSelectionChange(
      kit
        .filter((item) => selectedNames.has(item.name) && (item.global_path || item.image_path))
        .map((item) => ({
          id: `world-kit:${item.name}`,
          name: item.name,
          src: item.global_path
            ? globalContentUrl(item.global_path)
            : contentUrl(item.image_path || ''),
          meta: /template/i.test(String(item.scope || ''))
            ? 'World Kit · template reference'
            : `World Kit · ${displayId(series)} series`,
        })),
    )
  }, [idea, kit, onKitSelectionChange, series])
  useEffect(() => {
    if (!series || !kitSyncReady) return
    const available = new Set(kit.map((item) => item.name))
    const refs = (selectedFeatureKey ? selectedFeatureKey.split('\u0000') : [])
      .filter((name) => available.has(name))
    let live = true
    void saveKitSelection(refs).catch((error) => {
      if (live) {
        setSeriesError(error instanceof Error ? error.message : 'Could not save the selected World Kit references.')
      }
    })
    return () => {
      live = false
    }
  }, [kit, kitSyncReady, saveKitSelection, selectedFeatureKey, series])

  return (
    <>
      {template || series ? (
        <p className="step1-selection-status">
          <span>
            {series ? <>{displayId(series)} series</> : <>Standalone</>}
            {template ? <> <span aria-hidden="true">→</span> {displayId(template)} template</> : null}
          </span>
          {!lockedReason ? (
            <button type="button" onClick={() => setOpen(true)} className="step1-change-link">
              change
            </button>
          ) : <span>locked</span>}
        </p>
      ) : null}

      <details
        className="vp-section"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="vp-section-sum">
          <span className="vp-sec-title">Advanced</span>
          <span className="vp-section-count">OPTIONAL</span>
        </summary>
        <div className="step1-advanced-body">
          <div className="step1-choice-group">
            <div className="step1-choice-head">
              <h3>Your Series</h3>
              <span>{lockedReason ? 'Series can change; the template remains locked' : 'Choosing a series also chooses its template'}</span>
            </div>
            <div className="step1-choice-row">
              <button
                type="button"
                className={`step1-choice-card ${series ? '' : 'sel'}`}
                disabled={!!joiningSeries}
                aria-pressed={!series}
                onClick={() => void leaveSeries()}
              >
                <span className="step1-choice-thumb empty" />
                <span className="step1-choice-copy">
                  <b>{joiningSeries === '__standalone' ? <><span className="spin" /> Changing…</> : 'Standalone'}</b>
                  <span>Make a one-off video</span>
                </span>
              </button>
              {seriesOptions.map((option) => {
                const selected = series === option.id
                return (
                  <span className="step1-choice-wrap" key={option.id}>
                    <button
                      type="button"
                      className={`step1-choice-card ${selected ? 'sel' : ''}`}
                      disabled={!!joiningSeries}
                      aria-pressed={selected}
                      onClick={() => void joinSeries(option.id)}
                    >
                      <span className={`step1-choice-thumb ${option.thumbnail ? '' : 'empty'}`}>
                        {option.thumbnail ? <img src={seriesThumbnailUrl(option.thumbnail)} alt="" onError={(event) => { event.currentTarget.style.display = 'none' }} /> : null}
                      </span>
                      <span className="step1-choice-copy">
                        <b>
                          {joiningSeries === option.id ? <><span className="spin" /> Changing…</> : (option.name || displayId(option.id))}
                        </b>
                        <span>{option.template ? `Includes ${displayId(option.template)} template` : 'Choose a template after joining'}</span>
                      </span>
                    </button>
                    {selected ? (
                      <button
                        type="button"
                        className="step1-choice-remove"
                        title="Remove this project from the series"
                        aria-label={`Remove ${displayId(option.id)} series`}
                        disabled={!!joiningSeries}
                        onClick={() => void leaveSeries()}
                      >
                        ×
                      </button>
                    ) : null}
                  </span>
                )
              })}
              <button
                type="button"
                className="step1-choice-card new"
                disabled={!!joiningSeries}
                onClick={() => setCreatingSeries(true)}
              >
                <span className="step1-choice-thumb empty">＋</span>
                <span className="step1-choice-copy">
                  <b>{series ? 'Duplicate as new series' : 'New series'}</b>
                  <span>{series ? 'Copy this project’s reusable setup into a new series' : 'Make this project its first episode'}</span>
                </span>
              </button>
            </div>
            {creatingSeries ? (
              <div className="step1-new-series">
                <label>
                  SERIES NAME
                  <input
                    autoFocus
                    value={newSeriesName}
                    onChange={(event) => setNewSeriesName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void createSeries()
                    }}
                    placeholder="e.g. Asyllum Loafer"
                  />
                </label>
                {seriesIdFromName(newSeriesName) ? (
                  <span className="vp-hint">ID: {seriesIdFromName(newSeriesName)}</span>
                ) : null}
                <button type="button" className="vp-undo" onClick={() => setCreatingSeries(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="vp-save"
                  disabled={!seriesIdFromName(newSeriesName) || !!joiningSeries}
                  onClick={() => void createSeries()}
                >
                  {joiningSeries === '__new' ? 'Creating…' : (series ? 'Duplicate series' : 'Create series')}
                </button>
              </div>
            ) : null}
            {seriesError ? <p className="voice-error">{seriesError}</p> : null}
          </div>

          <TemplatePickerBar
            idea={idea}
            current={template}
            chosenBySeries={!!series}
            seriesName={series}
            lockedReason={lockedReason}
            onApplied={(nextTemplate) => {
              setTemplate(nextTemplate)
              onIdeaChange(withFeaturingNames(idea, []))
            }}
          />

          {series ? (
            <div className="step1-choice-group">
              <div className="step1-choice-head">
                <h3>World Kit</h3>
                <span>shared series and template references</span>
              </div>
              {kitLoading ? (
                <p className="vp-hint" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
                  <span className="spin" />
                  Loading shared references…
                </p>
              ) : imageKit.length ? (
                <>
                  <p className="vp-hint" style={{ margin: '0 0 10px' }}>
                    Choose anything this video should feature. The names are added to the idea brief.
                  </p>
                  <div className="vp-ref-chips" style={{ marginBottom: 0 }}>
                    {imageKit.map((item) => {
                      const selected = selectedSet.has(item.name)
                      const src = item.global_path
                        ? globalContentUrl(item.global_path)
                        : contentUrl(item.image_path || '')
                      return (
                        <button
                          key={item.name}
                          type="button"
                          className={`vp-ref-chip ${selected ? 'on' : ''}`}
                          onClick={() => {
                            const next = selected
                              ? selectedFeatures.filter((name) => name !== item.name)
                              : [...selectedFeatures, item.name]
                            onIdeaChange(withFeaturingNames(idea, next))
                          }}
                        >
                          <img src={src} alt="" />
                          <span>{item.name}</span>
                        </button>
                      )
                    })}
                  </div>
                </>
              ) : (
                <p className="vp-hint" style={{ margin: 0 }}>
                  No series-shared images yet. In World Kit, open an image and set Save to → Series.
                </p>
              )}
            </div>
          ) : null}

          <div className="step1-choice-group">
            <div className="step1-choice-head">
              <h3>Web research</h3>
              <span>runs in the background after Step 1</span>
            </div>
            {webResearch !== null ? (
              <label className="voice-pron-check step1-option-check">
                <input
                  type="checkbox"
                  checked={webResearch}
                  onChange={(event) => void toggleWebResearch(event.target.checked)}
                />
                <span>Allow Spoolcast to search the web when researching this topic</span>
              </label>
            ) : null}
            <p className="step1-helper-text">
              Links pasted in the idea are always read; this setting only controls finding additional sources.
            </p>
          </div>
        </div>
      </details>
    </>
  )
}

export function IdeaBriefContent({ blankProject, stepId }: { blankProject: boolean; stepId: string }) {
  const brief = useWorkflowStore((s) => s.ideaBrief)
  const setIdeaBrief = useWorkflowStore((s) => s.setIdeaBrief)
  const stageProcess = useWorkflowStore((s) => s.stageProcesses[stepId] ?? null)
  const setStageProcess = useWorkflowStore((s) => s.setStageProcess)
  const session = activeSession()
  const improveJobStorageKey = `spoolcast:improve-idea-job:${session}`
  const improveProposalStorageKey = `spoolcast:improve-idea-proposal:${session}`
  const [improveJobId, setImproveJobId] = useState(() => localStorage.getItem(improveJobStorageKey) || '')
  const [improvedPrompt, setImprovedPrompt] = useState(() => localStorage.getItem(improveProposalStorageKey) || '')
  const [improveError, setImproveError] = useState<string | null>(null)
  const [improveRuleWarning, setImproveRuleWarning] = useState<string | null>(null)
  const [improveModel, setImproveModel] = useState(DEFAULT_MODEL_ID)
  const [improveOpen, setImproveOpen] = useState(false)
  const [improveNotes, setImproveNotes] = useState('')
  const [attachmentsInfoOpen, setAttachmentsInfoOpen] = useState(false)
  const improving = Boolean(improveJobId)
    || Boolean(stageProcess && ['queued', 'running'].includes(stageProcess.status))
  const onBriefChange = (value: string) => {
    localStorage.removeItem(improveProposalStorageKey)
    setImprovedPrompt('')
    setImproveError(null)
    setImproveRuleWarning(null)
    setIdeaBrief(stepId, value)
  }
  const [files, setFiles] = useState<SourceFile[]>(
    blankProject
      ? []
      : [], // ZERO DUMMY DATA RULE: Source material must come from the engine, not hardcoded mocks.
  )
  const [kitAttachments, setKitAttachments] = useState<StepOneKitAttachment[]>([])
  const handleKitSelectionChange = useCallback((items: StepOneKitAttachment[]) => {
    setKitAttachments(items)
  }, [])

  const improveIdea = useCallback(async (instructions: string, model: string) => {
    const idea = brief.trim()
    if (!idea || improving) return
    setImproveError(null)
    setImproveRuleWarning(null)
    localStorage.removeItem(improveProposalStorageKey)
    setImprovedPrompt('')
    try {
      const response = await fetch(jobsUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: activeSession(),
          tenant: 'local',
          kind: 'improve_idea',
          idea,
          feedback: instructions,
          model,
          reasoning: draftReasoning(model),
          allow_cost: true,
        }),
      })
      const queued = await response.json().catch(() => null)
      if (!response.ok || queued?.ok === false || !queued?.data?.id) {
        setImproveError(queued?.message || queued?.error || 'Could not start the prompt improvement.')
        return
      }

      const jobId = String(queued.data.id)
      localStorage.setItem(improveJobStorageKey, jobId)
      setImproveJobId(jobId)
      setStageProcess(stepId, {
        stageId: stepId,
        jobId,
        status: 'queued',
        label: 'AI is improving the video prompt…',
      })
    } catch {
      setImproveError('Could not reach the engine. Your original idea is unchanged.')
    }
  }, [brief, improveJobStorageKey, improveProposalStorageKey, improving, session, setStageProcess, stepId])

  // The paid call lives in the durable engine queue. The job id is also kept
  // locally so leaving Step 1 (or remounting it) resumes the same poll instead
  // of starting over or losing the proposal.
  useEffect(() => {
    if (!improveJobId) return
    let cancelled = false
    let attempts = 0
    const poll = async () => {
      attempts += 1
      try {
        const response = await fetch(jobsUrl(improveJobId), { cache: 'no-store' })
        const out = await response.json().catch(() => null)
        const job = out?.data
        if (cancelled) return
        if (!response.ok || out?.ok === false) {
          throw new Error(out?.message || out?.error || 'Could not check the prompt improvement.')
        }
        if (job?.status === 'done') {
          const proposal = String(job?.result?.improved_prompt || '').trim()
          const warning = ruleFindingMessage(job?.result?.rule_findings)
          setImproveRuleWarning(warning || null)
          localStorage.removeItem(improveJobStorageKey)
          setImproveJobId('')
          setStageProcess(stepId, null)
          if (!proposal) {
            setImproveError('The AI did not return a usable improved prompt.')
          } else {
            localStorage.setItem(improveProposalStorageKey, proposal)
            setImprovedPrompt(proposal)
          }
          return
        }
        if (job?.status === 'failed') {
          const message = job?.message || job?.result?.message || job?.error || 'Prompt improvement failed.'
          localStorage.removeItem(improveJobStorageKey)
          setImproveJobId('')
          setImproveError(message)
          setStageProcess(stepId, {
            stageId: stepId,
            jobId: improveJobId,
            status: 'failed',
            label: 'Prompt improvement failed',
            error: message,
          })
          return
        }
        if (attempts >= 600) {
          localStorage.removeItem(improveJobStorageKey)
          setImproveJobId('')
          setImproveError('Prompt improvement timed out. Your original idea is unchanged.')
          setStageProcess(stepId, null)
          return
        }
        if (!stageProcess || stageProcess.jobId !== improveJobId || stageProcess.status !== job.status) {
          setStageProcess(stepId, {
            stageId: stepId,
            jobId: improveJobId,
            status: job.status === 'queued' ? 'queued' : 'running',
            label: 'AI is improving the video prompt…',
          })
        }
      } catch (error) {
        if (!cancelled && attempts >= 3) {
          setImproveError(error instanceof Error ? error.message : 'Could not check the prompt improvement.')
        }
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 1000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [
    improveJobId,
    improveJobStorageKey,
    improveProposalStorageKey,
    setStageProcess,
    stageProcess,
    stepId,
  ])

  // FILES ARE TRUTH: list what is actually in source/ rather than only what
  // this browser tab uploaded. Uploads used to vanish from this step on
  // reload — they were on disk (the World Kit could map them via the same
  // endpoint) but this panel never asked the engine.
  const loadSourceFiles = useCallback(() => {
    fetch(apiUrl('source-images', { session: activeSession() }))
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        const images = out?.images ?? out?.data?.images
        if (!Array.isArray(images)) return
        setFiles(
          images.map((img: { path: string; name: string; size: number }) => ({
            id: img.path,
            name: img.name,
            meta: `${(img.size / 1024).toFixed(1)} KB · in source/`,
            kind: 'image' as const,
            desc: '',
          })),
        )
      })
      .catch(() => {
        /* engine offline — the upload flow below still explains itself */
      })
  }, [])
  useEffect(() => {
    if (!blankProject) loadSourceFiles()
  }, [blankProject, loadSourceFiles])

  const setDesc = (id: string, desc: string) =>
    setFiles((current) => current.map((file) => (file.id === id ? { ...file, desc } : file)))
  const removeFile = (id: string) =>
    setFiles((current) => current.filter((file) => file.id !== id))

  // RULE 5: Functional Input Rule - Handle real file uploads to the local API
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    try {
      // Read file as base64 via FileReader. NOT String.fromCharCode(...bytes):
      // spreading a multi-MB file as call arguments overflows the JS call
      // stack, so every real photo "failed to upload" while the API was fine.
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '')
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })

      // Send to local API
      const res = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: activeSession(),
          tenant: 'local',
          action: 'upload_file',
          filename: file.name,
          content: base64
        })
      })

      if (res.ok) {
        await res.json() // Consume the response to ensure request completes
        // Re-list from the engine: the disk is the truth, not this tab.
        loadSourceFiles()
        alert(`Successfully uploaded ${file.name} to the engine!`)
      } else {
        alert('Failed to upload file to the engine.')
      }
    } catch (err) {
      console.error('Upload error:', err)
      alert('Error uploading file. Is the local API running?')
    }
    // Clear input so the same file can be selected again
    e.target.value = ''
  }

  return (
    <div
      className="idea-v2"
      style={improving ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
    >
      <h3 className="idea-q">What's this video about?</h3>

      <textarea
        className="idea-textbox"
        rows={5}
        value={brief}
        onChange={(event) => onBriefChange(event.target.value)}
        placeholder="Describe the idea, topic, opinion, or story this video should become. Paste any relevant links here too."
      />

      <div className="step1-input-actions">
        <span className="step1-attach-actions">
          <label className="vp-undo step1-attach-button">
            <span>＋ Attach references</span>
            <input type="file" onChange={handleFileUpload} />
          </label>
          <button
            type="button"
            className="step1-info-toggle"
            onClick={() => setAttachmentsInfoOpen((value) => !value)}
            aria-expanded={attachmentsInfoOpen}
          >
            ⓘ What can I attach?
          </button>
          {attachmentsInfoOpen ? (
            <span className="step1-helper-text step1-attachment-info">
              Attach notes, transcripts, screenshots, and reference files. Paste links in the video idea above.
            </span>
          ) : null}
        </span>
        <span className={`vg-split-action ${improveOpen ? 'open' : ''}`}>
          <button
            type="button"
            className="vg-split-toggle"
            disabled={!brief.trim() || improving}
            title="Add optional notes or choose a model"
            aria-label="Open improvement options"
            onClick={() => setImproveOpen((value) => !value)}
          >
            {improveOpen ? '▴' : '▾'}
          </button>
          <button
            type="button"
            className="vp-undo vg-split-main"
            disabled={!brief.trim() || improving}
            title={brief.trim()
              ? 'Improve this idea immediately using the selected model'
              : 'Write the video idea first'}
            onClick={() => void improveIdea('', improveModel)}
          >
            {improving ? 'AI rewriting…' : '✦ Improve prompt with AI'}
          </button>
        </span>
      </div>
      {improveOpen ? (
        <div className="vg-regen-note-panel step1-improve-panel">
          <textarea
            value={improveNotes}
            onChange={(event) => setImproveNotes(event.target.value)}
            placeholder="Optional notes about what the improved prompt should emphasize or preserve…"
            rows={3}
          />
          <div className="vp-edit-actions step1-improve-actions">
            <ModelPicker
              model={improveModel}
              onChange={setImproveModel}
              disabled={improving}
            />
            <button
              type="button"
              className="vp-save"
              disabled={!brief.trim() || improving}
              onClick={() => void improveIdea(improveNotes, improveModel)}
            >
              {improving ? <><span className="spin" /> Improving…</> : '✦ Improve prompt'}
            </button>
          </div>
        </div>
      ) : null}

      {improveError ? <p className="voice-error">{improveError}</p> : null}
      {improvedPrompt ? (
        <div className="check">
          <span className="eyebrow">AI-SUGGESTED IMPROVEMENT</span>
          {improveRuleWarning ? (
            <p style={{ color: 'var(--amber)', fontSize: 13, lineHeight: 1.5 }}>
              Rule check: {improveRuleWarning} The suggestion is still available below.
            </p>
          ) : null}
          <div className="md-preview" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>
            {improvedPrompt}
          </div>
          <div className="actions">
            <button
              type="button"
              onClick={() => {
                localStorage.removeItem(improveProposalStorageKey)
                setImprovedPrompt('')
              }}
            >
              Keep original
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                // "Featuring:" is structured state, not prose for the model
                // to rewrite. Keep the exact Step 1 reference choices when
                // applying an improved creative brief.
                setIdeaBrief(
                  stepId,
                  withFeaturingNames(improvedPrompt, featuringNames(brief)),
                )
                localStorage.removeItem(improveProposalStorageKey)
                setImprovedPrompt('')
              }}
            >
              Use improved prompt
            </button>
          </div>
        </div>
      ) : null}

      <section className="idea-sources compact">
        {files.length || kitAttachments.length ? (
          <div className="file-list">
            {files.map((file) => (
              <div className={`file-row ${file.kind === 'image' ? 'has-thumb' : ''}`} key={file.id}>
                {/* VISUAL-FIRST RULE: an uploaded image shows AS an image —
                    a real preview, not an icon standing in for one. */}
                {file.kind === 'image' ? (
                  <img className="file-thumb" src={contentUrl(file.id)} alt={file.name} loading="lazy" />
                ) : (
                  <span className="file-icon">
                    <FileGlyph kind={file.kind} />
                  </span>
                )}
                <span className="file-meta-col">
                  <span className="file-name">{file.name}</span>
                  <span className="file-desc">
                    <input
                      value={file.desc}
                      onChange={(event) => setDesc(file.id, event.target.value)}
                      placeholder="Add a one-line description so the model knows how to use this file…"
                    />
                  </span>
                  <span className="file-size">{file.meta}</span>
                </span>
                <button className="file-remove" onClick={() => removeFile(file.id)}>
                  Remove
                </button>
              </div>
            ))}
            {kitAttachments.map((item) => (
              <div className="file-row has-thumb" key={item.id}>
                <img className="file-thumb" src={item.src} alt="" loading="lazy" />
                <span className="file-meta-col">
                  <span className="file-name">{item.name}</span>
                  <span className="file-size">{item.meta}</span>
                </span>
                <button
                  type="button"
                  className="file-remove"
                  onClick={() => onBriefChange(withFeaturingNames(
                    brief,
                    featuringNames(brief).filter((name) => name !== item.name),
                  ))}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </section>
      {!blankProject ? (
        <StepOneAdvanced
          idea={brief}
          onIdeaChange={onBriefChange}
          onKitSelectionChange={handleKitSelectionChange}
        />
      ) : null}
    </div>
  )
}

export function CoreMessageContent({ stepId }: { stepId: string }) {
  const goal = useWorkflowStore((s) => s.goal)
  const storeSetGoal = useWorkflowStore((s) => s.setGoal)
  const setGoal = (g: Goal) => storeSetGoal(stepId, g)
  const candidateJobStorageKey = `spoolcast:core-message-job:${activeSession()}`
  const pendingSuggestionStorageKey = `spoolcast:core-message-wait:${activeSession()}`
  const [writeOpen, setWriteOpen] = useState(false)
  const [candidateJobId, setCandidateJobId] = useState(
    () => sessionStorage.getItem(candidateJobStorageKey) || '',
  )
  const [candidateStarting, setCandidateStarting] = useState(false)
  const [pendingSuggestion, setPendingSuggestion] = useState<{
    instruction: string
    model: string
  } | null>(() => {
    try {
      const stored = sessionStorage.getItem(pendingSuggestionStorageKey)
      if (!stored) return null
      const parsed = JSON.parse(stored)
      return typeof parsed?.instruction === 'string' && typeof parsed?.model === 'string'
        ? parsed
        : null
    } catch {
      return null
    }
  })
  const [candidates, setCandidates] = useState<string[] | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [candidateRuleWarning, setCandidateRuleWarning] = useState<string | null>(null)
  const [needRewind, setNeedRewind] = useState(false)
  const [researchBrief, setResearchBrief] = useState('')
  const [researchOpen, setResearchOpen] = useState(false)
  const [researchEditing, setResearchEditing] = useState(false)
  const [researchRunning, setResearchRunning] = useState(false)
  const [researchSaving, setResearchSaving] = useState(false)
  const [researchError, setResearchError] = useState<string | null>(null)
  const [researchAiOpen, setResearchAiOpen] = useState(false)
  const [researchNotes, setResearchNotes] = useState('')
  const [researchModel, setResearchModel] = useState(DEFAULT_MODEL_ID)
  const [researchUpdateRequested, setResearchUpdateRequested] = useState(false)
  const registerStepAIAction = useWorkflowStore((s) => s.registerStepAIAction)
  const setStepMenu = useWorkflowStore((s) => s.setStepMenu)

  const loadResearchBrief = useCallback(async () => {
    const response = await fetch(fileUrl('working/research-brief.md'), { cache: 'no-store' })
    const out = await response.json().catch(() => null)
    if (out?.ok && out.data?.exists && typeof out.data.content === 'string') {
      setResearchBrief(out.data.content)
    }
  }, [])
  useEffect(() => {
    void loadResearchBrief().catch(() => {})
  }, [loadResearchBrief])

  const saveResearchBrief = useCallback(async (content: string) => {
    setResearchSaving(true)
    setResearchError(null)
    try {
      const response = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: activeSession(),
          tenant: TENANT,
          action: 'set_research_brief',
          content,
        }),
      })
      const out = await response.json().catch(() => null)
      if (!response.ok || out?.ok === false) {
        setResearchError(out?.message || out?.error || 'Could not save the research brief.')
        return false
      }
      return true
    } catch {
      setResearchError('Could not reach the engine. The research edit was not saved.')
      return false
    } finally {
      setResearchSaving(false)
    }
  }, [])

  const updateResearchWithAi = useCallback(async (instructions: string, model: string) => {
    if (researchRunning || researchSaving) return
    if (researchBrief.trim() && !(await saveResearchBrief(researchBrief))) return
    setResearchError(null)
    setResearchRunning(true)
    setResearchUpdateRequested(true)
    const storageKey = researchJobStorageKey()
    sessionStorage.setItem(storageKey, 'pending')
    try {
      const response = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: activeSession(),
          tenant: TENANT,
          action: 'draft_research',
          allow_cost: true,
          force: true,
          model,
          reasoning: draftReasoning(model),
          feedback: instructions.trim(),
        }),
      })
      const out = await response.json().catch(() => null)
      const jobId = out?.data?.id
      if (!response.ok || out?.ok === false || !jobId) {
        sessionStorage.removeItem(storageKey)
        setResearchRunning(false)
        setResearchUpdateRequested(false)
        setResearchError(out?.message || out?.error || 'Could not start the research update.')
        return
      }
      sessionStorage.setItem(storageKey, String(jobId))
    } catch {
      sessionStorage.removeItem(storageKey)
      setResearchRunning(false)
      setResearchUpdateRequested(false)
      setResearchError('Could not reach the engine. The current research brief is unchanged.')
    }
  }, [researchBrief, researchRunning, researchSaving, saveResearchBrief])

  // Step 1 queues research without waiting. Step 2 owns its readable/editable
  // home and follows that same durable job after navigation or a remount.
  useEffect(() => {
    let cancelled = false
    const storageKey = researchJobStorageKey()
    const refreshResearch = async () => {
      const storedJob = sessionStorage.getItem(storageKey)
      if (!storedJob) {
        if (!cancelled) setResearchRunning(false)
        return
      }
      if (!cancelled) setResearchRunning(true)
      if (storedJob === 'pending') return
      const response = await fetch(jobsUrl(storedJob), { cache: 'no-store' })
      const out = await response.json().catch(() => null)
      const status = out?.data?.status
      if (status === 'done') {
        sessionStorage.removeItem(storageKey)
        if (!cancelled) {
          setResearchRunning(false)
          setResearchUpdateRequested(false)
        }
        await loadResearchBrief()
      } else if (!response.ok || out?.ok === false || status === 'failed') {
        sessionStorage.removeItem(storageKey)
        if (!cancelled) {
          setResearchRunning(false)
          if (researchUpdateRequested) {
            setResearchError(out?.data?.message || out?.message || out?.error || 'Research update failed.')
          }
          setResearchUpdateRequested(false)
        }
      }
    }
    void refreshResearch().catch(() => {})
    const timer = window.setInterval(() => void refreshResearch().catch(() => {}), 3000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [loadResearchBrief, researchUpdateRequested])

  // CANDIDATES CONVENTION: working/core-message-candidates.json is THE
  // candidates artifact for every template's lock stage (the drafter writes
  // it; the ad contract declares it as a required output). Preloading it
  // means suggestions survive a reload instead of living in component state.
  useEffect(() => {
    fetch(fileUrl('working/core-message-candidates.json'))
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        if (out?.ok && out.data?.exists) {
          try {
            const parsed = JSON.parse(out.data.content) as {
              candidates?: string[]
              rule_findings?: RuleFinding[]
            }
            const opts = (parsed?.candidates ?? []).filter((c) => typeof c === 'string')
            if (opts.length > 0) setCandidates((prev) => prev ?? opts)
            const warning = ruleFindingMessage(parsed?.rule_findings)
            setCandidateRuleWarning(warning || null)
          } catch { /* ignore */ }
        }
      })
      .catch(() => {})
  }, [])

  // MULTI-MESSAGE: goal.text holds messages separated by blank lines (e.g. a
  // UGC product video may carry 3 selling points). Default is one; "+ Add"
  // appends. session.json:core_message stores the joined text.
  const messages = goal.text === '' ? [''] : goal.text.split('\n\n')
  // Typing claims the text as YOURS (mode '') — editing a picked candidate
  // adopts it as your working draft ("pick one, then edit it").
  const setMessages = (msgs: string[]) => setGoal({ text: msgs.join('\n\n'), mode: '' })

  // Activate a candidate WITHOUT destroying the user's own draft: the draft
  // is stashed in goal.ownText and restored when they come back to option 2.
  const pickCandidate = (c: string) => {
    setGoal({ text: c, mode: 'ai', ownText: goal.mode === '' ? goal.text : goal.ownText })
    setWriteOpen(false)
  }

  // Auto-expand "write your own" once when real content arrives (engine prefill).
  const autoOpenedRef = useRef(false)
  useEffect(() => {
    if (!autoOpenedRef.current && goal.text.trim() && goal.mode === '') {
      autoOpenedRef.current = true
      setWriteOpen(true)
    }
  }, [goal.text, goal.mode])

  // REAL AI SUGGESTION: runs the engine's metered propose_core_message draft
  // (writes working/core-message-candidates.json), then loads the candidates.
  const loadCandidates = useCallback(async () => {
    const response = await fetch(fileUrl('working/core-message-candidates.json'), { cache: 'no-store' })
    const out = await response.json().catch(() => null)
    if (!response.ok || !out?.ok || !out.data?.exists) return
    const parsed = JSON.parse(out.data.content)
    setCandidates(Array.isArray(parsed?.candidates) ? parsed.candidates : [])
    const warning = ruleFindingMessage(parsed?.rule_findings)
    setCandidateRuleWarning(warning || null)
  }, [])

  const generateCandidates = async (instruction: string, requestedModel: string) => {
    setCandidateStarting(true)
    setAiError(null)
    try {
      const res = await fetch(jobsUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: activeSession(),
          tenant: 'local',
          kind: 'draft_stage',
          stage_id: stepId,
          allow_cost: true,
          model: requestedModel,
          ...(draftReasoning(requestedModel) ? { reasoning: draftReasoning(requestedModel) } : {}),
          ...(instruction.trim() ? { feedback: instruction.trim() } : {}),
        }),
      })
      const out = await res.json().catch(() => null)
      const jobId = out?.data?.id
      if (!res.ok || out?.ok === false || !jobId) {
        if (out?.error === 'illegal_action') {
          setNeedRewind(true)
          return
        }
        setAiError(out?.message || out?.error || 'Suggestion failed.')
        return
      }
      sessionStorage.setItem(candidateJobStorageKey, String(jobId))
      setCandidateJobId(String(jobId))
    } catch {
      setAiError('Could not reach the engine.')
    } finally {
      setCandidateStarting(false)
    }
  }

  // The paid draft runs in the engine job queue. Keeping the job id in
  // sessionStorage lets Step 2 resume the same poll after navigation/remounts
  // instead of starting a duplicate model call.
  useEffect(() => {
    if (!candidateJobId) return
    let cancelled = false
    const poll = async () => {
      try {
        const response = await fetch(jobsUrl(candidateJobId), { cache: 'no-store' })
        const out = await response.json().catch(() => null)
        if (cancelled) return
        const job = out?.data
        if (!response.ok || out?.ok === false) {
          throw new Error(out?.message || out?.error || 'Could not check the candidate draft.')
        }
        if (job?.status === 'done') {
          sessionStorage.removeItem(candidateJobStorageKey)
          setCandidateJobId('')
          await loadCandidates()
        } else if (job?.status === 'failed') {
          sessionStorage.removeItem(candidateJobStorageKey)
          setCandidateJobId('')
          const error = job?.result?.error || job?.error
          if (error === 'illegal_action') setNeedRewind(true)
          else setAiError(job?.message || job?.result?.message || error || 'Suggestion failed.')
        }
      } catch (error) {
        if (!cancelled) {
          sessionStorage.removeItem(candidateJobStorageKey)
          setCandidateJobId('')
          setAiError(error instanceof Error ? error.message : 'Could not check the candidate draft.')
        }
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 3000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [candidateJobId, candidateJobStorageKey, loadCandidates])

  // Research never holds the user on Step 1 or locks the rest of Step 2.
  // It only sequences this dependent AI action: a click made while research is
  // active is remembered, shows an honest waiting state, and runs automatically
  // once research-brief.md has finished writing.
  const suggest = async (
    requestedFeedback: string | unknown = '',
    requestedModel = DEFAULT_MODEL_ID,
  ) => {
    if (candidateStarting || candidateJobId || pendingSuggestion) return
    const instruction = typeof requestedFeedback === 'string' ? requestedFeedback : ''
    const researchPending = researchRunning
      || Boolean(sessionStorage.getItem(researchJobStorageKey()))
    if (researchPending) {
      setAiError(null)
      const request = { instruction, model: requestedModel }
      sessionStorage.setItem(pendingSuggestionStorageKey, JSON.stringify(request))
      setPendingSuggestion(request)
      return
    }
    await generateCandidates(instruction, requestedModel)
  }

  useEffect(() => {
    if (
      !pendingSuggestion
      || researchRunning
      || sessionStorage.getItem(researchJobStorageKey())
    ) return
    const request = pendingSuggestion
    const timer = window.setTimeout(() => {
      sessionStorage.removeItem(pendingSuggestionStorageKey)
      setPendingSuggestion(null)
      void loadResearchBrief()
        .catch(() => {})
        .then(() => generateCandidates(request.instruction, request.model))
    }, 0)
    return () => window.clearTimeout(timer)
  }, [loadResearchBrief, pendingSuggestion, researchRunning])

  const generating = candidateStarting || Boolean(candidateJobId)
  const aiBusy = generating || Boolean(pendingSuggestion)

  const rewindAndSuggest = async () => {
    setNeedRewind(false)
    try {
      const res = await fetch(actionUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: activeSession(),
          tenant: 'local',
          action: 'rewind_stage',
          stage_id: stepId,
          // AI-suggest on a passed step rewrites this step only — keep every
          // later step's files; approvals reset and get re-passed in order.
          keep_files: true,
        }),
      })
      const out = await res.json().catch(() => null)
      if (!res.ok || out?.ok === false) {
        setAiError(out?.message || out?.error || 'Could not invalidate the stage.')
        return
      }
      await suggest()
    } catch {
      setAiError('Could not reach the engine.')
    }
  }

  useEffect(() => {
    registerStepAIAction(stepId, {
      stageId: stepId,
      label: candidates?.length ? 'Update with AI' : 'Complete step with AI',
      busy: aiBusy,
      busyLabel: pendingSuggestion
        ? 'Waiting for research to finish…'
        : 'Drafting candidates…',
      usesTextModel: true,
      run: ({ instructions, model: requestedModel }) => suggest(instructions, requestedModel),
    })
    return () => registerStepAIAction(stepId, null)
  }, [aiBusy, candidates?.length, pendingSuggestion, registerStepAIAction, stepId])

  useEffect(() => {
    setStepMenu({
      stepId,
      actions: [{
        id: 'view-step-1-research',
        label: 'View research from Step 1',
        title: researchOpen ? 'Hide the Step 1 research brief' : 'Show the Step 1 research brief',
        active: researchOpen,
        placement: 'toolbar',
        run: () => setResearchOpen((open) => !open),
      }],
    })
    return () => {
      if (useWorkflowStore.getState().stepMenu?.stepId === stepId) setStepMenu(null)
    }
  }, [researchOpen, setStepMenu, stepId])

  // ONLY the selected option wears a stroke (the app's accent selection
  // treatment, same family as .core-opt.sel / .node.selected) — unselected
  // cards are quiet surfaces, so exactly one option ever reads as chosen.
  const optStyle = (sel: boolean): React.CSSProperties => ({
    width: '100%',
    textAlign: 'left',
    border: `1px solid ${sel ? 'var(--accent)' : 'transparent'}`,
    borderRadius: 10,
    background: sel ? 'rgba(122,162,255,.07)' : 'rgba(255,255,255,.02)',
    padding: '14px 16px',
    marginBottom: 10,
  })

  return (
    <div className="idea-v2">
      {researchOpen ? (
        <section className="vp-section">
          <div className="vp-section-sum">
            <span className="vp-sec-title">Research from Step 1</span>
            <span className="vp-section-count">
              {researchRunning ? (
                <><span className="spin" /> UPDATING</>
              ) : researchBrief.trim() ? 'READY' : 'NOT AVAILABLE'}
            </span>
          </div>
        <div style={{ marginTop: 12 }}>
          {researchRunning ? (
            <p className="voice-pron-existing" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 10px' }}>
              <span className="spin" />
              <span>Research is updating in the background. You can continue working.</span>
            </p>
          ) : null}
          {researchBrief.trim() && !researchEditing ? (
            <div
              className="md-preview"
              title="Click to edit"
              onClick={() => {
                if (!researchRunning) setResearchEditing(true)
              }}
              style={{
                border: '1px solid var(--line, #2a3142)',
                borderRadius: 8,
                padding: '4px 16px',
                cursor: researchRunning ? 'default' : 'text',
                opacity: researchRunning ? 0.4 : 1,
                pointerEvents: researchRunning ? 'none' : 'auto',
              }}
              dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(marked.parse(researchBrief, { async: false }) as string),
              }}
            />
          ) : researchEditing ? (
            <textarea
              className="raw-source-textarea"
              autoFocus
              value={researchBrief}
              onChange={(event) => setResearchBrief(event.target.value)}
              onBlur={() => {
                setResearchEditing(false)
                void saveResearchBrief(researchBrief)
              }}
              style={{
                width: '100%',
                minHeight: 240,
                boxSizing: 'border-box',
                resize: 'vertical',
                background: 'transparent',
                color: 'var(--ink-1, inherit)',
                border: '1px solid var(--line, #2a3142)',
                borderRadius: 8,
                padding: 12,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 13,
                lineHeight: 1.55,
              }}
            />
          ) : (
            <p className="vp-hint" style={{ margin: 0 }}>
              {researchRunning
                ? 'The brief will appear here when it is ready.'
                : 'No research brief was created for this project.'}
            </p>
          )}
          {researchBrief.trim() ? (
            <span className="label" style={{ display: 'block', marginTop: 6 }}>
              {researchEditing ? 'Click away to save.' : 'Click the text to edit the raw markdown.'}
            </span>
          ) : null}
          {researchError ? <p className="voice-error">{researchError}</p> : null}
          <div className="step1-input-actions">
            <span className={`vg-split-action ${researchAiOpen ? 'open' : ''}`}>
              <button
                type="button"
                className="vg-split-toggle"
                disabled={researchRunning || researchSaving}
                title="Add optional notes or choose a model"
                aria-label="Open research update options"
                onClick={() => setResearchAiOpen((value) => !value)}
              >
                {researchAiOpen ? '▴' : '▾'}
              </button>
              <button
                type="button"
                className="vp-undo vg-split-main"
                disabled={researchRunning || researchSaving}
                onClick={() => void updateResearchWithAi('', researchModel)}
              >
                {researchRunning ? <><span className="spin" /> Updating research…</> : '✦ Update research with AI'}
              </button>
            </span>
          </div>
          {researchAiOpen ? (
            <div className="vg-regen-note-panel step1-improve-panel">
              <textarea
                value={researchNotes}
                onChange={(event) => setResearchNotes(event.target.value)}
                placeholder="Optional directions for what the updated research should add, verify, or preserve…"
                rows={3}
              />
              <div className="vp-edit-actions step1-improve-actions">
                <ModelPicker
                  model={researchModel}
                  onChange={setResearchModel}
                  disabled={researchRunning}
                />
                <button
                  type="button"
                  className="vp-save"
                  disabled={researchRunning || researchSaving}
                  onClick={() => void updateResearchWithAi(researchNotes, researchModel)}
                >
                  {researchRunning ? <><span className="spin" /> Updating…</> : '✦ Update research'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
        </section>
      ) : null}

      <h3 className="idea-q">What should the viewer walk away believing?</h3>

      {needRewind && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <span style={{ color: 'var(--amber)', fontSize: 13 }}>
            This step is already approved. New suggestions will <b>un-approve it and every step
            after it</b> — you’ll review and approve them again as you go.
          </span>
          <button className="save-continue" style={{ width: 'auto', padding: '8px 14px' }} onClick={rewindAndSuggest}>
            Un-approve & suggest
          </button>
          <button
            style={{ background: 'none', border: '1px solid var(--line, #2a3142)', borderRadius: 6, color: 'var(--ink-2)', padding: '8px 14px', cursor: 'pointer', fontSize: 13 }}
            onClick={() => setNeedRewind(false)}
          >
            Never mind, keep it
          </button>
        </div>
      )}

      {/* OPTION 1 — AI suggests (the default path). Selected while the
          locked text came from picking a candidate — writing your own hands
          the selection to option 2. Clicking the card (once candidates
          exist) selects it by activating the highlighted/first candidate;
          the user's own draft is stashed in goal.ownText, never destroyed. */}
      <div
        role="button"
        tabIndex={aiBusy ? -1 : 0}
        aria-busy={aiBusy}
        aria-label={candidates?.length ? 'Choose an AI-generated core message' : 'Draft three core-message candidates with AI'}
        style={{ ...optStyle(goal.mode === 'ai'), cursor: aiBusy ? 'wait' : 'pointer' }}
        onClick={(e) => {
          if (aiBusy) return
          if ((e.target as HTMLElement).closest('button, textarea, input')) return
          if (!candidates?.length) {
            void suggest()
            return
          }
          if (goal.mode === 'ai') return
          pickCandidate(candidates[0])
        }}
        onKeyDown={(event) => {
          if (aiBusy || (event.key !== 'Enter' && event.key !== ' ')) return
          event.preventDefault()
          if (!candidates?.length) void suggest()
          else if (goal.mode !== 'ai') pickCandidate(candidates[0])
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="ap-spark">✦</span>
          <span style={{ flex: 1 }}>
            <span className="nm" style={{ display: 'block' }}>
              {pendingSuggestion ? (
                <><span className="spin" /> Waiting for research to finish…</>
              ) : generating ? (
                <><span className="spin" /> Drafting candidates…</>
              ) : 'Let AI suggest'}
            </span>
            <span className="ds">
              {candidates?.length
                ? '3 candidates drafted from your idea & source material — pick one, then edit it'
                : 'Draft 3 candidates from your idea & source material — pick one, then edit it'}
            </span>
          </span>
        </div>
        {aiError && <div style={{ color: 'var(--red)', fontSize: 13, marginTop: 8 }}>Engine: {aiError}</div>}
        {candidateRuleWarning ? (
          <div style={{ color: 'var(--amber)', fontSize: 13, marginTop: 8, lineHeight: 1.5 }}>
            Rule check: {candidateRuleWarning} The candidates are still available.
          </div>
        ) : null}
        {candidates && candidates.length > 0 && (
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {candidates.map((c, i) => (
              <button
                key={i}
                type="button"
                onClick={() => pickCandidate(c)}
                style={{
                  textAlign: 'left',
                  border: `1px solid ${goal.text === c ? 'var(--ink-2)' : 'var(--line, #2a3142)'}`,
                  borderRadius: 8,
                  background: goal.text === c ? 'rgba(255,255,255,.04)' : 'transparent',
                  color: 'var(--ink-2)',
                  padding: '10px 12px',
                  fontSize: 13,
                  lineHeight: 1.5,
                  cursor: 'pointer',
                }}
              >
                {c}
              </button>
            ))}
            {goal.mode === 'ai' && (
              <textarea
                className="idea-textbox"
                rows={2}
                value={goal.text}
                onChange={(e) => setGoal({ text: e.target.value, mode: 'ai', ownText: goal.ownText })}
                title="Edit your pick — refining a candidate keeps the AI option selected"
                style={{ width: '100%', boxSizing: 'border-box' }}
              />
            )}
          </div>
        )}
      </div>

      {/* OPTION 2 — write your own (collapsed until expanded). Selected when
          the message is yours — typed, edited, or claimed by clicking here. */}
      <div style={optStyle(goal.mode === '' && (goal.text.trim().length > 0 || writeOpen))}>
        <button
          type="button"
          onClick={() => {
            if (goal.mode !== '') {
              // Coming back from AI/skip: restore the stashed own draft.
              setGoal({ text: goal.ownText ?? '', mode: '' })
              setWriteOpen(true)
            } else {
              setWriteOpen((v) => !v)
            }
          }}
          style={{ background: 'none', border: 'none', padding: 0, width: '100%', textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}
        >
          <span style={{ fontSize: 10, color: 'var(--ink-2)' }}>{writeOpen ? '▾' : '▸'}</span>
          <span style={{ flex: 1 }}>
            <span className="nm" style={{ display: 'block' }}>Write your own</span>
            <span className="ds">one by default — add more if the video carries several points</span>
          </span>
        </button>
        {writeOpen && (
          <div style={{ marginTop: 10 }}>
            {messages.map((m, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <textarea
                  className="idea-textbox"
                  rows={2}
                  value={m}
                  onChange={(e) => setMessages(messages.map((x, j) => (j === i ? e.target.value : x)))}
                  placeholder={i === 0 ? 'The one thing a viewer should walk away believing.' : 'Another core point…'}
                  style={{ flex: 1 }}
                />
                {messages.length > 1 && (
                  <button
                    type="button"
                    title="Remove this message"
                    onClick={() => setMessages(messages.filter((_, j) => j !== i))}
                    style={{ background: 'none', border: '1px solid var(--line, #2a3142)', borderRadius: 6, color: 'var(--ink-3)', padding: '0 10px', cursor: 'pointer' }}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={() => setMessages([...messages, ''])}
              style={{ background: 'none', border: '1px dashed var(--line, #2a3142)', borderRadius: 6, color: 'var(--ink-2)', padding: '6px 12px', cursor: 'pointer', fontSize: 13 }}
            >
              + Add another core message
            </button>
          </div>
        )}
      </div>

      {/* OPTION 3 — skip */}
      <button
        type="button"
        className={goal.mode === 'skip' ? 'sel' : ''}
        onClick={() => setGoal({ text: '', mode: 'skip', ownText: goal.mode === '' ? goal.text : goal.ownText })}
        style={{ ...optStyle(goal.mode === 'skip'), cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}
      >
        <span style={{ flex: 1 }}>
          <span className="nm" style={{ display: 'block' }}>Skip — no core message needed</span>
          <span className="ds">freeform / vibe-based</span>
        </span>
      </button>
    </div>
  )
}

function FileGlyph({ kind }: { kind: 'doc' | 'clock' | 'image' }) {
  if (kind === 'clock') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    )
  }
  if (kind === 'image') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="M21 15l-5-5L5 21" />
      </svg>
    )
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}

// Per-episode settings for SERIES projects. The inherited view locks what the
// series owns (style, format, voice) — but episode length is a per-episode
// decision the series must not swallow. This section feeds the SAME save path
// as the blank-project flow: step-1 save writes target_length_s to the engine
// (set_session_fields), which every AI drafter downstream reads.
export function EpisodeSettings({ stepId }: { stepId: string }) {
  const s1 = useWorkflowStore((s) => s.s1)
  const storeSetS1 = useWorkflowStore((s) => s.setS1)
  const seedDrafts = useWorkflowStore((s) => s.seedDrafts)
  const seededRef = useRef(false)
  const setS1: React.Dispatch<React.SetStateAction<S1>> = (updater) => storeSetS1(stepId, updater)

  // THE FORMAT ANSWERS THIS, OR NOBODY ASKS IT: video-first templates generate
  // picture and sound together, so a still cannot carry the audio and the
  // medium cannot vary (docs/format-templates.md). Only audio-first slots the
  // visuals into an audio clock, where still-vs-clip is a real parameter.
  // Mirrors scripts/shot_medium.medium_is_a_choice — keep both in sync.
  // Hide ONLY for video-first — matching the engine's `!= "video-first"`
  // exactly. An unknown template (the devlogs predate the field) is a real
  // choice, not a reason to hide the control the engine would still honour.
  const [mediumIsAChoice, setMediumIsAChoice] = useState(false)
  useEffect(() => {
    let live = true
    Promise.all([
      fetch(fileUrl('session.json')).then((r) => (r.ok ? r.json() : null)),
      fetch(templatesUrl()).then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([sess, reg]) => {
        if (!live || typeof sess?.data?.content !== 'string') return
        const tpl = String(JSON.parse(sess.data.content)?.template || '')
        const hit = reg?.data?.templates?.find((t: { id?: string }) => t.id === tpl)
        setMediumIsAChoice(hit?.format !== 'video-first')
      })
      .catch(() => {
        /* engine offline — stay hidden rather than ask what we can't judge */
      })
    return () => {
      live = false
    }
  }, [])

  // Prefill from the engine's session.json (files are truth) — never clobber
  // an edit in progress.
  useEffect(() => {
    if (seededRef.current) return
    seededRef.current = true
    fetch(fileUrl('session.json'))
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        if (!out?.ok || !out.data?.exists || typeof out.data.content !== 'string') return
        try {
          const cfg = JSON.parse(out.data.content)
          const len = Number(cfg?.target_length_s)
          const medium = String(cfg?.shot_medium || '')
          const store = useWorkflowStore.getState()
          if (store.dirtySteps[stepId]) return
          const next = { ...store.s1 }
          if (Number.isFinite(len) && len > 0) next.length = len
          if (medium === 'video' || medium === 'image' || medium === 'mix') next.medium = medium
          if (next.length !== store.s1.length || next.medium !== store.s1.medium) {
            seedDrafts({ s1: next })
          }
        } catch {
          /* unreadable session.json — keep the default */
        }
      })
      .catch(() => {
        /* engine offline — the status UI explains */
      })
  }, [stepId, seedDrafts])

  // One quiet row: label · sleek hairline slider · value · ✦ AI button.
  // The "not inherited" explanation lives in the tooltip.
  const fill = `${Math.round((((s1.length || 300) - 15) / (600 - 15)) * 100)}%`
  return (
    <>
    <div
      title="Not inherited from the show — structure, script, and visuals are planned to this length"
      style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 0' }}
    >
      <span style={{ fontSize: 13, color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>Length</span>
      <input
        type="range"
        className="sleek-range"
        min={15}
        max={600}
        step={15}
        value={s1.length || 300}
        disabled={s1.length === 0}
        onChange={(event) => setS1((c) => ({ ...c, length: Number(event.target.value) }))}
        style={{ flex: 1, ['--fill' as string]: fill } as React.CSSProperties}
      />
      <b style={{ fontSize: 13, color: s1.length === 0 ? 'var(--ink-3)' : 'var(--ink)', whiteSpace: 'nowrap', minWidth: 92, textAlign: 'right' }}>
        {s1.length === 0 ? 'Auto' : `~${Math.round((s1.length / 60) * 10) / 10} min · ${s1.length}s`}
      </b>
      <button
        className={`ai-btn ${s1.length === 0 ? 'sel' : ''}`}
        title="The AI picks a length from the source material at the structure step"
        onClick={() => setS1((c) => ({ ...c, length: c.length === 0 ? 300 : 0 }))}
      >
        <span className="ap-spark">✦</span> Let AI decide
      </button>
    </div>
    {/* Shots: only asked when the format leaves it open. Video-first generates
        picture and sound together, so there is nothing to choose. */}
    {mediumIsAChoice ? (
      <div
        title="Video clips cost far more than stills, and the choice sets each shot's legal length"
        style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 0' }}
      >
        <span style={{ fontSize: 13, color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>Shots</span>
        <div style={{ flex: 1, display: 'flex', gap: 8 }}>
          {[
            ['image', 'Stills', 'every shot is a held frame — cheapest'],
            ['video', 'Video', 'every shot is generated motion'],
          ].map(([id, label, hint]) => (
            <button
              key={id}
              className={`pill-btn ${s1.medium === id ? 'sel' : ''}`}
              title={hint}
              onClick={() => setS1((c) => ({ ...c, medium: c.medium === id ? '' : id }))}
            >
              {label}
            </button>
          ))}
        </div>
        {/* "Let AI decide" IS the mix policy — under it the screenplay drafter
            picks a medium per shot and you can flip any row. Not a third
            option beside Mix: the same thing said honestly. Purple because the
            AI really does decide here, the way length=0 defers to step 04. */}
        <button
          className={`ai-btn ${s1.medium === 'mix' ? 'sel' : ''}`}
          title="The AI picks stills or video per shot at the screenplay — you can change any of them"
          onClick={() => setS1((c) => ({ ...c, medium: c.medium === 'mix' ? '' : 'mix' }))}
        >
          <span className="ap-spark">✦</span> Let AI decide
        </button>
      </div>
    ) : null}
    </>
  )
}

// SERIES SETUP (step 01 for series episodes): flat rows with hairline
// dividers — no nested boxes. Inherited rows show the REAL sources (style
// from session.json, voice + series rules from the engine's rulebooks) and
// expand in place for detail. Per-episode fields (length) sit below.
export function SeriesSetup({ stepId, showName, onOpenCast }: { stepId: string; showName: string; onOpenCast: () => void }) {
  const setupAIError = useSetupAISuggestion(stepId)
  const ideaBrief = useWorkflowStore((s) => s.ideaBrief)
  const selectedWorldKitNames = featuringNames(ideaBrief)
  const [open, setOpen] = useState<string | null>(null)
  const [styleId, setStyleId] = useState('')
  const [series, setSeries] = useState('')
  const [template, setTemplate] = useState('')
  // The CLOCK (audio-first / video-first) comes from the template registry —
  // session.json's `format` key is the contract id (naming debt, see
  // docs/format-templates.md), so it can't be read as the clock.
  const [clock, setClock] = useState('')
  const [voiceExcerpt, setVoiceExcerpt] = useState('')
  const [rulesExcerpt, setRulesExcerpt] = useState('')

  useEffect(() => {
    fetch(fileUrl('session.json'))
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        if (out?.ok && out.data?.exists) {
          try {
            const cfg = JSON.parse(out.data.content)
            if (typeof cfg?.style === 'string') setStyleId(cfg.style)
            if (typeof cfg?.series === 'string') setSeries(cfg.series)
            if (typeof cfg?.template === 'string') {
              setTemplate(cfg.template)
              fetch(templatesUrl())
                .then((r) => (r.ok ? r.json() : null))
                .then((reg) => {
                  const hit = reg?.data?.templates?.find(
                    (t: { id?: string; format?: string }) => t.id === cfg.template,
                  )
                  if (typeof hit?.format === 'string') setClock(hit.format)
                })
                .catch(() => {})
            }
          } catch { /* ignore */ }
        }
      })
      .catch(() => {})
    fetch(apiUrl('rules', { session: activeSession(), tenant: TENANT }))
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        if (out?.ok && Array.isArray(out.data?.rules)) {
          for (const r of out.data.rules) {
            if (String(r.id).endsWith(':voice')) setVoiceExcerpt(String(r.content).slice(0, 420))
            if (String(r.id).endsWith(':rules') && r.scope === 'series') setRulesExcerpt(String(r.content).slice(0, 420))
          }
        }
      })
      .catch(() => {})
  }, [])

  // Deep-link straight to the relevant rulebook — never make the user hunt.
  const goRules = (focus?: string) => {
    window.location.href = `/p/${activeSession()}/rules${focus ? `?focus=${focus}` : ''}`
  }

  const rows: { id: string; label: string; value: string; jump?: () => void; detail?: React.ReactNode }[] = [
    {
      id: 'style',
      label: 'Visual style',
      // No style on the session = no style. Claiming one would be a lie —
      // ad sessions ship without a style anchor until the Brand kit sets one.
      value: styleId ? `Wojak comic · ${styleId}` : 'Not set yet — the Brand kit / World Kit owns the look',
      detail: (
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
          <img src={asset('styles/wojak-comic/references/chad.png')} alt="" style={{ width: 240, maxWidth: '45%', borderRadius: 8 }} />
          <p style={{ margin: 0 }}>
            Locked by the show — every episode renders in this style so the channel looks
            consistent. The style anchor, character references, and prompt rules live in the
            World Kit and the Visuals rulebook.
          </p>
        </div>
      ),
    },
    {
      id: 'format',
      label: 'Format',
      // The format is a FACT of the session, decided when its template was
      // picked (docs/format-templates.md) — never re-asked here. The clock
      // comes from the template registry, not a hardcoded assumption.
      value: template
        ? clock === 'video-first'
          ? `Video-first — the clips own the clock · from the ${template} template`
          : `Audio-first — narration drives the clock · from the ${template} template`
        : 'Illustration video · 16:9 widescreen',
      detail: (
        <p style={{ margin: 0 }}>
          {template
            ? clock === 'video-first'
              ? 'Locked when this video was created: the video model generates picture and sound together, the clips are the timeline, and any music is layered on afterwards. Want a narrated piece instead? Start a new video from an audio-first template.'
              : 'Locked when this video was created: the narration audio owns the master timeline and visuals are slotted into it. Want a video-first piece instead? Start a new video from a video-first template.'
            : "Chunked still images rendered into video: the script is split into audio chunks, each chunk gets one or more generated images, and the renderer assembles them with narration, captions, and overlays. Locked by the show's format template."}
        </p>
      ),
    },
    // Video-first sessions have NO narration voice — the spoken lines live in
    // the clips. Showing a voice profile row there would be a lie.
    ...(clock === 'video-first'
      ? []
      : [{
          id: 'voice',
          label: 'Narration voice',
          value: series ? `${series} voice profile` : 'series voice profile',
          detail: (
            <>
              {voiceExcerpt ? <p style={{ margin: '0 0 8px', whiteSpace: 'pre-wrap' }}>{voiceExcerpt}…</p> : <p style={{ margin: '0 0 8px' }}>The voice profile loads from the engine.</p>}
              <button type="button" className="vp-undo" onClick={() => goRules('voice')}>Read or edit the full profile →</button>
            </>
          ),
        }]),
    {
      id: 'rules',
      label: 'Series rules',
      value: series || 'series editorial conventions',
      detail: (
        <>
          {rulesExcerpt ? <p style={{ margin: '0 0 8px', whiteSpace: 'pre-wrap' }}>{rulesExcerpt}…</p> : <p style={{ margin: '0 0 8px' }}>The series rulebook loads from the engine.</p>}
          <button type="button" className="vp-undo" onClick={() => goRules('series-rules')}>Read or edit the full rulebook →</button>
        </>
      ),
    },
    {
      id: 'worldkit',
      label: 'World Kit',
      value: selectedWorldKitNames.length
        ? selectedWorldKitNames.join(', ')
        : 'No featured references selected in Step 1',
      jump: onOpenCast,
    },
  ]

  // No divider lines — quiet rows separated by whitespace only. Plain divs,
  // not <button>s: dark-mode browsers paint buttons with their own dark
  // background, which read as a "black bar" here.
  const rowBtn: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 12, width: '100%',
    padding: '11px 2px', backgroundColor: 'transparent',
    cursor: 'pointer', fontSize: 13, textAlign: 'left',
  }

  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 2 }}>Inherited from {showName}</div>
      {rows.map((r) => (
        <div key={r.id}>
          <div
            role="button"
            tabIndex={0}
            style={rowBtn}
            onClick={() => (r.jump ? r.jump() : setOpen((o) => (o === r.id ? null : r.id)))}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              if (r.jump) r.jump()
              else setOpen((o) => (o === r.id ? null : r.id))
            }}
          >
            <span style={{ width: 150, flexShrink: 0, color: 'var(--ink-2)' }}>{r.label}</span>
            <span style={{ flex: 1, color: 'var(--ink)' }}>{r.value}</span>
            {r.jump ? (
              <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>→</span>
            ) : (
              // Same chevron as everywhere else in the app (rotating SVG).
              <svg
                width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                style={{ color: 'var(--ink-3)', transform: open === r.id ? 'rotate(180deg)' : 'none', transition: 'transform .15s ease', flexShrink: 0 }}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            )}
          </div>
          {open === r.id && r.detail ? (
            // Reading width, not page width.
            <div style={{ margin: '4px 2px 18px 164px', maxWidth: 560, color: 'var(--ink-2)', fontSize: 13, lineHeight: 1.6 }}>
              {r.detail}
            </div>
          ) : null}
        </div>
      ))}
      <div className="eyebrow" style={{ margin: '22px 0 2px' }}>This episode</div>
      <EpisodeSettings stepId={stepId} />
      {setupAIError ? <p className="voice-error">Engine: {setupAIError}</p> : null}
    </div>
  )
}

// SHOW SETUP (the show-plan contract's series_setup stage): the show-tier
// twin of the episode "Project setup" step — the same format question and
// row idiom, pointed at SHOW scope. Field edits save onto the planning
// session (set_session_fields, the episode step's save path); approving the
// stage stamps the template and these defaults into series/<id>/defaults.json,
// where every fanned-out episode inherits them. Narrator voice is the ONE
// format-conditional row: narration-first shows see it, video-first shows
// don't — same panel, never a second flow.
const SERIES_SETUP_TEMPLATE_RE = /^Template:\s*([a-z0-9\-_]+)\s*$/m

export function ShowSetup({ stepId }: { stepId: string }) {
  const registerStepAIAction = useWorkflowStore((s) => s.registerStepAIAction)
  const [seriesId, setSeriesId] = useState('')
  const [draftMd, setDraftMd] = useState('')
  const [ttsVoice, setTtsVoice] = useState('')
  const [stylePrompt, setStylePrompt] = useState('')
  const [aspect, setAspect] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const savedStyleRef = useRef('')
  const styleBoxRef = useRef<HTMLTextAreaElement | null>(null)

  // The draft file is the machine truth (its Template line is what approval
  // parses); the format question is that line rendered as the step-1 pills.
  // The Recommended/Aspect/Style lines are the AI's original picks — they
  // survive user overrides, so "Recommended by Spoolcast" stays honest.
  const templateId = SERIES_SETUP_TEMPLATE_RE.exec(draftMd)?.[1] ?? ''
  const narrator = templateId === 'explainer' ? 'yes' : templateId === 'ad' ? 'no' : ''
  const recTemplate = /^Recommended:\s*([a-z0-9\-_]+)\s*$/m.exec(draftMd)?.[1] ?? ''
  const recNarrator = recTemplate === 'explainer' ? 'yes' : recTemplate === 'ad' ? 'no' : ''
  const recAspect = /^Aspect:\s*(16:9|9:16|1:1)\s*$/m.exec(draftMd)?.[1] ?? ''
  const recStyle = /^Style:\s*(.+?)\s*$/m.exec(draftMd)?.[1] ?? ''
  const why = /## Why\n+([\s\S]*?)(?:\n## |$)/.exec(draftMd)?.[1]?.trim() ?? ''

  const loadDraft = useCallback(async (): Promise<boolean> => {
    const out = await fetch(fileUrl('working/series-setup.md'))
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
    if (out?.ok && out.data?.exists && typeof out.data.content === 'string') {
      setDraftMd(out.data.content)
      return true
    }
    return false
  }, [])

  useEffect(() => {
    fetch(fileUrl('session.json'))
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        if (!out?.ok || !out.data?.exists || typeof out.data.content !== 'string') return
        try {
          const cfg = JSON.parse(out.data.content)
          if (typeof cfg?.series === 'string') setSeriesId(cfg.series)
          if (typeof cfg?.tts_voice === 'string') setTtsVoice(cfg.tts_voice)
          if (typeof cfg?.default_style_prompt === 'string') {
            setStylePrompt(cfg.default_style_prompt)
            savedStyleRef.current = cfg.default_style_prompt
          }
          if (typeof cfg?.aspect_ratio === 'string') setAspect(cfg.aspect_ratio)
        } catch { /* unreadable session.json — leave the defaults */ }
      })
      .catch(() => {})
    // Season-breakdown approval auto-drafts the recommendation (zero-touch);
    // if it hasn't landed yet, keep checking while the job runs.
    let alive = true
    let attempts = 0
    const tick = async () => {
      const found = await loadDraft()
      attempts += 1
      if (alive && !found && attempts < 24) window.setTimeout(tick, 5000)
    }
    void tick()
    return () => { alive = false }
  }, [loadDraft])

  const saveFields = async (fields: Record<string, unknown>) => {
    setError('')
    const out = await postAction<{ message?: string; error?: string }>({ action: 'set_session_fields', fields })
    if (out?.ok === false) setError(String(out?.message || out?.error || 'Could not save.'))
  }

  const chooseFormat = async (choice: 'yes' | 'no') => {
    const id = choice === 'yes' ? 'explainer' : 'ad'
    const next = SERIES_SETUP_TEMPLATE_RE.test(draftMd)
      ? draftMd.replace(SERIES_SETUP_TEMPLATE_RE, `Template: ${id}`)
      : `# Format — ${seriesId || 'show'}\n\nTemplate: ${id}\n\n## Why\n\nChosen by hand in Series setup.\n`
    setDraftMd(next)
    setError('')
    const out = await postAction<{ message?: string; error?: string }>({
      action: 'set_stage_output',
      stage_id: stepId,
      path: 'working/series-setup.md',
      content: next,
    })
    if (out?.ok === false) setError(String(out?.message || out?.error || 'Could not save the format choice.'))
  }

  // The step's ✦ button runs the engine drafter (the stage's registered
  // action, same OpenRouter path as the other planning gates) and reloads
  // the recommendation.
  const busyRef = useRef(false)
  useEffect(() => {
    registerStepAIAction(stepId, {
      stageId: stepId,
      label: 'Recommend a format',
      busy,
      busyLabel: 'Reading the season breakdown…',
      usesTextModel: false,
      acceptsInstructions: false,
      run: async () => {
        if (busyRef.current) return
        busyRef.current = true
        setBusy(true)
        setError('')
        try {
          const out = await postAction<{ message?: string; error?: string }>({
            action: 'draft_stage',
            stage_id: stepId,
            allow_cost: true,
          })
          if (out?.ok === false) setError(String(out?.message || out?.error || 'Drafting failed.'))
          await loadDraft()
        } finally {
          busyRef.current = false
          setBusy(false)
        }
      },
    })
    return () => registerStepAIAction(stepId, null)
  }, [busy, loadDraft, registerStepAIAction, stepId])

  const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0' }
  const labelStyle: CSSProperties = { width: 104, flexShrink: 0, fontSize: 13, color: 'var(--ink-2)' }
  // The visible aspect: the user's saved choice, else the AI's recommendation
  // (which is exactly what approval will stamp if left untouched).
  const shownAspect = aspect || recAspect
  const shownStyle = stylePrompt || recStyle

  // The style box grows to fit its content (the user can still drag the
  // resize handle for more room). Refit when the card's width settles or
  // changes — measuring during the card's initial layout wraps the text
  // into a sliver and locks in a bogus height.
  useEffect(() => {
    const el = styleBoxRef.current
    if (!el) return
    const fit = () => {
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight + 2}px`
    }
    fit()
    let lastWidth = el.clientWidth
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== lastWidth) {
        lastWidth = el.clientWidth
        fit()
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [shownStyle])
  // The ✦ tag sits ON TOP of whatever it recommends. Every option column
  // reserves the SAME fixed tag line, so box tops stay perfectly aligned
  // whether or not a column carries the tag.
  const recTag = (on: boolean) => (
    <span className="lock-text" style={{ display: 'block', height: 16, lineHeight: '16px', whiteSpace: 'nowrap', overflow: 'hidden' }}>
      {on ? (<><span className="ap-spark">✦</span> AI recommended</>) : null}
    </span>
  )

  return (
    <div>
      <div className="s1-flow">
        <div className="s1-question active">
          <div className="s1-q-head" style={{ marginBottom: 4 }}>
            <span className="s1-q-title">
              Is there a narrator? <span style={{ color: 'var(--ink-3)', fontWeight: 400 }}>(this decides how the audio is made)</span>
            </span>
          </div>
          <div className="s1-pills">
            {([
              ['yes', 'Yes — a narrator reads the entire video', 'audio is generated separately from the video'],
              ['no', 'Speech is generated with the video', 'characters speak on screen — no separate narration track'],
            ] as const).map(([key, name, desc]) => (
              <span key={key} style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {recTag(recNarrator === key)}
                <Pill selected={narrator === key} onClick={() => void chooseFormat(key)}>
                  <span className="name">{name}</span>
                  <span className="desc">{desc}</span>
                </Pill>
              </span>
            ))}
          </div>
        </div>
      </div>
      {why ? (
        <div style={{ margin: '4px 2px 10px', color: 'var(--ink-2)', fontSize: 13, lineHeight: 1.6 }}>
          <span className="eyebrow" style={{ display: 'block', marginBottom: 4 }}>Why Spoolcast recommends this</span>
          <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{why}</p>
        </div>
      ) : null}

      <div className="eyebrow" style={{ margin: '22px 0 2px' }}>Every episode inherits</div>
      {narrator !== 'no' ? (
        <div title="Narration-first only — the one voice that reads every episode" style={rowStyle}>
          <span style={labelStyle}>Narrator voice</span>
          <div style={{ flex: 1, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {NARRATION_VOICES.filter((v) => v.value !== 'elevenlabs-library').map((v) => (
              <button
                key={v.id}
                className={`pill-btn ${ttsVoice === v.value ? 'sel' : ''}`}
                title={v.detail}
                onClick={() => { setTtsVoice(v.value); void saveFields({ tts_voice: v.value }) }}
              >
                {v.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div
        title="The style anchor every episode's visuals start from — reference images are generated in the Series World Kit"
        style={{ ...rowStyle, alignItems: 'flex-start' }}
      >
        <span style={{ ...labelStyle, paddingTop: 27 }}>Visual style</span>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {recTag(Boolean(shownStyle) && shownStyle === recStyle)}
          <textarea
            ref={styleBoxRef}
            className="show-setup-input"
            value={shownStyle}
            rows={1}
            placeholder="e.g. ink-wash storybook, muted palette"
            onChange={(event) => setStylePrompt(event.target.value)}
            onBlur={() => {
              if (shownStyle !== savedStyleRef.current) {
                savedStyleRef.current = shownStyle
                void saveFields({ default_style_prompt: shownStyle })
              }
            }}
          />
        </div>
      </div>
      <div title="Every episode renders to this shape" style={{ ...rowStyle, alignItems: 'flex-start' }}>
        <span style={{ ...labelStyle, paddingTop: 27 }}>Output</span>
        <div style={{ flex: 1, display: 'flex', gap: 8 }}>
          {[
            ['16:9', 'Widescreen'],
            ['9:16', 'Vertical'],
            ['1:1', 'Square'],
          ].map(([value, label]) => (
            <span key={value} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {recTag(value === recAspect)}
              <button
                className={`pill-btn ${shownAspect === value ? 'sel' : ''}`}
                onClick={() => { setAspect(value); void saveFields({ aspect_ratio: value }) }}
              >
                {label} {value}
              </button>
            </span>
          ))}
        </div>
      </div>
      <p style={{ margin: '14px 2px 0', color: 'var(--ink-3)', fontSize: 12.5, lineHeight: 1.6 }}>
        Approving this step stamps the format and these defaults into the show — every episode
        created by fan-out inherits them. Episode length stays a per-episode choice.
      </p>
      {error ? <p className="voice-error">Engine: {error}</p> : null}
    </div>
  )
}

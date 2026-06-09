import { useEffect, useRef, useState } from 'react'
import { Pill } from '../../components/common/Pill'
import { styleThumbs } from '../../data/cast'
import { INHERITED_COMPONENTS, SCAN_SUGGESTIONS, type TplRule } from '../../data/template-rules'
import { useWorkflowStore, type Goal, type S1 } from '../../store/workflow'
import type { Step } from '../../types'

// Last step (Video output): once the video exists, offer to immortalize its setup.
// The kind is predetermined — a brand-new/standalone video saves a NEW format
// template; a video that came from an existing series saves a SUBTEMPLATE (a new
// episode pattern). If the format never diverged from what it started from, there's
// nothing new to save, so the action is greyed out.
export function SaveTemplateContent({
  step,
  origin,
  formatDirty,
  onToast,
}: {
  step: Step
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
      <div className="stub">
        <p>{step.blurb}</p>
        <div className="what">Source-of-truth files and action logs will appear here when backend wiring lands.</div>
      </div>
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

export function NarrationContent() {
  return (
    <div className="idea-v2">
      <h3 className="idea-q">What voice narrates this video?</h3>
      <p className="idea-sources-caption">
        The script is read by this voice reference. Defaults to Google TTS — swap it for any voice in the library.
      </p>
      <div className="voice-card">
        <span className="voice-play">▶</span>
        <span className="voice-meta">
          <span className="voice-name">Google TTS · Schedar</span>
          <span className="voice-sub">English · male · default</span>
        </span>
        <button className="voice-change">Change voice →</button>
      </div>
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

export function Step01Flow({ stepId }: { stepId: string }) {
  const s1 = useWorkflowStore((s) => s.s1)
  const storeSetS1 = useWorkflowStore((s) => s.setS1)
  const setS1: React.Dispatch<React.SetStateAction<S1>> = (updater) => storeSetS1(stepId, updater)
  const active =
    s1.editing ||
    (!s1.narrator ? 'narrator' : !s1.style ? 'style' : !s1.output ? 'output' : '')
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
              min={30}
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
    </div>
  )
}

type SourceFile = { id: string; name: string; meta: string; kind: 'doc' | 'clock' | 'image'; desc: string }

export function IdeaBriefContent({ blankProject, stepId }: { blankProject: boolean; stepId: string }) {
  const brief = useWorkflowStore((s) => s.ideaBrief)
  const setIdeaBrief = useWorkflowStore((s) => s.setIdeaBrief)
  const onBriefChange = (value: string) => setIdeaBrief(stepId, value)
  const [files, setFiles] = useState<SourceFile[]>(
    blankProject
      ? []
      : [], // ZERO DUMMY DATA RULE: Source material must come from the engine, not hardcoded mocks.
  )

  const setDesc = (id: string, desc: string) =>
    setFiles((current) => current.map((file) => (file.id === id ? { ...file, desc } : file)))
  const removeFile = (id: string) =>
    setFiles((current) => current.filter((file) => file.id !== id))

  // RULE 5: Functional Input Rule - Handle real file uploads to the local API
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    try {
      // Read file as base64
      const buffer = await file.arrayBuffer()
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)))
      
      // Send to local API
      const res = await fetch('http://localhost:8000/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: 'spoolcast-dev-log-12',
          tenant: 'local',
          action: 'upload_file',
          filename: file.name,
          content: base64
        })
      })

      if (res.ok) {
      await res.json() // Consume the response to ensure request completes
        setFiles(prev => [...prev, { 
          id: `f${Date.now()}`, 
          name: file.name, 
          meta: `${(file.size / 1024).toFixed(1)} KB · Uploaded`, 
          kind: 'doc', 
          desc: '' 
        }])
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
    <div className="idea-v2">
      <h3 className="idea-q">What's this video about?</h3>

      <textarea
        className="idea-textbox"
        rows={5}
        value={brief}
        onChange={(event) => onBriefChange(event.target.value)}
        placeholder="A short explanation of the idea, topic, opinion, or story this video should turn into."
      />

      <div className="idea-helpers">
        <a>Generate angles</a>
        <a>Ask clarifying questions</a>
        <a>Turn notes into a thesis</a>
      </div>

      <section className="idea-sources">
        <span className="eyebrow">SOURCE MATERIAL</span>
        <p className="idea-sources-caption">
          Links, notes, transcripts, screenshots, and reference files can attach here after the idea is clear.
        </p>

        {files.length ? (
          <div className="file-list">
            {files.map((file) => (
              <div className="file-row" key={file.id}>
                <span className="file-icon">
                  <FileGlyph kind={file.kind} />
                </span>
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
          </div>
        ) : null}

        <label className="idea-attach" style={{ cursor: 'pointer' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
          Attach files
          <input 
            type="file" 
            style={{ display: 'none' }} 
            onChange={handleFileUpload} 
          />
        </label>
      </section>
    </div>
  )
}

export function CoreMessageContent({ stepId }: { stepId: string }) {
  const goal = useWorkflowStore((s) => s.goal)
  const ideaBrief = useWorkflowStore((s) => s.ideaBrief)
  const storeSetGoal = useWorkflowStore((s) => s.setGoal)
  const setGoal: React.Dispatch<React.SetStateAction<Goal>> = (updater) => storeSetGoal(stepId, updater)
  const [generating, setGenerating] = useState(false)
  const genTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(genTimer.current), [])

  const createWithAI = () => {
    setGenerating(true)
    setGoal({ text: '', mode: 'ai' })
    genTimer.current = window.setTimeout(() => {
      const suggestion = ideaBrief.trim()
        ? 'The Spoolcast engine is finally stable enough that the product is now the UI wrapped around it — not the pipeline itself.'
        : 'One clear, memorable idea your audience should walk away believing.'
      setGoal({ text: suggestion, mode: '' })
      setGenerating(false)
    }, 1600)
  }

  return (
    <div className="idea-v2">
      <h3 className="idea-q">What's the one core message of this video?</h3>

      <div className={`idea-textbox-wrap ${generating ? 'generating' : ''}`}>
        <textarea
          className="idea-textbox"
          rows={4}
          value={goal.text}
          disabled={generating}
          onChange={(event) => setGoal({ text: event.target.value, mode: '' })}
          placeholder="The one thing a viewer should walk away believing."
        />
        {generating ? (
          <span className="gen-overlay">
            <span className="spin" /> Drafting a core message…
          </span>
        ) : null}
      </div>

      <div className="core-or">or</div>

      <div className="core-opts">
        <div className="core-ai">
          <span className="ap-spark">✦</span>
          <span className="core-ai-text">
            <span className="nm">Let AI suggest one</span>
            <span className="ds">drafted from your idea &amp; answers — you can edit it</span>
          </span>
          <button type="button" className="core-create" disabled={generating} onClick={createWithAI}>
            {generating ? (
              <>
                <span className="spin" /> Generating…
              </>
            ) : (
              'Create with AI'
            )}
          </button>
        </div>
        <button
          type="button"
          className={`core-opt ${goal.mode === 'skip' ? 'sel' : ''}`}
          onClick={() => {
            window.clearTimeout(genTimer.current)
            setGenerating(false)
            setGoal({ text: '', mode: 'skip' })
          }}
        >
          <span className="nm">Skip — no core message needed</span>
          <span className="ds">freeform / vibe-based</span>
        </button>
      </div>
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

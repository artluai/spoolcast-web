import { useEffect, useRef, useState } from 'react'
import { Pill } from '../../components/common/Pill'
import { asset } from '../../lib/assets'
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
  const storeSetGoal = useWorkflowStore((s) => s.setGoal)
  const setGoal = (g: Goal) => storeSetGoal(stepId, g)
  const [writeOpen, setWriteOpen] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [candidates, setCandidates] = useState<string[] | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [needRewind, setNeedRewind] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [feedbackOpen, setFeedbackOpen] = useState(false)

  // MULTI-MESSAGE: goal.text holds messages separated by blank lines (e.g. a
  // UGC product video may carry 3 selling points). Default is one; "+ Add"
  // appends. session.json:core_message stores the joined text.
  const messages = goal.text === '' ? [''] : goal.text.split('\n\n')
  const setMessages = (msgs: string[]) => setGoal({ text: msgs.join('\n\n'), mode: '' })

  // Auto-expand "write your own" once when real content arrives (engine prefill).
  const autoOpenedRef = useRef(false)
  useEffect(() => {
    if (!autoOpenedRef.current && goal.text.trim()) {
      autoOpenedRef.current = true
      setWriteOpen(true)
    }
  }, [goal.text])

  // REAL AI SUGGESTION: runs the engine's metered propose_core_message draft
  // (writes working/core-message-candidates.json), then loads the candidates.
  const suggest = async () => {
    setGenerating(true)
    setAiError(null)
    try {
      const res = await fetch('http://localhost:8000/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: 'spoolcast-dev-log-12',
          tenant: 'local',
          action: 'draft_stage',
          stage_id: stepId,
          allow_cost: true,
          ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
        }),
      })
      const out = await res.json().catch(() => null)
      if (!res.ok || out?.ok === false) {
        if (out?.error === 'illegal_action') {
          setNeedRewind(true)
          return
        }
        setAiError(out?.message || out?.error || 'Suggestion failed.')
        return
      }
      const fr = await fetch(
        'http://localhost:8000/api/file?session=spoolcast-dev-log-12&path=' +
          encodeURIComponent('working/core-message-candidates.json'),
      )
      const fileOut = await fr.json().catch(() => null)
      if (fileOut?.ok && fileOut.data?.exists) {
        const parsed = JSON.parse(fileOut.data.content)
        setCandidates(Array.isArray(parsed?.candidates) ? parsed.candidates : [])
      }
    } catch {
      setAiError('Could not reach the engine.')
    } finally {
      setGenerating(false)
    }
  }

  const rewindAndSuggest = async () => {
    setNeedRewind(false)
    try {
      const res = await fetch('http://localhost:8000/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: 'spoolcast-dev-log-12',
          tenant: 'local',
          action: 'rewind_stage',
          stage_id: stepId,
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

  const optStyle = (sel: boolean): React.CSSProperties => ({
    width: '100%',
    textAlign: 'left',
    border: `1px solid ${sel ? 'var(--ink-2)' : 'var(--line, #2a3142)'}`,
    borderRadius: 10,
    background: 'transparent',
    padding: '14px 16px',
    marginBottom: 10,
  })

  return (
    <div className="idea-v2">
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

      {/* OPTION 1 — AI suggests (the default path) */}
      <div style={optStyle(candidates !== null)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="ap-spark">✦</span>
          <span style={{ flex: 1 }}>
            <span className="nm" style={{ display: 'block' }}>Let AI suggest</span>
            <span className="ds">3 candidates drafted from your idea &amp; source material — pick one, then edit it</span>
          </span>
          {!candidates && (
            <button type="button" className="core-create" disabled={generating} onClick={suggest}>
              {generating ? (<><span className="spin" /> Generating…</>) : 'Suggest'}
            </button>
          )}
        </div>
        {aiError && <div style={{ color: 'var(--red)', fontSize: 13, marginTop: 8 }}>Engine: {aiError}</div>}
        {candidates && candidates.length > 0 && (
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {candidates.map((c, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  setGoal({ text: c, mode: '' })
                  setWriteOpen(true)
                }}
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
            {/* RE-SUGGEST: plain button by default; the expand toggle opens a
                multi-line feedback box with the button inside it. */}
            {!feedbackOpen ? (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                {/* SPLIT BUTTON: one pill, two zones — ▾ opens the feedback box,
                    the main zone re-suggests. */}
                <span style={{ display: 'inline-flex' }}>
                  <button
                    type="button"
                    className="core-create"
                    title="Add feedback for the next suggestions"
                    onClick={() => setFeedbackOpen(true)}
                    style={{ borderRadius: '8px 0 0 8px', padding: '8px 11px', borderRight: '1px solid rgba(0,0,0,.3)' }}
                  >
                    ▾
                  </button>
                  <button
                    type="button"
                    className="core-create"
                    disabled={generating}
                    onClick={suggest}
                    style={{ borderRadius: '0 8px 8px 0' }}
                  >
                    {generating ? (<><span className="spin" /> Generating…</>) : 'Re-suggest'}
                  </button>
                </span>
              </div>
            ) : (
              <div style={{ position: 'relative', marginTop: 4 }}>
                <textarea
                  autoFocus
                  rows={3}
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  placeholder="Tell the AI what to change — e.g. “easier to understand”, “more dramatic”, “focus on the cost angle”…"
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    resize: 'vertical',
                    background: 'rgba(255,255,255,.02)',
                    color: 'var(--ink-1)',
                    border: '1px dashed var(--line, #2a3142)',
                    borderRadius: 8,
                    padding: '11px 12px 46px',
                    fontSize: 13,
                    lineHeight: 1.5,
                  }}
                />
                <button
                  type="button"
                  title="Collapse"
                  onClick={() => setFeedbackOpen(false)}
                  style={{
                    position: 'absolute', right: 8, top: 8,
                    background: 'none', border: 'none', color: 'var(--ink-3)',
                    cursor: 'pointer', fontSize: 12, padding: 2,
                  }}
                >
                  ▴
                </button>
                <button
                  type="button"
                  className="core-create"
                  disabled={generating}
                  onClick={suggest}
                  style={{ position: 'absolute', right: 8, bottom: 12, padding: '6px 14px', fontSize: 12 }}
                >
                  {generating ? (<><span className="spin" /> Generating…</>) : 'Re-suggest'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* OPTION 2 — write your own (collapsed until expanded) */}
      <div style={optStyle(goal.mode !== 'skip' && goal.text.trim().length > 0)}>
        <button
          type="button"
          onClick={() => setWriteOpen((v) => !v)}
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
        onClick={() => setGoal({ text: '', mode: 'skip' })}
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

  // Prefill from the engine's session.json (files are truth) — never clobber
  // an edit in progress.
  useEffect(() => {
    if (seededRef.current) return
    seededRef.current = true
    fetch('http://localhost:8000/api/file?session=spoolcast-dev-log-12&path=session.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        if (!out?.ok || !out.data?.exists || typeof out.data.content !== 'string') return
        try {
          const cfg = JSON.parse(out.data.content)
          const len = Number(cfg?.target_length_s)
          const store = useWorkflowStore.getState()
          if (Number.isFinite(len) && len > 0 && !store.dirtySteps[stepId]) {
            seedDrafts({ s1: { ...store.s1, length: len } })
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
  const fill = `${Math.round((((s1.length || 300) - 30) / (600 - 30)) * 100)}%`
  return (
    <div
      title="Not inherited from the show — structure, script, and visuals are planned to this length"
      style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 0' }}
    >
      <span style={{ fontSize: 13, color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>Length</span>
      <input
        type="range"
        className="sleek-range"
        min={30}
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
  )
}

// SERIES SETUP (step 01 for series episodes): flat rows with hairline
// dividers — no nested boxes. Inherited rows show the REAL sources (style
// from session.json, voice + series rules from the engine's rulebooks) and
// expand in place for detail. Per-episode fields (length) sit below.
export function SeriesSetup({ stepId, showName, onOpenCast }: { stepId: string; showName: string; onOpenCast: () => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const [styleId, setStyleId] = useState('')
  const [series, setSeries] = useState('')
  const [voiceExcerpt, setVoiceExcerpt] = useState('')
  const [rulesExcerpt, setRulesExcerpt] = useState('')

  useEffect(() => {
    fetch('http://localhost:8000/api/file?session=spoolcast-dev-log-12&path=session.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        if (out?.ok && out.data?.exists) {
          try {
            const cfg = JSON.parse(out.data.content)
            if (typeof cfg?.style === 'string') setStyleId(cfg.style)
            if (typeof cfg?.series === 'string') setSeries(cfg.series)
          } catch { /* ignore */ }
        }
      })
      .catch(() => {})
    fetch('http://localhost:8000/api/rules?session=spoolcast-dev-log-12')
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

  const goRules = () => { window.location.href = '/p/dev-log-12/rules' }

  const rows: { id: string; label: string; value: string; jump?: () => void; detail?: React.ReactNode }[] = [
    {
      id: 'style',
      label: 'Visual style',
      value: `Wojak comic${styleId ? ` · ${styleId}` : ''}`,
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
      value: 'Illustration video · 16:9 widescreen',
      detail: (
        <p style={{ margin: 0 }}>
          Chunked still images rendered into video: the script is split into audio chunks, each
          chunk gets one or more generated images, and the renderer assembles them with narration,
          captions, and overlays. Locked by the show's format template.
        </p>
      ),
    },
    {
      id: 'voice',
      label: 'Narration voice',
      value: series ? `${series} voice profile` : 'series voice profile',
      detail: (
        <>
          {voiceExcerpt ? <p style={{ margin: '0 0 8px', whiteSpace: 'pre-wrap' }}>{voiceExcerpt}…</p> : <p style={{ margin: '0 0 8px' }}>The voice profile loads from the engine.</p>}
          <button type="button" className="vp-undo" onClick={goRules}>Read or edit in House rules →</button>
        </>
      ),
    },
    {
      id: 'rules',
      label: 'Series rules',
      value: series || 'series editorial conventions',
      detail: (
        <>
          {rulesExcerpt ? <p style={{ margin: '0 0 8px', whiteSpace: 'pre-wrap' }}>{rulesExcerpt}…</p> : <p style={{ margin: '0 0 8px' }}>The series rulebook loads from the engine.</p>}
          <button type="button" className="vp-undo" onClick={goRules}>Read or edit in House rules →</button>
        </>
      ),
    },
    { id: 'worldkit', label: 'World Kit', value: 'cast, places, props & references', jump: onOpenCast },
  ]

  // No divider lines — quiet rows separated by whitespace only.
  const rowBtn: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 12, width: '100%',
    padding: '11px 2px', background: 'none', border: 'none',
    cursor: 'pointer', fontSize: 13, textAlign: 'left', borderRadius: 6,
  }

  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 2 }}>Inherited from {showName}</div>
      {rows.map((r) => (
        <div key={r.id}>
          <button type="button" style={rowBtn} onClick={() => (r.jump ? r.jump() : setOpen((o) => (o === r.id ? null : r.id)))}>
            <span style={{ width: 150, flexShrink: 0, color: 'var(--ink-2)' }}>{r.label}</span>
            <span style={{ flex: 1, color: 'var(--ink)' }}>{r.value}</span>
            <span style={{ color: 'var(--ink-3)', fontSize: 11 }}>{r.jump ? '→' : open === r.id ? '▾' : '▸'}</span>
          </button>
          {open === r.id && r.detail ? (
            <div style={{ padding: '4px 2px 18px 164px', color: 'var(--ink-2)', fontSize: 13, lineHeight: 1.6 }}>
              {r.detail}
            </div>
          ) : null}
        </div>
      ))}
      <div className="eyebrow" style={{ margin: '22px 0 2px' }}>This episode</div>
      <EpisodeSettings stepId={stepId} />
    </div>
  )
}

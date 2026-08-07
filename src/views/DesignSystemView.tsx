import { useState } from 'react'
import { DEFAULT_MODEL_ID } from '../lib/draft-models'
import { applyTheme, DEFAULT_THEME_ID, THEMES } from '../lib/theme'
import { ModelPicker } from './workflow/ModelPicker'
import '../styles/design-system.css'

const COLORS = [
  ['Page', '--bg'],
  ['Raised', '--bg-2'],
  ['Control', '--bg-3'],
  ['Hover', '--bg-4'],
  ['Panel', '--panel'],
  ['Border', '--line-2'],
  ['Text', '--ink'],
  ['Muted', '--ink-2'],
  ['Quiet', '--ink-3'],
  ['Focus', '--accent'],
  ['AI action', '--ai'],
  ['Autopilot', '--autopilot'],
  ['Success', '--green'],
  ['Working', '--amber'],
  ['Error', '--red'],
] as const

function Example({
  title,
  note,
  children,
}: {
  title: string
  note: string
  children: React.ReactNode
}) {
  return (
    <article className="ds-example">
      <div className="ds-example-head">
        <div>
          <h3>{title}</h3>
          <p>{note}</p>
        </div>
      </div>
      <div className="ds-example-body">{children}</div>
    </article>
  )
}

export default function DesignSystemView() {
  const [theme, setTheme] = useState(
    document.documentElement.dataset.theme || DEFAULT_THEME_ID,
  )
  const [splitOpen, setSplitOpen] = useState(false)
  const [textOnly, setTextOnly] = useState(false)
  const [model, setModel] = useState(DEFAULT_MODEL_ID)
  const [compactMenuOpen, setCompactMenuOpen] = useState(false)
  const [compactChoice, setCompactChoice] = useState('Default')
  const [selectedCard, setSelectedCard] = useState('series')
  const [modalOpen, setModalOpen] = useState(false)

  const chooseTheme = (next: string) => {
    setTheme(applyTheme(next))
  }

  return (
    <div className="ds-view">
      <div className="ds-wrap">
        <section className="ds-intro">
          <div>
            <span className="eyebrow">Spoolcast UI system</span>
            <h1>One interface, multiple skins</h1>
            <p>
              This page renders the real controls and states agents must inspect before
              building UI. A skin changes tokens; component behavior stays the same.
            </p>
          </div>
          <label className="ds-theme-picker">
            <span>Theme</span>
            <select value={theme} onChange={(event) => chooseTheme(event.target.value)}>
              {THEMES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <small>{THEMES.find((item) => item.id === theme)?.description}</small>
          </label>
        </section>

        <nav className="ds-jump" aria-label="Design system sections">
          <a href="#foundations">Foundations</a>
          <a href="#controls">Controls</a>
          <a href="#states">States</a>
          <a href="#selection">Selection</a>
          <a href="#thumbnails">Thumbnails</a>
          <a href="#disclosures">Disclosures</a>
          <a href="#assets">Assets</a>
        </nav>

        <section id="foundations" className="ds-section">
          <div className="ds-section-head">
            <span className="eyebrow">01 · Foundations</span>
            <h2>Theme tokens</h2>
            <p>Every launch skin supplies this complete semantic palette.</p>
          </div>
          <div className="ds-swatches">
            {COLORS.map(([label, token]) => (
              <div className="ds-swatch" key={token}>
                <span style={{ background: `var(${token})` }} />
                <b>{label}</b>
                <code>{token}</code>
              </div>
            ))}
          </div>
          <div className="ds-type-grid">
            <div>
              <span className="eyebrow">Interface type · Inter</span>
              <h2>Clear hierarchy without decorative noise</h2>
              <p>Body copy explains the decision in direct, natural language.</p>
            </div>
            <div className="ds-mono-sample">
              <span>System type · JetBrains Mono</span>
              <b>STEP 05 · GENERATING · 03 / 12</b>
              <code>--control-height: 34px</code>
            </div>
          </div>
        </section>

        <section id="controls" className="ds-section">
          <div className="ds-section-head">
            <span className="eyebrow">02 · Controls</span>
            <h2>Buttons and AI actions</h2>
            <p>Reuse these real controls. Stars and blue identify AI actions; purple is reserved for Autopilot.</p>
          </div>
          <div className="ds-grid">
            <Example title="Compact actions" note="Same 34px footprint for controls in one row.">
              <div className="ds-row">
                <button type="button" className="vp-save">Save</button>
                <button type="button" className="vp-undo">Secondary</button>
                <button type="button" className="vp-undo" disabled>Disabled</button>
                <span className="ds-menu-anchor">
                  <button
                    type="button"
                    className="vp-menu-btn"
                    aria-expanded={compactMenuOpen}
                    onClick={() => setCompactMenuOpen((value) => !value)}
                  >
                    {compactChoice === 'Default' ? 'Menu' : compactChoice} ▾
                  </button>
                  {compactMenuOpen ? (
                    <>
                      <span className="vp-menu-backdrop" onClick={() => setCompactMenuOpen(false)} />
                      <span className="vp-menu ds-compact-menu">
                        <span className="vp-menu-h">MENU</span>
                        {[
                          ['Default', 'The standard presentation'],
                          ['Compact', 'Less supporting detail'],
                          ['Expanded', 'More context stays visible'],
                        ].map(([label, note]) => (
                          <button
                            type="button"
                            key={label}
                            className={compactChoice === label ? 'on' : ''}
                            onClick={() => {
                              setCompactChoice(label)
                              setCompactMenuOpen(false)
                            }}
                          >
                            <span className="vg-select-choice">
                              <span className={`vg-menu-check ${compactChoice === label ? 'on' : ''}`} />
                              {label}
                            </span>
                            <small>{note}</small>
                          </button>
                        ))}
                      </span>
                    </>
                  ) : null}
                </span>
              </div>
            </Example>

            <Example title="Primary continuation" note="Reserved for the step’s main forward action.">
              <div className="ds-row">
                <button type="button" className="save-continue">Save and continue →</button>
                <button type="button" className="save-continue" disabled>Finish this section first</button>
              </div>
            </Example>

            <Example title="AI split action" note="Main click runs the simple default; caret reveals optional notes, model, and advanced scope.">
              <div className="ds-split-demo">
                <span className={`vg-split-action ${splitOpen ? 'open' : ''}`}>
                  <button
                    type="button"
                    className="vg-split-toggle"
                    aria-label="Open AI options"
                    onClick={() => setSplitOpen((value) => !value)}
                  >
                    {splitOpen ? '▴' : '▾'}
                  </button>
                  <button type="button" className="vp-undo vg-split-main">
                    ✦ Fill with AI
                  </button>
                </span>
                {splitOpen ? (
                  <div className="vg-regen-note-panel step1-improve-panel ds-ai-panel">
                    <label style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'flex-start', gap: 8, color: 'var(--ink-2)', fontSize: 12 }}>
                      <input
                        type="checkbox"
                        checked={textOnly}
                        onChange={(event) => setTextOnly(event.target.checked)}
                        style={{ margin: '2px 0 0', accentColor: 'var(--accent)' }}
                      />
                      <span>
                        <b style={{ display: 'block', color: 'var(--ink-1)', fontWeight: 600 }}>Advanced: text only</b>
                        <span style={{ display: 'block', marginTop: 2, color: 'var(--ink-3)' }}>
                          Plan now and leave image generation for later.
                        </span>
                      </span>
                    </label>
                    <textarea placeholder="Optional directions for what AI should emphasize or preserve…" rows={3} />
                    <div className="vp-edit-actions step1-improve-actions">
                      <ModelPicker model={model} onChange={setModel} />
                      <button type="button" className="vp-save">
                        {textOnly ? '✦ Draft text only' : '✦ Fill with AI'}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            </Example>

            <Example title="Dropdown menu" note="The trigger matches a regular button; the menu portals above clipped panels and flips near an edge.">
              <div className="ds-row">
                <ModelPicker model={model} onChange={setModel} />
              </div>
            </Example>

            <Example title="Modal" note="One scrim, one raised surface, explicit consequence and actions.">
              <button type="button" className="vp-undo" onClick={() => setModalOpen(true)}>
                Open example
              </button>
            </Example>
          </div>
        </section>

        <section id="states" className="ds-section">
          <div className="ds-section-head">
            <span className="eyebrow">03 · States</span>
            <h2>Status and long-running work</h2>
            <p>Disable only the affected module. Navigation and unrelated work remain available.</p>
          </div>
          <div className="ds-grid">
            <Example title="Status labels" note="Mono text communicates state; color supports it.">
              <div className="ds-row">
                <span className="status-pill done">Ready</span>
                <span className="status-pill work">Generating</span>
                <span className="status-pill">Pending</span>
                <span className="ds-error-pill">Failed</span>
              </div>
            </Example>
            <Example title="Persistent generation state" note="Spinner, honest activity text, affected content dimmed.">
              <div className="ds-processing" aria-live="polite">
                <div className="ds-processing-note">
                  <span className="spin" />
                  <span>
                    <b>Generating reference image…</b>
                    <small>You can leave this step. Progress will still be here when you return.</small>
                  </span>
                </div>
                <div className="ds-processing-content">
                  <button type="button" className="vp-undo" disabled>Replace image</button>
                  <button type="button" className="vp-undo" disabled>Delete</button>
                </div>
              </div>
            </Example>
            <Example title="Inline feedback" note="Errors preserve the current work and explain the next action.">
              <div>
                <p className="voice-error">Generation failed. The previous image is unchanged.</p>
                <button type="button" className="vp-undo">Retry</button>
              </div>
            </Example>
          </div>
        </section>

        <section id="selection" className="ds-section">
          <div className="ds-section-head">
            <span className="eyebrow">04 · Selection</span>
            <h2>Cards show one clear choice</h2>
            <p>Selected items use the accent ring; unselected items stay quiet.</p>
          </div>
          <div className="step1-choice-row ds-choice-row">
            <button
              type="button"
              className={`step1-choice-card ${selectedCard === 'series' ? 'sel' : ''}`}
              aria-pressed={selectedCard === 'series'}
              onClick={() => setSelectedCard('series')}
            >
              <span className="step1-choice-thumb">
                <img src="/world-kit-thumb.jpg" alt="" />
              </span>
              <span className="step1-choice-copy">
                <b>Your series</b>
                <span>Includes its template, World Kit, rules, and defaults.</span>
              </span>
            </button>
            <button
              type="button"
              className={`step1-choice-card ${selectedCard === 'standalone' ? 'sel' : ''}`}
              aria-pressed={selectedCard === 'standalone'}
              onClick={() => setSelectedCard('standalone')}
            >
              <span className="step1-choice-thumb empty">＋</span>
              <span className="step1-choice-copy">
                <b>Standalone</b>
                <span>Make a one-off project without shared defaults.</span>
              </span>
            </button>
            <button type="button" className="step1-choice-card ai">
              <span className="step1-choice-thumb ai">✦</span>
              <span className="step1-choice-copy">
                <b>Let AI choose</b>
                <span>AI actions always use the same star language.</span>
              </span>
            </button>
          </div>
        </section>

        <section id="thumbnails" className="ds-section">
          <div className="ds-section-head">
            <span className="eyebrow">05 · Thumbnails</span>
            <h2>Preserve ratio and balance visual area</h2>
            <p>
              Media is the product. Keep thumbnails large, never stretch or crop by default,
              and give different aspect ratios approximately equal visual area.
            </p>
          </div>
          <div className="ds-thumbnail-stage">
            <figure className="ds-thumbnail square">
              <img src="/world-kit-thumb.jpg" alt="Square World Kit reference example" />
              <figcaption><b>Near square</b><span>≈ 36k px²</span></figcaption>
            </figure>
            <figure className="ds-thumbnail portrait">
              <img src="/content/shows/news-anime-bot/characters/altman.png" alt="Portrait reference example" />
              <figcaption><b>9:16 portrait</b><span>≈ 36k px²</span></figcaption>
            </figure>
            <figure className="ds-thumbnail landscape">
              <img src="/content/sessions/spoolcast-dev-log-06/source/generated-assets/thumbnails/thumb-v2-three-answers.png" alt="Landscape thumbnail example" />
              <figcaption><b>16:9 landscape</b><span>≈ 36k px²</span></figcaption>
            </figure>
          </div>
          <div className="ds-thumbnail-formula">
            <code>A ≈ (available area − gaps) ÷ item count</code>
            <code>width = √(A × ratio) · height = √(A ÷ ratio)</code>
            <p>Pack the resulting rectangles to minimize unused space; scale the group uniformly when the container is smaller.</p>
          </div>
        </section>

        <section id="disclosures" className="ds-section">
          <div className="ds-section-head">
            <span className="eyebrow">06 · Disclosures</span>
            <h2>Advanced content stays available, not noisy</h2>
            <p>Use the established quiet uppercase disclosure pattern.</p>
          </div>
          <details className="vp-section ds-disclosure">
            <summary className="vp-section-sum">
              <span className="vp-sec-title">Advanced</span>
              <span className="vp-section-count">Optional</span>
            </summary>
            <div className="ds-disclosure-body">
              <label>
                <input type="checkbox" defaultChecked />
                Allow web research for additional sources
              </label>
              <p className="vp-hint">The setting is secondary but remains discoverable and editable.</p>
            </div>
          </details>
        </section>

        <section id="assets" className="ds-section">
          <div className="ds-section-head">
            <span className="eyebrow">07 · Assets</span>
            <h2>Brand mark and glyph language</h2>
            <p>SVGs are for reusable assets. Interactive UI remains real HTML and CSS.</p>
          </div>
          <div className="ds-assets">
            <div className="ds-logo-card">
              <img src="/favicon.svg" alt="Spoolcast lightning mark" />
              <div>
                <b>Spoolcast lightning mark</b>
                <code>/favicon.svg</code>
              </div>
            </div>
            <div className="ds-glyphs" aria-label="Approved interface glyphs">
              {['✦', '▾', '⋯', '✓', '↻', '↓', '▶', '⤢'].map((glyph) => (
                <span key={glyph}>{glyph}</span>
              ))}
            </div>
          </div>
        </section>
      </div>

      {modalOpen ? (
        <div className="modal-scrim ds-modal-scrim" role="presentation" onMouseDown={() => setModalOpen(false)}>
          <div className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="ds-modal-title" onMouseDown={(event) => event.stopPropagation()}>
            <span className="need">USES CREDITS</span>
            <h3 id="ds-modal-title">Generate this reference?</h3>
            <p>The current image stays recoverable. Generation continues if you leave this step.</p>
            <div className="actions">
              <button type="button" onClick={() => setModalOpen(false)}>Cancel</button>
              <button type="button" className="primary" onClick={() => setModalOpen(false)}>Approve and generate</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

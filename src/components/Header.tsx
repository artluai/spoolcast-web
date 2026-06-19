import { useState } from 'react'
import type { SetupMode } from '../types'

export function Header({
  route,
  setupMode,
  showName,
  isWorkflow,
  isWorldKit,
  isRules,
  autopilot,
  onLogo,
  onBack,
  onAutopilot,
  onCast,
  onRules,
  onSave,
  onSaves,
  onNew,
  onLibrary,
  onProfile,
}: {
  route: string
  setupMode: SetupMode
  showName: string
  isWorkflow: boolean
  isWorldKit: boolean
  isRules?: boolean
  autopilot: boolean
  onLogo: () => void
  onBack: () => void
  onAutopilot: () => void
  onCast: () => void
  onRules?: () => void
  onSave?: () => void
  onSaves?: () => void
  onNew: () => void
  onLibrary: () => void
  onProfile: () => void
}) {
  // One menu instead of a row of header buttons — simpler, scales.
  const [menuOpen, setMenuOpen] = useState(false)
  const pick = (fn?: () => void) => () => {
    setMenuOpen(false)
    fn?.()
  }
  // Project label comes from the route (/p/dev-log-12 → "Dev Log #12") — the
  // crumb must reflect the project actually open, never a hardcoded episode.
  const projectId = route.startsWith('/p/') ? (route.split('/')[2] ?? '') : ''
  const devLogMatch = projectId.match(/^dev-log-(\d+)$/)
  const projectLabel = devLogMatch
    ? `Dev Log #${devLogMatch[1].padStart(2, '0')}`
    : projectId
      ? projectId.replace(/-/g, ' ')
      : 'Untitled video'

  let crumb = null
  if (route === '/projects') {
    crumb = (
      <>
        <span>New project</span>
        <span className="sep">/</span>
        <b>Start a project</b>
      </>
    )
  } else if (route === '/library') {
    crumb = (
      <>
        <span>Projects</span>
        <span className="sep">/</span>
        <b>Library</b>
      </>
    )
  } else if (route === '/setup') {
    crumb = (
      <>
        <button className="back" onClick={onBack}>
          ←
        </button>
        <span>Projects</span>
        <span className="sep">/</span>
        <b>New video</b>
      </>
    )
  } else if (isWorkflow) {
    crumb = (
      <>
        <button className="back" onClick={onBack}>
          ←
        </button>
        <span className="crumb-secondary">Projects</span>
        <span className="sep">/</span>
        {isWorldKit ? (
          <>
            <span className="crumb-secondary">{showName}</span>
            <span className="sep">/</span>
            <b>World Kit</b>
          </>
        ) : setupMode === 'series' ? (
          <>
            <b>{projectLabel}</b>
            <span className="sep">·</span>
            <span className="crumb-secondary">{showName}</span>
          </>
        ) : (
          <>
            <b>Untitled video</b>
            <span className="sep">·</span>
            <span className="crumb-secondary">Standalone</span>
          </>
        )}
      </>
    )
  }

  return (
    <header className={menuOpen ? 'menu-open' : undefined}>
      <button className="logo" type="button" onClick={onLogo}>
        <img className="mark" src="/favicon.svg" alt="" />
        <span>Spoolcast</span>
      </button>
      <div className="crumb">{crumb}</div>
      {isWorkflow ? (
        <div className="header-right">
          <div className="saving">
            <span className="pulse" />
            auto-saved
          </div>
          {!isWorldKit ? (
            <button
              className={`autopilot ${autopilot ? 'on' : ''}`}
              type="button"
              onClick={onAutopilot}
            >
              <span className="ap-dot" />
              <span>Autopilot</span>
              <span className="ap-state">{autopilot ? 'on' : 'off'}</span>
            </button>
          ) : null}
          <span style={{ position: 'relative' }}>
            <button
              className={`btn-soft ${isWorldKit || isRules || route === '/library' ? 'active' : ''}`}
              onClick={() => setMenuOpen((v) => !v)}
            >
              Menu ▾
            </button>
            {menuOpen ? (
              <>
                <span className="vp-menu-backdrop" onClick={() => setMenuOpen(false)} />
                <span className="vp-menu" style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, minWidth: 200 }}>
                  {onRules ? (
                    <button type="button" onClick={pick(onRules)} title="The rulebooks the AI works under — view and edit">
                      Project Wiki
                    </button>
                  ) : null}
                  <button type="button" onClick={pick(onCast)}>World Kit</button>
                  <button type="button" onClick={pick(onLibrary)}>Asset Library</button>
                  <span className="vp-menu-div" style={{ display: 'block' }} />
                  {onSave || onSaves ? (
                    // Save (the action) with Recent saves (the list) tucked
                    // quietly to its right.
                    <span style={{ display: 'flex' }}>
                      {onSave ? (
                        <button type="button" style={{ flex: 1 }} onClick={pick(onSave)} title="Keep a save point of the whole project right now — free">
                          Save
                        </button>
                      ) : null}
                      {onSaves ? (
                        <button type="button" style={{ color: 'var(--ink-3)' }} onClick={pick(onSaves)} title="Saves are also kept automatically before every start-over">
                          Recent saves
                        </button>
                      ) : null}
                    </span>
                  ) : null}
                  <button type="button" onClick={pick(onNew)}>New project</button>
                </span>
              </>
            ) : null}
          </span>
          <button className="avatar-btn" onClick={onProfile}>
            R
          </button>
        </div>
      ) : route === '/projects' || route === '/library' ? (
        <div className="header-right">
          <button
            className={`btn-soft ${route === '/library' ? 'active' : ''}`}
            onClick={onLibrary}
          >
            Library
          </button>
          <button className="avatar-btn" onClick={onProfile}>
            R
          </button>
        </div>
      ) : null}
    </header>
  )
}

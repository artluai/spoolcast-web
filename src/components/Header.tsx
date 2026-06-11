import type { SetupMode } from '../types'

export function Header({
  route,
  setupMode,
  showName,
  isWorkflow,
  isWorldKit,
  autopilot,
  onLogo,
  onBack,
  onAutopilot,
  onCast,
  onNew,
  onLibrary,
  onProfile,
}: {
  route: string
  setupMode: SetupMode
  showName: string
  isWorkflow: boolean
  isWorldKit: boolean
  autopilot: boolean
  onLogo: () => void
  onBack: () => void
  onAutopilot: () => void
  onCast: () => void
  onNew: () => void
  onLibrary: () => void
  onProfile: () => void
}) {
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
    <header>
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
          <button className={`btn-soft ${isWorldKit ? 'active' : ''}`} onClick={onCast}>
            World Kit
          </button>
          <button
            className={`btn-soft ${route === '/library' ? 'active' : ''}`}
            onClick={onLibrary}
          >
            Library
          </button>
          <button className="btn-soft" onClick={onNew}>
            New<span className="np-extra"> project</span>
          </button>
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

import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { CastGrid } from '../../components/CastGrid'
import { castByShow } from '../../data/cast'
import { FORMAT_TEMPLATE_NAMES, WORLD_KIT_SCOPES, WORLD_KIT_SECTIONS } from '../../data/worldkit'

export function WorldKitPanel({
  castData,
  showName,
  onManage,
  compact = false,
}: {
  castData: (typeof castByShow)['spoolcast dev log']
  showName: string
  onManage?: () => void
  compact?: boolean
}) {
  const [scopes, setScopes] = useState<Record<string, string>>(() =>
    Object.fromEntries(WORLD_KIT_SECTIONS.map((s) => [s.id, s.scope])),
  )
  // the format template (series pipeline), NOT the visual style
  const templateName = FORMAT_TEMPLATE_NAMES[showName] ?? 'format template'
  const scopeLabels: Record<string, string> = {
    Episode: 'Episode only',
    Show: `Show: ${showName}`,
    Template: `Template: ${templateName}`,
  }
  return (
    <div className="wk-panel">
      <div className="wk-note">
        <span>
          Source of truth: <code>working/world-kit.md</code> · Cast manifest: <code>cast.txt</code>
        </span>
        <span className="wk-flex">Each beat pulls whatever references it needs — there's no fixed recipe.</span>
      </div>
      <div className="wk-grid">
        {WORLD_KIT_SECTIONS.map((sec) => (
          <div className={`wk-card ${sec.locked ? 'wk-card-locked' : ''}`} key={sec.id}>
            <div className="wk-card-head">
              <div className="wk-card-meta">
                <h3>{sec.name}</h3>
                <p>{sec.desc}</p>
              </div>
              {sec.locked ? (
                <span className="wk-locked-tag">Step 01</span>
              ) : (
                <label className="wk-scope" title="Where this reference can be reused">
                  <span>Share</span>
                  <select
                    value={scopes[sec.id]}
                    onChange={(e) => setScopes((p) => ({ ...p, [sec.id]: e.target.value }))}
                  >
                    {WORLD_KIT_SCOPES.map((o) => (
                      <option key={o} value={o}>{scopeLabels[o]}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {sec.locked ? (
              sec.image ? (
                <div className="wk-style">
                  <img src={sec.image} alt="" />
                  <span>{sec.caption}</span>
                </div>
              ) : (
                <div className="wk-empty">No style reference set</div>
              )
            ) : sec.cast ? (
              <>
                <CastGrid castData={castData} compact={compact} />
                {onManage ? (
                  <button className="wk-manage" onClick={onManage}>Manage cast →</button>
                ) : null}
              </>
            ) : (
              <div className="wk-items">
                {sec.items?.map((it) => (
                  <span className="wk-item" key={it}>{it}</span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

export function WorldKitView({
  castData,
  showName,
}: {
  castData: (typeof castByShow)['spoolcast dev log']
  showName: string
}) {
  const navigate = useNavigate()
  const params = useParams()
  return (
    <section className="cast-view">
      <div className="cast-wrap">
        <div className="cast-head">
          <button className="back-btn" onClick={() => navigate(`/p/${params.id ?? 'dev-log-06'}`)}>←</button>
          <div>
            <div className="eyebrow">World Kit · {showName}</div>
            <div className="title-row">
              <h1>Visual references for this episode</h1>
              <button>+ New reference</button>
            </div>
            <p>Style, cast, environments, props, screens, motion, and beat-specific refs — each with its own reuse scope. Style library: {castData.style}.</p>
          </div>
        </div>
        <WorldKitPanel castData={castData} showName={showName} />
      </div>
    </section>
  )
}

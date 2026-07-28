import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ResolvedRules } from '../components/ResolvedRules'
import { apiUrl, getFileJson, getJson, sessionsUrl } from '../lib/api'

// THE CHAIN MANAGER (docs/source-of-truth.md "The UI for the chain"): one
// place to SEE and CONTROL everything configurable, with a provenance label
// on every row. Three columns — Assets | Rules | Settings — anchored to a
// picked project, because resolution is always relative to one (its template
// and series come from session.json). The in-flow panels stay the everyday
// editing surface; this page is the overview.

type SessionRow = { id: string; contract?: string; series?: string | null }
type KitItem = {
  name: string
  kind: string
  read_only?: boolean
  global_id?: string
  variant_of?: string
  image_path?: string
}
type SessionCfg = {
  series?: string
  contract?: string
  template?: string
  core_message?: string
  budget?: unknown
}

const tierLabel = (item: KitItem) => {
  if (item.read_only || item.global_id) return 'Global'
  if (item.variant_of) return 'My Library'
  return 'This project'
}

export default function StudioView({ onToast }: { onToast?: (message: string) => void }) {
  const { id } = useParams()
  const navigate = useNavigate()
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [kit, setKit] = useState<KitItem[]>([])
  const [cfg, setCfg] = useState<SessionCfg | null>(null)

  useEffect(() => {
    void getJson<{ data?: { sessions?: SessionRow[] } }>(sessionsUrl())
      .then((out) => setSessions(out?.data?.sessions ?? []))
      .catch(() => {})
  }, [])
  useEffect(() => {
    if (!id) return
    setKit([])
    setCfg(null)
    void getJson<{ data?: { kit?: KitItem[] } }>(apiUrl('source-images', { session: id, include_refs: 1 }))
      .then((out) => setKit(out?.data?.kit ?? []))
      .catch(() => {})
    void getFileJson<SessionCfg>('session.json').then((doc) => setCfg(doc ?? null))
  }, [id])

  return (
    <div className="studio">
      <div className="studio-head">
        <h1>Studio — the chain</h1>
        <p>
          Everything configurable, labeled with the level it comes from. Levels:
          Global → My account → Template → Series → This video; the narrower level wins.
        </p>
        <label className="studio-pick">
          Project
          <select value={id ?? ''} onChange={(e) => navigate(`/studio/${e.target.value}`)} className="sc-select">
            <option value="" disabled>pick a project…</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>{s.id}</option>
            ))}
          </select>
        </label>
      </div>
      {id ? (
        <div className="studio-cols">
          <section className="studio-col">
            <h2>Assets</h2>
            <p className="studio-note">
              The project's World Kit, by tier. Manage in{' '}
              <Link to={`/p/${id}/world-kit`}>World Kit</Link> · <Link to="/library">Asset Library</Link>
            </p>
            {kit.length ? (
              <ul className="studio-assets">
                {kit.map((item) => (
                  <li key={item.name}>
                    <b>{item.name}</b>
                    <span className="studio-kind">{item.kind}</span>
                    <span className={`studio-badge tier-${tierLabel(item).replace(/\s/g, '').toLowerCase()}`}>
                      {tierLabel(item)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="studio-note">No kit items yet (or the engine is offline).</p>
            )}
          </section>
          <section className="studio-col studio-col-rules">
            <h2>Rules</h2>
            <p className="studio-note">
              Every rule with its source level; edits always target a named level.
            </p>
            <ResolvedRules onToast={onToast} />
          </section>
          <section className="studio-col">
            <h2>Settings</h2>
            {cfg ? (
              <ul className="studio-settings">
                <li>
                  <b>Format</b>
                  <span>{cfg.contract || '—'}</span>
                  <span className="studio-badge tier-thisproject">This video</span>
                </li>
                <li>
                  <b>Template</b>
                  <span>{cfg.template || '—'}</span>
                  <span className="studio-badge tier-template">Template</span>
                </li>
                <li>
                  <b>Series</b>
                  <span>{cfg.series || 'standalone'}</span>
                  <span className="studio-badge tier-series">Series</span>
                </li>
                <li>
                  <b>Core message</b>
                  <span>{cfg.core_message ? String(cfg.core_message).slice(0, 90) : '—'}</span>
                  <span className="studio-badge tier-thisproject">This video</span>
                </li>
              </ul>
            ) : (
              <p className="studio-note">Loading project settings…</p>
            )}
            <p className="studio-note">
              Series defaults (style, voice, brand) live in Show settings on the project header.
            </p>
          </section>
        </div>
      ) : (
        <p className="studio-note">Pick a project above — the chain is always shown relative to one.</p>
      )}
    </div>
  )
}

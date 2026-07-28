import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { castByShow } from '../../data/cast'
import { fileUrl, postAction } from '../../lib/api'
import { useWorkflowStore } from '../../store/workflow'
import { WorldKitEditor } from './WorldKitEditor'

export function WorldKitView({
  showName,
}: {
  castData: (typeof castByShow)['spoolcast dev log']
  showName: string
  blank?: boolean
}) {
  const navigate = useNavigate()
  const params = useParams()
  const stageId = 'world_kit'
  const draft = useWorkflowStore((state) => state.stageDrafts[stageId] ?? '')
  const seedStageDraft = useWorkflowStore((state) => state.seedStageDraft)
  const clearDirty = useWorkflowStore((state) => state.clearDirty)
  const dirty = useWorkflowStore((state) => state.dirtySteps[stageId] ?? false)
  const [loading, setLoading] = useState(!draft)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (draft) return
    let live = true
    fetch(fileUrl('working/world-kit.md'))
      .then((response) => (response.ok ? response.json() : null))
      .then(async (out) => {
        if (!live) return
        let content = String(out?.data?.content || '')
        if (!content) {
          const inherited = await postAction<{ content?: string }>({
            action: 'inherit_world_kit',
          })
          content = String(inherited?.data?.content || '')
        }
        if (content) seedStageDraft(stageId, content)
      })
      .catch(() => {
        if (live) setMessage('Could not load the World Kit.')
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [draft, seedStageDraft])

  const save = async () => {
    if (!draft || saving) return
    setSaving(true)
    setMessage('')
    const out = await postAction({
      action: 'set_stage_output',
      stage_id: stageId,
      path: 'working/world-kit.md',
      content: draft,
    })
    setSaving(false)
    if (out?.ok) {
      clearDirty(stageId)
      setMessage('World Kit saved.')
    } else {
      setMessage(out?.error || out?.message || 'Could not save the World Kit.')
    }
  }

  return (
    <section className="cast-view">
      <div className="cast-wrap">
        <div className="cast-head">
          <button
            type="button"
            className="back-btn"
            onClick={() => navigate(`/p/${params.id ?? 'new'}`)}
          >
            ←
          </button>
          <div style={{ flex: 1 }}>
            <div className="eyebrow">World Kit · {showName}</div>
            <div className="title-row">
              <h1>Visual references for this project</h1>
              <button
                type="button"
                disabled={!draft || saving || !dirty}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
            <p>
              Style, cast, environments, props, screens, motion, and beat-specific references.
              Open any asset to control where it can be shared.
            </p>
            {message ? <p className="series-menu-error">{message}</p> : null}
          </div>
        </div>
        {loading ? (
          <div className="wk-empty"><span className="spin" /> Loading World Kit…</div>
        ) : (
          <WorldKitEditor stageId={stageId} onToast={setMessage} />
        )}
      </div>
    </section>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  activeSession,
  apiUrl,
  postAction,
  seriesUrl,
  sessionsUrl,
  templatesUrl,
} from '../../lib/api'

type Share = {
  target_type: 'project' | 'series' | 'template'
  target_id: string
  shared_at?: string
}

type Context = {
  project: string
  series: string
  template: string
  shares: Share[]
}

type ProjectOption = {
  id: string
  series?: string
  template?: string
  modified_at?: number
}

type SeriesOption = {
  id: string
  name?: string
  template?: string
  modified_at?: number
}

type TemplateOption = {
  id: string
  name?: string
  modified_at?: number
}

const displayId = (id: string) =>
  id
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())

const idFromName = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const scopeKind = (scope: string) =>
  /template/i.test(scope) ? 'template' : /show|series/i.test(scope) ? 'series' : 'project'

export function WorldKitShareMenu({
  refId,
  scope,
  onScopeChange,
  onToast,
}: {
  refId: string
  scope: string
  onScopeChange: (scope: string) => Promise<boolean>
  onToast: (message: string) => void
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLSpanElement | null>(null)
  const [menuPos, setMenuPos] = useState<{
    left: number
    top?: number
    bottom?: number
    maxHeight: number
  } | null>(null)
  const [mode, setMode] = useState<'menu' | 'targets' | 'series' | 'template'>('menu')
  const [context, setContext] = useState<Context>({
    project: activeSession(),
    series: '',
    template: '',
    shares: [],
  })
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [series, setSeries] = useState<SeriesOption[]>([])
  const [templates, setTemplates] = useState<TemplateOption[]>([])
  const [query, setQuery] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const load = async () => {
    const [sharingResponse, projectsResponse, seriesResponse, templatesResponse] = await Promise.all([
      fetch(apiUrl('world-kit-sharing', { session: activeSession(), ref: refId })).catch(() => null),
      fetch(sessionsUrl()).catch(() => null),
      fetch(seriesUrl()).catch(() => null),
      fetch(templatesUrl()).catch(() => null),
    ])
    const [sharingOut, projectsOut, seriesOut, templatesOut] = await Promise.all([
      sharingResponse?.json().catch(() => null),
      projectsResponse?.json().catch(() => null),
      seriesResponse?.json().catch(() => null),
      templatesResponse?.json().catch(() => null),
    ])
    if (sharingOut?.ok) {
      setContext({
        project: String(sharingOut.data?.project || activeSession()),
        series: String(sharingOut.data?.series || ''),
        template: String(sharingOut.data?.template || ''),
        shares: Array.isArray(sharingOut.data?.shares) ? sharingOut.data.shares : [],
      })
    }
    setProjects(Array.isArray(projectsOut?.data?.sessions) ? projectsOut.data.sessions : [])
    setSeries(Array.isArray(seriesOut?.data?.series) ? seriesOut.data.series : [])
    setTemplates(Array.isArray(templatesOut?.data?.templates) ? templatesOut.data.templates : [])
  }

  useEffect(() => {
    // The fetch resolves before it updates the menu catalogs.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
    // A ref rename creates a different share identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refId])

  const open = menuPos !== null
  const scrollMenuToTop = () => {
    window.requestAnimationFrame(() => {
      if (menuRef.current) menuRef.current.scrollTop = 0
    })
  }
  const showMode = (nextMode: 'menu' | 'targets' | 'series' | 'template') => {
    setMode(nextMode)
    scrollMenuToTop()
  }
  const toggle = () => {
    if (open) {
      setMenuPos(null)
      return
    }
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight
    const left = viewportWidth
      ? Math.max(8, Math.min(rect.left, viewportWidth - 374))
      : rect.left
    const gap = 8
    const spaceAbove = Math.max(0, rect.top - gap)
    const spaceBelow = Math.max(0, viewportHeight - rect.bottom - gap)
    const openAbove = viewportHeight > 0 && spaceBelow < 320 && spaceAbove > spaceBelow
    const availableHeight = openAbove ? spaceAbove : spaceBelow
    setMenuPos(openAbove
      ? {
          left,
          bottom: viewportHeight - rect.top + gap,
          maxHeight: Math.min(520, availableHeight),
        }
      : {
          left,
          top: rect.bottom + gap,
          maxHeight: viewportHeight ? Math.min(520, availableHeight) : 520,
        })
    setMode('menu')
    scrollMenuToTop()
    setError('')
    setQuery('')
    setName('')
    void load()
  }

  const currentKind = scopeKind(scope)
  const shareName = (share: Share) => {
    if (share.target_type === 'series') {
      const match = series.find((item) => item.id === share.target_id)
      return match?.name || displayId(share.target_id)
    }
    if (share.target_type === 'template') {
      const match = templates.find((item) => item.id === share.target_id)
      return match?.name || displayId(share.target_id)
    }
    return displayId(share.target_id)
  }
  const shareLabel = (share: Share) =>
    `${share.target_type === 'project' ? 'Project' : share.target_type === 'series' ? 'Series' : 'Template'} · ${shareName(share)}`
  const defaultLabel =
    currentKind === 'series'
      ? `Series · ${context.series ? displayId(context.series) : 'No series'}`
      : currentKind === 'template'
        ? `Template · ${context.template ? displayId(context.template) : 'No template'}`
        : 'This project only'
  const shareCount = context.shares.length
  const triggerLabel =
    shareCount === 1
      ? `${defaultLabel} + ${shareName(context.shares[0])}`
      : shareCount > 1
        ? `${defaultLabel} +${shareCount}`
        : defaultLabel

  const chooseScope = async (nextScope: string) => {
    if (busy) return
    setBusy(`scope:${nextScope}`)
    setError('')
    const ok = await onScopeChange(nextScope)
    setBusy('')
    if (ok) setMenuPos(null)
  }

  const isShared = (targetType: Share['target_type'], targetId: string) =>
    context.shares.some(
      (share) => share.target_type === targetType && share.target_id === targetId,
    )

  const toggleShare = async (targetType: Share['target_type'], targetId: string) => {
    const key = `${targetType}:${targetId}`
    if (busy) return
    setBusy(key)
    setError('')
    const enabled = !isShared(targetType, targetId)
    const out = await postAction<{ shares?: Share[] }>({
      action: 'set_world_kit_share',
      ref: refId,
      target_type: targetType,
      target_id: targetId,
      enabled,
    })
    setBusy('')
    if (!out?.ok) {
      setError(out?.error || out?.message || 'Could not update sharing.')
      return
    }
    const shares = Array.isArray(out.data?.shares) ? out.data.shares : []
    setContext((value) => ({ ...value, shares }))
    onToast(
      enabled
        ? `“${refId}” is now shared with ${displayId(targetId)}.`
        : `“${refId}” is no longer shared with ${displayId(targetId)}.`,
    )
  }

  const createSeriesAndShare = async () => {
    const id = idFromName(name)
    if (!id || busy) return
    setBusy('create-series')
    setError('')
    const created = await postAction({
      action: 'create_series',
      series: id,
      name: name.trim(),
      template: context.template,
    })
    if (!created?.ok) {
      setBusy('')
      setError(created?.error || created?.message || 'Could not create the series.')
      return
    }
    const shared = await postAction<{ shares?: Share[] }>({
      action: 'set_world_kit_share',
      ref: refId,
      target_type: 'series',
      target_id: id,
      enabled: true,
    })
    setBusy('')
    if (!shared?.ok) {
      setError(shared?.error || shared?.message || 'Series created, but sharing failed.')
      return
    }
    setContext((value) => ({
      ...value,
      shares: Array.isArray(shared.data?.shares) ? shared.data.shares : value.shares,
    }))
    await load()
    setMode('targets')
    setName('')
    onToast(`Created ${displayId(id)} and shared “${refId}” with it.`)
  }

  const duplicateTemplateAndShare = async () => {
    const id = idFromName(name)
    if (!id || !context.template || busy) return
    setBusy('duplicate-template')
    setError('')
    const created = await postAction({
      action: 'duplicate_template',
      template: context.template,
      new_id: id,
      name: name.trim(),
    })
    if (!created?.ok) {
      setBusy('')
      setError(created?.error || created?.message || 'Could not duplicate the template.')
      return
    }
    const shared = await postAction<{ shares?: Share[] }>({
      action: 'set_world_kit_share',
      ref: refId,
      target_type: 'template',
      target_id: id,
      enabled: true,
    })
    setBusy('')
    if (!shared?.ok) {
      setError(shared?.error || shared?.message || 'Template duplicated, but sharing failed.')
      return
    }
    setContext((value) => ({
      ...value,
      shares: Array.isArray(shared.data?.shares) ? shared.data.shares : value.shares,
    }))
    await load()
    setMode('targets')
    setName('')
    onToast(`Created ${displayId(id)} and shared “${refId}” with it.`)
  }

  const recentTargets = useMemo(() => [
    ...series
      .filter((item) => item.id !== context.series && Number(item.modified_at || 0) > 0)
      .map((item) => ({
        targetType: 'series' as const,
        targetId: item.id,
        label: `Series · ${item.name || displayId(item.id)}`,
        detail: item.template ? `${displayId(item.template)} template` : 'Series',
        modifiedAt: Number(item.modified_at || 0),
      })),
    ...templates
      .filter((item) => item.id !== context.template && Number(item.modified_at || 0) > 0)
      .map((item) => ({
        targetType: 'template' as const,
        targetId: item.id,
        label: `Template · ${item.name || displayId(item.id)}`,
        detail: 'Every project using this template',
        modifiedAt: Number(item.modified_at || 0),
      })),
  ].sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 5), [
    context.series,
    context.template,
    series,
    templates,
  ])

  const targetRows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches = (id: string, label = '') =>
      !needle || `${id} ${displayId(id)} ${label}`.toLowerCase().includes(needle)
    const recentKeys = new Set(
      recentTargets.map((item) => `${item.targetType}:${item.targetId}`),
    )
    return {
      series: series.filter(
        (item) =>
          item.id !== context.series
          && matches(item.id, item.name)
          && (needle || !recentKeys.has(`series:${item.id}`)),
      ),
      templates: templates.filter(
        (item) =>
          item.id !== context.template
          && matches(item.id, item.name)
          && (needle || !recentKeys.has(`template:${item.id}`)),
      ),
      projects: projects.filter(
        (item) => item.id !== context.project && matches(item.id),
      ),
    }
  }, [
    context.project,
    context.series,
    context.template,
    projects,
    query,
    recentTargets,
    series,
    templates,
  ])

  const targetButton = (
    targetType: Share['target_type'],
    targetId: string,
    label: string,
    detail: string,
  ) => {
    const selected = isShared(targetType, targetId)
    const key = `${targetType}:${targetId}`
    return (
      <button
        type="button"
        key={key}
        className={selected ? 'on' : undefined}
        disabled={!!busy}
        onClick={() => void toggleShare(targetType, targetId)}
      >
        {selected ? '✓ ' : ''}{label}
        <small>{busy === key ? 'Updating…' : detail}</small>
      </button>
    )
  }

  const menu = menuPos ? (
    <>
      <span className="vp-menu-backdrop" onClick={() => setMenuPos(null)} />
      <span
        ref={menuRef}
        className="vp-menu"
        style={{
          ...menuPos,
          width: 360,
          maxWidth: 'calc(100vw - 16px)',
          overflowY: 'auto',
        }}
      >
        {mode === 'menu' ? (
          <>
            <span className="vp-menu-h">SHARE WITH</span>
            <button
              type="button"
              className={currentKind === 'project' ? 'on' : undefined}
              disabled={!!busy}
              onClick={() => void chooseScope('episode-only')}
            >
              {currentKind === 'project' ? '✓ ' : ''}This project only
              <small>{displayId(context.project)}</small>
            </button>
            {context.series ? (
              <button
                type="button"
                className={currentKind === 'series' ? 'on' : undefined}
                disabled={!!busy}
                onClick={() => void chooseScope('show-shared')}
              >
                {currentKind === 'series' ? '✓ ' : ''}Series · {displayId(context.series)}
                <small>Default series · current and future episodes</small>
              </button>
            ) : null}
            {context.template ? (
              <button
                type="button"
                className={currentKind === 'template' ? 'on' : undefined}
                disabled={!!busy}
                onClick={() => void chooseScope('template-shared')}
              >
                {currentKind === 'template' ? '✓ ' : ''}Template · {displayId(context.template)}
                <small>Default template · every project using it</small>
              </button>
            ) : null}
            {context.shares.length ? (
              <>
                <span className="series-menu-empty">ALSO SHARED WITH</span>
                {context.shares.map((share) =>
                  targetButton(
                    share.target_type,
                    share.target_id,
                    shareLabel(share),
                    'Additional access · click to remove',
                  ),
                )}
              </>
            ) : null}
            <span className="vp-menu-div" />
            <button type="button" onClick={() => showMode('targets')}>
              Share with another project, series, or template
              <small>{shareCount ? 'Add or change destinations' : 'No additional sharing yet'}</small>
            </button>
            <button type="button" onClick={() => { showMode('series'); setName('') }}>
              Create new series and share
              <small>The current project stays where it is</small>
            </button>
            <button
              type="button"
              disabled={!context.template}
              onClick={() => { showMode('template'); setName('') }}
            >
              Duplicate template and share
              <small>{context.template ? `Starts from ${displayId(context.template)}` : 'This project has no template'}</small>
            </button>
          </>
        ) : mode === 'targets' ? (
          <>
            <span className="world-kit-share-search-head">
              <button type="button" className="series-menu-back" onClick={() => showMode('menu')}>
                ← Share with
              </button>
              <span className="vp-menu-h">ADDITIONAL SHARING</span>
              <span className="series-menu-form">
                <input
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Find a project, series, or template"
                />
              </span>
            </span>
            {!query.trim() && recentTargets.length ? (
              <>
                <span className="series-menu-empty">RECENTS</span>
                {recentTargets.map((item) =>
                  targetButton(
                    item.targetType,
                    item.targetId,
                    item.label,
                    item.detail,
                  ),
                )}
              </>
            ) : null}
            {targetRows.series.length ? (
              <>
                <span className="series-menu-empty">SERIES</span>
                {targetRows.series.map((item) =>
                  targetButton(
                    'series',
                    item.id,
                    item.name || displayId(item.id),
                    item.template ? `${displayId(item.template)} template` : 'Series',
                  ),
                )}
              </>
            ) : null}
            {targetRows.templates.length ? (
              <>
                <span className="series-menu-empty">TEMPLATES</span>
                {targetRows.templates.map((item) =>
                  targetButton(
                    'template',
                    item.id,
                    item.name || displayId(item.id),
                    'Every project using this template',
                  ),
                )}
              </>
            ) : null}
            {targetRows.projects.length ? (
              <>
                <span className="series-menu-empty">PROJECTS</span>
                {targetRows.projects.map((item) =>
                  targetButton(
                    'project',
                    item.id,
                    displayId(item.id),
                    [item.series && `${displayId(item.series)} series`, item.template && `${displayId(item.template)} template`]
                      .filter(Boolean)
                      .join(' · ') || 'Standalone project',
                  ),
                )}
              </>
            ) : null}
            {(query.trim() || !recentTargets.length)
              && !targetRows.projects.length
              && !targetRows.series.length
              && !targetRows.templates.length ? (
              <span className="series-menu-empty">No matching destinations.</span>
            ) : null}
          </>
        ) : (
          <>
            <button type="button" className="series-menu-back" onClick={() => showMode('menu')}>
              ← Share with
            </button>
            <span className="vp-menu-h">
              {mode === 'series' ? 'CREATE NEW SERIES' : 'DUPLICATE TEMPLATE'}
            </span>
            <span className="series-menu-form">
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || !idFromName(name)) return
                  if (mode === 'series') void createSeriesAndShare()
                  else void duplicateTemplateAndShare()
                }}
                placeholder={mode === 'series' ? 'Series name' : 'Template name'}
              />
              {idFromName(name) ? <small>ID: {idFromName(name)}</small> : null}
              <button
                type="button"
                className="vp-undo"
                disabled={!idFromName(name) || !!busy}
                onClick={() => {
                  if (mode === 'series') void createSeriesAndShare()
                  else void duplicateTemplateAndShare()
                }}
              >
                {busy
                  ? 'Creating…'
                  : mode === 'series'
                    ? 'Create series and share'
                    : 'Duplicate template and share'}
              </button>
            </span>
          </>
        )}
        {error ? <span className="series-menu-error">{error}</span> : null}
      </span>
    </>
  ) : null

  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        ref={buttonRef}
        className="vp-menu-btn"
        aria-expanded={open}
        onClick={toggle}
        style={{ whiteSpace: 'nowrap', maxWidth: 290, overflow: 'hidden', textOverflow: 'ellipsis' }}
      >
        {triggerLabel} ▾
      </button>
      {menu ? createPortal(menu, document.body) : null}
    </span>
  )
}

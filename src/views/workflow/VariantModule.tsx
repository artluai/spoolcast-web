import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DEFAULT_IMAGE_MODEL_ID, IMAGE_MODELS } from '../../lib/image-models'
import { actionUrl, activeSession, apiUrl, contentUrl } from '../../lib/api'
import { ModelPicker } from './ModelPicker'

// THE VARIANT MODULE — shared between the step-7 mapping board and the
// step-5 World Kit panel. Any kit object can get a variant: an image-backed
// base generates with its picked image as reference 1; a prompt-only base
// varies the prompt itself. The module is a floating, draggable, resizable
// window portaled to <body> (the host cards are stacking contexts that would
// otherwise trap it under the app header).

export type VariantBase = {
  name: string
  kind: string
  notes: string
  image_path: string
  active_prompt?: string
  active_model?: string
}

export function VariantModule({
  base,
  kit,
  initialPos,
  anchorRect,
  inline = false,
  onClose,
  onCreated,
}: {
  base: VariantBase
  // Extra-reference candidates (image-backed kit objects). Pass [] to let
  // the module fetch the session kit itself.
  kit: VariantBase[]
  initialPos?: { x: number; y: number }
  // Optional: the on-screen rect of the base's card — draws the dashed thread.
  anchorRect?: () => DOMRect | undefined
  // Inline mode: render only the fields (no floating window) — for embedding
  // in a host panel that already shows the base item (World Kit CREATE box).
  inline?: boolean
  onClose: () => void
  onCreated: (name: string, instruction: string) => void
}) {
  const [pool, setPool] = useState<VariantBase[]>(kit)
  useEffect(() => {
    if (kit.length) {
      setPool(kit)
      return
    }
    let live = true
    fetch(apiUrl('source-images', { session: activeSession(), include_refs: 1 }))
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        if (live && Array.isArray(out?.data?.kit)) setPool(out.data.kit)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [kit])

  const [vName, setVName] = useState('')
  const [vInstr, setVInstr] = useState('')
  // Extra references travel as session-relative IMAGE PATHS (not kit names):
  // kit refs, imported sources and fresh uploads all fit the same list.
  const [vExtras, setVExtras] = useState<string[]>([])
  const [vExtrasOpen, setVExtrasOpen] = useState(false)
  const [vUploads, setVUploads] = useState<{ path: string; name: string }[]>([])
  const [vModel, setVModel] = useState(base.active_model || '')
  const [vBusy, setVBusy] = useState('')
  const [vErr, setVErr] = useState('')
  const [lightbox, setLightbox] = useState('')
  const [vPos, setVPos] = useState<{ x: number; y: number } | null>(initialPos ?? null)
  const [vSize, setVSize] = useState<{ w: number; h: number | null }>({ w: 680, h: null })
  const vModalRef = useRef<HTMLDivElement>(null)
  const vDragRef = useRef<{ dx: number; dy: number } | null>(null)

  // The drag handle must stay reachable: never above the app header, never
  // fully off any edge — a module dragged out of reach is dragged forever.
  const clampVXY = (x: number, y: number) => {
    const vw = window.innerWidth || 1600
    const vh = window.innerHeight || 1000
    const w = vModalRef.current?.offsetWidth ?? 680
    const topMin = (document.querySelector('header')?.getBoundingClientRect().bottom ?? 56) + 4
    return {
      x: Math.min(Math.max(x, 140 - w), vw - 140),
      y: Math.min(Math.max(y, topMin), vh - 48),
    }
  }
  const onVDrag = (e: React.PointerEvent) => {
    vDragRef.current = { dx: e.clientX - (vPos?.x ?? 0), dy: e.clientY - (vPos?.y ?? 0) }
    const move = (ev: PointerEvent) => {
      const d = vDragRef.current
      if (d) setVPos(clampVXY(ev.clientX - d.dx, ev.clientY - d.dy))
    }
    const up = () => {
      vDragRef.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const onVResize = (e: React.PointerEvent, dir: string) => {
    e.preventDefault()
    e.stopPropagation()
    const rect = vModalRef.current?.getBoundingClientRect()
    if (!rect) return
    const start = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height, px: rect.left, py: rect.top }
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x
      const dy = ev.clientY - start.y
      let w = start.w
      let h = start.h
      if (dir.includes('e')) w = start.w + dx
      if (dir.includes('w')) w = start.w - dx
      if (dir.includes('s')) h = start.h + dy
      if (dir.includes('n')) h = start.h - dy
      w = Math.min(Math.max(w, 460), Math.max(460, (window.innerWidth || 1600) - 24))
      h = Math.min(Math.max(h, 300), Math.max(300, (window.innerHeight || 1000) - 24))
      setVSize({ w: Math.round(w), h: Math.round(h) })
      setVPos(
        clampVXY(
          dir.includes('w') ? start.px + (start.w - w) : start.px,
          dir.includes('n') ? start.py + (start.h - h) : start.py,
        ),
      )
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // Upload the user's own reference image into the session source pool; the
  // returned path slots straight into the extra references.
  const uploadExtraRef = async (file: File) => {
    const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, '-')
    const b64 = await new Promise<string>((resolve, reject) => {
      const rd = new FileReader()
      rd.onload = () => resolve(String(rd.result).split(',')[1] || '')
      rd.onerror = reject
      rd.readAsDataURL(file)
    })
    const r = await fetch(actionUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: activeSession(), tenant: 'local', action: 'upload_file', filename: safeName, content: b64 }),
    }).then((x) => x.json()).catch(() => null)
    if (r?.ok) {
      const rel = `source/${safeName}`
      setVUploads((cur) => (cur.some((u) => u.path === rel) ? cur : [...cur, { path: rel, name: safeName }]))
      setVExtras((cur) => (cur.includes(rel) ? cur : [...cur, rel]))
    } else {
      setVErr(r?.error || 'Upload failed.')
    }
  }

  const refetchKit = async (): Promise<VariantBase[]> => {
    const out = await fetch(apiUrl('source-images', { session: activeSession(), include_refs: 1 }))
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
    const fresh = (out?.data?.kit ?? []) as VariantBase[]
    if (fresh.length) setPool(fresh)
    return fresh
  }

  const createVariant = async () => {
    if (!vInstr.trim()) return
    const name = (vName.trim() || `${base.name}--${vInstr.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`).replace(/-+$/, '')
    setVErr('')
    setVBusy('Registering…')
    const reg = await fetch(actionUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: activeSession(), tenant: 'local', action: 'register_master_variant', master: base.name, name, instruction: vInstr.trim() }),
    }).then((r) => r.json()).catch(() => null)
    if (!reg?.ok) {
      setVBusy('')
      setVErr(reg?.error || 'Could not register the variant.')
      return
    }
    const baseIsImage = !!base.image_path
    setVBusy(baseIsImage ? 'Generating — the base image is reference 1…' : 'Generating — from the base prompt…')
    // Image-backed base: the picked image IS the shot, one change. Prompt-only
    // base: the variant is a change to the prompt itself.
    const basePrompt = (base.active_prompt || base.notes || '').trim()
    const prompt = baseIsImage
      ? `Use reference image 1 as the exact base shot: same person, same clothes, same setting, same framing, same light, same casual phone-camera look. ` +
        `ONE change only: ${vInstr.trim()}. Everything else stays exactly identical to the reference.`
      : `${basePrompt}\n\nONE deliberate change from the description above: ${vInstr.trim()}. Everything else stays exactly as described.`
    const gen = await fetch(actionUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: activeSession(),
        tenant: 'local',
        action: 'generate_worldkit_ref',
        ref: name,
        prompt,
        // Exactly what the picker shows: explicit choice > base's model > default.
        model: vModel || base.active_model || DEFAULT_IMAGE_MODEL_ID,
        ref_images: [...(baseIsImage ? [base.image_path] : []), ...vExtras],
        allow_cost: true,
      }),
    }).then((r) => r.json()).catch(() => null)
    if (!gen?.ok) {
      setVBusy('')
      setVErr(gen?.error || gen?.message || 'Generation did not start.')
      return
    }
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => window.setTimeout(r, 6000))
      const fresh = await refetchKit()
      if (fresh.find((k) => k.name === name)?.image_path) {
        setVBusy('')
        onCreated(name, vInstr.trim())
        onClose()
        return
      }
      setVBusy(`Generating… (~${Math.round(((i + 1) * 6) / 60)}min)`)
    }
    setVBusy('')
    setVErr('Still generating — it will appear in the kit when done.')
  }


  // The FIELDS are the module; the floating window is only chrome. Inline
  // mode embeds them straight into a host panel.
  const fieldsJsx = (
    <div className="vp-var-fields">
      <label className="vp-edit-field">What changes (one deliberate change)
        <textarea rows={7} value={vInstr} onChange={(e) => setVInstr(e.target.value)} placeholder="e.g. remove the shoes from her hands — hands rest in her lap" />
      </label>
      <div className="vp-var-row">
        <button
          type="button"
          className="vp-undo"
          disabled={!(base.active_prompt || base.notes)}
          title="Append the prompt that made the base"
          onClick={() => setVInstr((cur) => (cur ? cur + '\n\n' : '') + (base.active_prompt || base.notes || ''))}
        >
          Import original prompt
        </button>
        <button type="button" className="vp-undo" onClick={() => setVExtrasOpen((v) => !v)}>
          {vExtrasOpen ? '▾' : '▸'} Extra references{vExtras.length ? ` · ${vExtras.length}` : ''}
        </button>
        <ModelPicker
          model={vModel || base.active_model || DEFAULT_IMAGE_MODEL_ID}
          onChange={setVModel}
          disabled={!!vBusy}
          models={IMAGE_MODELS}
          primary={IMAGE_MODELS}
        />
      </div>
      {vExtrasOpen ? (
        <div className="vp-var-extras">
          {pool.filter((k) => k.image_path && k.name !== base.name).map((k) => (
            <button
              key={k.name}
              type="button"
              className={`vp-var-xref ${vExtras.includes(k.image_path) ? 'on' : ''}`}
              title={k.name}
              onClick={() => setVExtras((cur) => (cur.includes(k.image_path) ? cur.filter((p) => p !== k.image_path) : [...cur, k.image_path]))}
            >
              <img src={contentUrl(k.image_path)} alt={k.name} />
            </button>
          ))}
          {vUploads.map((u) => (
            <button
              key={u.path}
              type="button"
              className={`vp-var-xref ${vExtras.includes(u.path) ? 'on' : ''}`}
              title={u.name}
              onClick={() => setVExtras((cur) => (cur.includes(u.path) ? cur.filter((p) => p !== u.path) : [...cur, u.path]))}
            >
              <img src={contentUrl(u.path)} alt={u.name} />
            </button>
          ))}
          <label className="vp-var-xref vp-var-upl" title="Upload your own reference image">
            ↑ upload
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void uploadExtraRef(f)
              }}
            />
          </label>
        </div>
      ) : null}
      <label className="vp-edit-field">Variant name
        <input value={vName} onChange={(e) => setVName(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-'))} placeholder={`${base.name}--…`} />
      </label>
      {vErr ? <p className="vp-var-err">{vErr}</p> : null}
      <div className="vp-edit-actions">
        <button type="button" className="vp-save" disabled={!!vBusy || !vInstr.trim()} onClick={createVariant}>
          ✦ Generate variant
        </button>
      </div>
    </div>
  )

  if (inline) {
    return (
      <div className="vp-var-inline" style={{ position: 'relative', border: '1px dashed var(--line, #2a3142)', borderRadius: 10, padding: 12 }}>
        {fieldsJsx}
        {vBusy ? (
          <div className="vp-var-busyov" style={{ borderRadius: 10 }}>
            <span className="spin" />
            <span>{vBusy}</span>
          </div>
        ) : null}
      </div>
    )
  }

  const rect = anchorRect?.()
  const pos = vPos ?? { x: 120, y: 120 }
  return createPortal(
    <>
      {rect ? (
        <svg className="vp-var-thread">
          <path d={`M ${rect.left + rect.width / 2} ${rect.top + rect.height / 2} C ${rect.left} ${rect.top - 40}, ${pos.x + 690} ${pos.y + 120}, ${pos.x + 660} ${pos.y + 90}`} />
        </svg>
      ) : null}
      <div
        className="vp-edit vp-var-modal"
        ref={vModalRef}
        style={{ left: pos.x, top: pos.y, width: vSize.w, ...(vSize.h ? { height: vSize.h } : {}) }}
        // The module is portaled to <body>, but React still bubbles its events
        // up the COMPONENT tree — into any canvas drag-to-pan mousedown whose
        // DOM closest() check can't see this detached subtree.
        onMouseDown={(e) => e.stopPropagation()}
      >
        {['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((dir) => (
          <span key={dir} className={`vp-var-rs vp-var-rs-${dir}`} onPointerDown={(e) => onVResize(e, dir)} />
        ))}
        <div className="vp-var-head" onPointerDown={onVDrag}>
          <b>Variant of {base.name}</b>
          <span className="vp-hint">drag to move</span>
          <button
            type="button"
            className="vp-var-close"
            title="Cancel"
            disabled={!!vBusy}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onClose}
          >✕</button>
        </div>
        <div className={`vp-var-scroll ${vBusy ? 'busy' : ''}`}>
          <div className="vp-var-body">
            {base.image_path ? (
              <img className="vp-var-master" src={contentUrl(base.image_path)} alt={base.name} onClick={() => setLightbox(base.image_path)} title="Click to view large" />
            ) : (
              <div className="vp-var-master vp-var-mastertext" title="The base prompt — the variant is one deliberate change to this">
                {(base.active_prompt || base.notes || 'Prompt-only reference.')}
              </div>
            )}
            {fieldsJsx}
          </div>
        </div>
        {vBusy ? (
          <div className="vp-var-busyov">
            <span className="spin" />
            <span>{vBusy}</span>
          </div>
        ) : null}
      </div>
      {lightbox ? (
        <div className="vp-var-overlay" onClick={() => setLightbox('')} style={{ zIndex: 120 }}>
          <img className="vp-lightbox" src={contentUrl(lightbox)} alt="" />
        </div>
      ) : null}
    </>,
    document.body,
  )
}

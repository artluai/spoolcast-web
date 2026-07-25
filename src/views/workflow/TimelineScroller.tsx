import { useEffect, useRef, useState } from 'react'
import type { PointerEvent, ReactNode, WheelEvent } from 'react'

export function TimelineScroller({
  zoom,
  setZoom,
  hint,
  notice,
  toolbarActions,
  position = 0,
  duration = 0,
  children,
}: {
  zoom: number
  setZoom: (next: number | ((current: number) => number)) => void
  hint: string
  notice?: ReactNode
  toolbarActions?: ReactNode
  position?: number
  duration?: number
  children: ReactNode
}) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x: number; left: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [overview, setOverview] = useState({ left: 0, width: 100 })
  const updateOverview = () => {
    const box = scrollerRef.current
    if (!box || !box.scrollWidth) return
    setOverview({
      left: (box.scrollLeft / box.scrollWidth) * 100,
      width: Math.min(100, (box.clientWidth / box.scrollWidth) * 100),
    })
  }
  useEffect(() => {
    const frame = window.requestAnimationFrame(updateOverview)
    const box = scrollerRef.current
    if (!box || typeof ResizeObserver === 'undefined') return () => window.cancelAnimationFrame(frame)
    const observer = new ResizeObserver(updateOverview)
    observer.observe(box)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [zoom])
  const zoomAround = (nextZoom: number, clientX?: number) => {
    const box = scrollerRef.current
    const next = Math.max(1, Math.min(8, nextZoom))
    if (!box || next === zoom) return
    const rect = box.getBoundingClientRect()
    const localX = clientX == null ? box.clientWidth / 2 : Math.max(0, Math.min(box.clientWidth, clientX - rect.left))
    const contentRatio = (box.scrollLeft + localX) / Math.max(1, box.scrollWidth)
    setZoom(next)
    window.requestAnimationFrame(() => {
      box.scrollLeft = Math.max(0, contentRatio * box.scrollWidth - localX)
      updateOverview()
    })
  }
  const zoomFromWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    zoomAround(zoom * (event.deltaY < 0 ? 1.2 : 1 / 1.2), event.clientX)
  }
  const pan = (dir: -1 | 1) => scrollerRef.current?.scrollBy({ left: dir * 240, behavior: 'smooth' })
  const startPan = (e: PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (target.closest('button, input, textarea, select, [data-no-pan]')) return
    dragRef.current = { x: e.clientX, left: scrollerRef.current?.scrollLeft ?? 0 }
    setDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const movePan = (e: PointerEvent<HTMLDivElement>) => {
    const cur = dragRef.current
    const box = scrollerRef.current
    if (!cur || !box) return
    box.scrollLeft = cur.left - (e.clientX - cur.x)
  }
  const endPan = () => {
    dragRef.current = null
    setDragging(false)
  }

  return (
    <>
      <div className="vp-hintbar vp-hintbar-top">
        <p className="vp-hint">{hint}</p>
        {notice ? <span className="vp-timeline-notice">{notice}</span> : null}
        <span className="vp-zoom-actions">
          <button type="button" className="vp-undo" title="Pan timeline left" disabled={zoom <= 1} onClick={() => pan(-1)}>←</button>
          <button type="button" className="vp-undo" title="Pan timeline right" disabled={zoom <= 1} onClick={() => pan(1)}>→</button>
          <button type="button" className="vp-undo" title="Zoom out around the current view" disabled={zoom <= 1} onClick={() => zoomAround(zoom / 1.5)}>−</button>
          <button type="button" className="vp-undo" title="Zoom in around the current view · Cmd/Ctrl-wheel zooms at the pointer" onClick={() => zoomAround(zoom * 1.5)}>+</button>
          <button type="button" className="vp-undo" title="Fit the whole video in view" disabled={zoom <= 1} onClick={() => zoomAround(1)}>Fit</button>
        </span>
        {toolbarActions ? <span className="vp-timeline-toolbar-actions">{toolbarActions}</span> : null}
      </div>
      <div
        ref={scrollerRef}
        className={`vp-timeline vp-timeline-scroll ${dragging ? 'dragging' : ''}`}
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onScroll={updateOverview}
        onWheel={zoomFromWheel}
      >
        <div className="vp-timeline-inner" style={{ width: `${zoom * 100}%`, minWidth: '100%' }}>
          {children}
        </div>
      </div>
      {zoom > 1 ? (
        <button
          type="button"
          className="vp-timeline-overview"
          title="Timeline overview · click to pan"
          onClick={(event) => {
            const box = scrollerRef.current
            if (!box) return
            const rect = event.currentTarget.getBoundingClientRect()
            const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)))
            box.scrollLeft = Math.max(0, ratio * box.scrollWidth - box.clientWidth / 2)
            updateOverview()
          }}
        >
          <span className="vp-timeline-overview-window" style={{ left: `${overview.left}%`, width: `${overview.width}%` }} />
          {duration > 0 ? <i style={{ left: `${Math.max(0, Math.min(100, position / duration * 100))}%` }} /> : null}
        </button>
      ) : null}
    </>
  )
}

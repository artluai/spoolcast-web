import { useRef, useState } from 'react'
import type { PointerEvent, ReactNode } from 'react'

export function TimelineScroller({
  zoom,
  setZoom,
  hint,
  children,
}: {
  zoom: number
  setZoom: (next: number | ((current: number) => number)) => void
  hint: string
  children: ReactNode
}) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x: number; left: number } | null>(null)
  const [dragging, setDragging] = useState(false)
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
      <div
        ref={scrollerRef}
        className={`vp-timeline vp-timeline-scroll ${dragging ? 'dragging' : ''}`}
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        <div className="vp-timeline-inner" style={{ width: `${zoom * 100}%`, minWidth: '100%' }}>
          {children}
        </div>
      </div>
      <div className="vp-hintbar">
        <p className="vp-hint">{hint}</p>
        <span className="vp-zoom-actions">
          <button type="button" className="vp-undo" title="Pan timeline left" disabled={zoom <= 1} onClick={() => pan(-1)}>←</button>
          <button type="button" className="vp-undo" title="Pan timeline right" disabled={zoom <= 1} onClick={() => pan(1)}>→</button>
          <button type="button" className="vp-undo" title="Zoom out" disabled={zoom <= 1} onClick={() => setZoom((z) => Math.max(1, z / 1.5))}>−</button>
          <button type="button" className="vp-undo" title="Zoom in; drag the timeline to pan" onClick={() => setZoom((z) => Math.min(8, z * 1.5))}>+</button>
          <button type="button" className="vp-undo" title="Fit the whole video in view" disabled={zoom <= 1} onClick={() => setZoom(1)}>Fit</button>
        </span>
      </div>
    </>
  )
}

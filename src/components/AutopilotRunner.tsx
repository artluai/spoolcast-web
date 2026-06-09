import { useEffect, useState } from 'react'

/* headless — drives the real canvas: focuses each remaining step, then marks
   it done, one at a time, until the run finishes or the user stops it. */
export function AutopilotRunner({
  steps,
  onSelect,
  onStepComplete,
  onFinish,
}: {
  steps: { id: string; name: string }[]
  onSelect: (id: string) => void
  onStepComplete: (id: string) => void
  onFinish: () => void
}) {
  const [idx, setIdx] = useState(0)
  useEffect(() => {
    if (idx >= steps.length) {
      onFinish()
      return
    }
    onSelect(steps[idx].id)
    const t = window.setTimeout(() => {
      onStepComplete(steps[idx].id)
      setIdx((i) => i + 1)
    }, 1100)
    return () => window.clearTimeout(t)
  }, [idx, steps, onSelect, onStepComplete, onFinish])
  return null
}

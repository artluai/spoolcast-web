type ConnectorProps = {
  selected?: boolean
  variant?: 'in' | 'out' | 'style'
  index?: number
  total?: number
}

export function Connector({
  selected = false,
  variant = 'in',
  index = 0,
  total = 1,
}: ConnectorProps) {
  const span = total > 1 ? index - (total - 1) / 2 : 0
  const cy = 19 + span * 4
  const startY = variant === 'in' ? cy : 19
  const endY = variant === 'out' ? cy : 19
  const d =
    variant === 'style'
      ? 'M 0 19 C 35 14, 65 24, 100 19'
      : `M 0 ${startY} C 30 ${variant === 'in' ? cy : 19}, 70 ${
          variant === 'out' ? cy : 19
        }, 100 ${endY}`

  return (
    <div className={`connector ${variant} ${selected ? 'selected' : ''}`}>
      <svg viewBox="0 0 100 38" preserveAspectRatio="none" aria-hidden="true">
        <path d={d} />
      </svg>
    </div>
  )
}

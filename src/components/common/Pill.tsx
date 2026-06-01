import type { ReactNode } from 'react'

type PillProps = {
  children: ReactNode
  selected?: boolean
  disabled?: boolean
  dim?: boolean
  className?: string
  onClick?: () => void
}

export function Pill({
  children,
  selected = false,
  disabled = false,
  dim = false,
  className = '',
  onClick,
}: PillProps) {
  return (
    <button
      type="button"
      className={`pill-node ${className} ${selected ? 'selected' : ''} ${
        disabled ? 'disabled' : ''
      } ${dim ? 'dim' : ''}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="pill-stripe" />
      <span className="pill-body">{children}</span>
    </button>
  )
}

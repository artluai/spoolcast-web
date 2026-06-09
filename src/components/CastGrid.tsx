import { castByShow } from '../data/cast'

export function CastGrid({
  castData,
  compact = false,
}: {
  castData: (typeof castByShow)['spoolcast dev log']
  compact?: boolean
}) {
  return (
    <div className={`cast-grid ${compact ? 'compact' : ''}`}>
      {castData.chars.map((char) => (
        <div className="cast-card" key={char.ref}>
          <div className="portrait">
            <img src={char.img} alt="" />
            <span>{char.ref}</span>
          </div>
          <div className="body">
            <h3>{char.name}</h3>
            <p>{char.role}</p>
            {!compact ? <small>{char.episodes} episodes · last: {char.lastUsed}</small> : null}
          </div>
        </div>
      ))}
    </div>
  )
}

export function ConfirmModal({
  onCancel,
  onApprove,
}: {
  onCancel: () => void
  onApprove: () => void
}) {
  return (
    <div className="modal-scrim">
      <div className="confirm-modal">
        <span className="need">USES CREDITS</span>
        <h3>Turn on Autopilot?</h3>
        <p>Spoolcast will run every remaining step automatically. This costs credits as it runs — about 380 credits for an episode of this length.</p>
        <div className="check">
          <b>Before turning it on</b>
          <ul>
            <li>About 380 credits needed · 2,140 available</li>
            <li>Autopilot pauses if credits run out</li>
            <li>Autopilot pauses if an audit gate fails</li>
            <li>Human-approval gates still pause unless turned off in Defaults</li>
          </ul>
        </div>
        <div className="actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={onApprove}>Approve and run</button>
        </div>
      </div>
    </div>
  )
}

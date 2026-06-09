export function ProfileDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <>
      <button className={`profile-scrim ${open ? 'open' : ''}`} onClick={onClose} aria-label="Close profile" />
      <aside className={`profile-panel ${open ? 'open' : ''}`}>
        <div className="pp-head">
          <div className="pp-avatar">R</div>
          <div>
            <b>Ralph Xu</b>
            <span>ralph@spoolcast.dev</span>
          </div>
          <button onClick={onClose}>×</button>
        </div>
        <div className="credits-card">
          <span>Credits</span>
          <b>2,140 <em>/ 5,000 this month</em></b>
          <i><u style={{ width: '42%' }} /></i>
          <div><small>Resets May 28</small><button>Top up</button></div>
        </div>
        <section>
          <h3>Plan</h3>
          <p>Creator · $24/mo</p>
          <small>5,000 credits · 4 active shows · billed monthly</small>
        </section>
        <section>
          <h3>Defaults</h3>
          {['Autopilot pauses on audit failures', 'Auto-approve mobile variant', 'Email when a step finishes'].map((item, i) => (
            <div className="pp-row" key={item}>
              <span>{item}<small>{i === 0 ? 'Recommended. Turn off only if the gates are trusted.' : i === 1 ? 'Skip the human gate when the vertical cut passes audits.' : 'One email per project, not per step.'}</small></span>
              <button className={`toggle ${i !== 1 ? 'on' : ''}`} />
            </div>
          ))}
        </section>
        <section>
          <h3>Account</h3>
          <p>Manage API keys ›</p>
          <p>Connected platforms ›</p>
          <p>Sign out ›</p>
        </section>
      </aside>
    </>
  )
}

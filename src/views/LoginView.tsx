export function LoginView({ onFirstTime, onGoogle }: { onFirstTime: () => void; onGoogle: () => void }) {
  return (
    <section className="login-view">
      <div className="login-card">
        <span className="mockup-pill">Interactive mockup</span>
        <div className="login-mark">S</div>
        <h1>Spoolcast</h1>
        <p>Script-first AI video pipeline.</p>
        <p className="mockup-note">
          This is a frontend design mockup — nothing here is real (no sign-in, no
          accounts, no video generation). Click anything to explore.
        </p>
        <button className="primary-cta" onClick={onFirstTime}>
          First time? Let's make your first video →
        </button>
        <div className="or-divider">Already have an account</div>
        <button className="google-btn" onClick={onGoogle}>
          <span className="g">G</span>
          Continue with Google
        </button>
        <div className="login-foot">By continuing, Terms & Privacy Policy apply.</div>
      </div>
    </section>
  )
}

// Sign-up gate at the end of onboarding: a first-timer must create an account
// before generation (autopilot or manual continue) takes them into the workflow.
export function SignupModal({
  auto,
  onCancel,
  onSignup,
}: {
  auto: boolean
  onCancel: () => void
  onSignup: () => void
}) {
  return (
    <div className="modal-scrim" onClick={onCancel}>
      <div className="confirm-modal signup-modal" onClick={(e) => e.stopPropagation()}>
        <div className="login-mark">S</div>
        <h3>Create your account to continue</h3>
        <p>
          {auto
            ? 'Autopilot will generate the rest of your video — '
            : 'Your video is ready to build — '}
          sign up to save it and pick up on any device.
        </p>
        <button className="google-btn" onClick={onSignup}>
          <span className="g">G</span>
          Continue with Google
        </button>
        <button className="signup-cancel" onClick={onCancel}>
          Not now
        </button>
      </div>
    </div>
  )
}

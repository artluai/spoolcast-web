export function Footer({ blank }: { blank: boolean }) {
  return (
    <footer>
      <div>
        <span className="dot run" />
        <b>{blank ? 'Project setup' : 'Visual generation'}</b> · {blank ? 'just started' : '14 / 22'}
      </div>
      <div>
        <span className="dot ok" />
        {blank ? '0 of 12 steps complete' : 'Narration audio complete'}
      </div>
      <div className="footer-right">
        <span>{blank ? '0 approvals on file' : '4 approvals on file'}</span>
        <span>Project: {blank ? 'Untitled video' : 'Dev Log #06'}</span>
      </div>
    </footer>
  )
}

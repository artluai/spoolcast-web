import { useState } from 'react'
import type { ChatState, ChatTab, Step } from '../types'

export function ChatWidget({
  state,
  tab,
  selected,
  customChat,
  onOpen,
  onClose,
  onPin,
  onTab,
}: {
  state: ChatState
  tab: ChatTab
  selected: Step
  customChat: boolean
  onOpen: () => void
  onClose: () => void
  onPin: () => void
  onTab: (tab: ChatTab) => void
}) {
  const [messages, setMessages] = useState(
    customChat
      ? []
      : [
          {
            who: 'Spoolcast',
            text: 'Looking at Visual generation — clip C15 failed the scene audit. I can re-prompt it with a calmer pose, or skip it and use a cutaway.',
          },
        ],
  )
  const [text, setText] = useState('')
  const suggestions =
    selected.id === 'pics'
      ? ['Regenerate C15 with a calmer pose', 'Skip C15 and use a cutaway']
      : ['Switch to standalone', 'Show inherited rules']

  if (state === 'closed') {
    return (
      <button className="chat-bubble" onClick={onOpen} aria-label="Ask Spoolcast">
        □
      </button>
    )
  }
  return (
    <aside className={`chat-root ${state}`}>
      <div className="chat-panel">
        <div className="chat-head">
          <div className="chat-tabs">
            <button className={tab === 'chat' ? 'active' : ''} onClick={() => onTab('chat')}>
              Chat
            </button>
            <button className={tab === 'history' ? 'active' : ''} onClick={() => onTab('history')}>
              History
            </button>
          </div>
          <button onClick={onPin}>⇱</button>
          <button onClick={onClose}>×</button>
        </div>
        {tab === 'chat' ? (
          <div className="chat-body">
            <div className="chat-suggestions">
              {suggestions.map((suggestion) => (
                <button key={suggestion} onClick={() => setText(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
            {messages.map((message, index) => (
              <div className="chat-msg" key={`${message.who}-${index}`}>
                <span>{message.who}</span>
                {message.text}
              </div>
            ))}
          </div>
        ) : (
          <div className="chat-history">
            {[
              ['REGEN', 'Regenerated clip C12 — "Job runner"', '12 min ago'],
              ['EDIT', 'Tightened narration on C09 ("Audit demo")', '42 min ago'],
              ['ADD', 'Added new gate: render audit (working/render-audit.passed)', '1 hr ago'],
              ['EDIT', 'Shot list — split C07 into two beats for pacing', '2 hr ago'],
              ['ADD', 'Added Chad (meme-chad) to the dev log roster', '5 hr ago'],
            ].map(([kind, what, when]) => (
              <div className="history-row" key={`${kind}-${what}`}>
                <b className={kind.toLowerCase()}>{kind}</b>
                <span>{what}</span>
                <i>{when}</i>
              </div>
            ))}
          </div>
        )}
        <div className="chat-input">
          <div className="chat-input-box">
            <textarea
              placeholder={customChat ? 'Start by describing what type of video you would like to make…' : 'Ask Spoolcast anything…'}
              value={text}
              autoFocus={customChat}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  if (!text.trim()) return
                  setMessages((items) => [...items, { who: 'Ralph', text }])
                  setText('')
                }
              }}
            />
            <button
              className="chat-send"
              aria-label="Send"
              disabled={!text.trim()}
              onClick={() => {
                if (!text.trim()) return
                setMessages((items) => [...items, { who: 'Ralph', text }])
                setText('')
              }}
            >
              ↑
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}

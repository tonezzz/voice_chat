import { MouseEvent, useMemo, useState } from 'react'
import './FloatingMicPanel.css'

const MOCK_COMMANDS = ['Switch window', 'Summarize chat', 'Spawn new tab']

const MOCK_WINDOWS = [
  { id: 'alpha', title: 'Windsurf · Alpha build', content: 'Working session transcript…' },
  { id: 'beta', title: 'Customer standup', content: '“Let’s ship the floating panel”' }
]

export default function FloatingMicPanel() {
  const [listening, setListening] = useState(false)
  const [activeCommandIndex, setActiveCommandIndex] = useState(0)
  const [floatingWindows, setFloatingWindows] = useState(MOCK_WINDOWS)
  const activeCommand = MOCK_COMMANDS[activeCommandIndex % MOCK_COMMANDS.length]

  const handleMicClick = () => {
    setListening((prev) => !prev)
    setActiveCommandIndex((prev) => prev + 1)
  }

  const windowGrid = useMemo(() => {
    return floatingWindows.map((win, index) => {
      const offset = index * 24
      return {
        ...win,
        style: {
          transform: `translate(${offset}px, ${offset}px)`
        }
      }
    })
  }, [floatingWindows])

  const handleClose = (event: MouseEvent<HTMLButtonElement>, id: string) => {
    event.stopPropagation()
    setFloatingWindows((prev) => prev.filter((win) => win.id !== id))
  }

  const handleAddWindow = () => {
    const nextIndex = floatingWindows.length + 1
    setFloatingWindows((prev) => [
      ...prev,
      {
        id: `window-${nextIndex}`,
        title: `Mock workspace ${nextIndex}`,
        content: 'Drop actual chat UI here'
      }
    ])
  }

  return (
    <div className="floating-mic">
      <div className="floating-mic-panel">
        <div className="floating-mic-status">
          <span className={`mic-indicator ${listening ? 'active' : ''}`} />
          <div>
            <p className="floating-mic-eyebrow">Voice control</p>
            <p className="floating-mic-command">{listening ? activeCommand : 'Tap to start listening'}</p>
          </div>
        </div>
        <div className="floating-mic-actions">
          <button type="button" className={`mic-button ${listening ? 'listening' : ''}`} onClick={handleMicClick}>
            {listening ? '● Listening' : '◉ Start'}
          </button>
          <button type="button" className="ghost" onClick={handleAddWindow}>
            + Window
          </button>
        </div>
      </div>

      <div className="floating-window-stack">
        {windowGrid.map((win) => (
          <article key={win.id} className="floating-window" style={win.style}>
            <header>
              <h3>{win.title}</h3>
              <div className="window-actions">
                <button type="button" aria-label="Minimize">−</button>
                <button type="button" aria-label="Close" onClick={(event) => handleClose(event, win.id)}>
                  ×
                </button>
              </div>
            </header>
            <div className="floating-window-body">
              <p>{win.content}</p>
              <div className="floating-window-footer">
                <span className="badge">Mock mode</span>
                <button type="button" className="link-button">
                  Attach…
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}

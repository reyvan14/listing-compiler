import { FormEvent, useState } from 'react'
import { postJson, toSafeMessage } from './apiClient'
import styles from './stationChrome.module.scss'

type ChatItem = { role: 'user' | 'assistant'; text: string; error?: boolean }

async function askAgent(messages: ChatItem[]): Promise<string> {
  const data = await postJson<{ reply?: string }>(
    '/api/agent/chat',
    { messages: messages.map(item => ({ role: item.role, content: item.text })) },
    { timeoutMs: 45_000 },
  )
  if (!data.reply) throw new Error('empty reply')
  return data.reply
}

const GREETING: ChatItem = {
  role: 'assistant',
  text: '我在右侧。可以问上新规则、帮你改提示词，或一起看三台检查。不自动上架，也不登广告账户。',
}

export function StationAgent({
  collapsed,
  onToggle,
}: {
  collapsed: boolean
  onToggle: () => void
}) {
  const [items, setItems] = useState<ChatItem[]>([GREETING])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [lastUserText, setLastUserText] = useState('')

  const send = async (text: string) => {
    const history: ChatItem[] = [...items, { role: 'user', text }]
    setItems(history)
    setLastUserText(text)
    setBusy(true)
    try {
      const reply = await askAgent(history)
      setItems([...history, { role: 'assistant', text: reply }])
    } catch (err) {
      setItems([...history, { role: 'assistant', text: toSafeMessage(err), error: true }])
    } finally {
      setBusy(false)
    }
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    const text = draft.trim()
    if (!text || busy) return
    setDraft('')
    void send(text)
  }

  const retry = () => {
    if (busy || !lastUserText) return
    void send(lastUserText)
  }

  if (collapsed) {
    return (
      <div className={styles.agentCollapsed}>
        <button type="button" title="展开 Agent" aria-label="展开 Agent 面板" onClick={onToggle}>
          Agent ▸
        </button>
      </div>
    )
  }

  const lastIsError = items.at(-1)?.error === true

  return (
    <aside className={styles.agent} aria-label="Agent 对话">
      <header className={styles.agentHead}>
        <strong>Agent</strong>
        <div className={styles.agentHeadBtns}>
          <button
            type="button"
            title="新对话"
            aria-label="新对话"
            onClick={() => {
              setItems([GREETING])
              setLastUserText('')
            }}
          >
            +
          </button>
          <button type="button" title="收起 Agent" aria-label="收起 Agent 面板" onClick={onToggle}>
            ◂
          </button>
        </div>
      </header>
      <div className={styles.agentLog}>
        {items.map((item, i) => (
          <div
            key={`${item.role}-${i}`}
            className={
              item.role === 'user' ? styles.user : item.error ? styles.botError : styles.bot
            }
          >
            {item.text}
          </div>
        ))}
        {busy && <div className={styles.bot}>在想…</div>}
        {lastIsError && !busy && (
          <button type="button" className={styles.agentRetry} onClick={retry}>
            重试
          </button>
        )}
      </div>
      <form className={styles.agentInput} onSubmit={onSubmit}>
        <textarea
          rows={3}
          value={draft}
          placeholder="问上新规则，或让我帮你改提示词"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              onSubmit(e)
            }
          }}
        />
        <button type="submit" disabled={busy || !draft.trim()}>
          发送
        </button>
      </form>
    </aside>
  )
}

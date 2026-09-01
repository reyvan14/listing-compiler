import { FormEvent, useState } from 'react'
import styles from './stationChrome.module.scss'

type ChatItem = { role: 'user' | 'assistant'; text: string }

async function askAgent(messages: ChatItem[]): Promise<string> {
  const res = await fetch('/api/agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: messages.map(item => ({ role: item.role, content: item.text })),
    }),
  })
  const json = (await res.json().catch(() => null)) as {
    code?: number
    message?: string
    data?: { reply?: string }
  } | null
  if (!res.ok || !json || json.code !== 0 || !json.data?.reply) {
    throw new Error(json?.message || `agent ${res.status}`)
  }
  return json.data.reply
}

export function StationAgent() {
  const [items, setItems] = useState<ChatItem[]>([
    {
      role: 'assistant',
      text: '我在右侧。可以问上新规则、帮你改提示词，或一起看三台检查。不自动上架，也不登广告账户。',
    },
  ])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const text = draft.trim()
    if (!text || busy) return
    const next = [...items, { role: 'user' as const, text }]
    setItems(next)
    setDraft('')
    setBusy(true)
    try {
      const reply = await askAgent(next)
      setItems([...next, { role: 'assistant', text: reply }])
    } catch (err) {
      const msg = err instanceof Error ? err.message : '对话失败'
      setItems([...next, { role: 'assistant', text: msg }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className={styles.agent} aria-label="Agent 对话">
      <header className={styles.agentHead}>
        <strong>Agent</strong>
        <button
          type="button"
          title="新对话"
          onClick={() =>
            setItems([
              {
                role: 'assistant',
                text: '新开一轮。问规则、改提示词，或看三台检查即可。',
              },
            ])
          }
        >
          +
        </button>
      </header>
      <div className={styles.agentLog}>
        {items.map((item, i) => (
          <div key={`${item.role}-${i}`} className={item.role === 'user' ? styles.user : styles.bot}>
            {item.text}
          </div>
        ))}
        {busy && <div className={styles.bot}>在想…</div>}
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
              void onSubmit(e)
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

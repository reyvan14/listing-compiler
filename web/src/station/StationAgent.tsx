import { FormEvent, useCallback, useMemo, useRef, useState } from 'react'
import type { Editor } from 'tldraw'
import { toSafeMessage } from './apiClient'
import styles from './stationChrome.module.scss'
import { AgentPlanCard } from './agent/AgentPlanCard'
import { AgentPreviewLayer } from './agent/AgentPreviewLayer'
import { askAgent, type AgentTurn } from './agent/agentApi'
import { applyPlan, focusAgentNodes, runAgentNodes, type ApplyResult } from './agent/apply'
import { buildCanvasContext, nodeDisplayNames } from './agent/canvasContext'
import { fetchFacts } from './evidenceApi'
import { validatePlan } from './agent/validate'
import type { AgentPlan, PlanState } from './agent/types'

// The Agent proposes; the canvas is changed only by an explicit click here.
//
// Every claim this panel makes is written AFTER the corresponding operation
// actually succeeded — there is no code path that reports "已应用" before
// applyPlan() has returned.

type ChatItem =
  | { kind: 'text'; role: 'user' | 'assistant'; text: string; error?: boolean }
  | { kind: 'plan'; role: 'assistant'; planId: string }
  | {
      kind: 'activity'
      role: 'assistant'
      text: string
      planId: string
      nodeIds: string[]
      runNodeIds: string[]
      undone?: boolean
    }

type PlanRecord = {
  plan: AgentPlan
  state: PlanState
  errors?: string[]
  applied?: ApplyResult
}

const GREETING: ChatItem = {
  kind: 'text',
  role: 'assistant',
  text:
    '我可以直接改画布，但每一步都先给你一份变更计划，你点了「应用」才会动。\n生成要再确认一次。不自动上架，也不登广告账户。',
}

const QUICK_ACTIONS = [
  '为这个 SKU 创建三台完整上新工作流',
  '给主图节点补一条白底提示词',
  '把没有证据支撑的宣称从卖点里去掉',
  '连接选中的两个节点',
]

export function StationAgent({
  editor,
  collapsed,
  onToggle,
}: {
  editor: Editor | null
  collapsed: boolean
  onToggle: () => void
}) {
  const [items, setItems] = useState<ChatItem[]>([GREETING])
  const [plans, setPlans] = useState<Record<string, PlanRecord>>({})
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [lastUserText, setLastUserText] = useState('')
  const [previewPlanId, setPreviewPlanId] = useState<string | null>(null)
  // Index of the activity row whose "运行这些节点" is awaiting confirmation.
  // Generation costs money, so it never happens on a single click.
  const [confirmRunAt, setConfirmRunAt] = useState<number | null>(null)
  const planSeq = useRef(0)
  const applyingPlans = useRef(new Set<string>())
  const runningPlans = useRef(new Set<string>())

  const nodeNames = useMemo(
    () => (editor ? nodeDisplayNames(editor) : new Map<string, string>()),
    // Recomputed per render of the panel; cheap, and names change as the user edits.
    [editor, items],
  )

  const setPlanState = useCallback(
    (planId: string, patch: Partial<PlanRecord>) =>
      setPlans(prev => (prev[planId] ? { ...prev, [planId]: { ...prev[planId], ...patch } } : prev)),
    [],
  )

  const push = useCallback((item: ChatItem) => setItems(prev => [...prev, item]), [])

  /** Counts only — the Agent gets no document text, and never invents one. */
  const evidenceSummary = useCallback(async () => {
    try {
      const facts = await fetchFacts()
      return {
        verified: facts.filter(f => f.state === 'verified').length,
        needsReview: facts.filter(f => f.state === 'needs_review').length,
        conflicting: facts.filter(f => f.state === 'conflicting').length,
        unsupported: facts.filter(f => f.state === 'unsupported' || f.state === 'expired').length,
      }
    } catch {
      // The ledger being unreachable must not block the conversation.
      return undefined
    }
  }, [])

  const send = async (text: string) => {
    const history: ChatItem[] = [...items, { kind: 'text', role: 'user', text }]
    setItems(history)
    setLastUserText(text)
    setBusy(true)
    try {
      const turns: AgentTurn[] = history
        .filter((item): item is Extract<ChatItem, { kind: 'text' }> => item.kind === 'text')
        .map(item => ({ role: item.role, content: item.text }))
      const context = buildCanvasContext(editor, await evidenceSummary())
      const { reply, plan } = await askAgent(turns, context)

      const next: ChatItem[] = [...history, { kind: 'text', role: 'assistant', text: reply }]
      if (plan) {
        planSeq.current += 1
        const planId = `plan-${planSeq.current}`
        const withId = { ...plan, id: planId }
        // Validate on arrival so the card can say up front that it cannot run,
        // instead of failing after the user commits to it.
        const check = editor ? validatePlan(editor, withId) : null
        setPlans(prev => ({
          ...prev,
          [planId]: {
            plan: withId,
            state: check && !check.ok ? 'invalid' : 'proposed',
            errors: check && !check.ok ? check.errors : undefined,
          },
        }))
        next.push({ kind: 'plan', role: 'assistant', planId })
      }
      setItems(next)
    } catch (err) {
      setItems([
        ...history,
        { kind: 'text', role: 'assistant', text: toSafeMessage(err), error: true },
      ])
    } finally {
      setBusy(false)
    }
  }

  /** Apply, then (optionally) run. Only reports what actually happened. */
  const apply = async (planId: string, thenRun: boolean) => {
    const record = plans[planId]
    if (!record || !editor || applyingPlans.current.has(planId)) return
    applyingPlans.current.add(planId)
    setPreviewPlanId(current => (current === planId ? null : current))
    setPlanState(planId, { state: 'applying', errors: undefined })

    let result: ApplyResult
    try {
      result = applyPlan(editor, record.plan)
    } catch (err) {
      setPlanState(planId, { state: 'failed', errors: [toSafeMessage(err)] })
      push({
        kind: 'text',
        role: 'assistant',
        text: '这次改动没有应用，画布保持原样。',
        error: true,
      })
      applyingPlans.current.delete(planId)
      return
    }

    const touched = [...result.createdNodeIds, ...result.updatedNodeIds]
    const nodesToRun = result.runNodeIds.length ? result.runNodeIds : touched
    setPlanState(planId, { state: 'applied', applied: result })
    push({
      kind: 'activity',
      role: 'assistant',
      planId,
      nodeIds: touched,
      runNodeIds: nodesToRun,
      text: `已应用到画布：新建 ${result.createdNodeIds.length} 个节点，修改 ${result.updatedNodeIds.length} 个，连接 ${result.connectionIds.length} 条。尚未生成任何内容。`,
    })

    if (!thenRun) {
      applyingPlans.current.delete(planId)
      return
    }
    try {
      await run(planId, nodesToRun)
    } finally {
      applyingPlans.current.delete(planId)
    }
  }

  const run = async (planId: string, nodeIds: string[]) => {
    if (!editor || nodeIds.length === 0 || runningPlans.current.has(planId)) return
    runningPlans.current.add(planId)
    setPlanState(planId, { state: 'running' })
    try {
      await runAgentNodes(editor, nodeIds)
      setPlanState(planId, { state: 'completed' })
      push({
        kind: 'text',
        role: 'assistant',
        text: '已触发这些节点的生成。结果以节点上的真实状态为准，我不代替节点报成功。',
      })
    } catch (err) {
      setPlanState(planId, { state: 'failed', errors: [toSafeMessage(err)] })
      push({ kind: 'text', role: 'assistant', text: toSafeMessage(err), error: true })
    } finally {
      runningPlans.current.delete(planId)
    }
  }

  const undo = (planId: string, itemIndex: number) => {
    const record = plans[planId]
    if (!record?.applied || runningPlans.current.has(planId)) return
    record.applied.undo()
    setPlanState(planId, { state: 'cancelled', applied: undefined })
    setItems(prev =>
      prev.map((item, i) =>
        i === itemIndex && item.kind === 'activity' ? { ...item, undone: true } : item,
      ),
    )
    push({ kind: 'text', role: 'assistant', text: '已撤销这次改动，画布回到应用前的状态。' })
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    const text = draft.trim()
    if (!text || busy) return
    setDraft('')
    void send(text)
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

  const lastIsError = items.at(-1)?.kind === 'text' && (items.at(-1) as { error?: boolean }).error
  const previewPlan = previewPlanId ? plans[previewPlanId]?.plan : null
  let latestUndoableActivity = -1
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (
      item.kind === 'activity' &&
      !item.undone &&
      Boolean(plans[item.planId]?.applied)
    ) {
      latestUndoableActivity = i
      break
    }
  }

  return (
    <>
      {editor && previewPlan && <AgentPreviewLayer editor={editor} plan={previewPlan} />}
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
                setPlans({})
                setPreviewPlanId(null)
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
          {items.map((item, i) => {
            if (item.kind === 'plan') {
              const record = plans[item.planId]
              if (!record) return null
              return (
                <AgentPlanCard
                  key={`plan-${item.planId}`}
                  plan={record.plan}
                  state={previewPlanId === item.planId ? 'previewing' : record.state}
                  errors={record.errors}
                  nodeNames={nodeNames}
                  onPreview={() => setPreviewPlanId(item.planId)}
                  onStopPreview={() => setPreviewPlanId(null)}
                  onApply={() => void apply(item.planId, false)}
                  onApplyAndRun={() => void apply(item.planId, true)}
                  onCancel={() => {
                    setPreviewPlanId(current => (current === item.planId ? null : current))
                    setPlanState(item.planId, { state: 'cancelled' })
                  }}
                />
              )
            }

            if (item.kind === 'activity') {
              const record = plans[item.planId]
              const canRun = !item.undone && (record?.state === 'applied' || record?.state === 'failed')
              const canUndo = !item.undone && i === latestUndoableActivity && record?.state !== 'running'
              return (
                <div key={`activity-${i}`} className={styles.bot}>
                  {item.undone ? '这次改动已被撤销。' : item.text}
                  {!item.undone && (
                    <div className={styles.activityBtns}>
                      <button type="button" onClick={() => focusAgentNodes(editor!, item.nodeIds)}>
                        定位改动
                      </button>
                      {canRun && item.runNodeIds.length > 0 && (
                        confirmRunAt === i ? (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setConfirmRunAt(null)
                                void run(item.planId, item.runNodeIds)
                              }}
                            >
                              确认运行（会调用模型）
                            </button>
                            <button type="button" onClick={() => setConfirmRunAt(null)}>
                              取消
                            </button>
                          </>
                        ) : (
                          <button type="button" onClick={() => setConfirmRunAt(i)}>
                            运行这些节点
                          </button>
                        )
                      )}
                      {canUndo && (
                        <button type="button" onClick={() => undo(item.planId, i)}>
                          撤销本次操作
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            }

            return (
              <div
                key={`${item.role}-${i}`}
                className={
                  item.role === 'user' ? styles.user : item.error ? styles.botError : styles.bot
                }
              >
                {item.text}
              </div>
            )
          })}
          {busy && <div className={styles.bot}>在想…</div>}
          {lastIsError && !busy && (
            <button
              type="button"
              className={styles.agentRetry}
              onClick={() => {
                if (!busy && lastUserText) void send(lastUserText)
              }}
            >
              重试
            </button>
          )}
        </div>

        {items.length <= 1 && (
          <div className={styles.quickActions} aria-label="快捷指令">
            {QUICK_ACTIONS.map(action => (
              <button
                key={action}
                type="button"
                disabled={busy}
                onClick={() => void send(action)}
              >
                {action}
              </button>
            ))}
          </div>
        )}

        <form className={styles.agentInput} onSubmit={onSubmit}>
          <textarea
            rows={3}
            value={draft}
            placeholder="描述你想在画布上做什么，我先给计划再动手"
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
    </>
  )
}

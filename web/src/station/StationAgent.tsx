import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useValue, type Editor } from 'tldraw'
import { toSafeMessage } from './apiClient'
import styles from './stationChrome.module.scss'
import { executionState } from '@/pipeline/execution/executionState'
import { findSkuShape, type SkuListingNode } from '@/pipeline/nodes/types/skuStation'
import { AgentPlanCard } from './agent/AgentPlanCard'
import { openMigrationCandidate } from '@/pipeline/nodes/types/migrationPanel'
import { skuProductId } from './useEvidenceGate'
import { actionErrorMessage, runAction, type ActionRun } from './agent/domainActions'
import { AgentPreviewLayer } from './agent/AgentPreviewLayer'
import { AgentTrace } from './agent/AgentTrace'
import { askAgent, streamAgent, type AgentTurn } from './agent/agentApi'
import { applyPlan, focusAgentNodes, runAgentNodes, type ApplyResult } from './agent/apply'
import { buildCanvasContext, nodeDisplayNames } from './agent/canvasContext'
import { fetchFacts } from './evidenceApi'
import { advanceTrace, type TraceEntry } from './agent/trace'
import { validatePlan } from './agent/validate'
import type { AgentPlan, PlanState } from './agent/types'

// The Agent proposes; the canvas is changed only by an explicit click here.
//
// Responses stream, so text appears as it is produced and the 执行过程 trace
// shows what the product is doing. Nothing about that changes the safety
// envelope: a plan is still only actionable once the complete, validated
// `plan` event has arrived, applying still needs a click, and generating still
// needs a second confirmation.

type ChatItem =
  | { kind: 'text'; role: 'user' | 'assistant'; text: string; error?: boolean }
  | { kind: 'stream'; role: 'assistant'; turnId: number }
  | {
      kind: 'trace'
      role: 'assistant'
      turnId: number
      entries: TraceEntry[]
      elapsedMs: number
      warnings: string[]
    }
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
  /** Outcome of each domain action in the plan, by index. */
  actionRuns?: Record<number, ActionRun>
}

/** The response currently streaming, if any. */
type LiveTurn = {
  id: number
  text: string
  trace: TraceEntry[]
  startedAt: number
  elapsedMs: number
  warnings: string[]
  error?: string
  retryable?: boolean
}

const GREETING: ChatItem = {
  kind: 'text',
  role: 'assistant',
  text:
    '我可以直接改画布，但每一步都先给你一份变更计划，你点了「应用」才会动。\n生成要再确认一次。不自动上架，也不登广告账户。',
}

const QUICK_ACTIONS = [
  '为这个 SKU 创建三平台完整工作流（含短视频）',
  '给主图节点补一条白底提示词',
  '把没有证据支撑的宣称从卖点里去掉',
  '连接选中的两个节点',
]

/** One line about what an action actually returned. Never more than the payload. */
function describeRun(run: ActionRun): string {
  const result = (run.result ?? {}) as Record<string, unknown>
  if (run.action === 'validate_listing') {
    const blockers = (result.blockers as string[] | undefined) ?? []
    return blockers.length > 0 ? `${blockers.length} 项阻断` : '无阻断项'
  }
  if (run.action === 'export_release_package') {
    return `${result.files} 个文件，已校验；未发布到任何平台`
  }
  if (run.action === 'build_migration_candidate' && result.candidate_id) {
    return `已生成迁移候选 ${result.candidate_id}`
  }
  if (result.readiness) return `就绪状态 ${result.readiness}`
  return '已返回结果'
}

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
  const [live, setLive] = useState<LiveTurn | null>(null)
  const [confirmRunAt, setConfirmRunAt] = useState<number | null>(null)
  /** Guards against a second click while one action request is in flight. */
  const actionBusy = useRef<Set<string>>(new Set())

  // The scope the evidence, review and media ledgers are keyed by, so a domain
  // action reads the same records the rest of the product is showing.
  const productId = useValue('agent product id', () => skuProductId(editor), [editor])

  const planSeq = useRef(0)
  const turnSeq = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  //: Guards a double-click on 发送 / a quick action: React state updates are
  //: async, so `busy` alone can let two sends through in the same tick.
  const sendingRef = useRef(false)
  //: Plans that have already been applied or run once. Re-entry here would
  //: duplicate nodes or spend a second round of model calls.
  const appliedRef = useRef(new Set<string>())
  const runningRef = useRef(new Set<string>())

  // Abort an in-flight stream if the panel unmounts.
  useEffect(() => () => abortRef.current?.abort(), [])

  const nodeNames = useMemo(
    () => (editor ? nodeDisplayNames(editor) : new Map<string, string>()),
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

  /** Register a validated plan and return the id the card will use. */
  const adoptPlan = useCallback(
    (plan: AgentPlan): string => {
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
      return planId
    },
    [editor],
  )

  const send = async (text: string) => {
    if (sendingRef.current) return
    sendingRef.current = true

    turnSeq.current += 1
    const turnId = turnSeq.current
    const startedAt = Date.now()

    const history: ChatItem[] = [...items, { kind: 'text', role: 'user', text }]
    setItems([...history, { kind: 'stream', role: 'assistant', turnId }])
    setLastUserText(text)
    setBusy(true)
    setLive({ id: turnId, text: '', trace: [], startedAt, elapsedMs: 0, warnings: [] })

    const controller = new AbortController()
    abortRef.current = controller

    const turns: AgentTurn[] = history
      .filter((item): item is Extract<ChatItem, { kind: 'text' }> => item.kind === 'text')
      .map(item => ({ role: item.role, content: item.text }))

    let planId: string | null = null
    let replyText = ''
    let traceEntries: TraceEntry[] = []
    let streamWarnings: string[] = []
    let streamError: { message: string; retryable: boolean } | null = null

    const settledTraceItem = (): ChatItem[] =>
      traceEntries.length > 0 || streamWarnings.length > 0
        ? [{
            kind: 'trace',
            role: 'assistant',
            turnId,
            entries: traceEntries,
            elapsedMs: Date.now() - startedAt,
            warnings: streamWarnings,
          }]
        : []

    try {
      const context = buildCanvasContext(editor, await evidenceSummary())
      const result = await streamAgent(
        turns,
        context,
        {
          onStatus: status => {
            traceEntries = advanceTrace(traceEntries, {
              ...status,
              at: Date.now() - startedAt,
            })
            setLive(prev =>
              prev && prev.id === turnId
                ? {
                    ...prev,
                    trace: traceEntries,
                  }
                : prev,
            )
          },
          onDelta: piece => {
            replyText += piece
            setLive(prev =>
              prev && prev.id === turnId ? { ...prev, text: prev.text + piece } : prev,
            )
          },
          onWarning: message => {
            streamWarnings = [...streamWarnings, message]
            setLive(prev =>
              prev && prev.id === turnId
                ? { ...prev, warnings: streamWarnings }
                : prev,
            )
          },
          onPlan: plan => {
            planId = adoptPlan(plan)
          },
          onError: error => {
            streamError = { message: error.message, retryable: error.retryable }
            traceEntries = advanceTrace(traceEntries, {
              stage: 'failed',
              detail: error.message,
              at: Date.now() - startedAt,
            })
            setLive(prev =>
              prev && prev.id === turnId
                ? {
                    ...prev,
                    trace: traceEntries,
                    error: error.message,
                    retryable: error.retryable,
                  }
                : prev,
            )
          },
        },
        controller.signal,
      )

      if (result.unsupported && !result.meaningful) {
        // Only reachable before anything was shown: the older endpoint answers
        // once, and the turn continues as if it had streamed.
        const fallback = await askAgent(turns, context)
        replyText = fallback.reply
        if (fallback.plan) planId = adoptPlan(fallback.plan)
      }

      setItems(prev => [
        ...prev.filter(item => !(item.kind === 'stream' && item.turnId === turnId)),
        ...settledTraceItem(),
        ...(replyText || !streamError
          ? [{ kind: 'text' as const, role: 'assistant' as const, text: replyText || '（无回复）' }]
          : []),
        ...(streamError
          ? [{
              kind: 'text' as const,
              role: 'assistant' as const,
              text: streamError.message,
              error: true,
            }]
          : []),
        ...(planId ? [{ kind: 'plan' as const, role: 'assistant' as const, planId }] : []),
      ])
    } catch (err) {
      const aborted = controller.signal.aborted
      traceEntries = advanceTrace(traceEntries, {
        stage: aborted ? 'cancelled' : 'failed',
        detail: aborted ? '用户停止了本次回复' : '流式连接未完成',
        at: Date.now() - startedAt,
      })
      setItems(prev => [
        ...prev.filter(item => !(item.kind === 'stream' && item.turnId === turnId)),
        ...settledTraceItem(),
        ...(replyText ? [{ kind: 'text' as const, role: 'assistant' as const, text: replyText }] : []),
        {
          kind: 'text' as const,
          role: 'assistant' as const,
          text: aborted ? '已停止。收到的内容保留在上面。' : toSafeMessage(err),
          error: !aborted,
        },
        ...(planId ? [{ kind: 'plan' as const, role: 'assistant' as const, planId }] : []),
      ])
    } finally {
      setLive(null)
      setBusy(false)
      sendingRef.current = false
      if (abortRef.current === controller) abortRef.current = null
    }
  }

  const stop = () => {
    abortRef.current?.abort()
  }

  /** Apply, then (optionally) run. Only reports what actually happened. */
  const apply = async (planId: string, thenRun: boolean) => {
    const record = plans[planId]
    if (!record || !editor) return
    // A second click while the first apply is in flight would duplicate nodes.
    if (appliedRef.current.has(planId)) return
    appliedRef.current.add(planId)
    setPreviewPlanId(current => (current === planId ? null : current))
    setPlanState(planId, { state: 'applying', errors: undefined })

    let result: ApplyResult
    try {
      result = applyPlan(editor, record.plan)
    } catch (err) {
      appliedRef.current.delete(planId)
      setPlanState(planId, { state: 'failed', errors: [toSafeMessage(err)] })
      push({
        kind: 'text',
        role: 'assistant',
        text: '这次改动没有应用，画布保持原样。',
        error: true,
      })
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
      text: `节点已创建并填好配置：新建 ${result.createdNodeIds.length} 个，修改 ${result.updatedNodeIds.length} 个，连接 ${result.connectionIds.length} 条。尚未生成任何内容，也未调用模型；要得到图片、视频和三平台文案，请点击下方「开始生成」。`,
    })
    // Applying a multi-node plan is an explicit navigation event. Frame the
    // whole changed group so the operator immediately sees the topology they
    // approved instead of finding new nodes off-screen.
    focusAgentNodes(editor, touched)

    if (!thenRun) {
      return
    }
    await run(planId, nodesToRun)
  }

  const run = async (planId: string, nodeIds: string[]) => {
    if (!editor || nodeIds.length === 0) return
    // Never start a second run for the same plan: it would spend the model
    // budget twice and race the first run's writes.
    if (runningRef.current.has(planId)) return
    runningRef.current.add(planId)
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
      runningRef.current.delete(planId)
    }
  }

  const undo = (planId: string, itemIndex: number) => {
    const record = plans[planId]
    if (!record?.applied || runningRef.current.has(planId)) return
    record.applied.undo()
    appliedRef.current.delete(planId)
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
    if (!text || busy || sendingRef.current) return
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
  /**
   * Run one typed domain action from an approved plan.
   *
   * The idempotency key is derived from the plan id and the action's position,
   * so it is stable across a re-render, a reconnect, or a user clicking twice:
   * the backend replays the first outcome instead of doing the work again. The
   * in-flight guard stops a double click from even reaching the network.
   */
  /**
   * Hand the operator to the panel that owns what an action produced.
   *
   * The Agent surface deliberately does not grow its own reviewer: a migration
   * candidate is reviewed in the migration panel, where the apply and rollback
   * gates already live.
   */
  const openActionResult = useCallback(
    (run: ActionRun) => {
      const result = (run.result ?? {}) as Record<string, unknown>
      if (editor && run.action === 'build_migration_candidate' && result.candidate_id) {
        openMigrationCandidate(editor, String(result.candidate_id))
      }
    },
    [editor],
  )

  const executeAction = useCallback(
    async (planId: string, index: number, confirmed: boolean) => {
      const record = plans[planId]
      const action = record?.plan.actions[index]
      if (!action) return

      const key = `${planId}:${index}:${action.action}`
      if (actionBusy.current.has(key)) return
      actionBusy.current.add(key)

      const setRun = (run: ActionRun) =>
        setPlans(prev => {
          const current = prev[planId]
          if (!current) return prev
          return {
            ...prev,
            [planId]: { ...current, actionRuns: { ...(current.actionRuns ?? {}), [index]: run } },
          }
        })

      try {
        let run = await runAction(action.action, action.params, key, '', productId)
        // A consequential action answers with its own token first; the user has
        // already confirmed in the card, so send it straight back.
        if (run.state === 'needs_confirmation' && confirmed && run.confirmation_token) {
          run = await runAction(
            action.action,
            action.params,
            key,
            run.confirmation_token,
            productId,
          )
        }
        setRun(run)
        if (run.state === 'ok') {
          setItems(prev => [
            ...prev,
            {
              kind: 'text' as const,
              role: 'assistant' as const,
              text: `已执行「${action.label}」：${describeRun(run)}`,
            },
          ])
        } else if (run.state !== 'needs_confirmation') {
          setItems(prev => [
            ...prev,
            {
              kind: 'text' as const,
              role: 'assistant' as const,
              text: run.message || '操作未成功。',
              error: true,
            },
          ])
        }
      } catch (err) {
        setRun({
          action: action.action,
          params: action.params,
          state: 'failed',
          message: actionErrorMessage(err),
          at: new Date().toISOString(),
          replayed: false,
        })
        setItems(prev => [
          ...prev,
          {
            kind: 'text' as const,
            role: 'assistant' as const,
            text: actionErrorMessage(err),
            error: true,
          },
        ])
      } finally {
        actionBusy.current.delete(key)
      }
    },
    [plans, productId],
  )

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
              disabled={busy}
              onClick={() => {
                setItems([GREETING])
                setPlans({})
                setPreviewPlanId(null)
                setLastUserText('')
                appliedRef.current.clear()
                runningRef.current.clear()
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
            if (item.kind === 'stream') {
              if (!live || live.id !== item.turnId) return null
              return (
                <div key={`stream-${item.turnId}`}>
                  <AgentTrace entries={live.trace} elapsedMs={live.elapsedMs} />
                  {live.text && <div className={styles.bot}>{live.text}</div>}
                  {live.warnings.map((warning, w) => (
                    <div key={w} className={styles.agentWarning}>
                      {warning}
                    </div>
                  ))}
                  {live.error && <div className={styles.botError}>{live.error}</div>}
                  {!live.text && !live.error && <div className={styles.bot}>正在回复…</div>}
                </div>
              )
            }

            if (item.kind === 'trace') {
              return (
                <div key={`trace-${item.turnId}`}>
                  <AgentTrace entries={item.entries} elapsedMs={item.elapsedMs} />
                  {item.warnings.map((warning, w) => (
                    <div key={w} className={styles.agentWarning}>
                      {warning}
                    </div>
                  ))}
                </div>
              )
            }

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
                  onApprove={() => setPlanState(item.planId, { state: 'applied' })}
                  actionRuns={record.actionRuns}
                  onRunAction={(index, confirmed) =>
                    void executeAction(item.planId, index, confirmed)
                  }
                  onOpenActionResult={openActionResult}
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
                  {record?.state === 'running' && editor && (
                    <GenerationProgress editor={editor} />
                  )}
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
                              确认生成（会调用模型）
                            </button>
                            <button type="button" onClick={() => setConfirmRunAt(null)}>
                              取消
                            </button>
                          </>
                        ) : (
                          <button type="button" onClick={() => setConfirmRunAt(i)}>
                            开始生成
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
          {lastIsError && !busy && (
            <button
              type="button"
              className={styles.agentRetry}
              onClick={() => {
                if (!busy && !sendingRef.current && lastUserText) void send(lastUserText)
              }}
            >
              重试
            </button>
          )}
        </div>

        {items.length <= 1 && !busy && (
          <div className={styles.quickActions} aria-label="快捷指令">
            {QUICK_ACTIONS.map(action => (
              <button key={action} type="button" onClick={() => void send(action)}>
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
          {busy ? (
            <button type="button" className={styles.agentStop} onClick={stop}>
              停止
            </button>
          ) : (
            <button type="submit" disabled={!draft.trim()}>
              发送
            </button>
          )}
        </form>
      </aside>
    </>
  )
}

/**
 * Real generation progress, read from the running ExecutionGraph.
 *
 * Counts nodes that have actually finished. There is no timer and no
 * fabricated percentage — if nothing has completed yet, it says 0.
 */
function GenerationProgress({ editor }: { editor: Editor }) {
  const progress = useValue(
    'agent generation progress',
    () => executionState.get(editor)?.runningGraph?.getModelProgress() ?? null,
    [editor],
  )
  if (!progress || progress.total === 0) return null
  return (
    <div className={styles.agentProgress} data-testid="agent-generation-progress">
      正在生成 {progress.done}/{progress.total}
    </div>
  )
}

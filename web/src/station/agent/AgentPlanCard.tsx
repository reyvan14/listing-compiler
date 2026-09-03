import { useState } from 'react';
import styles from './agentPlan.module.scss';
import { planCounts, planRows } from './planSummary';
import type { AgentPlan, PlanState } from './types';

// The approval surface. Everything the plan would do is spelled out here
// BEFORE anything touches the canvas — that is the whole point of the card, so
// it never summarises away an operation the user has not seen.

const STATE_LABEL: Record<PlanState, string> = {
  proposed: '待你确认',
  invalid: '无法执行',
  previewing: '预览中',
  applying: '正在应用…',
  applied: '已应用到画布',
  running: '正在运行…',
  completed: '已运行完成',
  failed: '未应用',
  cancelled: '已取消',
};

const STATE_CLASS: Partial<Record<PlanState, string>> = {
  invalid: styles.stateInvalid,
  applying: styles.stateApplying,
  applied: styles.stateApplied,
  running: styles.stateRunning,
  completed: styles.stateCompleted,
  failed: styles.stateFailed,
};

export type AgentPlanCardProps = {
  plan: AgentPlan;
  state: PlanState;
  /** Validation errors. Present when `state === 'invalid'` or an apply failed. */
  errors?: string[];
  /** Canvas node id → display name, for readable references. */
  nodeNames: Map<string, string>;
  onPreview: () => void;
  onStopPreview: () => void;
  onApply: () => void;
  onApplyAndRun: () => void;
  onCancel: () => void;
};

export function AgentPlanCard({
  plan,
  state,
  errors,
  nodeNames,
  onPreview,
  onStopPreview,
  onApply,
  onApplyAndRun,
  onCancel,
}: AgentPlanCardProps) {
  const [confirmingRun, setConfirmingRun] = useState(false);
  const rows = planRows(plan, nodeNames);
  const counts = planCounts(plan);
  const busy = state === 'applying' || state === 'running';
  const settled =
    state === 'applied' || state === 'completed' || state === 'cancelled' || state === 'invalid';

  return (
    <section className={styles.card} aria-label="Agent 变更计划" data-plan-state={state}>
      <div className={styles.cardHead}>
        <span className={styles.cardTitle}>{plan.title}</span>
        <span className={`${styles.state} ${STATE_CLASS[state] ?? ''}`} data-testid="plan-state">
          {STATE_LABEL[state]}
        </span>
      </div>

      <p className={styles.summary}>{plan.summary}</p>

      <ul className={styles.rows}>
        {rows.map((row, i) => (
          <li
            key={`${row.kind}-${i}`}
            className={`${styles.row} ${row.kind === 'run' ? styles.rowRun : ''}`}
          >
            <span className={styles.rowLabel}>{row.label}</span>
            <span className={styles.rowDetail}>{row.detail}</span>
          </li>
        ))}
      </ul>

      <p className={styles.meta}>
        新建 {counts.created} · 修改 {counts.updated} · 连接 {counts.connections} · 预计模型调用{' '}
        {plan.estimatedModelCalls} 次
        {plan.estimatedModelCalls === 0 ? '（仅写字段，不生成）' : ''}
      </p>

      {plan.warnings.length > 0 && (
        <ul className={styles.warnings} aria-label="计划提示">
          {plan.warnings.map((warning, i) => (
            <li key={i}>{warning}</li>
          ))}
        </ul>
      )}

      {errors && errors.length > 0 && (
        <ul className={styles.errors} aria-label="计划错误">
          {errors.map((error, i) => (
            <li key={i}>{error}</li>
          ))}
        </ul>
      )}

      {confirmingRun ? (
        <div className={styles.confirm} role="alertdialog" aria-label="确认运行">
          <p>
            将先创建并连接节点，再调用生成模型，预计 {plan.estimatedModelCalls} 次，可能产生费用。
            生成结果会留在画布中，不会发布到任何平台。
          </p>
          <div className={styles.confirmBtns}>
            <button
              type="button"
              className={styles.primary}
              onClick={() => {
                setConfirmingRun(false);
                onApplyAndRun();
              }}
            >
              确认创建并生成
            </button>
            <button type="button" onClick={() => setConfirmingRun(false)}>
              返回
            </button>
          </div>
        </div>
      ) : (
        !settled && (
          <div className={styles.actions}>
            {state === 'previewing' ? (
              <button type="button" onClick={onStopPreview} disabled={busy}>
                结束预览
              </button>
            ) : (
              <button type="button" onClick={onPreview} disabled={busy}>
                在画布预览
              </button>
            )}
            {(plan.estimatedModelCalls > 0 || counts.runs > 0) && (
              <button
                type="button"
                className={styles.primary}
                onClick={() => setConfirmingRun(true)}
                disabled={busy}
              >
                创建并生成
              </button>
            )}
            <button type="button" onClick={onApply} disabled={busy}>
              仅创建节点
            </button>
            <button type="button" onClick={onCancel} disabled={busy}>
              取消
            </button>
          </div>
        )
      )}
    </section>
  );
}

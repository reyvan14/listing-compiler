import { useState } from 'react';
import styles from './agentPlan.module.scss';
import { NODE_LABELS } from './planSummary';
import type { AgentNodeType, PlanRationale } from './types';

// 为什么这样规划 — a collapsed, structured account of the planning decision.
//
// It renders only typed fields the backend derived from the validated plan:
// detected intent, platforms, which planner produced it, what each node is
// for, ratios and durations, warnings, cost, and the standing fact that the
// workflow publishes nothing. It is not, and cannot become, model reasoning —
// there is no free-text field in the payload for reasoning to arrive in.

const SOURCE_LABEL: Record<PlanRationale['source'], string> = {
  template: '经过审计的确定性模板',
  model: '模型生成，已通过允许清单校验',
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.whyRow}>
      <span className={styles.whyLabel}>{label}</span>
      <span className={styles.whyValue}>{children}</span>
    </div>
  );
}

export function PlanRationaleSection({ rationale }: { rationale: PlanRationale }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={styles.why}>
      <button
        type="button"
        className={styles.whyToggle}
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        为什么这样规划
        <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className={styles.whyBody} data-testid="plan-rationale">
          {rationale.intent.length > 0 && (
            <Row label="识别到的意图">{rationale.intent.join('、')}</Row>
          )}
          {rationale.platforms.length > 0 && (
            <Row label="选定平台">{rationale.platforms.join('、')}</Row>
          )}
          <Row label="规划来源">{SOURCE_LABEL[rationale.source]}</Row>

          {rationale.nodes.length > 0 && (
            <Row label="节点与用途">
              <ul className={styles.whyList}>
                {rationale.nodes.map(node => (
                  <li key={node.ref}>
                    {NODE_LABELS[node.nodeType as AgentNodeType] ?? node.nodeType}
                    {node.aspectRatio ? ` · ${node.aspectRatio}` : ''}
                    {node.duration ? ` · ${node.duration}` : ''} — {node.purpose}
                  </li>
                ))}
              </ul>
            </Row>
          )}

          <Row label="改动规模">
            新建 {rationale.nodeCount} · 修改 {rationale.updatedNodeCount} · 连接{' '}
            {rationale.connectionCount}
          </Row>

          {rationale.warnings.length > 0 && (
            <Row label="证据 / 合规提示">
              <ul className={styles.whyList}>
                {rationale.warnings.map((warning, i) => (
                  <li key={i}>{warning}</li>
                ))}
              </ul>
            </Row>
          )}

          <Row label="预计模型调用">
            {rationale.estimatedModelCalls} 次
            {rationale.estimatedModelCalls === 0 ? '（仅写字段，不生成）' : ''}
          </Row>
          <Row label="是否需要二次确认">
            {rationale.requiresRunConfirmation ? '需要，生成前会再问一次' : '不需要，本计划不生成内容'}
          </Row>
          <Row label="发布行为">
            {rationale.publishes ? '会发布' : '不发布'}
            {rationale.publishNote ? ` — ${rationale.publishNote}` : ''}
          </Row>
        </div>
      )}
    </div>
  );
}

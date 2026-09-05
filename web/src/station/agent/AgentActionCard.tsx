import { useState } from 'react';
import type { AgentPlanAction } from './types';
import type { ActionRun } from './domainActions';
import styles from './agentActions.module.scss';

// Domain actions inside an approved Agent plan.
//
// Approving a plan and confirming an action are separate decisions, and the UI
// keeps them separate: a read-only action runs on approval, while anything that
// approves, exports, migrates or spends money asks again with its own prompt.
//
// Every label here comes from the local action spec, never from the model's
// payload, so a hostile plan cannot describe a paid action as free.

/** Human-readable target, assembled from the typed parameters only. */
export function describeTarget(action: AgentPlanAction): string {
  const params = action.params as Record<string, unknown>;
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
    .map(([k, v]) => `${TARGET_LABEL[k] ?? k} ${Array.isArray(v) ? v.join('、') : String(v)}`);
  return parts.join(' · ') || '（无参数）';
}

const TARGET_LABEL: Record<string, string> = {
  revision_id: '修订',
  asset_id: '图片',
  passport_id: '护照',
  sku_id: 'SKU',
  platform: '平台',
  base: '基线快照',
  candidate: '候选快照',
  source_id: '证据',
  import_id: '导入',
  hypothesis: '假设',
  baseline_revision_id: '基线修订',
  candidate_revision_id: '候选修订',
  fields: '字段',
};

/** What the action will read, stated per action rather than guessed. */
const READS: Record<string, string> = {
  validate_listing: '读取该修订的文案与当前政策快照',
  inspect_image: '读取该图片资产的字节与检查记录',
  open_release_passport: '读取已存在的发布护照',
  build_release_passport: '读取修订、证据、图片检查与政策快照',
  export_release_package: '读取护照及其引用的全部实体',
  analyze_policy_impact: '读取两份政策快照',
  build_migration_candidate: '读取政策差异与受影响的产物',
  open_evidence_source: '读取该证据文件的元数据与关联事实',
  analyze_feedback: '读取该次导入的表现数据',
  create_experiment: '写入一条实验记录',
};

const RESULTS: Record<string, string> = {
  validate_listing: '阻断项与提醒项清单',
  inspect_image: '像素检查结论与校验和',
  open_release_passport: '护照就绪状态与未决项',
  build_release_passport: '新的护照就绪状态',
  export_release_package: '已校验的交接包摘要',
  analyze_policy_impact: '新增 / 移除 / 变更的规则',
  build_migration_candidate: '候选补丁 ID 与受影响字段',
  open_evidence_source: '证据元数据与关联事实',
  analyze_feedback: '观测信号与候选改进项',
  create_experiment: '实验记录 ID',
};

export function AgentActionCard({
  action,
  run,
  busy,
  planApproved,
  onExecute,
}: {
  action: AgentPlanAction;
  run: ActionRun | null;
  busy: boolean;
  planApproved: boolean;
  onExecute: (confirmed: boolean) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const settled = run?.state === 'ok';
  const needsSecond = action.requiresConfirmation;

  return (
    <li
      className={styles.action}
      data-testid="agent-action"
      data-action={action.action}
      data-state={run?.state ?? 'proposed'}
    >
      <div className={styles.head}>
        <b>{action.label}</b>
        {action.readOnly ? (
          <span className={styles.tag} data-tone="ok">
            只读
          </span>
        ) : (
          <span className={styles.tag} data-tone="warn">
            会改动状态
          </span>
        )}
        {action.costsMoney && (
          <span className={styles.tag} data-tone="danger" data-testid="agent-action-paid">
            可能产生费用
          </span>
        )}
        {needsSecond && (
          <span className={styles.tag} data-tone="warn">
            需二次确认
          </span>
        )}
      </div>

      <p className={styles.summary}>{action.summary}</p>
      <dl className={styles.detail}>
        <div>
          <dt>目标</dt>
          <dd data-testid="agent-action-target">{describeTarget(action)}</dd>
        </div>
        <div>
          <dt>会读取</dt>
          <dd>{READS[action.action] ?? '该操作声明的记录'}</dd>
        </div>
        <div>
          <dt>预期结果</dt>
          <dd>{RESULTS[action.action] ?? '操作的真实返回结果'}</dd>
        </div>
      </dl>

      {run && run.state !== 'needs_confirmation' && (
        <p
          className={run.state === 'ok' ? styles.ok : styles.bad}
          data-testid="agent-action-result"
        >
          {run.state === 'ok'
            ? `已执行${run.replayed ? '（重复请求，返回首次结果）' : ''}：${summarise(run)}`
            : run.message || '操作未成功。'}
        </p>
      )}

      {!settled && planApproved && (
        <div className={styles.actions}>
          {!needsSecond ? (
            <button
              type="button"
              disabled={busy}
              data-testid="agent-action-run"
              onClick={() => onExecute(false)}
            >
              执行
            </button>
          ) : confirming ? (
            <div className={styles.confirm} role="alertdialog" data-testid="agent-action-confirm">
              <b>{action.confirmPrompt || '该操作需要单独确认。'}</b>
              <div className={styles.confirmBtns}>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={busy}
                  data-testid="agent-action-confirm-yes"
                  onClick={() => {
                    setConfirming(false);
                    onExecute(true);
                  }}
                >
                  确认执行
                </button>
                <button
                  type="button"
                  disabled={busy}
                  data-testid="agent-action-confirm-no"
                  onClick={() => setConfirming(false)}
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={busy}
              data-testid="agent-action-request"
              onClick={() => setConfirming(true)}
            >
              执行（需确认）
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** One line about what really came back. Never a claim beyond the payload. */
function summarise(run: ActionRun): string {
  const result = (run.result ?? {}) as Record<string, unknown>;
  if (run.action === 'validate_listing') {
    const blockers = (result.blockers as string[] | undefined) ?? [];
    const warnings = (result.warnings as string[] | undefined) ?? [];
    return `${blockers.length} 项阻断 / ${warnings.length} 项提醒`;
  }
  if (run.action === 'export_release_package') {
    return `${result.files} 个文件 · 摘要 ${String(result.digest ?? '').slice(0, 12)}… · 未发布到任何平台`;
  }
  if (run.action === 'build_release_passport' || run.action === 'open_release_passport') {
    return `就绪状态 ${result.readiness}`;
  }
  if (run.action === 'inspect_image') {
    const summary = (result.summary ?? {}) as Record<string, unknown>;
    return summary.blocked ? '存在阻断项' : '可机械判定项均通过';
  }
  if (run.action === 'analyze_policy_impact') {
    const changed = (result.changed as string[] | undefined) ?? [];
    const added = (result.added as string[] | undefined) ?? [];
    return `新增 ${added.length} 条 · 变更 ${changed.length} 条`;
  }
  if (run.action === 'build_migration_candidate') {
    return result.candidate_id
      ? `候选 ${result.candidate_id}`
      : String(result.note ?? '未生成候选');
  }
  if (run.action === 'analyze_feedback') {
    const signals = (result.signals as unknown[] | undefined) ?? [];
    return `${signals.length} 个观测信号`;
  }
  if (run.action === 'create_experiment') {
    return `实验 ${result.experiment_id}`;
  }
  return '已返回结果';
}

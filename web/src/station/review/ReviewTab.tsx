import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ListingResultNode } from '@/pipeline/nodes/types/skuStation';
import {
  REVISION_STATE_META,
  acknowledgeWarnings,
  approveRevision,
  createRevision,
  fetchDiff,
  fetchRevision,
  requestChanges,
  reviewErrorMessage,
  rollbackTo,
  saveDraft,
  submitForValidation,
  type Revision,
  type RevisionContent,
  type RevisionDiff,
  type RevisionView,
} from './reviewApi';
import {
  DIFF_STATUS_LABEL,
  GROUP_LABEL,
  changedRows,
  diffContent,
  groupFields,
  nodeToContent,
  sameContent,
  withFieldValue,
} from './reviewModel';
import styles from './reviewTab.module.scss';

// The review tab of the detail inspector.
//
// Everything rendered here is read back from the server after each action --
// there is no optimistic local state pretending an approval happened. The tab
// only reads the canvas shape (to register the generated copy as revision 1);
// it never writes to the editor, so opening or closing it cannot move a node
// or nudge the camera.

const OPERATOR_KEY = 'listing.review.operator.v1';

function readOperator(): string {
  try {
    return localStorage.getItem(OPERATOR_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeOperator(value: string) {
  try {
    localStorage.setItem(OPERATOR_KEY, value);
  } catch {
    /* private mode — the field simply will not persist */
  }
}

type Busy = '' | 'loading' | 'save' | 'validate' | 'approve' | 'changes' | 'rollback' | 'ack';

/** The SKU source of truth the revision is graded against. */
export type SkuSource = {
  skuId: string;
  productName: string;
  points: string;
  assetMode: string;
};

export function ReviewTab({
  node,
  sku,
  productId,
}: {
  node: ListingResultNode;
  sku: SkuSource;
  productId: string;
}) {
  const [view, setView] = useState<RevisionView | null>(null);
  const [buffer, setBuffer] = useState<RevisionContent | null>(null);
  const [operator, setOperator] = useState(readOperator);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<Busy>('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [diff, setDiff] = useState<RevisionDiff | null>(null);
  const [ackChoice, setAckChoice] = useState<string[]>([]);
  const mounted = useRef(true);

  const generated = useMemo(() => nodeToContent(node), [node]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(
    async (revisionId: string) => {
      const next = await fetchRevision(revisionId, productId);
      if (!mounted.current) return;
      setView(next);
      setBuffer(next.revision.content);
      setAckChoice([]);
      setDiff(null);
    },
    [productId],
  );

  // Register the generated copy as revision 1, once per sku+platform.
  //
  // The endpoint is idempotent on identical content, so this cannot manufacture
  // history. The guard matters for a different reason: this component re-renders
  // whenever the canvas emits a signal, and re-bootstrapping would drag the
  // reviewer back to revision 1 — discarding the candidate they had open and any
  // unsaved edit in it.
  const bootstrapped = useRef('');
  const key = `${sku.skuId}|${node.platform}`;

  useEffect(() => {
    if (bootstrapped.current === key) return;
    bootstrapped.current = key;

    let cancelled = false;
    setBusy('loading');
    setError('');
    createRevision(
      {
        sku_id: sku.skuId,
        platform: node.platform,
        content: generated,
        // the same inputs generation used, so the checker grades like-for-like
        product_name: sku.productName,
        points: sku.points,
        asset_mode: sku.assetMode,
        generator: { source: 'canvas' },
      },
      productId,
    )
      .then(revision => (cancelled ? null : load(revision.revision_id)))
      .catch(err => {
        if (!cancelled) {
          // let a retry happen if the tab is reopened
          bootstrapped.current = '';
          setError(reviewErrorMessage(err));
        }
      })
      .finally(() => {
        if (!cancelled) setBusy('');
      });
    return () => {
      cancelled = true;
    };
    // `generated` and the sku details are read at bootstrap time only; see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, productId, load]);

  const revision = view?.revision ?? null;
  const validation = view?.validation ?? null;
  const dirty = !!(revision && buffer && !sameContent(revision.content, buffer));

  const run = useCallback(
    async (kind: Busy, action: () => Promise<RevisionView | Revision>, done: string) => {
      setBusy(kind);
      setError('');
      setNotice('');
      try {
        const result = await action();
        const id = 'revision' in result ? result.revision.revision_id : result.revision_id;
        await load(id);
        if (mounted.current) setNotice(done);
      } catch (err) {
        if (mounted.current) setError(reviewErrorMessage(err));
        // Re-read: a refused approval still records a fresh validation result,
        // and the operator needs to see the blockers that caused the refusal.
        if (revision) await load(revision.revision_id).catch(() => undefined);
      } finally {
        if (mounted.current) setBusy('');
      }
    },
    [load, revision],
  );

  if (busy === 'loading' && !view) {
    return <p className={styles.muted}>正在读取审核状态…</p>;
  }
  if (!revision || !buffer) {
    return (
      <div className={styles.stack}>
        {error && (
          <p className={styles.error} role="alert" data-testid="review-error">
            {error}
          </p>
        )}
        {!error && <p className={styles.muted}>暂无可审核的修订。</p>}
      </div>
    );
  }

  const meta = REVISION_STATE_META[revision.state];
  const blockers = validation?.checks.filter(c => c.blocking) ?? [];
  const warnings =
    validation?.checks.filter(c => !c.blocking && (validation.warnings ?? []).includes(c.id)) ?? [];
  const canApprove = revision.state === 'validated' && blockers.length === 0;
  const editable = revision.state === 'draft' || revision.state === 'needs_changes';
  const acknowledgedIds = new Set(
    (view?.acknowledgements ?? []).flatMap(a => a.warning_ids),
  );

  return (
    <div className={styles.stack} data-testid="review-tab">
      <section className={styles.block}>
        <div className={styles.blockHead}>
          <h3>当前修订</h3>
          <span
            className={styles.state}
            data-tone={meta.tone}
            data-state={revision.state}
            data-testid="review-state"
          >
            {meta.label}
          </span>
        </div>
        <dl className={styles.metaGrid}>
          <div>
            <dt>修订号</dt>
            <dd>
              <code data-testid="review-revision-id">{revision.revision_id}</code>
            </dd>
          </div>
          <div>
            <dt>来源</dt>
            <dd>{SOURCE_LABEL[revision.source] ?? revision.source}</dd>
          </div>
          <div>
            <dt>市场 / 语言</dt>
            <dd>
              {revision.market} · {revision.locale}
            </dd>
          </div>
          <div>
            <dt>父修订</dt>
            <dd>
              {revision.parent_revision_id ? <code>{revision.parent_revision_id}</code> : '—'}
            </dd>
          </div>
          <div>
            <dt>内容指纹</dt>
            <dd>
              <code>{revision.content_hash.slice(0, 12)}</code>
            </dd>
          </div>
          <div>
            <dt>生成方</dt>
            <dd>{describeGenerator(revision)}</dd>
          </div>
        </dl>
        {view?.approved_revision_id && view.approved_revision_id !== revision.revision_id && (
          <p className={styles.muted} data-testid="review-active-elsewhere">
            当前生效的已批准修订是 <code>{view.approved_revision_id}</code>，本修订为候选。
          </p>
        )}
      </section>

      {error && (
        <p className={styles.error} role="alert" data-testid="review-error">
          {error}
        </p>
      )}
      {notice && !error && (
        <p className={styles.notice} role="status" data-testid="review-notice">
          {notice}
        </p>
      )}

      <section className={styles.block}>
        <div className={styles.blockHead}>
          <h3>编辑内容</h3>
          {dirty && (
            <span className={styles.dirty} data-testid="review-dirty">
              有未保存修改
            </span>
          )}
        </div>
        {!editable && (
          <p className={styles.muted} data-testid="review-fork-hint">
            该修订已进入审核流程，保存修改将创建新的候选修订，不会覆盖它。
          </p>
        )}

        <label className={styles.field}>
          <span>标题</span>
          <textarea
            rows={2}
            value={buffer.title}
            data-testid="review-title-input"
            onChange={e => setBuffer({ ...buffer, title: e.target.value })}
          />
          <small>{buffer.title.length} 字符</small>
        </label>

        {groupFields(buffer.fields).map(group => (
          <div className={styles.group} key={group.group}>
            <h4>{GROUP_LABEL[group.group]}</h4>
            {group.fields.map(f => (
              <label className={styles.field} key={f.label}>
                <span>{f.label}</span>
                <textarea
                  rows={f.value.length > 120 ? 4 : 2}
                  value={f.value}
                  data-testid="review-field-input"
                  data-label={f.label}
                  onChange={e => setBuffer(withFieldValue(buffer, f.label, e.target.value))}
                />
              </label>
            ))}
          </div>
        ))}

        {dirty && (
          <div className={styles.pendingDiff} data-testid="review-pending-diff">
            <h4>未保存的改动</h4>
            <ul>
              {changedRows(diffContent(revision.content, buffer)).map(row => (
                <li key={row.label} data-status={row.status}>
                  <b>{row.label}</b>
                  <i>{DIFF_STATUS_LABEL[row.status]}</i>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primary}
            disabled={!dirty || busy !== ''}
            data-testid="review-save"
            onClick={() =>
              run('save', () => saveDraft(revision.revision_id, buffer, operator, productId).then(r => r.revision), '已保存草稿。')
            }
          >
            保存草稿
          </button>
          <button
            type="button"
            disabled={!dirty || busy !== ''}
            data-testid="review-reset"
            onClick={() => {
              setBuffer(revision.content);
              setNotice('已丢弃未保存的修改。');
              setError('');
            }}
          >
            重置未保存修改
          </button>
          <button
            type="button"
            disabled={dirty || busy !== '' || revision.state === 'approved'}
            data-testid="review-validate"
            onClick={() =>
              run(
                'validate',
                () => submitForValidation(revision.revision_id, operator, productId),
                '校验完成。',
              )
            }
          >
            提交校验
          </button>
        </div>
        {dirty && (
          <p className={styles.muted}>先保存草稿，再提交校验——校验结果必须对应已存下的内容。</p>
        )}
      </section>

      <section className={styles.block}>
        <h3>校验结果</h3>
        {!validation && (
          <p className={styles.muted} data-testid="review-unvalidated">
            尚未校验。批准前必须先通过确定性校验。
          </p>
        )}
        {validation && (
          <>
            <p className={styles.muted}>
              校验编号 <code>{validation.validation_id}</code> · 政策快照{' '}
              {validation.policy_snapshot_ids.map(id => (
                <code key={id}>{id}</code>
              ))}{' '}
              · {validation.ran_at}
            </p>
            {blockers.length > 0 ? (
              <ul className={styles.checkList} data-testid="review-blockers">
                {blockers.map(c => (
                  <li key={c.id} data-blocking="1">
                    <b>{c.label}</b>
                    <span>{c.detail}</span>
                    {c.suggestion && <em>{c.suggestion}</em>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.ok} data-testid="review-no-blockers">
                无阻断项。机械校验通过，不等于平台终审。
              </p>
            )}

            {warnings.length > 0 && (
              <div className={styles.warnings}>
                <h4>警告（{warnings.length}）</h4>
                <ul className={styles.checkList} data-testid="review-warnings">
                  {warnings.map(c => (
                    <li key={c.id}>
                      <label className={styles.ackRow}>
                        <input
                          type="checkbox"
                          data-testid="review-warning-check"
                          data-warning={c.id}
                          disabled={acknowledgedIds.has(c.id)}
                          checked={ackChoice.includes(c.id) || acknowledgedIds.has(c.id)}
                          onChange={e =>
                            setAckChoice(prev =>
                              e.target.checked
                                ? [...prev, c.id]
                                : prev.filter(id => id !== c.id),
                            )
                          }
                        />
                        <b>{c.label}</b>
                        {acknowledgedIds.has(c.id) && <i className={styles.ackTag}>已确认</i>}
                      </label>
                      <span>{c.detail}</span>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  disabled={ackChoice.length === 0 || !operator.trim() || !reason.trim() || busy !== ''}
                  data-testid="review-acknowledge"
                  onClick={() =>
                    run(
                      'ack',
                      () =>
                        acknowledgeWarnings(
                          revision.revision_id,
                          ackChoice,
                          operator,
                          reason,
                          productId,
                        ),
                      '已记录警告确认。',
                    )
                  }
                >
                  确认所选警告
                </button>
                <p className={styles.muted}>确认警告需要填写复核人与理由，记录将永久留存。</p>
              </div>
            )}
          </>
        )}
      </section>

      <section className={styles.block}>
        <h3>审批</h3>
        <div className={styles.approvalForm}>
          <label className={styles.field}>
            <span>复核人 / 操作人</span>
            <input
              type="text"
              value={operator}
              data-testid="review-operator"
              placeholder="填写你的名字或工号"
              onChange={e => {
                setOperator(e.target.value);
                storeOperator(e.target.value);
              }}
            />
          </label>
          <label className={styles.field}>
            <span>理由 / 说明</span>
            <textarea
              rows={2}
              value={reason}
              data-testid="review-reason"
              placeholder="批准、退回、回滚与警告确认都会记录这段说明"
              onChange={e => setReason(e.target.value)}
            />
          </label>
        </div>

        {!canApprove && revision.state !== 'approved' && (
          <p className={styles.muted} data-testid="review-approve-hint">
            {blockers.length > 0
              ? `仍有 ${blockers.length} 项阻断校验，批准已被拦截。`
              : '批准前需先提交校验并通过。'}
          </p>
        )}

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primary}
            disabled={!canApprove || !operator.trim() || busy !== ''}
            data-testid="review-approve"
            onClick={() =>
              run(
                'approve',
                () => approveRevision(revision.revision_id, operator, reason, productId),
                '已批准该修订。',
              )
            }
          >
            批准
          </button>
          <button
            type="button"
            disabled={
              !operator.trim() ||
              !reason.trim() ||
              busy !== '' ||
              ['approved', 'superseded', 'rolled_back'].includes(revision.state)
            }
            data-testid="review-request-changes"
            onClick={() =>
              run(
                'changes',
                () => requestChanges(revision.revision_id, operator, reason, productId),
                '已退回修改。',
              )
            }
          >
            退回修改
          </button>
        </div>
        <p className={styles.muted}>
          批准只表示内部复核通过。本工具不做平台发布，也不代表任何平台的审核结论。
        </p>

        {(view?.approvals.length ?? 0) > 0 && (
          <ul className={styles.recordList} data-testid="review-approvals">
            {view!.approvals.map(a => (
              <li key={a.approval_id}>
                <b>{DECISION_LABEL[a.decision] ?? a.decision}</b>
                <span>
                  {a.operator} · {a.at}
                </span>
                {a.reason && <em>{a.reason}</em>}
                <small>
                  依据校验 {a.validation_result_ids.join('、') || '—'} · 政策{' '}
                  {a.policy_snapshot_ids.join('、') || '—'}
                </small>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.block}>
        <h3>修订历史</h3>
        <ul className={styles.history} data-testid="review-history">
          {(view?.history ?? []).map(h => (
            <li key={h.revision_id} data-current={h.revision_id === revision.revision_id}>
              <div className={styles.historyRow}>
                <code>{h.revision_id}</code>
                <span className={styles.state} data-tone={REVISION_STATE_META[h.state].tone}>
                  {REVISION_STATE_META[h.state].label}
                </span>
                <span className={styles.muted}>{SOURCE_LABEL[h.source] ?? h.source}</span>
                <span className={styles.muted}>{h.created_at}</span>
              </div>
              <div className={styles.historyActions}>
                {h.restores_revision_id && (
                  <span className={styles.muted}>还原自 {h.restores_revision_id}</span>
                )}
                <button
                  type="button"
                  disabled={busy !== '' || h.revision_id === revision.revision_id}
                  data-testid="review-diff"
                  data-revision={h.revision_id}
                  onClick={() =>
                    fetchDiff(h.revision_id, revision.revision_id, productId)
                      .then(d => mounted.current && setDiff(d))
                      .catch(err => mounted.current && setError(reviewErrorMessage(err)))
                  }
                >
                  与当前对比
                </button>
                <button
                  type="button"
                  disabled={
                    busy !== '' ||
                    !operator.trim() ||
                    !reason.trim() ||
                    h.revision_id === view?.approved_revision_id
                  }
                  data-testid="review-rollback"
                  data-revision={h.revision_id}
                  onClick={() =>
                    run(
                      'rollback',
                      () => rollbackTo(h.revision_id, operator, reason, productId),
                      `已回滚到 ${h.revision_id} 的内容，并创建了新的修订。`,
                    )
                  }
                >
                  回滚到此版本
                </button>
              </div>
            </li>
          ))}
        </ul>
        <p className={styles.muted}>回滚不会删除后续历史，而是以新修订还原选定版本的内容。</p>
      </section>

      {diff && (
        <section className={styles.block} data-testid="review-diff-panel">
          <div className={styles.blockHead}>
            <h3>
              对比 <code>{diff.base.revision_id}</code> → <code>{diff.target.revision_id}</code>
            </h3>
            <button type="button" onClick={() => setDiff(null)}>
              关闭
            </button>
          </div>
          {diff.identical ? (
            <p className={styles.muted}>两个修订的内容完全相同。</p>
          ) : (
            <table className={styles.diffTable}>
              <thead>
                <tr>
                  <th>字段</th>
                  <th>状态</th>
                  <th>之前</th>
                  <th>之后</th>
                </tr>
              </thead>
              <tbody>
                {changedRows(diff.rows).map(row => (
                  <tr key={row.label} data-status={row.status}>
                    <td>{row.label}</td>
                    <td>
                      <span className={styles.diffTag} data-status={row.status}>
                        {DIFF_STATUS_LABEL[row.status]}
                      </span>
                    </td>
                    <td>{row.before || '—'}</td>
                    <td>{row.after || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className={styles.muted}>
            未变 {diff.counts.unchanged} · 修改 {diff.counts.modified} · 新增 {diff.counts.added} ·
            删除 {diff.counts.removed}
          </p>
        </section>
      )}
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  generated: '模型/模板生成',
  edited: '人工编辑',
  rollback: '回滚还原',
};

const DECISION_LABEL: Record<string, string> = {
  approved: '批准',
  changes_requested: '退回修改',
  rollback: '回滚',
};

function describeGenerator(revision: Revision): string {
  const parts = [revision.generator.provider, revision.generator.model].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

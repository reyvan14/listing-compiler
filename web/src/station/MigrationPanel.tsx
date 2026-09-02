import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Editor } from 'tldraw';
import { focusShape } from '@/pipeline/nodes/types/skuStation';
import { toSafeMessage } from './apiClient';
import {
  applyMigration,
  artifactToWire,
  buildCandidate,
  fetchPolicyDiff,
  rollbackMigration,
  runImpact,
  wireImpact,
  wirePatchToCandidate,
  wireToArtifact,
  type PolicyDiff,
} from './migration/api';
import {
  applyArtifactsToCanvas,
  applyImpactToCanvas,
  collectArtifacts,
  driftCapacity,
  ensureListingCards,
  factsFromCanvas,
  resetCanvasMigration,
} from './migration/collect';
import { buildDependencyGraph, impactSummary, propagateStale } from './migration/graph';
import {
  approvedPatches,
  initMigrationState,
  migrationReducer,
  pendingHumanReview,
} from './migration/reducer';
import { downloadReport, serializeReport } from './migration/report';
import { diffFacts } from './migration/skuFacts';
import { patchKey, type CandidatePatch, type ImpactRow } from './migration/types';
import styles from './nodes.module.scss';

const AMAZON_BASE = 'amazon-us-2025.03';
const AMAZON_CANDIDATE = 'amazon-us-2026.03-candidate';

type Trigger =
  | { kind: 'policy'; platform: string; base: string; candidate: string }
  | { kind: 'sku'; before: Record<string, string>; after: Record<string, string>; changed: string[] }
  | null;

type Busy = '' | 'setup' | 'impact' | 'candidate' | 'apply' | 'rollback';

const CAUSE_LABEL: Record<string, string> = {
  sku: 'SKU 事实',
  policy: '政策',
  both: 'SKU + 政策',
};

export function MigrationPanel({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [state, dispatch] = useReducer(migrationReducer, undefined, () =>
    initMigrationState(collectArtifacts(editor)),
  );
  const [trigger, setTrigger] = useState<Trigger>(null);
  const [policyDiff, setPolicyDiff] = useState<PolicyDiff | null>(null);
  const [busy, setBusy] = useState<Busy>('');
  const [error, setError] = useState('');
  const [sourceNote, setSourceNote] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useEffect(() => {
    // Clean the amber/green stamps off the canvas when the panel closes.
    return () => resetCanvasMigration(editor);
  }, [editor]);

  const summary = useMemo(
    () => (state.impact ? impactSummary(state.impact) : null),
    [state.impact],
  );

  const runError = (err: unknown) => setError(toSafeMessage(err));

  // ---- demo triggers --------------------------------------------------- //

  const startPolicyDemo = useCallback(async () => {
    setError('');
    setBusy('setup');
    try {
      const src = await ensureListingCards(editor);
      if (src !== 'exists') setSourceNote(src);
      dispatch({ type: 'reset', current: collectArtifacts(editor) });
      const diff = await fetchPolicyDiff(AMAZON_BASE, AMAZON_CANDIDATE);
      setPolicyDiff(diff);
      setTrigger({
        kind: 'policy',
        platform: 'amazon',
        base: AMAZON_BASE,
        candidate: AMAZON_CANDIDATE,
      });
    } catch (err) {
      runError(err);
    } finally {
      setBusy('');
    }
  }, [editor]);

  const startSkuDemo = useCallback(async () => {
    setError('');
    setBusy('setup');
    try {
      const src = await ensureListingCards(editor);
      if (src !== 'exists') setSourceNote(src);
      const { before, after, changed } = driftCapacity(editor);
      dispatch({ type: 'reset', current: collectArtifacts(editor) });
      setPolicyDiff(null);
      setTrigger({
        kind: 'sku',
        before,
        after,
        changed: changed ? diffFacts(before, after).changed : [],
      });
    } catch (err) {
      runError(err);
    } finally {
      setBusy('');
    }
  }, [editor]);

  // ---- workflow steps ------------------------------------------------- //

  const runAnalysis = useCallback(async () => {
    if (!trigger) return;
    setError('');
    setBusy('impact');
    const artifacts = collectArtifacts(editor);
    dispatch({ type: 'reset', current: artifacts });
    dispatch({ type: 'setTrigger', trigger: reducerTrigger(trigger) });
    try {
      let rows: ImpactRow[];
      try {
        const data = await runImpact({
          artifacts,
          factsBefore: trigger.kind === 'sku' ? trigger.before : factsFromCanvas(editor),
          factsAfter: trigger.kind === 'sku' ? trigger.after : factsFromCanvas(editor),
          basePolicyVersion: trigger.kind === 'policy' ? trigger.base : undefined,
          candidatePolicyVersion: trigger.kind === 'policy' ? trigger.candidate : undefined,
        });
        rows = wireImpact(data).rows;
      } catch {
        // Backend unreachable — the local deterministic graph mirrors it.
        rows = propagateStale(buildDependencyGraph(artifacts), localPropagateInput(trigger, policyDiff));
      }
      dispatch({ type: 'analyzed', impact: rows });
      applyImpactToCanvas(editor, rows);
    } catch (err) {
      runError(err);
    } finally {
      setBusy('');
    }
  }, [editor, trigger, policyDiff]);

  const runCandidate = useCallback(async () => {
    if (!trigger || !state.impact) return;
    setError('');
    setBusy('candidate');
    try {
      const artifacts = collectArtifacts(editor);
      const data = await buildCandidate({
        artifacts,
        impact: rebuildImpactWire(state.impact),
        factsBefore: trigger.kind === 'sku' ? trigger.before : factsFromCanvas(editor),
        factsAfter: trigger.kind === 'sku' ? trigger.after : factsFromCanvas(editor),
        basePolicyVersion: trigger.kind === 'policy' ? trigger.base : undefined,
        candidatePolicyVersion: trigger.kind === 'policy' ? trigger.candidate : undefined,
      });
      const patches: CandidatePatch[] = (data.patches ?? []).map(wirePatchToCandidate);
      dispatch({ type: 'candidates', patches });
      applyImpactToCanvas(
        editor,
        state.impact.map(r =>
          r.affected ? { ...r } : r,
        ),
      );
    } catch (err) {
      runError(err);
    } finally {
      setBusy('');
    }
  }, [editor, trigger, state.impact]);

  const runApply = useCallback(async () => {
    if (!trigger) return;
    const approved = approvedPatches(state);
    if (!approved.length) return;
    setError('');
    setBusy('apply');
    try {
      const artifacts = collectArtifacts(editor);
      const data = await applyMigration({
        artifacts,
        approvedPatches: approved,
        factsAfter: trigger.kind === 'sku' ? trigger.after : factsFromCanvas(editor),
        candidatePolicyVersion: trigger.kind === 'policy' ? trigger.candidate : undefined,
      });
      const next = (data.artifacts ?? []).map((r: Record<string, any>) => wireToArtifact(r));
      dispatch({
        type: 'applied',
        artifacts: next,
        appliedIds: data.applied_artifact_ids ?? [],
        needsReviewIds: data.needs_human_review_ids ?? [],
      });
      applyArtifactsToCanvas(editor, next, 'applied');
    } catch (err) {
      runError(err);
    } finally {
      setBusy('');
    }
  }, [editor, trigger, state]);

  const runRollback = useCallback(async () => {
    if (!state.snapshot) return;
    setError('');
    setBusy('rollback');
    try {
      const snapshot = { artifacts: state.snapshot.map(artifactToWire) };
      let restored = state.snapshot;
      try {
        const data = await rollbackMigration(snapshot);
        restored = (data.artifacts ?? []).map((r: Record<string, any>) => wireToArtifact(r));
      } catch {
        /* deterministic local fallback = the snapshot itself */
      }
      dispatch({ type: 'rolledBack' });
      applyArtifactsToCanvas(
        editor,
        restored.map(a => ({ ...a, status: 'rolled-back' as const })),
        'rolled-back',
      );
    } catch (err) {
      runError(err);
    } finally {
      setBusy('');
    }
  }, [editor, state.snapshot]);

  const onDownloadReport = useCallback(() => {
    downloadReport(
      serializeReport(state, {
        ruleDiff: policyDiff ?? undefined,
        factDelta:
          trigger?.kind === 'sku'
            ? diffFacts(trigger.before, trigger.after)
            : undefined,
      }),
    );
  }, [state, policyDiff, trigger]);

  const affectedRows = (state.impact ?? []).filter(r => r.affected);
  const unaffectedRows = (state.impact ?? []).filter(r => !r.affected);
  const patches = state.candidates ?? [];
  const canApply = state.phase === 'candidate' && approvedPatches(state).length > 0;
  const canRollback =
    !!state.snapshot && (state.phase === 'applied' || state.phase === 'candidate');

  return (
    <div
      ref={dialogRef}
      className={`${styles.drawer} ${styles.migrationDrawer}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="migration-title"
      id="migration-panel"
    >
      <div className={styles.mask} aria-hidden="true" onClick={onClose} />
      <aside>
        <header>
          <div>
            <div className={styles.kicker}>规则变更 / 迁移 · 自愈式 Listing CI/CD</div>
            <h2 id="migration-title">政策 / SKU 漂移 → 影响面 → 候选补丁 → 应用 / 回滚</h2>
          </div>
          <button ref={closeRef} type="button" className={styles.btnGhost} onClick={onClose}>
            关闭
          </button>
        </header>

        <p className={styles.rulesNote} data-phase={state.phase} id="migration-status">
          状态：{PHASE_LABEL[state.phase]}
          {sourceNote && `　·　演示数据：${SOURCE_LABEL[sourceNote] ?? sourceNote}`}
        </p>

        {error && (
          <p className={styles.rulesError} role="alert">
            {error}
          </p>
        )}

        {!trigger && (
          <section className={styles.migSection}>
            <div className={styles.menuTitle}>选择一个漂移场景（本地演示数据）</div>
            <div className={styles.migActions}>
              <button
                type="button"
                className={styles.btnPrimary}
                id="migration-demo-policy"
                disabled={busy !== ''}
                onClick={startPolicyDemo}
              >
                演示 1：平台政策漂移（Amazon 候选政策）
              </button>
              <button
                type="button"
                className={styles.btnPrimary}
                id="migration-demo-sku"
                disabled={busy !== ''}
                onClick={startSkuDemo}
              >
                演示 2：SKU 事实漂移（350ml → 300ml）
              </button>
            </div>
            <p className={styles.help}>
              两个场景都是确定性的本地演示，不调用真实模型、不代表线上店铺数据。
            </p>
          </section>
        )}

        {trigger?.kind === 'policy' && policyDiff && (
          <section className={styles.migSection} id="migration-policy-card">
            <div className={styles.menuTitle}>政策差异</div>
            <p className={styles.rulesNote}>
              <strong>{policyDiff.platform}</strong>　<code>{policyDiff.base_version}</code>
              （生效 {policyDiff.base_effective_date}）　→
              <code>{policyDiff.candidate_version}</code>
              （生效 {policyDiff.candidate_effective_date}）
              <br />
              出处：
              <a href={policyDiff.source_url} target="_blank" rel="noreferrer noopener">
                {policyDiff.source_name}
              </a>
            </p>
            <ul className={styles.migDiff}>
              {policyDiff.changed.map(c => (
                <li key={c.rule_id} data-kind="changed">
                  <b>变更</b> <code>{c.rule_id}</code>：{describeParams(c.old)} → {describeParams(c.new)}
                </li>
              ))}
              {policyDiff.added.map(a => (
                <li key={a.id} data-kind="added">
                  <b>新增</b> <code>{a.id}</code>：{a.description}
                </li>
              ))}
              {policyDiff.removed.map(r => (
                <li key={r.id} data-kind="removed">
                  <b>移除</b> <code>{r.id}</code>
                </li>
              ))}
            </ul>
          </section>
        )}

        {trigger?.kind === 'sku' && (
          <section className={styles.migSection} id="migration-fact-card">
            <div className={styles.menuTitle}>SKU 事实差异</div>
            {trigger.changed.length === 0 ? (
              <p className={styles.rulesError}>未检测到容量字样，无法演示该场景。</p>
            ) : (
              <ul className={styles.migDiff}>
                {trigger.changed.map(id => (
                  <li key={id} data-kind="changed">
                    <b>变更</b> <code>{id}</code>：{trigger.before[id]} → {trigger.after[id]}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {trigger && (
          <section className={styles.migSection}>
            <div className={styles.migActions}>
              <button
                type="button"
                className={styles.btnPrimary}
                id="migration-run-impact"
                disabled={busy !== ''}
                onClick={runAnalysis}
              >
                {busy === 'impact' ? '分析中…' : '运行影响分析'}
              </button>
              <button
                type="button"
                className={styles.btnGhost}
                id="migration-build-candidate"
                disabled={busy !== '' || !state.impact || affectedRows.length === 0}
                onClick={runCandidate}
              >
                {busy === 'candidate' ? '构建中…' : '构建候选补丁'}
              </button>
              <button
                type="button"
                className={styles.btnGhost}
                id="migration-apply"
                disabled={busy !== '' || !canApply}
                onClick={runApply}
              >
                {busy === 'apply' ? '应用中…' : '应用所选'}
              </button>
              <button
                type="button"
                className={styles.btnGhost}
                id="migration-rollback"
                disabled={busy !== '' || !canRollback}
                onClick={runRollback}
              >
                {busy === 'rollback' ? '回滚中…' : '回滚'}
              </button>
              <button
                type="button"
                className={styles.btnGhost}
                id="migration-download-report"
                disabled={!state.impact}
                onClick={onDownloadReport}
              >
                下载迁移报告
              </button>
            </div>
          </section>
        )}

        {summary && (
          <section className={styles.migSection} id="migration-impact">
            <div className={styles.menuTitle}>
              影响面：受影响 <b>{summary.affectedCount}</b> · 未受影响{' '}
              <b>{summary.unaffectedCount}</b>
            </div>
            <ul className={styles.migList}>
              {affectedRows.map(row => (
                <li key={row.artifactId} data-tone="warn">
                  <button
                    type="button"
                    className={styles.migRow}
                    data-testid="mig-affected-row"
                    data-affected="1"
                    data-artifact={row.artifactId}
                    onClick={() => row.nodeId && focusShape(editor, row.nodeId)}
                  >
                    <span className={styles.migRowHead}>
                      <b>{row.platform || row.artifactId}</b>
                      <em data-cause={row.cause ?? ''}>{CAUSE_LABEL[row.cause ?? ''] ?? '—'}</em>
                      <span className={styles.migStale}>受影响</span>
                    </span>
                    {row.reasons.map((reason, i) => (
                      <span key={i} className={styles.migReason}>
                        {reason.detail}
                        {reason.fields.length ? `（${reason.fields.join('、')}）` : ''}
                      </span>
                    ))}
                    {row.fieldsToRegenerate.length > 0 && (
                      <span className={styles.migReason}>
                        需重编译：{row.fieldsToRegenerate.join('、')}
                      </span>
                    )}
                    {!row.hasDependencyMetadata && (
                      <span className={styles.migReason}>（保守判定：缺 factRefs 元数据）</span>
                    )}
                  </button>
                </li>
              ))}
              {unaffectedRows.map(row => (
                <li key={row.artifactId} data-tone="ok">
                  <button
                    type="button"
                    className={styles.migRow}
                    data-testid="mig-unaffected-row"
                    data-affected="0"
                    data-artifact={row.artifactId}
                    onClick={() => row.nodeId && focusShape(editor, row.nodeId)}
                  >
                    <span className={styles.migRowHead}>
                      <b>{row.platform || row.artifactId}</b>
                      <span className={styles.migKeep}>保留</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {patches.length > 0 && (
          <section className={styles.migSection} id="migration-candidates">
            <div className={styles.menuTitle}>候选补丁（当前草稿不被改写）</div>
            <ul className={styles.migPatches}>
              {patches.map(patch => {
                const key = patchKey(patch);
                return (
                  <li
                    key={key}
                    data-testid="mig-patch"
                    data-key={key}
                    data-review={patch.needsHumanReview ? '1' : '0'}
                  >
                    <label className={styles.migPatchHead}>
                      <input
                        type="checkbox"
                        checked={!!state.approvals[key]}
                        onChange={() => dispatch({ type: 'toggleApproval', key })}
                      />
                      <b>{patch.platform || patch.artifactId}</b> · <code>{patch.field}</code>
                      {patch.needsHumanReview && <em className={styles.migReview}>需人工复核</em>}
                      {!patch.validation.ok && <em className={styles.migFail}>校验未过</em>}
                    </label>
                    <div className={styles.migPatchBody}>
                      <span className={styles.migPrev}>原：{patch.previousValue}</span>
                      <span className={styles.migNext}>新：{patch.candidateValue}</span>
                      <span className={styles.migReason}>
                        原因：{patch.reason}
                        {patch.triggering.ruleIds?.length
                          ? `　触发规则：${patch.triggering.ruleIds.join('、')}`
                          : patch.triggering.factIds?.length
                            ? `　触发事实：${patch.triggering.factIds.join('、')}`
                            : ''}
                        {patch.factRefs.length ? `　factRefs：${patch.factRefs.join('、')}` : ''}
                      </span>
                      {patch.note && <span className={styles.migFail}>{patch.note}</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
            {pendingHumanReview(state).length > 0 && (
              <p className={styles.help}>
                {pendingHumanReview(state).length} 项待人工复核，未勾选则不会被应用，状态保持「需人工复核」。
              </p>
            )}
          </section>
        )}

        {state.phase === 'applied' && (
          <section className={styles.migSection} id="migration-applied">
            <p className={styles.rulesNote}>
              已应用 {state.appliedIds.length} 个产物（仅改写已批准字段，其余逐字节保留）。
              {state.needsReviewIds.length > 0 &&
                ` ${state.needsReviewIds.length} 个仍为「需人工复核」。`}
            </p>
          </section>
        )}
        {state.phase === 'rolled-back' && (
          <section className={styles.migSection} id="migration-rolledback">
            <p className={styles.rulesNote}>已回滚：产物值、状态、政策版本已还原到迁移前。</p>
          </section>
        )}
      </aside>
    </div>
  );
}

// --------------------------------------------------------------------------- //

const PHASE_LABEL: Record<string, string> = {
  idle: '待选择场景',
  analyzed: '已完成影响分析',
  candidate: '已生成候选补丁（待批准）',
  applied: '已应用',
  'rolled-back': '已回滚',
};

const SOURCE_LABEL: Record<string, string> = {
  'token-plan': '模型生成',
  'api-fallback': '后端规则兜底',
  'local-sample': '本地示例',
};

function describeParams(rule: { severity: string; params: Record<string, unknown> }): string {
  const bits: string[] = [];
  if ('max' in rule.params) bits.push(`≤ ${rule.params.max} 字符`);
  if ('min' in rule.params) bits.push(`≥ ${rule.params.min} 字符`);
  if ('chars' in rule.params) bits.push(`禁用「${rule.params.chars}」`);
  if ('limit' in rule.params) bits.push(`同词 ≤ ${rule.params.limit} 次`);
  bits.push(rule.severity === 'blocking' ? '强制' : '建议');
  return bits.join(' · ');
}

function reducerTrigger(trigger: Trigger): import('./migration/reducer').MigrationTrigger {
  if (trigger?.kind === 'policy') {
    return {
      kind: 'policy',
      platform: trigger.platform,
      baseVersion: trigger.base,
      candidateVersion: trigger.candidate,
    };
  }
  if (trigger?.kind === 'sku') {
    return {
      kind: 'sku',
      changedFacts: trigger.changed,
      factsBefore: trigger.before,
      factsAfter: trigger.after,
    };
  }
  return null;
}

function localPropagateInput(trigger: Trigger, policyDiff: PolicyDiff | null) {
  if (trigger?.kind === 'sku') {
    return { factDelta: diffFacts(trigger.before, trigger.after) };
  }
  if (trigger?.kind === 'policy' && policyDiff) {
    const fields = policyDiff.affected_fields;
    const hasBlocking =
      policyDiff.changed.some(c => c.new.severity === 'blocking') ||
      policyDiff.added.length > 0;
    const blocking = hasBlocking ? fields : [];
    return {
      policy: {
        platform: policyDiff.platform,
        fields,
        blockingFields: blocking,
        baseVersion: policyDiff.base_version,
        candidateVersion: policyDiff.candidate_version,
        ruleIds: [
          ...policyDiff.changed.map(c => c.rule_id),
          ...policyDiff.added.map(a => a.id),
        ],
      },
    };
  }
  return {};
}

/** Reassemble a backend-shaped impact object from frontend rows so the
 * candidate endpoint can reuse a prior analysis instead of recomputing it. */
function rebuildImpactWire(rows: ImpactRow[]) {
  const toWire = (r: ImpactRow) => ({
    artifact_id: r.artifactId,
    platform: r.platform,
    kind: r.kind,
    affected: r.affected,
    cause: r.cause,
    reasons: r.reasons.map(reason => ({
      type: reason.type,
      detail: reason.detail,
      fact_ids: reason.factIds ?? [],
      rule_ids: reason.ruleIds ?? [],
      fields: reason.fields,
      requires_regen: !!reason.requiresRegen,
    })),
    fields_to_regenerate: r.fieldsToRegenerate,
    reusable_fields: r.reusableFields,
    has_dependency_metadata: r.hasDependencyMetadata,
  });
  const affected = rows.filter(r => r.affected).map(toWire);
  const unaffected = rows.filter(r => !r.affected).map(toWire);
  return {
    affected,
    unaffected,
    fact_delta: { added: [], removed: [], changed: [] },
    policy_diff: null,
    summary: {
      affected_count: affected.length,
      unaffected_count: unaffected.length,
      by_cause: { sku: 0, policy: 0, both: 0 },
    },
  };
}

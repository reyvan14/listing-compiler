import { useCallback, useEffect, useRef, useState } from 'react';
import {
  applyCandidate,
  candidateErrorMessage,
  fetchCandidate,
  fetchConfirmation,
  rollbackCandidate,
  type StoredCandidate,
} from './candidateApi';
import chrome from '../stationChrome.module.scss';
import styles from '../nodes.module.scss';

// The panel's view of a candidate the server built and stored — normally
// because an Agent action asked for one.
//
// Building and applying are two decisions and this component keeps them two:
// what arrives here is a set of proposed patches with the rules that motivated
// them, and nothing reaches a listing until the operator ticks specific
// patches, names themselves, gives a reason, and confirms. The confirmation
// token is fetched for exactly the ticked set, so widening the selection
// invalidates it.

const STATE_LABEL: Record<StoredCandidate['state'], string> = {
  blocked: '未生成（前置条件缺失）',
  built: '已生成候选，待审阅',
  applied: '已应用为草稿修订',
  rolled_back: '已回滚',
};

export function StoredCandidateSection({
  candidateId,
  productId,
  onDismiss,
}: {
  candidateId: string;
  /** Same evidence-store partition the action that built this wrote into. */
  productId: string;
  onDismiss: () => void;
}) {
  const [candidate, setCandidate] = useState<StoredCandidate | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [operator, setOperator] = useState('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setBusy('load');
    setError('');
    try {
      const data = await fetchCandidate(candidateId, productId);
      if (!mounted.current) return;
      setCandidate(data.candidate);
      // Nothing is pre-ticked. A migration that applies itself by default is
      // not a review step.
      setSelected(new Set());
    } catch (err) {
      if (mounted.current) setError(candidateErrorMessage(err));
    } finally {
      if (mounted.current) setBusy('');
    }
  }, [candidateId, productId]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (patchId: string) => {
    setConfirming(false);
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(patchId)) next.delete(patchId);
      else next.add(patchId);
      return next;
    });
  };

  const runApply = async () => {
    if (!candidate) return;
    const patchIds = [...selected];
    setBusy('apply');
    setError('');
    setNotice('');
    try {
      // Fetched now, for this exact selection: a token taken before the
      // operator changed their ticks would authorise the wrong patch set.
      const { confirmation_token } = await fetchConfirmation(
        candidate.candidate_id,
        patchIds,
        productId,
      );
      const data = await applyCandidate(candidate.candidate_id, productId, {
        patch_ids: patchIds,
        operator,
        reason,
        confirm_token: confirmation_token,
      });
      if (!mounted.current) return;
      setCandidate(data.candidate);
      setConfirming(false);
      setNotice(
        `已写入 ${data.candidate.applied.length} 条草稿修订；原已批准修订保持不变，仍需在审核界面校验与批准。`,
      );
    } catch (err) {
      if (mounted.current) setError(candidateErrorMessage(err));
    } finally {
      if (mounted.current) setBusy('');
    }
  };

  const runRollback = async () => {
    if (!candidate) return;
    setBusy('rollback');
    setError('');
    setNotice('');
    try {
      const data = await rollbackCandidate(candidate.candidate_id, productId, {
        operator,
        reason,
      });
      if (!mounted.current) return;
      setCandidate(data.candidate);
      setNotice(
        `已撤回 ${(data.candidate.withdrawn_revision_ids ?? []).length} 条由本次迁移创建的草稿。`,
      );
    } catch (err) {
      if (mounted.current) setError(candidateErrorMessage(err));
    } finally {
      if (mounted.current) setBusy('');
    }
  };

  if (!candidate) {
    return (
      <section className={styles.migSection} data-testid="stored-candidate">
        <div className={chrome.menuTitle}>迁移候选 {candidateId}</div>
        {error ? (
          <p className={styles.rulesError} role="alert" data-testid="stored-candidate-error">
            {error}
          </p>
        ) : (
          <p className={styles.rulesNote}>正在读取候选…</p>
        )}
      </section>
    );
  }

  const canApply =
    candidate.state === 'built' && selected.size > 0 && !!operator.trim() && !!reason.trim();

  return (
    <section
      className={styles.migSection}
      data-testid="stored-candidate"
      data-candidate={candidate.candidate_id}
      data-state={candidate.state}
    >
      <div className={chrome.menuTitle}>
        迁移候选 <code>{candidate.candidate_id}</code>　·　{STATE_LABEL[candidate.state]}
      </div>
      <p className={styles.rulesNote} data-testid="stored-candidate-provenance">
        由 <code>{candidate.source_action || '手动'}</code> 于 {candidate.created_at} 生成
        {candidate.idempotency_key && `　·　幂等键 ${candidate.idempotency_key}`}
      </p>

      {candidate.policy_diff && (
        <p className={styles.rulesNote} data-testid="stored-candidate-policy">
          规则变更：<code>{candidate.base_policy_version}</code> →{' '}
          <code>{candidate.candidate_policy_version}</code>
          　·　新增 {candidate.policy_diff.added.length}、修改{' '}
          {candidate.policy_diff.changed.length}、移除 {candidate.policy_diff.removed.length}
          　·　涉及字段 {candidate.policy_diff.affected_fields.join('、') || '—'}
        </p>
      )}

      {candidate.blockers.length > 0 && (
        <ul className={styles.migList} data-testid="stored-candidate-blockers">
          {candidate.blockers.map(b => (
            <li key={b.code}>
              <strong>{b.code}</strong>：{b.detail}
            </li>
          ))}
        </ul>
      )}

      {candidate.warnings.map(w => (
        <p className={styles.rulesNote} key={w} data-testid="stored-candidate-warning">
          {w}
        </p>
      ))}

      {candidate.state !== 'blocked' && (
        <>
          {candidate.patches.length === 0 ? (
            <p className={styles.help} data-testid="stored-candidate-empty">
              这次规则变更没有产生任何需要改写的字段。已批准内容在新规则下仍然合规。
            </p>
          ) : (
            <ul className={styles.migPatches} data-testid="stored-candidate-patches">
              {candidate.patches.map(patch => (
                <li key={patch.patch_id} data-testid="stored-candidate-patch" data-patch={patch.patch_id}>
                  <label className={styles.migPatchHead}>
                    <input
                      type="checkbox"
                      checked={selected.has(patch.patch_id)}
                      disabled={candidate.state !== 'built' || busy !== ''}
                      data-testid="stored-candidate-tick"
                      data-patch={patch.patch_id}
                      onChange={() => toggle(patch.patch_id)}
                    />
                    <strong>
                      {patch.artifact_id} · {patch.field}
                    </strong>
                  </label>
                  <p className={styles.rulesNote}>
                    {patch.reason}
                    {patch.triggering?.rule_ids?.length
                      ? `　·　触发规则 ${patch.triggering.rule_ids.join('、')}`
                      : ''}
                  </p>
                  <div className={styles.migPatchBody}>
                    <span className={styles.migPrev} data-testid="stored-candidate-before">
                      原：{patch.previous_value}
                    </span>
                    <span className={styles.migNext} data-testid="stored-candidate-after">
                      新：{patch.candidate_value}
                    </span>
                  </div>
                  {patch.needs_human_review && (
                    <p className={styles.migFail} data-testid="stored-candidate-human">
                      需人工确认：{patch.note}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}

          <p className={styles.help} data-testid="stored-candidate-evidence">
            依据：{candidate.evidence_refs.map(r => `${r.kind}:${r.id}`).join('　·　') || '—'}
          </p>
        </>
      )}

      {candidate.state === 'applied' && (
        <ul className={styles.migList} data-testid="stored-candidate-applied">
          {candidate.applied.map(row => (
            <li key={row.candidate_revision_id}>
              <code>{row.source_revision_id}</code> → 新草稿{' '}
              <code>{row.candidate_revision_id}</code>（{row.fields.join('、')}）
              {row.forked && '　·　原修订未被改动'}
            </li>
          ))}
        </ul>
      )}

      {candidate.state === 'rolled_back' && (
        <p className={styles.rulesNote} data-testid="stored-candidate-rolledback">
          已回滚：撤回了 {(candidate.withdrawn_revision_ids ?? []).length} 条草稿修订。
          原已批准修订自始至终没有被改动。
        </p>
      )}

      {(candidate.state === 'built' || candidate.state === 'applied') && (
        <div className={styles.migActions}>
          <input
            type="text"
            placeholder="操作人"
            value={operator}
            data-testid="stored-candidate-operator"
            onChange={e => setOperator(e.target.value)}
          />
          <input
            type="text"
            placeholder="原因"
            value={reason}
            data-testid="stored-candidate-reason"
            onChange={e => setReason(e.target.value)}
          />
        </div>
      )}

      {error && (
        <p className={styles.rulesError} role="alert" data-testid="stored-candidate-error">
          {error}
        </p>
      )}
      {notice && !error && (
        <p className={styles.rulesNote} role="status" data-testid="stored-candidate-notice">
          {notice}
        </p>
      )}

      <div className={styles.migActions}>
        {candidate.state === 'built' && !confirming && (
          <button
            type="button"
            className={styles.btnPrimary}
            disabled={!canApply || busy !== ''}
            data-testid="stored-candidate-apply"
            onClick={() => setConfirming(true)}
          >
            应用选中的 {selected.size} 项补丁…
          </button>
        )}
        {candidate.state === 'built' && confirming && (
          <>
            <span className={styles.rulesNote} data-testid="stored-candidate-confirm-prompt">
              将为 {selected.size} 项补丁创建<strong>草稿</strong>修订。
              已批准内容不会被替换，草稿仍需通过校验与人工批准。确认？
            </span>
            <button
              type="button"
              className={styles.btnPrimary}
              disabled={busy !== ''}
              data-testid="stored-candidate-confirm"
              onClick={() => void runApply()}
            >
              确认应用
            </button>
            <button
              type="button"
              className={styles.btnGhost}
              disabled={busy !== ''}
              data-testid="stored-candidate-cancel"
              onClick={() => setConfirming(false)}
            >
              取消
            </button>
          </>
        )}
        {candidate.state === 'applied' && (
          <button
            type="button"
            className={styles.btnGhost}
            disabled={busy !== '' || !operator.trim() || !reason.trim()}
            data-testid="stored-candidate-rollback"
            onClick={() => void runRollback()}
          >
            回滚本次迁移
          </button>
        )}
        <button type="button" className={styles.btnGhost} data-testid="stored-candidate-dismiss" onClick={onDismiss}>
          收起候选
        </button>
      </div>
    </section>
  );
}

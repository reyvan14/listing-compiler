import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RESULT_META,
  approveCandidate,
  checkAll,
  fetchMarkets,
  fetchWatches,
  rejectCandidate,
  watchErrorMessage,
  type MarketCoverage,
  type PolicyCandidate,
  type WatchOverview,
} from './policyWatchApi';
import {
  approvalMeaning,
  candidatesFor,
  describeLastCheck,
  pendingCandidates,
  splitCoverage,
  watchTone,
} from './watchModel';
import styles from './policyWatch.module.scss';

// Policy Watch, inside the rule-change panel where it belongs.
//
// The section is deliberately undramatic: it reports that a page moved and
// offers a human the chance to say "yes, it really did". It cannot write a
// rule, and the copy never implies otherwise — the snapshot that governs
// grading is still a file someone commits.

export function PolicyWatchSection({ productId = 'default-product' }: { productId?: string }) {
  const [overview, setOverview] = useState<WatchOverview | null>(null);
  const [markets, setMarkets] = useState<MarketCoverage[]>([]);
  const [operator, setOperator] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const [watches, marketList] = await Promise.all([
        fetchWatches(productId, signal),
        fetchMarkets(productId, signal),
      ]);
      if (!mounted.current) return;
      setOverview(watches);
      setMarkets(marketList.markets);
    },
    [productId],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch(err => {
      if (!controller.signal.aborted && mounted.current) setError(watchErrorMessage(err));
    });
    return () => controller.abort();
  }, [load]);

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await load();
      if (mounted.current) setNotice(done);
    } catch (err) {
      if (mounted.current) setError(watchErrorMessage(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const pending = pendingCandidates(overview?.candidates ?? []);
  const { covered, uncovered } = splitCoverage(markets);

  return (
    <section className={styles.section} data-testid="policy-watch">
      <div className={styles.head}>
        <h3>政策来源监视</h3>
        <span className={styles.kicker}>只提示变化，不自动改规则</span>
      </div>

      <p className={styles.muted}>
        只抓取白名单内的官方页面，解析到内网地址或跳转出白名单一律拒绝。
        检测到变化只会生成<strong>候选记录</strong>；写入并启用新的政策快照仍需人工在
        <code>api/policy/snapshots/</code> 提交。
      </p>

      <div className={styles.actions}>
        <button
          type="button"
          disabled={busy}
          data-testid="policy-watch-check"
          onClick={() => run(() => checkAll(productId), '已完成一次检查。')}
        >
          {busy ? '检查中…' : '检查更新'}
        </button>
        {overview && (
          <span className={styles.muted}>
            白名单 {overview.allowlist.length} 个域名 · 待复核候选 {pending.length}
          </span>
        )}
      </div>

      {error && (
        <p className={styles.error} role="alert" data-testid="policy-watch-error">
          {error}
        </p>
      )}
      {notice && !error && (
        <p className={styles.notice} role="status" data-testid="policy-watch-notice">
          {notice}
        </p>
      )}

      {overview && (
        <ul className={styles.watches} data-testid="policy-watch-list">
          {overview.watches.map(watch => (
            <li key={watch.watch_id} data-testid="policy-watch-item" data-watch={watch.watch_id}>
              <div className={styles.watchHead}>
                <b>
                  {watch.platform} · {watch.market}
                </b>
                {watch.last_result && (
                  <span
                    className={styles.state}
                    data-tone={watchTone(watch)}
                    data-result={watch.last_result}
                  >
                    {RESULT_META[watch.last_result as 'unchanged' | 'changed' | 'failed']?.label ??
                      watch.last_result}
                  </span>
                )}
                {!watch.allowed && (
                  <span className={styles.state} data-tone="danger">
                    来源不在白名单
                  </span>
                )}
              </div>
              <p className={styles.source}>
                <code>{watch.snapshot_id}</code> · {watch.source_url}
              </p>
              <p className={styles.muted}>{describeLastCheck(watch)}</p>

              {candidatesFor(overview.candidates, watch.watch_id).map(candidate => (
                <CandidateRow
                  key={candidate.candidate_id}
                  candidate={candidate}
                  operator={operator}
                  reason={reason}
                  busy={busy}
                  onApprove={() =>
                    run(
                      () => approveCandidate(candidate.candidate_id, operator, reason, productId),
                      '已确认来源发生变化；规则仍未改动。',
                    )
                  }
                  onReject={() =>
                    run(
                      () => rejectCandidate(candidate.candidate_id, operator, reason, productId),
                      '已否决该候选记录。',
                    )
                  }
                />
              ))}
            </li>
          ))}
        </ul>
      )}

      {pending.length > 0 && (
        <div className={styles.reviewer}>
          <label>
            <span>复核人</span>
            <input
              type="text"
              value={operator}
              data-testid="policy-watch-operator"
              onChange={e => setOperator(e.target.value)}
            />
          </label>
          <label>
            <span>说明</span>
            <input
              type="text"
              value={reason}
              data-testid="policy-watch-reason"
              onChange={e => setReason(e.target.value)}
            />
          </label>
        </div>
      )}

      {markets.length > 0 && (
        <div className={styles.coverage} data-testid="policy-coverage">
          <h4>市场政策覆盖</h4>
          <ul>
            {covered.map(m => (
              <li key={m.market} data-covered="1">
                <b>
                  {m.label} {m.market}
                </b>
                <span className={styles.muted}>
                  {m.language} · {m.currency} · 已覆盖 {m.covered_platforms.join('、')}
                </span>
              </li>
            ))}
            {uncovered.map(m => (
              <li key={m.market} data-covered="0" data-testid="policy-uncovered">
                <b>
                  {m.label} {m.market}
                </b>
                <span className={styles.notCovered}>政策未覆盖，需人工复核</span>
                <em>{m.note}</em>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function CandidateRow({
  candidate,
  operator,
  reason,
  busy,
  onApprove,
  onReject,
}: {
  candidate: PolicyCandidate;
  operator: string;
  reason: string;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const settled = candidate.state !== 'changed';
  return (
    <div className={styles.candidate} data-testid="policy-candidate" data-state={candidate.state}>
      <div className={styles.candidateHead}>
        <code>{candidate.candidate_id}</code>
        <span className={styles.muted}>
          抓取于 {candidate.retrieved_at} · HTTP {candidate.http_status}
        </span>
      </div>
      <p className={styles.excerpt} data-testid="policy-candidate-excerpt">
        {candidate.excerpt}
      </p>
      <p className={styles.muted}>
        当前快照 <code>{candidate.current_snapshot_id}</code> · 内容指纹{' '}
        <code>{candidate.previous_content_hash.slice(0, 10) || '—'}</code> →{' '}
        <code>{candidate.content_hash.slice(0, 10)}</code>
      </p>

      {candidate.interpretation && (
        <p className={styles.assisted} data-testid="policy-interpretation">
          模型解读（仅供参考）：{candidate.interpretation.summary}
          <em>{candidate.interpretation.note}</em>
        </p>
      )}

      {settled ? (
        <p className={styles.settled} data-testid="policy-candidate-settled">
          {candidate.state === 'approved' ? '已确认' : '已否决'} · {candidate.reviewed_by} ·{' '}
          {candidate.reviewed_at}
          {candidate.review_note && ` · ${candidate.review_note}`}
          {approvalMeaning(candidate) && <em>{approvalMeaning(candidate)}</em>}
        </p>
      ) : (
        <div className={styles.candidateActions}>
          <button
            type="button"
            disabled={busy || !operator.trim()}
            data-testid="policy-candidate-approve"
            onClick={onApprove}
          >
            确认来源已变化
          </button>
          <button
            type="button"
            disabled={busy || !operator.trim() || !reason.trim()}
            data-testid="policy-candidate-reject"
            onClick={onReject}
          >
            否决
          </button>
        </div>
      )}
    </div>
  );
}

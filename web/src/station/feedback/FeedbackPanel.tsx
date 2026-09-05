import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from 'tldraw';
import { openRevisionForReview } from '@/pipeline/nodes/types/listingInspector';
import {
  CONFIDENCE_LABEL,
  SIGNAL_LABEL,
  createExperiment,
  feedbackErrorMessage,
  fetchAnalysis,
  fetchComparison,
  fetchRevisionContent,
  importFile,
  listExperiments,
  listImports,
  promoteSignal,
  templateUrl,
  type Analysis,
  type Comparison,
  type Experiment,
  type ImportRecord,
  type Signal,
} from './feedbackApi';
import {
  METRIC_ROWS,
  comparisonCaveats,
  describeDelta,
  formatCount,
  formatRate,
  orderSignals,
  sampleSummary,
} from './feedbackModel';
import styles from './feedbackPanel.module.scss';

// 反馈实验室 — a dedicated analytics panel, deliberately not on the canvas.
//
// Tables of numbers belong in a table. The canvas gets, at most, a concise
// candidate node; everything that needs columns, sample sizes and caveats lives
// here where there is room to show them honestly.

export function FeedbackPanel({
  onClose,
  editor,
  productId = 'default-product',
}: {
  onClose: () => void;
  /** Needed to hand a created candidate to the listing review interface. */
  editor: Editor | null;
  productId?: string;
}) {
  const [imports, setImports] = useState<ImportRecord[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [hypothesis, setHypothesis] = useState('');
  const [baseline, setBaseline] = useState('');
  const [candidate, setCandidate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Draft candidate copy per signal index, prefilled from the baseline. */
  const [drafts, setDrafts] = useState<Record<number, { title: string; fields: { label: string; value: string }[] }>>({});
  const [created, setCreated] = useState<Record<number, { revisionId: string; platform: string; replayed: boolean }>>({});
  const [operator, setOperator] = useState('');
  const [notice, setNotice] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    closeRef.current?.focus();
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const [rows, exps] = await Promise.all([
        listImports(productId, signal),
        listExperiments(productId, signal),
      ]);
      if (!mounted.current) return;
      setImports(rows);
      setExperiments(exps);
      if (!selected && rows.length > 0) setSelected(rows[rows.length - 1].import_id);
    },
    [productId, selected],
  );

  useEffect(() => {
    const controller = new AbortController();
    reload(controller.signal).catch(err => {
      if (!controller.signal.aborted && mounted.current) setError(feedbackErrorMessage(err));
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  useEffect(() => {
    if (!selected) return;
    setComparison(null);
    fetchAnalysis(selected, productId)
      .then(a => mounted.current && setAnalysis(a))
      .catch(err => mounted.current && setError(feedbackErrorMessage(err)));
  }, [selected, productId]);

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await reload();
      if (mounted.current) setNotice(done);
    } catch (err) {
      if (mounted.current) setError(feedbackErrorMessage(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  /**
   * Load the baseline copy so the operator edits real text rather than being
   * shown invented "improved" copy. The signal supplies a direction; a human
   * writes the words.
   */
  const prepareCandidate = async (index: number, signal: Signal) => {
    setError('');
    try {
      const baseline = await fetchRevisionContent(signal.revision_id, productId);
      if (!mounted.current) return;
      setDrafts(prev => ({ ...prev, [index]: baseline.revision.content }));
    } catch (err) {
      if (mounted.current) setError(feedbackErrorMessage(err));
    }
  };

  const createCandidate = async (index: number, signal: Signal) => {
    const draft = drafts[index];
    if (!draft) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await promoteSignal(
        selected,
        index,
        operator,
        draft,
        // Stable across re-renders and double clicks, so a retry replays the
        // first candidate instead of forking another one.
        `${selected}:${index}:${signal.revision_id}`,
        productId,
      );
      if (!mounted.current) return;
      setCreated(prev => ({
        ...prev,
        [index]: {
          revisionId: result.revision.revision_id,
          // The revision's own platform, not a guess from the import data:
          // the review inspector must open the tab this candidate belongs to.
          platform: result.revision.platform,
          replayed: result.replayed,
        },
      }));
      setNotice(
        result.replayed
          ? '该信号已经创建过候选修订，这里返回的是同一条。'
          : '已创建候选修订；原已批准修订未被改动。',
      );
    } catch (err) {
      if (mounted.current) setError(feedbackErrorMessage(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const revisions = analysis ? Object.keys(analysis.by_revision) : [];

  return (
    <div
      className={styles.drawer}
      role="dialog"
      aria-modal="true"
      aria-labelledby="feedback-title"
      data-testid="feedback-panel"
    >
      <div className={styles.mask} aria-hidden="true" onClick={onClose} />
      <aside>
        <header>
          <div>
            <div className={styles.kicker}>反馈实验室</div>
            <h2 id="feedback-title">导入表现数据 → 观测信号 → 候选改进 → 实验</h2>
          </div>
          <button ref={closeRef} type="button" className={styles.ghost} onClick={onClose}>
            关闭
          </button>
        </header>

        <p className={styles.disclaimer} data-testid="feedback-disclaimer">
          数据来自<strong>人工导入的表格</strong>，不是平台实时接口。
          这里给出的都是<strong>观测到的相关性</strong>，不是因果结论，也不预测提升幅度。
          发现的问题只会变成<strong>候选修订</strong>，不会自动改动任何已批准内容。
        </p>

        <div className={styles.actions}>
          <a className={styles.ghost} href={templateUrl()} download data-testid="feedback-template">
            下载导入模板
          </a>
          <button
            type="button"
            disabled={busy}
            data-testid="feedback-import"
            onClick={() => fileRef.current?.click()}
          >
            导入表现数据
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className={styles.file}
            data-testid="feedback-file"
            onChange={e => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void run(() => importFile(file, productId), '已导入。');
            }}
          />
          {imports.length > 0 && (
            <select
              value={selected}
              data-testid="feedback-select-import"
              onChange={e => setSelected(e.target.value)}
            >
              {imports.map(row => (
                <option key={row.import_id} value={row.import_id}>
                  {row.import_id} · {row.filename || '未命名'} · {row.row_count} 行
                </option>
              ))}
            </select>
          )}
        </div>

        {error && (
          <p className={styles.error} role="alert" data-testid="feedback-error">
            {error}
          </p>
        )}
        {notice && !error && (
          <p className={styles.notice} role="status" data-testid="feedback-notice">
            {notice}
          </p>
        )}

        {analysis && (
          <>
            {analysis.problems.length > 0 && (
              <section className={styles.section} data-testid="feedback-problems">
                <h3>未导入的行（{analysis.problems.length}）</h3>
                <ul className={styles.problems}>
                  {analysis.problems.map(p => (
                    <li key={`${p.line}-${p.code}`}>
                      第 {p.line} 行：{p.message}
                    </li>
                  ))}
                </ul>
                <p className={styles.muted}>其余行已正常导入，未受影响。</p>
              </section>
            )}

            <section className={styles.section} data-testid="feedback-overall">
              <h3>总体</h3>
              <p className={styles.muted}>
                {analysis.overall.rows} 行 · {analysis.overall.period_start} →{' '}
                {analysis.overall.period_end}
              </p>
              <table className={styles.metrics}>
                <tbody>
                  {METRIC_ROWS.map(metric => (
                    <tr key={String(metric.key)}>
                      <th>{metric.label}</th>
                      <td>
                        {metric.rate
                          ? formatRate(analysis.overall[metric.key] as number | null)
                          : formatCount(analysis.overall[metric.key] as number | null)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {analysis.overall.warnings.map(w => (
                <p className={styles.warn} key={w} data-testid="feedback-warning">
                  {w}
                </p>
              ))}
            </section>

            <section className={styles.section} data-testid="feedback-signals">
              <h3>观测到的信号（{analysis.signals.length}）</h3>
              {analysis.signals.length === 0 ? (
                <p className={styles.muted} data-testid="feedback-no-signals">
                  本次导入没有触发任何检测阈值，因此没有可操作的改进建议。
                  这不代表文案没有问题，只代表这批数据里没有达到阈值的信号。
                </p>
              ) : (
                <ul className={styles.signals}>
                  {orderSignals(analysis.signals).map(s => {
                    // orderSignals re-sorts by confidence, so the render index
                    // is NOT the backend's signal_index. Promoting by the render
                    // index would create a candidate for a different signal than
                    // the one that was clicked.
                    const i = analysis.signals.indexOf(s);
                    return (
                    <li
                      key={`${s.signal}-${s.revision_id}-${i}`}
                      data-testid="feedback-signal"
                      data-signal={s.signal}
                      data-confidence={s.confidence}
                    >
                      <div className={styles.signalHead}>
                        <b>{SIGNAL_LABEL[s.signal]}</b>
                        <code>{s.revision_id}</code>
                        <span className={styles.confidence} data-level={s.confidence}>
                          置信度{CONFIDENCE_LABEL[s.confidence]}
                        </span>
                      </div>
                      <p className={styles.observed}>{s.observed}</p>
                      <p className={styles.proposal}>
                        建议方向（{s.affected_field}）：{s.proposal}
                      </p>
                      <p className={styles.muted} data-testid="feedback-evidence">
                        证据：{s.supporting_rows.length} 行原始数据（第{' '}
                        {s.supporting_rows.join('、')} 行）
                        {analysis.overall.period_start && analysis.overall.period_end
                          ? ` · 数据区间 ${analysis.overall.period_start} 至 ${analysis.overall.period_end}`
                          : ' · 数据区间未知（导入文件缺少日期列）'}
                        {' '}· 影响修订 <code>{s.revision_id}</code> 的「{s.affected_field}」
                      </p>
                      <p className={styles.muted}>风险：{s.risks}</p>
                      {s.quotes.length > 0 && (
                        <ul className={styles.quotes}>
                          {s.quotes.map((q, qi) => (
                            <li key={qi}>“{q}”</li>
                          ))}
                        </ul>
                      )}
                      <p className={styles.causality}>{s.causality}</p>

                      {created[i] ? (
                        <div className={styles.candidateBox} data-testid="feedback-created">
                          <p className={styles.ok}>
                            候选修订 <code>{created[i].revisionId}</code> 已创建
                            {created[i].replayed && '（重复请求，返回同一条）'}
                            ，原已批准修订未被改动。
                          </p>
                          <button
                            type="button"
                            data-testid="feedback-open-review"
                            onClick={() => {
                              if (!editor) return;
                              openRevisionForReview(
                                editor,
                                created[i].platform,
                                created[i].revisionId,
                              );
                              onClose();
                            }}
                          >
                            在审核中打开并对比
                          </button>
                        </div>
                      ) : drafts[i] ? (
                        <div className={styles.candidateBox} data-testid="feedback-draft">
                          <label>
                            <span>候选标题（基于基线修订，请自行改写）</span>
                            <input
                              type="text"
                              value={drafts[i].title}
                              data-testid="feedback-draft-title"
                              onChange={e =>
                                setDrafts(prev => ({
                                  ...prev,
                                  [i]: { ...prev[i], title: e.target.value },
                                }))
                              }
                            />
                          </label>
                          <label>
                            <span>操作人</span>
                            <input
                              type="text"
                              value={operator}
                              data-testid="feedback-operator"
                              onChange={e => setOperator(e.target.value)}
                            />
                          </label>
                          <button
                            type="button"
                            className={styles.primary}
                            disabled={busy || !operator.trim() || !drafts[i].title.trim()}
                            data-testid="feedback-create-candidate"
                            onClick={() => void createCandidate(i, s)}
                          >
                            创建候选版本
                          </button>
                          <p className={styles.muted}>
                            这里预填的是基线修订的原文，不是模型生成的「改进版」。
                            候选修订会进入审核流程，需要校验与批准后才可能替换现有版本。
                          </p>
                        </div>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          data-testid="feedback-prepare-candidate"
                          onClick={() => void prepareCandidate(i, s)}
                        >
                          创建候选版本…
                        </button>
                      )}
                    </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {revisions.length >= 2 && (
              <section className={styles.section} data-testid="feedback-compare">
                <h3>对比</h3>
                <div className={styles.compareRow}>
                  {revisions.slice(0, 4).map(left =>
                    revisions
                      .filter(r => r > left)
                      .slice(0, 1)
                      .map(right => (
                        <button
                          key={`${left}-${right}`}
                          type="button"
                          disabled={busy}
                          data-testid="feedback-compare-btn"
                          onClick={() =>
                            fetchComparison(selected, { mode: 'revision', left, right }, productId)
                              .then(c => mounted.current && setComparison(c))
                              .catch(err => mounted.current && setError(feedbackErrorMessage(err)))
                          }
                        >
                          {left} ↔ {right}
                        </button>
                      )),
                  )}
                </div>

                {comparison && (
                  <div className={styles.comparison} data-testid="feedback-comparison">
                    <p className={styles.muted} data-testid="feedback-samples">
                      {sampleSummary(comparison)}
                    </p>
                    <ul className={styles.deltas}>
                      {Object.entries(comparison.deltas).map(([metric, delta]) => (
                        <li key={metric}>{describeDelta(metric, delta)}</li>
                      ))}
                    </ul>
                    {comparisonCaveats(comparison).map(caveat => (
                      <p className={styles.causality} key={caveat} data-testid="feedback-caveat">
                        {caveat}
                      </p>
                    ))}
                  </div>
                )}
              </section>
            )}
          </>
        )}

        <section className={styles.section} data-testid="feedback-experiments">
          <h3>实验</h3>
          <div className={styles.experimentForm}>
            <label>
              <span>假设</span>
              <input
                type="text"
                value={hypothesis}
                data-testid="experiment-hypothesis"
                onChange={e => setHypothesis(e.target.value)}
              />
            </label>
            <label>
              <span>基线修订</span>
              <input
                type="text"
                value={baseline}
                data-testid="experiment-baseline"
                onChange={e => setBaseline(e.target.value)}
              />
            </label>
            <label>
              <span>候选修订</span>
              <input
                type="text"
                value={candidate}
                data-testid="experiment-candidate"
                onChange={e => setCandidate(e.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={busy || !hypothesis.trim() || !baseline.trim()}
              data-testid="experiment-create"
              onClick={() =>
                run(
                  () =>
                    createExperiment(
                      {
                        hypothesis,
                        baseline_revision_id: baseline,
                        candidate_revision_id: candidate,
                      },
                      productId,
                    ),
                  '已登记实验。',
                )
              }
            >
              登记实验
            </button>
          </div>

          {experiments.length > 0 && (
            <ul className={styles.experiments}>
              {experiments.map(exp => (
                <li key={exp.experiment_id} data-testid="experiment-row" data-state={exp.state}>
                  <div className={styles.signalHead}>
                    <code>{exp.experiment_id}</code>
                    <span className={styles.confidence} data-level="medium">
                      {exp.state}
                    </span>
                  </div>
                  <p className={styles.observed}>{exp.hypothesis}</p>
                  <p className={styles.muted}>
                    基线 <code>{exp.baseline_revision_id}</code>
                    {exp.candidate_revision_id && (
                      <>
                        {' '}
                        · 候选 <code>{exp.candidate_revision_id}</code>
                      </>
                    )}{' '}
                    · 主指标 {exp.primary_metric} · 护栏 {exp.guardrail_metrics.join('、')}
                  </p>
                  {exp.result && (
                    <p className={styles.causality}>{exp.result.interpretation}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className={styles.muted}>
            实验记录只描述计划与观测，不预测提升幅度，也不会自动改动任何修订。
          </p>
        </section>
      </aside>
    </div>
  );
}

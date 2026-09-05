import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ORIGIN_LABEL,
  REVIEW_STATE_META,
  evidenceBlobUrl,
  extractSource,
  fetchCandidates,
  fetchCapabilities,
  intakeErrorMessage,
  reviewCandidate,
  type Candidate,
  type Capabilities,
  type ExtractResult,
  type FactConflict,
} from './intakeApi';
import { boxPercent, describeConfidence, groupLines, lowConfidenceWords } from './ocrBoxes';
import styles from './intakeReview.module.scss';

// Reading uploads, and showing the operator exactly what was read.
//
// The OCR overlay is the point of this panel, not decoration: it puts the
// machine's reading next to the pixels it came from, so a wrong number is
// caught before it becomes a fact. Nothing here can produce a verified fact —
// approving a candidate says "the machine read this correctly", which is a
// smaller claim than "this is true", and the two stay separate all the way
// down to the ledger.

export function IntakeReview({
  sourceId,
  sourceMime,
  productId,
  onLedgerChange,
}: {
  sourceId: string;
  sourceMime: string;
  productId: string;
  onLedgerChange?: () => void;
}) {
  const [result, setResult] = useState<ExtractResult | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [conflicts, setConflicts] = useState<FactConflict[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [operator, setOperator] = useState('');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dims, setDims] = useState({ width: 0, height: 0 });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchCapabilities(productId, controller.signal)
      .then(c => mounted.current && setCapabilities(c))
      .catch(() => undefined);
    fetchCandidates(productId, controller.signal)
      .then(d => {
        if (!mounted.current) return;
        setCandidates(d.candidates);
        setConflicts(d.conflicts);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [productId]);

  const runExtract = useCallback(async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const extracted = await extractSource(sourceId, productId);
      if (!mounted.current) return;
      setResult(extracted);
      setConflicts(extracted.conflicts);
      const all = await fetchCandidates(productId);
      if (mounted.current) setCandidates(all.candidates);
      setNotice(extracted.note);
    } catch (err) {
      if (mounted.current) setError(intakeErrorMessage(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [sourceId, productId]);

  const decide = async (
    candidate: Candidate,
    decision: 'approved' | 'rejected' | 'corrected',
  ) => {
    setBusy(true);
    setError('');
    try {
      await reviewCandidate(
        candidate.candidate_id,
        decision,
        operator,
        { value: edits[candidate.candidate_id] },
        productId,
      );
      const all = await fetchCandidates(productId);
      if (mounted.current) {
        setCandidates(all.candidates);
        setConflicts(all.conflicts);
        setNotice(
          decision === 'rejected'
            ? '已否决该读数，不会进入事实账本。'
            : '已确认读数并写入事实账本，仍需在证据页核实后才算已核实。',
        );
      }
      onLedgerChange?.();
    } catch (err) {
      if (mounted.current) setError(intakeErrorMessage(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const ocr = result?.ocr ?? null;
  const isImage = sourceMime.startsWith('image/');
  const mine = candidates.filter(c => c.source_id === sourceId);

  return (
    <section className={styles.block} data-testid="intake-review">
      <div className={styles.head}>
        <h4>读取内容</h4>
        <span className={styles.kicker}>提取只说明文件写了什么，不代表它为真</span>
      </div>

      {capabilities && (
        <p className={styles.capability} data-testid="intake-ocr-capability">
          {capabilities.ocr.available
            ? `OCR：${capabilities.ocr.provider} ${capabilities.ocr.version}，语言 ${capabilities.ocr.languages.join('、') || '—'}。`
            : 'OCR：未安装引擎。'}
          {capabilities.ocr.note}
        </p>
      )}

      <div className={styles.actions}>
        <button type="button" disabled={busy} data-testid="intake-extract" onClick={runExtract}>
          {busy ? '读取中…' : '读取并提取事实'}
        </button>
      </div>

      {error && (
        <p className={styles.error} role="alert" data-testid="intake-error">
          {error}
        </p>
      )}
      {notice && !error && (
        <p className={styles.notice} role="status" data-testid="intake-notice">
          {notice}
        </p>
      )}

      {isImage && ocr && (
        <div className={styles.viewer} data-testid="intake-viewer">
          <div className={styles.imageWrap}>
            <img
              src={evidenceBlobUrl(sourceId, productId)}
              alt="证据原图"
              data-testid="intake-image"
              onLoad={e =>
                setDims({
                  width: (e.target as HTMLImageElement).naturalWidth,
                  height: (e.target as HTMLImageElement).naturalHeight,
                })
              }
            />
            {dims.width > 0 &&
              ocr.words.map((word, i) => {
                const rect = boxPercent(word.box, dims.width, dims.height);
                return (
                  <i
                    key={`${word.text}-${i}`}
                    className={styles.box}
                    data-testid="intake-ocr-box"
                    data-confidence={Math.round(word.confidence)}
                    data-low={word.confidence < 75 ? '1' : undefined}
                    title={`${word.text} · ${word.confidence.toFixed(0)}%`}
                    style={{
                      left: `${rect.left}%`,
                      top: `${rect.top}%`,
                      width: `${rect.width}%`,
                      height: `${rect.height}%`,
                    }}
                  />
                );
              })}
          </div>

          <div className={styles.readout}>
            {ocr.state === 'ok' ? (
              <>
                <p className={styles.muted}>
                  识别 {ocr.words.length} 个词，平均置信度 {ocr.mean_confidence.toFixed(0)}%
                  {lowConfidenceWords(ocr.words).length > 0 && (
                    <b className={styles.warnInline}>
                      　其中 {lowConfidenceWords(ocr.words).length} 个词置信度偏低，请核对
                    </b>
                  )}
                </p>
                <ol className={styles.lines} data-testid="intake-ocr-lines">
                  {groupLines(ocr.words).map(line => (
                    <li key={line.line}>
                      {line.words.map((w, i) => (
                        <span key={i} data-low={w.confidence < 75 ? '1' : undefined}>
                          {w.text}
                        </span>
                      ))}
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <p className={styles.unavailable} data-testid="intake-ocr-unavailable">
                {ocr.detail || '未能读取图片中的文字。'}
                {ocr.reason === 'ocr_unavailable' &&
                  '这不是「检查通过」，相关事实仍需人工阅读确认。'}
              </p>
            )}
          </div>
        </div>
      )}

      {mine.length > 0 && (
        <>
          <label className={styles.operator}>
            <span>审核人</span>
            <input
              type="text"
              value={operator}
              placeholder="确认或更正读数需要署名"
              data-testid="intake-operator"
              onChange={e => setOperator(e.target.value)}
            />
          </label>

          <ul className={styles.candidates} data-testid="intake-candidates">
            {mine.map(candidate => {
              const meta = REVIEW_STATE_META[candidate.review_state];
              const settled = candidate.review_state !== 'needs_review';
              return (
                <li
                  key={candidate.candidate_id}
                  data-testid="intake-candidate"
                  data-key={candidate.key}
                  data-state={candidate.review_state}
                >
                  <div className={styles.candidateHead}>
                    <b>{candidate.label}</b>
                    <span className={styles.state} data-tone={meta.tone}>
                      {meta.label}
                    </span>
                    <span className={styles.muted}>
                      {ORIGIN_LABEL[candidate.origin] ?? candidate.origin} ·{' '}
                      {describeConfidence(candidate)}
                    </span>
                  </div>
                  {candidate.excerpt && (
                    <p className={styles.excerpt}>原文：{candidate.excerpt}</p>
                  )}
                  {candidate.corrected_from && (
                    <p className={styles.muted}>
                      原读数 <code>{candidate.corrected_from}</code> 已由 {candidate.reviewed_by} 更正
                    </p>
                  )}
                  <div className={styles.candidateActions}>
                    <input
                      type="text"
                      className={styles.valueInput}
                      value={edits[candidate.candidate_id] ?? candidate.value}
                      disabled={settled}
                      data-testid="intake-value"
                      onChange={e =>
                        setEdits(prev => ({
                          ...prev,
                          [candidate.candidate_id]: e.target.value,
                        }))
                      }
                    />
                    <button
                      type="button"
                      disabled={busy || settled || !operator.trim()}
                      data-testid="intake-approve"
                      onClick={() => decide(candidate, 'approved')}
                    >
                      确认读数
                    </button>
                    <button
                      type="button"
                      disabled={
                        busy ||
                        settled ||
                        !operator.trim() ||
                        (edits[candidate.candidate_id] ?? candidate.value) === candidate.value
                      }
                      data-testid="intake-correct"
                      onClick={() => decide(candidate, 'corrected')}
                    >
                      更正后确认
                    </button>
                    <button
                      type="button"
                      disabled={busy || settled || !operator.trim()}
                      data-testid="intake-reject"
                      onClick={() => decide(candidate, 'rejected')}
                    >
                      否决
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          <p className={styles.muted}>
            「确认读数」只表示机器读对了，事实仍会以<strong>待确认</strong>状态进入账本，
            要在「证据」区核实后才算已核实。
          </p>
        </>
      )}

      {conflicts.length > 0 && (
        <div className={styles.conflicts} data-testid="intake-conflicts">
          <h4>来源冲突（{conflicts.length}）</h4>
          <ul>
            {conflicts.map(conflict => (
              <li key={conflict.conflict_id} data-key={conflict.key}>
                <b>{conflict.label}</b>
                <span className={styles.muted}>
                  {conflict.readings
                    .map(r => `${ORIGIN_LABEL[r.origin] ?? r.origin} ${r.display}`)
                    .join(' / ')}
                </span>
                <em>不同来源给出不同取值，需人工判定以哪个为准。</em>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Honest disclosure of whether an uploaded image can condition generation. */
export function ReferenceImageNotice({ capabilities }: { capabilities: Capabilities | null }) {
  if (!capabilities) return null;
  const supported = capabilities.reference_image.supported;
  return (
    <p
      className={supported ? styles.notice : styles.unavailable}
      data-testid="reference-image-notice"
      data-supported={supported ? '1' : '0'}
    >
      {supported
        ? `上传图可作为参考图参与出图（字段 ${capabilities.reference_image.field}）。只有真正随请求发送时才会标注「已使用参考图」。`
        : capabilities.reference_image.reason}
    </p>
  );
}

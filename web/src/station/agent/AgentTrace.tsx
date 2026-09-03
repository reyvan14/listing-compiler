import { useState } from 'react';
import styles from './agentTrace.module.scss';
import { currentEntry, type TraceEntry } from './trace';

// 执行过程 — what the Agent actually did, in order.
//
// Every row corresponds to a real step the product performed and the user
// could verify. It is not, and must not become, a view of model reasoning:
// nothing the model emits reaches this component, and there are no percentages
// because there is no honest number to put in one.

export function AgentTrace({
  entries,
  elapsedMs,
}: {
  entries: TraceEntry[];
  /** Wall time for the turn, shown only once it has settled. */
  elapsedMs?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  if (entries.length === 0) return null;

  const current = currentEntry(entries);
  const running = entries.some(e => e.state === 'active');

  return (
    <section className={styles.trace} aria-label="执行过程" data-testid="agent-trace">
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={expanded}
        onClick={() => setExpanded(v => !v)}
      >
        <span
          className={`${styles.dot} ${running ? styles.dotActive : ''} ${
            current?.state === 'failed' ? styles.dotFailed : ''
          }`}
          aria-hidden="true"
        />
        <span className={styles.currentLabel}>{current?.label ?? '执行过程'}</span>
        <span className={styles.toggleHint}>{expanded ? '收起' : '查看执行过程'}</span>
      </button>

      {expanded && (
        <ol className={styles.steps}>
          {entries.map(entry => (
            <li
              key={`${entry.stage}-${entry.sequence}`}
              className={styles.step}
              data-state={entry.state}
              data-stage={entry.stage}
            >
              <span className={styles.mark} aria-hidden="true">
                {entry.state === 'done' ? '✓' : entry.state === 'failed' ? '×' : '·'}
              </span>
              <span className={styles.stepBody}>
                <span className={styles.stepLabel}>{entry.label}</span>
                {entry.detail && <span className={styles.stepDetail}>{entry.detail}</span>}
              </span>
              {entry.at > 0 && (
                <span className={styles.stepTime}>{(entry.at / 1000).toFixed(1)}s</span>
              )}
            </li>
          ))}
          {!running && typeof elapsedMs === 'number' && elapsedMs > 0 && (
            <li className={styles.total}>共用时 {(elapsedMs / 1000).toFixed(1)}s</li>
          )}
        </ol>
      )}
    </section>
  );
}

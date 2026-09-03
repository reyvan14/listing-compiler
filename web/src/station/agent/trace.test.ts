import { describe, expect, it } from 'vitest';
import { advanceTrace, currentEntry, isTraceStage, STAGE_LABELS } from './trace';

describe('execution trace', () => {
  const build = () => {
    let entries = advanceTrace([], { stage: 'understanding', sequence: 1 });
    entries = advanceTrace(entries, { stage: 'reading_canvas', sequence: 2, detail: '3 个节点' });
    entries = advanceTrace(entries, { stage: 'planning', sequence: 3 });
    return entries;
  };

  it('preserves event order and settles the previous stage', () => {
    const entries = build();
    expect(entries.map(e => e.stage)).toEqual(['understanding', 'reading_canvas', 'planning']);
    expect(entries.map(e => e.state)).toEqual(['done', 'done', 'active']);
  });

  it('exposes the active stage as the collapsed row', () => {
    expect(currentEntry(build())?.stage).toBe('planning');
  });

  it('marks earlier stages failed when the turn fails', () => {
    const entries = advanceTrace(build(), { stage: 'failed', detail: '上游中断' });
    expect(entries.at(-1)).toMatchObject({ stage: 'failed', state: 'failed' });
    expect(entries.find(e => e.stage === 'planning')?.state).toBe('failed');
  });

  it('updates a repeated stage in place rather than stacking rows', () => {
    let entries = advanceTrace(build(), { stage: 'generating', detail: '1/5' });
    entries = advanceTrace(entries, { stage: 'generating', detail: '2/5' });
    const generating = entries.filter(e => e.stage === 'generating');
    expect(generating).toHaveLength(1);
    expect(generating[0].detail).toBe('2/5');
  });

  it('treats ready as a settled stage, not an ongoing one', () => {
    const entries = advanceTrace(build(), { stage: 'ready' });
    expect(entries.at(-1)?.state).toBe('done');
    expect(entries.some(e => e.state === 'active')).toBe(false);
  });

  it('rejects stage names that are not part of the protocol', () => {
    expect(isTraceStage('planning')).toBe(true);
    expect(isTraceStage('thinking')).toBe(false);
    expect(isTraceStage(42)).toBe(false);
  });

  it('never labels any stage as the model thinking', () => {
    // The product shows 执行过程, never 思考过程.
    for (const label of Object.values(STAGE_LABELS)) {
      expect(label).not.toContain('思考');
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  CAUSALITY_CAVEAT,
  METRIC_ROWS,
  comparisonCaveats,
  describeDelta,
  formatCount,
  formatRate,
  missingDataWarnings,
  orderSignals,
  sampleSummary,
} from './feedbackModel';
import { CONFIDENCE_LABEL, SIGNAL_LABEL, type Comparison, type Signal } from './feedbackApi';

const signal = (over: Partial<Signal> = {}): Signal =>
  ({
    signal: 'elevated_return_rate',
    revision_id: 'rev-0001',
    observed: '退货率 12%',
    measurements: {},
    affected_field: '描述',
    proposal: '核对尺寸描述',
    supporting_rows: [2, 3],
    quotes: [],
    confidence: 'high',
    risks: '退货也可能与物流有关',
    causality: '观测到的相关性，不是因果结论。',
    ...over,
  }) as Signal;

const comparison = (over: Partial<Comparison> = {}): Comparison =>
  ({
    left_label: 'rev-0001',
    right_label: 'rev-0002',
    left: { rows: 2, warnings: [] },
    right: { rows: 2, warnings: [] },
    deltas: { ctr: { left: 0.015, right: 0.034, absolute: 0.019, relative: 1.2667 } },
    left_sample: { rows: 2, impressions: 12000, window: ['2026-08-01', '2026-08-14'] },
    right_sample: { rows: 2, impressions: 11800, window: ['2026-08-15', '2026-08-28'] },
    low_sample: false,
    causality_note: '这是两组观测数据的差异，不是因果结论。',
    warnings: [],
    ...over,
  }) as Comparison;

describe('formatting', () => {
  it('renders missing values as em dashes rather than zero', () => {
    expect(formatRate(null)).toBe('—');
    expect(formatRate(undefined)).toBe('—');
    expect(formatCount(null)).toBe('—');
    expect(formatRate(0.0234)).toBe('2.34%');
    expect(formatCount(12000)).toBe('12,000');
  });

  it('renders a real zero as zero, not as missing', () => {
    expect(formatRate(0)).toBe('0.00%');
    expect(formatCount(0)).toBe('0');
  });
});

describe('deltas are observations', () => {
  it('describes direction without asserting a cause', () => {
    const text = describeDelta('点击率', comparison().deltas.ctr);
    expect(text).toContain('后一组比前一组高');
    for (const forbidden of ['提升了', '带来', '导致', '因为']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('says data is insufficient rather than showing a fake zero', () => {
    expect(describeDelta('转化率', null)).toContain('数据不足');
  });

  it('always carries the causality caveat with the numbers', () => {
    const caveats = comparisonCaveats(comparison());
    expect(caveats.some(c => c.includes('不是因果结论'))).toBe(true);
    expect(CAUSALITY_CAVEAT).toContain('不代表因果关系');
  });

  it('adds a noise warning when the sample is small', () => {
    const caveats = comparisonCaveats(comparison({ low_sample: true }));
    expect(caveats.some(c => c.includes('噪声'))).toBe(true);
  });

  it('does not duplicate a warning the backend already sent', () => {
    const caveats = comparisonCaveats(
      comparison({ low_sample: true, warnings: ['样本量偏小，差异可能只是噪声。'] }),
    );
    expect(new Set(caveats).size).toBe(caveats.length);
  });
});

describe('sample reporting', () => {
  it('shows both sizes and both windows so a reader can judge the comparison', () => {
    const text = sampleSummary(comparison());
    expect(text).toContain('12,000');
    expect(text).toContain('11,800');
    expect(text).toContain('2026-08-01');
    expect(text).toContain('2026-08-28');
  });
});

describe('signals', () => {
  it('puts the strongest evidence first', () => {
    const rows = orderSignals([
      signal({ confidence: 'low', revision_id: 'a' }),
      signal({ confidence: 'high', revision_id: 'b' }),
      signal({ confidence: 'medium', revision_id: 'c' }),
    ]);
    expect(rows.map(r => r.confidence)).toEqual(['high', 'medium', 'low']);
  });

  it('labels every signal kind and confidence level', () => {
    for (const kind of Object.keys(SIGNAL_LABEL) as Signal['signal'][]) {
      expect(SIGNAL_LABEL[kind]).toBeTruthy();
    }
    for (const level of ['low', 'medium', 'high'] as const) {
      expect(CONFIDENCE_LABEL[level]).toBeTruthy();
    }
  });

  it('never labels a signal as a proven cause', () => {
    for (const label of Object.values(SIGNAL_LABEL)) {
      expect(label).not.toContain('导致');
      expect(label).not.toContain('因为');
    }
  });
});

describe('missing data', () => {
  it('surfaces the backend warnings rather than hiding gaps', () => {
    expect(missingDataWarnings({ rows: 1, warnings: ['2/3 行缺少 purchases'] })).toHaveLength(1);
    expect(missingDataWarnings(undefined)).toEqual([]);
  });
});

describe('metric table', () => {
  it('covers the metrics the spec names, in a stable order', () => {
    const keys = METRIC_ROWS.map(r => r.key);
    expect(keys).toEqual([
      'impressions', 'clicks', 'ctr', 'add_to_cart', 'purchases', 'cvr', 'returns', 'return_rate',
    ]);
  });
});

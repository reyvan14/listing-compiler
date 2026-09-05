import type { Aggregate, Comparison, Signal } from './feedbackApi';

// Presentation rules for the Feedback Lab.
//
// The single thing these helpers exist to prevent: a difference between two
// numbers being rendered as an effect. Every comparison formatter here returns
// language about what was *observed*, and the causality caveat travels with the
// data rather than living in a footnote someone can crop out.

export const CAUSALITY_CAVEAT = '观测到的差异，不代表因果关系。';

export function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${(value * 100).toFixed(2)}%`;
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString('en-US');
}

/** A delta, described as an observation and never as a cause. */
export function describeDelta(
  metric: string,
  delta: Comparison['deltas'][string],
): string {
  if (!delta) return `${metric}：数据不足，无法比较`;
  const direction = delta.absolute > 0 ? '高' : delta.absolute < 0 ? '低' : '持平';
  const relative =
    delta.relative === null || delta.relative === undefined
      ? ''
      : `（相对 ${(delta.relative * 100).toFixed(1)}%）`;
  return `${metric}：后一组比前一组${direction}${relative}`;
}

/** Whether a comparison is solid enough to act on without more data. */
export function comparisonCaveats(comparison: Comparison): string[] {
  const out = [comparison.causality_note];
  if (comparison.low_sample) out.push('样本量偏小，差异可能只是噪声。');
  out.push(...comparison.warnings.filter(w => !out.includes(w)));
  return [...new Set(out)];
}

export function sampleSummary(comparison: Comparison): string {
  const left = comparison.left_sample;
  const right = comparison.right_sample;
  return (
    `${comparison.left_label}：${left.rows} 行 / ${formatCount(left.impressions)} 曝光 ` +
    `(${left.window[0]} → ${left.window[1]})　·　` +
    `${comparison.right_label}：${right.rows} 行 / ${formatCount(right.impressions)} 曝光 ` +
    `(${right.window[0]} → ${right.window[1]})`
  );
}

/** Signals worst-first, so the strongest evidence is not buried. */
const ORDER: Signal['confidence'][] = ['high', 'medium', 'low'];

export function orderSignals(signals: Signal[]): Signal[] {
  return [...signals].sort(
    (a, b) => ORDER.indexOf(a.confidence) - ORDER.indexOf(b.confidence),
  );
}

export function missingDataWarnings(stats: Aggregate | undefined): string[] {
  return stats?.warnings ?? [];
}

/** Metrics a reader can act on, in a fixed order. */
export const METRIC_ROWS: { key: keyof Aggregate; label: string; rate: boolean }[] = [
  { key: 'impressions', label: '曝光', rate: false },
  { key: 'clicks', label: '点击', rate: false },
  { key: 'ctr', label: '点击率', rate: true },
  { key: 'add_to_cart', label: '加购', rate: false },
  { key: 'purchases', label: '成交', rate: false },
  { key: 'cvr', label: '转化率', rate: true },
  { key: 'returns', label: '退货', rate: false },
  { key: 'return_rate', label: '退货率', rate: true },
];

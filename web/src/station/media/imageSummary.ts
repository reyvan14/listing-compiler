import type { ImageAsset, InspectionResult, ResultState } from './imageApi';

// Pure presentation rules for image inspection results.
//
// The single rule these helpers exist to enforce: an image with unresolved
// manual-review items must never be summarised with the same words, or the same
// colour, as an image that actually passed every check.

export const RESULT_ORDER: ResultState[] = [
  'fail',
  'warning',
  'manual_review',
  'unavailable',
  'pass',
];

/** Worst-first, so a blocker is never buried under a list of passes. */
export function orderResults(results: InspectionResult[]): InspectionResult[] {
  return [...results].sort(
    (a, b) => RESULT_ORDER.indexOf(a.state) - RESULT_ORDER.indexOf(b.state),
  );
}

export type Verdict = {
  tone: 'ok' | 'warn' | 'danger' | 'neutral';
  headline: string;
  detail: string;
};

/**
 * One sentence about an inspected image.
 *
 * Note what is missing: there is no branch that produces an unqualified "合规".
 * The best available outcome is "the checks we can actually run, passed", which
 * is the only claim the evidence supports.
 */
export function verdictOf(asset: ImageAsset): Verdict {
  const { summary } = asset;
  if (summary.blocked) {
    return {
      tone: 'danger',
      headline: `${summary.counts.fail} 项不通过`,
      detail: '存在阻断项，按平台规则不能作为该位置的图片使用。',
    };
  }
  if (summary.counts.warning > 0) {
    return {
      tone: 'warn',
      headline: `${summary.counts.warning} 项提醒`,
      detail: '没有阻断项，但有需要留意的偏差。',
    };
  }
  if (summary.needs_manual_review || summary.unavailable) {
    const open = summary.counts.manual_review + summary.counts.unavailable;
    return {
      tone: 'neutral',
      headline: `可机械判定的项均通过 · ${open} 项待人工核验`,
      detail: '本工具未对主体占比、叠加文字与 logo 作判定，这些项仍需人工确认。',
    };
  }
  return {
    tone: 'ok',
    headline: '可机械判定的项均通过',
    detail: '机械检查通过，不等于平台终审。',
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Human text for a measured/expected value that may be a list or an object. */
export function describeValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.join('、');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Rules the tool cannot settle, listed so the gap is visible rather than absent. */
export function openQuestions(asset: ImageAsset): InspectionResult[] {
  return asset.results.filter(r => r.state === 'manual_review' || r.state === 'unavailable');
}

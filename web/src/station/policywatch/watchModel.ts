import type { MarketCoverage, PolicyCandidate, Watch } from './policyWatchApi';

// Pure presentation rules for Policy Watch.
//
// The one invariant worth encoding here: nothing this module returns may read
// as "the rule has been updated". A candidate is a notice that a page moved,
// and the UI has to keep saying so even after a human approves it.

export const NOT_COVERED_LABEL = '政策未覆盖，需人工复核';

export function pendingCandidates(candidates: PolicyCandidate[]): PolicyCandidate[] {
  return candidates.filter(c => c.state === 'changed');
}

export function candidatesFor(candidates: PolicyCandidate[], watchId: string): PolicyCandidate[] {
  return candidates.filter(c => c.watch_id === watchId);
}

/**
 * What an approved candidate means, spelled out.
 *
 * Approval is easy to misread as activation, so the wording never uses a verb
 * that implies the rulebook changed.
 */
export function approvalMeaning(candidate: PolicyCandidate): string {
  if (candidate.state !== 'approved') return '';
  return (
    candidate.activation?.note ??
    '已确认来源确实发生变化。新的政策快照仍需人工提交，本流程不会自动启用规则。'
  );
}

export function watchTone(watch: Watch): 'ok' | 'warn' | 'danger' | 'neutral' {
  if (watch.last_result === 'failed') return 'danger';
  if (watch.last_result === 'changed') return 'warn';
  if (watch.last_result === 'unchanged') return 'ok';
  return 'neutral';
}

export function describeLastCheck(watch: Watch): string {
  if (!watch.last_checked_at) return '尚未检查过';
  const status = watch.last_status ? ` · HTTP ${watch.last_status}` : '';
  if (watch.last_result === 'failed') {
    return `${watch.last_checked_at}${status} · ${watch.last_error_message ?? '检查失败'}`;
  }
  return `${watch.last_checked_at}${status}`;
}

/** Markets split by whether we hold a real snapshot for them. */
export function splitCoverage(markets: MarketCoverage[]): {
  covered: MarketCoverage[];
  uncovered: MarketCoverage[];
} {
  return {
    covered: markets.filter(m => m.coverage === 'covered'),
    uncovered: markets.filter(m => m.coverage !== 'covered'),
  };
}

/** Whether a compliance verdict for this market may be shown as verified. */
export function mayShowVerified(market: MarketCoverage | undefined): boolean {
  return Boolean(market?.verifiable);
}

export function coverageLabel(market: MarketCoverage | undefined): string {
  if (!market) return NOT_COVERED_LABEL;
  return market.coverage === 'covered' ? '' : NOT_COVERED_LABEL;
}

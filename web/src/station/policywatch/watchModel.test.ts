import { describe, expect, it } from 'vitest';
import { RESULT_META, type MarketCoverage, type PolicyCandidate, type Watch } from './policyWatchApi';
import {
  NOT_COVERED_LABEL,
  approvalMeaning,
  candidatesFor,
  coverageLabel,
  describeLastCheck,
  mayShowVerified,
  pendingCandidates,
  splitCoverage,
  watchTone,
} from './watchModel';

const watch = (over: Partial<Watch> = {}): Watch =>
  ({
    watch_id: 'watch-amazon-us',
    platform: 'amazon',
    market: 'US',
    source_url: 'https://sell.amazon.com/x',
    source_name: 'Amazon',
    snapshot_id: 'amazon-us-2025.01.21',
    snapshot_hash: 'h',
    allowed: true,
    last_checked_at: '',
    last_status: 0,
    etag: '',
    last_modified: '',
    content_hash: '',
    last_result: '',
    ...over,
  }) as Watch;

const candidate = (over: Partial<PolicyCandidate> = {}): PolicyCandidate =>
  ({
    candidate_id: 'polcand-0001',
    watch_id: 'watch-amazon-us',
    platform: 'amazon',
    market: 'US',
    source_url: 'https://sell.amazon.com/x',
    source_name: 'Amazon',
    retrieved_at: '2026-09-05T00:00:00+00:00',
    http_status: 200,
    previous_content_hash: 'a',
    content_hash: 'b',
    current_snapshot_id: 'amazon-us-2025.01.21',
    current_snapshot_hash: 'h',
    excerpt: 'Titles must be under 180 characters.',
    redirect_hops: [],
    state: 'changed',
    interpretation: null,
    reviewed_by: '',
    reviewed_at: '',
    review_note: '',
    ...over,
  }) as PolicyCandidate;

const market = (over: Partial<MarketCoverage> = {}): MarketCoverage =>
  ({
    market: 'US',
    label: '美国',
    language: 'en-US',
    language_label: 'English (US)',
    currency: 'USD',
    currency_symbol: '$',
    measurement_system: 'imperial',
    coverage: 'covered',
    covered_platforms: ['amazon'],
    uncovered_platforms: [],
    verifiable: true,
    note: '',
    ...over,
  }) as MarketCoverage;

describe('candidates', () => {
  it('lists only the ones still awaiting review', () => {
    const rows = pendingCandidates([
      candidate({ candidate_id: 'a', state: 'changed' }),
      candidate({ candidate_id: 'b', state: 'approved' }),
      candidate({ candidate_id: 'c', state: 'rejected' }),
    ]);
    expect(rows.map(r => r.candidate_id)).toEqual(['a']);
  });

  it('groups candidates by their watch', () => {
    const rows = candidatesFor(
      [candidate({ watch_id: 'w1' }), candidate({ watch_id: 'w2' })],
      'w2',
    );
    expect(rows).toHaveLength(1);
  });

  it('never describes an approved candidate as an activated rule', () => {
    // Approval means "the page really changed", not "the rulebook moved".
    const text = approvalMeaning(
      candidate({
        state: 'approved',
        activation: { activated: false, note: '已确认来源确实发生变化。仍需人工提交快照。' },
      }),
    );
    expect(text).toContain('确认来源');
    expect(text).toContain('人工提交');
    expect(text).not.toContain('已启用');
    expect(text).not.toContain('已生效');
  });

  it('says nothing for a candidate nobody has reviewed', () => {
    expect(approvalMeaning(candidate({ state: 'changed' }))).toBe('');
  });
});

describe('watch presentation', () => {
  it('tones a failed check as a problem, not as no news', () => {
    expect(watchTone(watch({ last_result: 'failed' }))).toBe('danger');
    expect(watchTone(watch({ last_result: 'changed' }))).toBe('warn');
    expect(watchTone(watch({ last_result: 'unchanged' }))).toBe('ok');
    expect(watchTone(watch())).toBe('neutral');
  });

  it('distinguishes never-checked from checked-and-clean', () => {
    expect(describeLastCheck(watch())).toBe('尚未检查过');
    expect(
      describeLastCheck(watch({ last_checked_at: '2026-09-05T00:00:00+00:00', last_status: 200, last_result: 'unchanged' })),
    ).toContain('HTTP 200');
  });

  it('surfaces the failure reason rather than a generic message', () => {
    const text = describeLastCheck(
      watch({
        last_checked_at: 't',
        last_result: 'failed',
        last_error: 'host_not_allowed',
        last_error_message: '主机不在允许清单内',
      }),
    );
    expect(text).toContain('主机不在允许清单内');
  });

  it('never labels a detected change as an applied one', () => {
    expect(RESULT_META.changed.label).toBe('检测到变化');
    expect(RESULT_META.changed.tone).not.toBe('ok');
  });
});

describe('market coverage', () => {
  it('splits markets by whether a real snapshot exists', () => {
    const { covered, uncovered } = splitCoverage([
      market({ market: 'US' }),
      market({ market: 'DE', coverage: 'not_covered', verifiable: false, covered_platforms: [] }),
    ]);
    expect(covered.map(m => m.market)).toEqual(['US']);
    expect(uncovered.map(m => m.market)).toEqual(['DE']);
  });

  it('refuses to show verified for a market with no snapshot of its own', () => {
    expect(mayShowVerified(market({ market: 'US' }))).toBe(true);
    expect(mayShowVerified(market({ market: 'DE', verifiable: false }))).toBe(false);
    expect(mayShowVerified(undefined)).toBe(false);
  });

  it('labels an uncovered market with the exact required wording', () => {
    expect(coverageLabel(market({ coverage: 'not_covered' }))).toBe(NOT_COVERED_LABEL);
    expect(coverageLabel(market())).toBe('');
    expect(coverageLabel(undefined)).toBe(NOT_COVERED_LABEL);
  });
});

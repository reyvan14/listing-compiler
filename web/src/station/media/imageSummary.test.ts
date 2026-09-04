import { describe, expect, it } from 'vitest';
import { RESULT_STATE_META, type ImageAsset, type InspectionResult, type ResultState } from './imageApi';
import {
  describeValue,
  formatBytes,
  openQuestions,
  orderResults,
  verdictOf,
} from './imageSummary';

function result(state: ResultState, rule_id = `rule.${state}`): InspectionResult {
  return {
    rule_id,
    kind: 'image_format',
    severity: state === 'fail' ? 'blocking' : 'warn',
    policy_snapshot_id: 'amazon-us-2025.01.21',
    asset_id: 'a1',
    state,
    measured: 'PNG',
    expected: ['JPEG'],
    detail: 'detail',
    method: 'pillow-decode/v1',
    evidence: {},
    description: '',
  };
}

function asset(states: ResultState[]): ImageAsset {
  const counts = { pass: 0, fail: 0, warning: 0, manual_review: 0, unavailable: 0 };
  for (const s of states) counts[s] += 1;
  return {
    asset_id: 'a1',
    sha256: 'f'.repeat(64),
    origin: 'generated',
    platform: 'amazon',
    revision_id: '',
    node_id: '',
    label: '主图',
    filename: '',
    measurements: {} as ImageAsset['measurements'],
    background: null,
    results: states.map(s => result(s)),
    summary: {
      counts,
      blocked: counts.fail > 0,
      fully_verified:
        counts.fail === 0 && counts.warning === 0 && counts.manual_review === 0 && counts.unavailable === 0,
      needs_manual_review: counts.manual_review > 0,
      unavailable: counts.unavailable > 0,
    },
    policy_snapshot_id: 'amazon-us-2025.01.21',
    unavailable_reason: '',
    stored_at: '2026-09-04T00:00:00+00:00',
  };
}

describe('verdictOf', () => {
  it('never calls an image compliant when checks could not be run', () => {
    // This is the whole point of the module: unresolved manual-review items
    // must not read, or look, like a pass.
    const v = verdictOf(asset(['pass', 'pass', 'manual_review']));
    expect(v.tone).toBe('neutral');
    expect(v.headline).toContain('待人工核验');
    expect(v.detail).toContain('人工确认');
  });

  it('leads with blockers when any check failed', () => {
    const v = verdictOf(asset(['fail', 'pass', 'manual_review']));
    expect(v.tone).toBe('danger');
    expect(v.headline).toContain('1 项不通过');
  });

  it('reports warnings when nothing blocks but something is off', () => {
    const v = verdictOf(asset(['warning', 'pass']));
    expect(v.tone).toBe('warn');
    expect(v.headline).toContain('提醒');
  });

  it('qualifies even the best outcome as mechanical only', () => {
    const v = verdictOf(asset(['pass', 'pass']));
    expect(v.tone).toBe('ok');
    // no unqualified "合规" anywhere
    expect(v.headline).toContain('可机械判定');
    expect(v.detail).toContain('不等于平台终审');
  });

  it('treats an unavailable measurement as unresolved, not as fine', () => {
    const v = verdictOf(asset(['pass', 'unavailable']));
    expect(v.tone).not.toBe('ok');
  });
});

describe('result presentation', () => {
  it('sorts worst first so a blocker is never buried under passes', () => {
    const rows = orderResults([
      result('pass', 'r.pass'),
      result('manual_review', 'r.manual'),
      result('fail', 'r.fail'),
      result('warning', 'r.warn'),
    ]);
    expect(rows.map(r => r.state)).toEqual(['fail', 'warning', 'manual_review', 'pass']);
  });

  it('gives manual review and unavailable a non-passing tone', () => {
    expect(RESULT_STATE_META.manual_review.tone).not.toBe('ok');
    expect(RESULT_STATE_META.unavailable.tone).not.toBe('ok');
    expect(RESULT_STATE_META.pass.tone).toBe('ok');
    expect(RESULT_STATE_META.fail.tone).toBe('danger');
  });

  it('lists exactly the questions the tool could not settle', () => {
    const rows = openQuestions(asset(['pass', 'manual_review', 'unavailable', 'fail']));
    expect(rows.map(r => r.state).sort()).toEqual(['manual_review', 'unavailable']);
  });
});

describe('value formatting', () => {
  it('renders lists, objects, numbers and missing values readably', () => {
    expect(describeValue(['JPEG', 'PNG'])).toBe('JPEG、PNG');
    expect(describeValue(1600)).toBe('1600');
    expect(describeValue(null)).toBe('—');
    expect(describeValue(undefined)).toBe('—');
    expect(describeValue({ a: 1 })).toBe('{"a":1}');
  });

  it('scales byte sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.00 MB');
  });
});

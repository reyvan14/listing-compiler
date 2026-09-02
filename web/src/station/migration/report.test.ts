import { describe, expect, it } from 'vitest';
import { buildDependencyGraph, propagateStale } from './graph';
import { initMigrationState, migrationReducer } from './reducer';
import { serializeReport } from './report';
import { capacityPatch, demoArtifacts } from './fixtures';
import { patchKey } from './types';

function runToApplied() {
  let state = initMigrationState(demoArtifacts());
  state = migrationReducer(state, {
    type: 'setTrigger',
    trigger: {
      kind: 'sku',
      changedFacts: ['fact-3'],
      factsBefore: {},
      factsAfter: {},
    },
  });
  const rows = propagateStale(buildDependencyGraph(demoArtifacts()), {
    factDelta: { added: [], removed: [], changed: ['fact-3'] },
  });
  state = migrationReducer(state, { type: 'analyzed', impact: rows });

  const safe = capacityPatch({ artifactId: 'amazon', field: 'title' });
  const risky = capacityPatch({
    artifactId: 'amazon',
    field: 'bullet-4',
    needsHumanReview: true,
    note: '350ml/12oz 单位不一致',
  });
  state = migrationReducer(state, { type: 'candidates', patches: [safe, risky] });

  const applied = JSON.parse(JSON.stringify(state.current));
  applied[0].title = safe.candidateValue;
  applied[0].revision = 2;
  state = migrationReducer(state, {
    type: 'applied',
    artifacts: applied,
    appliedIds: ['amazon'],
    needsReviewIds: [],
  });
  return { state, safe, risky };
}

describe('serializeReport', () => {
  it('captures diff, counts, patched/preserved fields, human review and status as plain JSON', () => {
    const { state, safe, risky } = runToApplied();
    const report = serializeReport(state, {
      ruleDiff: { changed: [{ rule_id: 'amazon.title.max_length' }] },
      factDelta: { added: [], removed: [], changed: ['fact-3'] },
    });

    // JSON round-trip (no functions / class instances / undefined-only keys)
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);

    expect(report.schema).toBe('listing-migration-report/v1');
    expect(report.status).toBe('applied');
    expect(report.factDelta).toEqual({ added: [], removed: [], changed: ['fact-3'] });
    expect(report.ruleDiff).toEqual({ changed: [{ rule_id: 'amazon.title.max_length' }] });

    expect(report.impact.affectedCount).toBe(3);
    expect(report.impact.unaffectedCount).toBe(0);

    const patched = Object.fromEntries(
      report.patchedFields.map(p => [`${p.artifactId}:${p.field}`, p]),
    );
    expect(patched['amazon:title'].applied).toBe(true);
    expect(patched['amazon:bullet-4'].applied).toBe(false); // was human-review, unapproved

    // amazon:bullet-2 was never touched -> preserved
    expect(report.preservedFields).toContainEqual({ artifactId: 'amazon', field: 'bullet-2' });
    // whole unaffected artifacts recorded with '*'
    expect(report.humanReview).toContainEqual({
      artifactId: 'amazon',
      field: 'bullet-4',
      note: '350ml/12oz 单位不一致',
    });
    expect(report.counts).toEqual({
      patched: report.patchedFields.length,
      preserved: report.preservedFields.length,
      humanReview: report.humanReview.length,
    });
    expect(report.validation.after).toContainEqual({
      artifactId: 'amazon',
      field: 'title',
      ok: true,
    });
    // the unapproved risky patch is not in "after" validation
    expect(report.validation.after.some(v => v.field === 'bullet-4')).toBe(false);
    void patchKey;
  });
});

import { describe, expect, it } from 'vitest';
import {
  approvedPatches,
  initMigrationState,
  migrationReducer,
  pendingHumanReview,
} from './reducer';
import { capacityPatch, demoArtifacts } from './fixtures';
import { patchKey } from './types';

function analyzed() {
  let state = initMigrationState(demoArtifacts());
  state = migrationReducer(state, {
    type: 'setTrigger',
    trigger: {
      kind: 'sku',
      changedFacts: ['fact-3'],
      factsBefore: { 'fact-3': '防漏盖，350ml' },
      factsAfter: { 'fact-3': '防漏盖，300ml' },
    },
  });
  state = migrationReducer(state, { type: 'analyzed', impact: [] });
  return state;
}

describe('candidate build never mutates current state', () => {
  it('leaves state.current deep-equal to the pre-candidate value', () => {
    const before = analyzed();
    const currentBefore = JSON.parse(JSON.stringify(before.current));
    const patches = [
      capacityPatch({ field: 'title' }),
      capacityPatch({ field: 'bullet-4', needsHumanReview: true, note: '12oz 不一致' }),
    ];
    const after = migrationReducer(before, { type: 'candidates', patches });

    expect(after.current).toEqual(currentBefore); // untouched
    expect(after.phase).toBe('candidate');
    expect(after.snapshot).toEqual(currentBefore); // rollback point captured
    // safe patch pre-approved, human-review patch left unchecked
    expect(after.approvals[patchKey(patches[0])]).toBe(true);
    expect(after.approvals[patchKey(patches[1])]).toBe(false);
    expect(pendingHumanReview(after)).toHaveLength(1);
  });
});

describe('partial approval', () => {
  it('approvedPatches only returns the checked patches, in order', () => {
    let state = analyzed();
    const p1 = capacityPatch({ artifactId: 'amazon', field: 'title' });
    const p2 = capacityPatch({ artifactId: 'amazon', field: 'search-terms' });
    const p3 = capacityPatch({ artifactId: 'tiktok', field: 'title' });
    state = migrationReducer(state, { type: 'candidates', patches: [p1, p2, p3] });

    // start: all three safe -> all approved
    expect(approvedPatches(state).map(p => p.field)).toEqual(['title', 'search-terms', 'title']);

    // uncheck the middle one
    state = migrationReducer(state, { type: 'toggleApproval', key: patchKey(p2) });
    expect(approvedPatches(state).map(patchKey)).toEqual([patchKey(p1), patchKey(p3)]);
  });

  it('approveAllSafe re-checks safe patches but leaves human-review ones alone', () => {
    let state = analyzed();
    const safe = capacityPatch({ field: 'title' });
    const risky = capacityPatch({ field: 'bullet-4', needsHumanReview: true });
    state = migrationReducer(state, { type: 'candidates', patches: [safe, risky] });
    state = migrationReducer(state, { type: 'setApproval', key: patchKey(safe), value: false });
    state = migrationReducer(state, { type: 'approveAllSafe' });
    expect(state.approvals[patchKey(safe)]).toBe(true);
    expect(state.approvals[patchKey(risky)]).toBe(false);
  });
});

describe('rollback reducer', () => {
  it('restores current to the captured snapshot exactly', () => {
    let state = analyzed();
    const snapshotArtifacts = JSON.parse(JSON.stringify(state.current));
    state = migrationReducer(state, {
      type: 'candidates',
      patches: [capacityPatch({ field: 'title' })],
    });

    // simulate an apply that changed amazon's title + bumped revision
    const applied = JSON.parse(JSON.stringify(state.current));
    applied[0].title = 'Collapsible Silicone Travel Cup 300ml, Leak-Proof Lid';
    applied[0].revision = 2;
    applied[0].status = 'applied';
    state = migrationReducer(state, {
      type: 'applied',
      artifacts: applied,
      appliedIds: ['amazon'],
      needsReviewIds: [],
    });
    expect(state.current[0].title).toContain('300ml');
    expect(state.current[0].revision).toBe(2);

    state = migrationReducer(state, { type: 'rolledBack' });
    expect(state.phase).toBe('rolled-back');
    expect(state.current).toEqual(snapshotArtifacts);
    expect(state.current[0].title).toContain('350ml');
    expect(state.current[0].revision).toBe(1);
  });

  it('is a no-op when there is no snapshot', () => {
    const state = analyzed();
    expect(migrationReducer(state, { type: 'rolledBack' })).toBe(state);
  });
});

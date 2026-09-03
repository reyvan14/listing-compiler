// Migration workflow state machine (pure).
//
// Invariants the canvas relies on:
//   * `current` is the approved artifact set. Building candidates NEVER mutates it.
//   * A snapshot of `current` is taken the moment candidates are built, so a
//     rollback can restore the exact previous revision without a model.
//   * Apply is partial: only approved (artifactId:field) patches are handed out.

import type { Artifact, CandidatePatch } from './types';
import { patchKey } from './types';

export type MigrationPhase =
  | 'idle'
  | 'analyzed'
  | 'candidate'
  | 'applied'
  | 'rolled-back';

export type MigrationTrigger =
  | { kind: 'policy'; platform: string; baseVersion: string; candidateVersion: string }
  | { kind: 'sku'; changedFacts: string[]; factsBefore: Record<string, string>; factsAfter: Record<string, string> }
  | null;

export type MigrationState = {
  phase: MigrationPhase;
  trigger: MigrationTrigger;
  current: Artifact[];
  snapshot: Artifact[] | null;
  impact: import('./types').ImpactRow[] | null;
  candidates: CandidatePatch[] | null;
  approvals: Record<string, boolean>;
  applied: Artifact[] | null;
  appliedIds: string[];
  needsReviewIds: string[];
  startedAt: string;
};

export type MigrationAction =
  | { type: 'reset'; current: Artifact[] }
  | { type: 'setTrigger'; trigger: MigrationTrigger }
  | { type: 'analyzed'; impact: import('./types').ImpactRow[] }
  | { type: 'candidates'; patches: CandidatePatch[] }
  | { type: 'toggleApproval'; key: string }
  | { type: 'setApproval'; key: string; value: boolean }
  | { type: 'approveAllSafe' }
  | { type: 'applied'; artifacts: Artifact[]; appliedIds: string[]; needsReviewIds: string[] }
  | { type: 'rolledBack' };

export function initMigrationState(current: Artifact[]): MigrationState {
  return {
    phase: 'idle',
    trigger: null,
    current: clone(current),
    snapshot: null,
    impact: null,
    candidates: null,
    approvals: {},
    applied: null,
    appliedIds: [],
    needsReviewIds: [],
    startedAt: new Date().toISOString(),
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export function migrationReducer(
  state: MigrationState,
  action: MigrationAction,
): MigrationState {
  switch (action.type) {
    case 'reset':
      return initMigrationState(action.current);

    case 'setTrigger':
      return { ...state, trigger: action.trigger };

    case 'analyzed':
      return {
        ...state,
        phase: 'analyzed',
        impact: action.impact,
        candidates: null,
        applied: null,
        approvals: {},
      };

    case 'candidates': {
      const approvals: Record<string, boolean> = {};
      for (const patch of action.patches) {
        // default: auto-approve safe patches, leave human-review ones unchecked
        approvals[patchKey(patch)] = !patch.needsHumanReview;
      }
      return {
        ...state,
        phase: 'candidate',
        candidates: action.patches,
        approvals,
        // capture the rollback point exactly as `current` stands now
        snapshot: clone(state.current),
      };
    }

    case 'toggleApproval':
      return {
        ...state,
        approvals: { ...state.approvals, [action.key]: !state.approvals[action.key] },
      };

    case 'setApproval':
      return {
        ...state,
        approvals: { ...state.approvals, [action.key]: action.value },
      };

    case 'approveAllSafe': {
      const approvals = { ...state.approvals };
      for (const patch of state.candidates ?? []) {
        if (!patch.needsHumanReview) approvals[patchKey(patch)] = true;
      }
      return { ...state, approvals };
    }

    case 'applied':
      return {
        ...state,
        phase: 'applied',
        applied: action.artifacts,
        current: clone(action.artifacts),
        appliedIds: action.appliedIds,
        needsReviewIds: action.needsReviewIds,
      };

    case 'rolledBack':
      return state.snapshot
        ? {
            ...state,
            phase: 'rolled-back',
            current: clone(state.snapshot),
            applied: null,
            appliedIds: [],
            needsReviewIds: [],
          }
        : state;

    default:
      return state;
  }
}

/** The approved subset of candidate patches, in candidate order. */
export function approvedPatches(state: MigrationState): CandidatePatch[] {
  const list = state.candidates ?? [];
  return list.filter(p => state.approvals[patchKey(p)]);
}

export function pendingHumanReview(state: MigrationState): CandidatePatch[] {
  return (state.candidates ?? []).filter(
    p => p.needsHumanReview && !state.approvals[patchKey(p)],
  );
}

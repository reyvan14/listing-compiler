// Local migration-report assembly + download. The backend also serves a report
// (/api/migration/report); this pure version lets the panel produce a download
// offline from reducer state and is what the unit test locks.

import { impactSummary } from './graph';
import { approvedPatches, type MigrationState } from './reducer';
import type { ImpactRow } from './types';
import { patchKey } from './types';

export type MigrationReport = {
  schema: 'listing-migration-report/v1';
  generatedAt: string;
  status: MigrationState['phase'];
  policy: {
    platform: string;
    baseVersion: string;
    candidateVersion: string;
  } | null;
  ruleDiff: unknown;
  factDelta: { added: string[]; removed: string[]; changed: string[] } | null;
  impact: {
    affectedCount: number;
    unaffectedCount: number;
    affected: ImpactRow[];
    unaffected: ImpactRow[];
  };
  patchedFields: {
    artifactId: string;
    field: string;
    previousValue: string;
    candidateValue: string;
    reason: string;
    applied: boolean;
  }[];
  preservedFields: { artifactId: string; field: string }[];
  humanReview: { artifactId: string; field: string; note: string }[];
  validation: {
    before: { artifactId: string; field: string; ok: boolean }[];
    after: { artifactId: string; field: string; ok: boolean }[];
  };
  counts: { patched: number; preserved: number; humanReview: number };
};

export function serializeReport(
  state: MigrationState,
  extra: { ruleDiff?: unknown; factDelta?: MigrationReport['factDelta'] } = {},
): MigrationReport {
  const rows = state.impact ?? [];
  const affected = rows.filter(r => r.affected);
  const unaffected = rows.filter(r => !r.affected);
  const summary = impactSummary(rows);
  const approvedKeys = new Set(approvedPatches(state).map(patchKey));
  const candidates = state.candidates ?? [];

  const patchedFields = candidates.map(p => ({
    artifactId: p.artifactId,
    field: p.field,
    previousValue: p.previousValue,
    candidateValue: p.candidateValue,
    reason: p.reason,
    applied:
      state.phase === 'applied' &&
      approvedKeys.has(patchKey(p)) &&
      state.appliedIds.includes(p.artifactId),
  }));

  const patchedKeys = new Set(candidates.map(patchKey));
  const preservedFields: MigrationReport['preservedFields'] = [];
  for (const row of affected) {
    for (const field of row.reusableFields) {
      if (!patchedKeys.has(`${row.artifactId}:${field}`)) {
        preservedFields.push({ artifactId: row.artifactId, field });
      }
    }
  }
  for (const row of unaffected) {
    preservedFields.push({ artifactId: row.artifactId, field: '*' });
  }

  const humanReview = candidates
    .filter(p => p.needsHumanReview)
    .map(p => ({ artifactId: p.artifactId, field: p.field, note: p.note }));

  const trigger = state.trigger;
  return {
    schema: 'listing-migration-report/v1',
    generatedAt: new Date().toISOString(),
    status: state.phase,
    policy:
      trigger?.kind === 'policy'
        ? {
            platform: trigger.platform,
            baseVersion: trigger.baseVersion,
            candidateVersion: trigger.candidateVersion,
          }
        : null,
    ruleDiff: extra.ruleDiff ?? null,
    factDelta:
      extra.factDelta ??
      (trigger?.kind === 'sku'
        ? { added: [], removed: [], changed: trigger.changedFacts }
        : null),
    impact: {
      affectedCount: summary.affectedCount,
      unaffectedCount: summary.unaffectedCount,
      affected,
      unaffected,
    },
    patchedFields,
    preservedFields,
    humanReview,
    validation: {
      before: [],
      after: candidates
        .filter(p => approvedKeys.has(patchKey(p)))
        .map(p => ({ artifactId: p.artifactId, field: p.field, ok: p.validation.ok })),
    },
    counts: {
      patched: patchedFields.length,
      preserved: preservedFields.length,
      humanReview: humanReview.length,
    },
  };
}

export function downloadReport(report: MigrationReport): void {
  const blob = new Blob([JSON.stringify(report, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `listing-migration-${report.generatedAt.slice(0, 19).replace(/[:T]/g, '')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

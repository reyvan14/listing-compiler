// Thin wrappers over the deterministic backend migration endpoints.
// All calls go through the shared apiClient (timeout, abort, safe errors).

import { apiUrl, postJson } from '../apiClient';
import type { Artifact, CandidatePatch, ImpactRow, ImpactSummary } from './types';

export type PolicySnapshotMeta = {
  platform: string;
  version: string;
  status: 'current' | 'candidate';
  effective_date: string;
  excerpt_date: string;
  source_name: string;
  source_url: string;
  reference_name?: string;
  reference_url?: string;
  summary: string;
  notes: string;
  display: Record<string, string>;
  rule_ids: string[];
};

export type PolicyDiff = {
  platform: string;
  base_version: string;
  candidate_version: string;
  base_effective_date: string;
  candidate_effective_date: string;
  source_name: string;
  source_url: string;
  added: { id: string; description: string; params: Record<string, unknown> }[];
  removed: { id: string; description: string }[];
  changed: {
    rule_id: string;
    old: { severity: string; params: Record<string, unknown>; description: string };
    new: { severity: string; params: Record<string, unknown>; description: string };
  }[];
  affected_fields: string[];
  is_empty: boolean;
};

export function artifactToWire(a: Artifact): Record<string, unknown> {
  return {
    artifact_id: a.artifactId,
    platform: a.platform,
    kind: a.kind,
    revision: a.revision,
    status: a.status,
    policy_version: a.policyVersion,
    sku_revision: a.skuRevision,
    title: a.title,
    title_fact_refs: a.titleFactRefs ?? [],
    fields: (a.fields ?? []).map(f => ({
      name: f.name,
      label: f.label,
      value: f.value,
      fact_refs: f.factRefs ?? [],
    })),
    asset_refs: a.assetRefs ?? [],
  };
}

export function wireToArtifact(row: Record<string, any>, nodeId?: string): Artifact {
  return {
    artifactId: String(row.artifact_id ?? row.id ?? ''),
    nodeId,
    platform: String(row.platform ?? ''),
    kind: (row.kind ?? 'listing') as Artifact['kind'],
    revision: Number(row.revision ?? 1),
    status: (row.status ?? 'current') as Artifact['status'],
    policyVersion: String(row.policy_version ?? ''),
    skuRevision: row.sku_revision ? String(row.sku_revision) : undefined,
    title: row.title != null ? String(row.title) : undefined,
    titleFactRefs: Array.isArray(row.title_fact_refs) ? row.title_fact_refs.map(String) : [],
    fields: (row.fields ?? []).map((f: any) => ({
      name: String(f.name ?? f.field ?? ''),
      label: String(f.label ?? ''),
      value: String(f.value ?? ''),
      factRefs: Array.isArray(f.fact_refs ?? f.factRefs)
        ? (f.fact_refs ?? f.factRefs).map(String)
        : [],
    })),
    assetRefs: Array.isArray(row.asset_refs) ? row.asset_refs.map(String) : undefined,
  };
}

export async function fetchPolicySnapshots(signal?: AbortSignal): Promise<PolicySnapshotMeta[]> {
  const res = await fetch(apiUrl('/api/policy/snapshots'), { signal });
  if (!res.ok) throw new Error(`policy snapshots ${res.status}`);
  const json = await res.json();
  return json?.data?.snapshots ?? [];
}

export async function fetchPolicyDiff(
  base: string,
  candidate: string,
  signal?: AbortSignal,
): Promise<PolicyDiff> {
  const res = await fetch(
    apiUrl(`/api/policy/diff?base=${encodeURIComponent(base)}&candidate=${encodeURIComponent(candidate)}`),
    { signal },
  );
  const json = await res.json();
  if (!res.ok) throw new Error(json?.message ?? `policy diff ${res.status}`);
  return json.data;
}

type ImpactWirePayload = {
  artifacts: Record<string, unknown>[];
  facts_before: Record<string, string>;
  facts_after: Record<string, string>;
  base_policy_version?: string | null;
  candidate_policy_version?: string | null;
};

export async function runImpact(payload: {
  artifacts: Artifact[];
  factsBefore: Record<string, string>;
  factsAfter: Record<string, string>;
  basePolicyVersion?: string;
  candidatePolicyVersion?: string;
  signal?: AbortSignal;
}) {
  const wire: ImpactWirePayload = {
    artifacts: payload.artifacts.map(artifactToWire),
    facts_before: payload.factsBefore,
    facts_after: payload.factsAfter,
    base_policy_version: payload.basePolicyVersion ?? null,
    candidate_policy_version: payload.candidatePolicyVersion ?? null,
  };
  return postJson<any>('/api/migration/impact', wire, { timeoutMs: 20_000, signal: payload.signal });
}

export async function buildCandidate(payload: {
  artifacts: Artifact[];
  impact: unknown;
  targets?: [string, string][];
  factsBefore: Record<string, string>;
  factsAfter: Record<string, string>;
  basePolicyVersion?: string;
  candidatePolicyVersion?: string;
  useModel?: boolean;
  signal?: AbortSignal;
}) {
  return postJson<any>(
    '/api/migration/candidate',
    {
      artifacts: payload.artifacts.map(artifactToWire),
      impact: payload.impact,
      targets: payload.targets ?? null,
      facts_before: payload.factsBefore,
      facts_after: payload.factsAfter,
      base_policy_version: payload.basePolicyVersion ?? null,
      candidate_policy_version: payload.candidatePolicyVersion ?? null,
      use_model: !!payload.useModel,
    },
    { timeoutMs: 60_000, signal: payload.signal },
  );
}

export function wirePatchToCandidate(p: Record<string, any>): CandidatePatch {
  return {
    artifactId: String(p.artifact_id ?? ''),
    platform: String(p.platform ?? ''),
    field: String(p.field ?? ''),
    previousValue: String(p.previous_value ?? ''),
    candidateValue: String(p.candidate_value ?? ''),
    reason: String(p.reason ?? ''),
    triggering: {
      kind: String(p.triggering?.kind ?? ''),
      factIds: p.triggering?.fact_ids ?? [],
      ruleIds: p.triggering?.rule_ids ?? [],
    },
    factRefs: Array.isArray(p.fact_refs) ? p.fact_refs.map(String) : [],
    validation: {
      ok: !!p.validation?.ok,
      checkable: !!p.validation?.checkable,
      semantic: p.validation?.semantic ? { ok: !!p.validation.semantic.ok } : undefined,
    },
    needsHumanReview: !!p.needs_human_review,
    note: String(p.note ?? ''),
  };
}

export async function applyMigration(payload: {
  artifacts: Artifact[];
  approvedPatches: CandidatePatch[];
  factsAfter?: Record<string, string>;
  candidatePolicyVersion?: string;
  signal?: AbortSignal;
}) {
  return postJson<any>(
    '/api/migration/apply',
    {
      artifacts: payload.artifacts.map(artifactToWire),
      approved_patches: payload.approvedPatches.map(p => ({
        artifact_id: p.artifactId,
        field: p.field,
        candidate_value: p.candidateValue,
        needs_human_review: p.needsHumanReview,
      })),
      facts_after: payload.factsAfter ?? {},
      candidate_policy_version: payload.candidatePolicyVersion ?? null,
    },
    { timeoutMs: 30_000, signal: payload.signal },
  );
}

export async function rollbackMigration(snapshot: unknown, signal?: AbortSignal) {
  return postJson<any>('/api/migration/rollback', { snapshot }, { timeoutMs: 20_000, signal });
}

// --- backend <-> frontend shape mappers ----------------------------------- //

export function wireImpactRow(row: Record<string, any>): ImpactRow {
  return {
    artifactId: String(row.artifact_id ?? ''),
    platform: String(row.platform ?? ''),
    kind: (row.kind ?? 'listing') as ImpactRow['kind'],
    affected: !!row.affected,
    cause: (row.cause ?? null) as ImpactRow['cause'],
    reasons: (row.reasons ?? []).map((r: any) => ({
      type: r.type,
      detail: String(r.detail ?? ''),
      factIds: r.fact_ids ?? [],
      ruleIds: r.rule_ids ?? [],
      fields: r.fields ?? [],
      requiresRegen: !!r.requires_regen,
    })),
    fieldsToRegenerate: row.fields_to_regenerate ?? [],
    reusableFields: row.reusable_fields ?? [],
    hasDependencyMetadata: !!row.has_dependency_metadata,
  };
}

export function wireImpact(data: Record<string, any>): {
  rows: ImpactRow[];
  summary: ImpactSummary;
  factDelta: { added: string[]; removed: string[]; changed: string[] };
  policyDiff: unknown;
} {
  const affected = (data.affected ?? []).map(wireImpactRow);
  const unaffected = (data.unaffected ?? []).map(wireImpactRow);
  return {
    rows: [...affected, ...unaffected],
    summary: {
      affectedCount: data.summary?.affected_count ?? affected.length,
      unaffectedCount: data.summary?.unaffected_count ?? unaffected.length,
      byCause: data.summary?.by_cause ?? { sku: 0, policy: 0, both: 0 },
    },
    factDelta: data.fact_delta ?? { added: [], removed: [], changed: [] },
    policyDiff: data.policy_diff ?? null,
  };
}

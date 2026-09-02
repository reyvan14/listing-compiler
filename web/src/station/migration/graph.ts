// Deterministic dependency graph + blast-radius (stale) propagation.
//
// Pure functions, no network. This mirrors the backend `migration.analyze_impact`
// closely enough to drive the canvas immediately, and is what the migration
// panel shows before/without a backend round-trip.

import type {
  Artifact,
  ImpactCause,
  ImpactReason,
  ImpactRow,
  ImpactSummary,
  PolicyChangeInput,
} from './types';

export type FactDelta = { added: string[]; removed: string[]; changed: string[] };

export type DependencyGraph = {
  artifacts: Artifact[];
  /** factId -> [{ artifactId, field }] that reference it */
  byFact: Map<string, { artifactId: string; field: string }[]>;
  /** artifactId -> Map<fieldName, factRefs[]> (includes the synthetic 'title' field) */
  byArtifact: Map<string, Map<string, string[]>>;
};

export function fieldEntries(artifact: Artifact): { name: string; factRefs: string[] }[] {
  const out: { name: string; factRefs: string[] }[] = [];
  if (typeof artifact.title === 'string') {
    out.push({ name: 'title', factRefs: artifact.titleFactRefs ?? [] });
  }
  for (const f of artifact.fields ?? []) {
    out.push({ name: f.name, factRefs: f.factRefs ?? [] });
  }
  return out;
}

export function hasDependencyMetadata(artifact: Artifact): boolean {
  // An assetRefs / titleFactRefs array that is present but empty still counts:
  // it means "we computed the dependencies and nothing matched", which is very
  // different from a legacy artifact that has no dependency data at all.
  if (Array.isArray(artifact.assetRefs)) return true;
  if (Array.isArray(artifact.titleFactRefs)) return true;
  return (artifact.fields ?? []).some(f => Array.isArray(f.factRefs));
}

export function buildDependencyGraph(artifacts: Artifact[]): DependencyGraph {
  const byFact = new Map<string, { artifactId: string; field: string }[]>();
  const byArtifact = new Map<string, Map<string, string[]>>();

  for (const artifact of artifacts) {
    const fieldMap = new Map<string, string[]>();
    for (const entry of fieldEntries(artifact)) {
      fieldMap.set(entry.name, [...entry.factRefs]);
      for (const factId of entry.factRefs) {
        const list = byFact.get(factId) ?? [];
        list.push({ artifactId: artifact.artifactId, field: entry.name });
        byFact.set(factId, list);
      }
    }
    for (const ref of artifact.assetRefs ?? []) {
      const list = byFact.get(ref) ?? [];
      list.push({ artifactId: artifact.artifactId, field: 'asset' });
      byFact.set(ref, list);
    }
    byArtifact.set(artifact.artifactId, fieldMap);
  }
  return { artifacts, byFact, byArtifact };
}

const POLICY_FIELD_ALIAS: Record<string, string> = {
  'main_image': 'image',
  'description': 'long-description',
};

function normalizePolicyField(raw: string): string {
  const bare = raw.includes(':') ? raw.split(':')[1] : raw;
  return POLICY_FIELD_ALIAS[bare] ?? bare;
}

export type PropagateInput = {
  factDelta?: FactDelta;
  policy?: PolicyChangeInput | null;
};

export function propagateStale(
  graph: DependencyGraph,
  input: PropagateInput,
): ImpactRow[] {
  const changedFacts = new Set([
    ...(input.factDelta?.changed ?? []),
    ...(input.factDelta?.removed ?? []),
  ]);
  const policy = input.policy ?? null;
  const policyFields = new Set((policy?.fields ?? []).map(normalizePolicyField));
  const blockingFields = new Set((policy?.blockingFields ?? []).map(normalizePolicyField));

  const rows: ImpactRow[] = [];

  for (const artifact of graph.artifacts) {
    const reasons: ImpactReason[] = [];
    const regen = new Set<string>();
    const touched = new Set<string>();
    const hasMeta = hasDependencyMetadata(artifact);
    const entries = fieldEntries(artifact);

    // ---- SKU fact cause ------------------------------------------------
    if (changedFacts.size) {
      if (artifact.kind === 'image' || artifact.kind === 'video') {
        const hit = (artifact.assetRefs ?? []).filter(r => changedFacts.has(r));
        if (hit.length) {
          reasons.push({
            type: 'sku_fact',
            detail: `素材依赖的 SKU 事实发生变化：${hit.join('、')}`,
            factIds: hit,
            fields: ['asset'],
          });
          regen.add('asset');
          touched.add('asset');
        } else if (!hasMeta) {
          reasons.push({
            type: 'sku_fact_conservative',
            detail: '该素材缺少依赖元数据，保守起见按受影响处理。',
            factIds: [...changedFacts],
            fields: ['asset'],
          });
          regen.add('asset');
          touched.add('asset');
        }
      } else {
        const perField: { field: string; factIds: string[] }[] = [];
        for (const entry of entries) {
          const hit = entry.factRefs.filter(r => changedFacts.has(r));
          if (hit.length) {
            perField.push({ field: entry.name, factIds: hit });
            regen.add(entry.name);
            touched.add(entry.name);
          }
        }
        if (perField.length) {
          reasons.push({
            type: 'sku_fact',
            detail: '以下字段引用了发生变化的 SKU 事实。',
            factIds: [...new Set(perField.flatMap(p => p.factIds))],
            fields: perField.map(p => p.field),
          });
        } else if (!hasMeta) {
          const names = entries.map(e => e.name);
          reasons.push({
            type: 'sku_fact_conservative',
            detail: '该产物缺少 factRefs 依赖元数据，保守起见按全字段受影响处理。',
            factIds: [...changedFacts],
            fields: names.length ? names : ['*'],
          });
          names.forEach(n => {
            regen.add(n);
            touched.add(n);
          });
        }
      }
    }

    // ---- Policy cause ------------------------------------------------
    if (policy && artifact.platform === policy.platform && artifact.kind === 'listing') {
      const polFields: string[] = [];
      let requiresRegen = false;
      for (const entry of entries) {
        if (!policyFields.has(entry.name)) continue;
        polFields.push(entry.name);
        touched.add(entry.name);
        if (blockingFields.has(entry.name)) {
          requiresRegen = true;
          regen.add(entry.name);
        }
      }
      if (polFields.length) {
        reasons.push({
          type: 'policy',
          detail: requiresRegen
            ? '候选政策收紧了该字段的强制校验，当前内容不满足，需要重编译。'
            : '候选政策变化涉及该字段；当前内容仍合规，只需重新校验并更新政策版本。',
          ruleIds: policy.ruleIds ?? [],
          fields: polFields,
          requiresRegen,
        });
      }
    }

    const hasSku = reasons.some(r => r.type.startsWith('sku_fact'));
    const hasPolicy = reasons.some(r => r.type === 'policy');
    const cause: ImpactCause = reasons.length
      ? hasSku && hasPolicy
        ? 'both'
        : hasSku
          ? 'sku'
          : 'policy'
      : null;

    rows.push({
      artifactId: artifact.artifactId,
      nodeId: artifact.nodeId,
      platform: artifact.platform,
      kind: artifact.kind,
      affected: reasons.length > 0,
      cause,
      reasons,
      fieldsToRegenerate: [...regen].sort(),
      reusableFields: entries.map(e => e.name).filter(n => !touched.has(n)).sort(),
      hasDependencyMetadata: hasMeta,
    });
  }

  return rows;
}

export function impactSummary(rows: ImpactRow[]): ImpactSummary {
  const byCause = { sku: 0, policy: 0, both: 0 };
  let affectedCount = 0;
  for (const row of rows) {
    if (!row.affected) continue;
    affectedCount += 1;
    if (row.cause && row.cause in byCause) byCause[row.cause as 'sku' | 'policy' | 'both'] += 1;
  }
  return {
    affectedCount,
    unaffectedCount: rows.length - affectedCount,
    byCause,
  };
}

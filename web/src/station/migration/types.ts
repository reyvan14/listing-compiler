// Self-healing Listing CI/CD — shared frontend types.
//
// The canvas owns a clean camelCase `Artifact` model. The deterministic
// dependency graph / stale propagation / reducer all operate on it; the backend
// migration endpoints are called with the same data serialised to snake_case.

export type MigrationStatus =
  | 'current'
  | 'stale'
  | 'candidate'
  | 'applied'
  | 'rolled-back'
  | 'needs-human-review';

export type ImpactCause = 'sku' | 'policy' | 'both' | null;

export type ArtifactFieldMeta = { name: string; factRefs: string[] };

export type Artifact = {
  artifactId: string;
  nodeId?: string; // tldraw shape id, for "click to focus"
  platform: string;
  kind: 'listing' | 'image' | 'video';
  revision: number;
  status: MigrationStatus;
  policyVersion: string;
  skuRevision?: string;
  title?: string;
  titleFactRefs?: string[];
  fields: { name: string; label: string; value: string; factRefs: string[] }[];
  assetRefs?: string[];
};

export type PolicyChangeInput = {
  platform: string;
  /** artifact field names the policy diff touches, e.g. ['title'] */
  fields: string[];
  baseVersion?: string;
  candidateVersion?: string;
  ruleIds?: string[];
  /** fields the candidate policy *blocks* (need regeneration, not just re-validation) */
  blockingFields?: string[];
};

export type ImpactReasonType = 'sku_fact' | 'sku_fact_conservative' | 'policy';

export type ImpactReason = {
  type: ImpactReasonType;
  detail: string;
  factIds?: string[];
  ruleIds?: string[];
  fields: string[];
  requiresRegen?: boolean;
};

export type ImpactRow = {
  artifactId: string;
  nodeId?: string;
  platform: string;
  kind: Artifact['kind'];
  affected: boolean;
  cause: ImpactCause;
  reasons: ImpactReason[];
  fieldsToRegenerate: string[];
  reusableFields: string[];
  hasDependencyMetadata: boolean;
};

export type ImpactSummary = {
  affectedCount: number;
  unaffectedCount: number;
  byCause: { sku: number; policy: number; both: number };
};

export type CandidatePatch = {
  artifactId: string;
  platform: string;
  field: string;
  previousValue: string;
  candidateValue: string;
  reason: string;
  triggering: { kind: string; factIds?: string[]; ruleIds?: string[] };
  factRefs: string[];
  validation: { ok: boolean; checkable: boolean; semantic?: { ok: boolean } };
  needsHumanReview: boolean;
  note: string;
};

export function patchKey(p: { artifactId: string; field: string }): string {
  return `${p.artifactId}:${p.field}`;
}

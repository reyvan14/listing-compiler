import { ApiError, apiUrl, toSafeMessage } from '../apiClient';
import { evidenceHeaders } from '../evidenceApi';

// The stored-candidate half of the migration API.
//
// The endpoints in ./api.ts are stateless: the panel hands them artifacts it
// already holds. These read candidates the server built and wrote down, which
// is what an Agent action produces — the action returns an id, and the panel
// has to be able to fetch the same record the action stored.

/**
 * Local transport rather than the shared postJson.
 *
 * The candidate endpoints refuse for reasons the operator has to read — the
 * confirmation token does not match these patches, this candidate was already
 * applied — and postJson collapses every 4xx into a category. Those messages
 * are server-authored, safe strings; dropping them would leave the panel
 * saying "请求失败" when it knows exactly what went wrong.
 */
type Envelope<T> = { code: number; data?: T; error?: string; message?: string };

export class CandidateRejected extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CandidateRejected';
  }
}

export function candidateErrorMessage(err: unknown): string {
  return err instanceof CandidateRejected ? err.message : toSafeMessage(err);
}

async function call<T>(path: string, productId: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    // Candidates live in the request-scoped evidence store, so every call has
    // to name the same workspace and product the Agent action wrote under —
    // otherwise the panel reads an empty store and reports the candidate it
    // was just handed as missing.
    res = await fetch(apiUrl(path), {
      ...init,
      headers: { ...(init.headers ?? {}), ...evidenceHeaders(productId) },
    });
  } catch {
    throw new ApiError('network');
  }
  let json: Envelope<T> | null = null;
  try {
    json = (await res.json()) as Envelope<T>;
  } catch {
    json = null;
  }
  if (!res.ok) {
    if (json?.error && json?.message) throw new CandidateRejected(json.error, json.message);
    throw new ApiError('bad-response', res.status);
  }
  if (!json || json.code !== 0 || json.data === undefined) throw new ApiError('bad-response');
  return json.data;
}

export type MigrationPatch = {
  patch_id: string;
  artifact_id: string;
  platform: string;
  field: string;
  previous_value: string;
  candidate_value: string;
  reason: string;
  note: string;
  needs_human_review: boolean;
  sku_id?: string;
  revision_state?: string;
  triggering: { kind?: string; rule_ids?: string[]; policy_from?: string; policy_to?: string };
};

export type StoredCandidate = {
  candidate_id: string;
  state: 'blocked' | 'built' | 'applied' | 'rolled_back';
  platform: string;
  created_at: string;
  source_action: string;
  idempotency_key: string;
  requested_fields: string[];
  base_policy_version: string;
  candidate_policy_version: string;
  policy_diff: {
    platform: string;
    base_version: string;
    candidate_version: string;
    added: { id: string }[];
    removed: { id: string }[];
    changed: { rule_id: string }[];
    affected_fields: string[];
  } | null;
  patches: MigrationPatch[];
  blockers: { code: string; detail: string }[];
  warnings: string[];
  human_review?: { artifact_id: string; field: string; note: string }[];
  evidence_refs: { kind: string; id: string }[];
  applied: {
    source_revision_id: string;
    candidate_revision_id: string;
    forked: boolean;
    fields: string[];
    patch_ids: string[];
    state: string;
  }[];
  applied_at?: string;
  applied_by?: string;
  withdrawn_revision_ids?: string[];
};

export function fetchCandidate(
  candidateId: string,
  productId: string,
): Promise<{ candidate: StoredCandidate; confirmation_token: string }> {
  return call(`/api/migration/candidates/${encodeURIComponent(candidateId)}`, productId);
}

/**
 * A token for one specific subset of patches.
 *
 * Deliberately not derivable on the client: the confirmation the operator gives
 * is bound server-side to exactly the patches they ticked, so a token collected
 * for two patches cannot authorise applying five.
 */
export function fetchConfirmation(
  candidateId: string,
  patchIds: string[],
  productId: string,
): Promise<{ confirmation_token: string }> {
  return call(`/api/migration/candidates/${encodeURIComponent(candidateId)}/confirmation`, productId, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patch_ids: patchIds }),
  });
}

export function applyCandidate(
  candidateId: string,
  productId: string,
  body: { patch_ids: string[]; operator: string; reason: string; confirm_token: string },
): Promise<{ candidate: StoredCandidate }> {
  return call(`/api/migration/candidates/${encodeURIComponent(candidateId)}/apply`, productId, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function rollbackCandidate(
  candidateId: string,
  productId: string,
  body: { operator: string; reason: string },
): Promise<{ candidate: StoredCandidate }> {
  return call(`/api/migration/candidates/${encodeURIComponent(candidateId)}/rollback`, productId, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

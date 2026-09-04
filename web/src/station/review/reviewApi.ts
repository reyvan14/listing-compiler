import { ApiError, apiUrl, toSafeMessage } from '../apiClient';
import { evidenceHeaders } from '../evidenceApi';

// Client for the listing review workflow (/api/review/*).
//
// Review state is server-owned on purpose: an approval that lived only in
// browser memory would be a claim about a decision rather than a record of one.
// Every state shown in the UI is read back from these endpoints.

export type RevisionState =
  | 'draft'
  | 'in_review'
  | 'needs_changes'
  | 'validated'
  | 'approved'
  | 'superseded'
  | 'rolled_back';

export const REVISION_STATE_META: Record<
  RevisionState,
  { label: string; tone: 'neutral' | 'ok' | 'warn' | 'danger' }
> = {
  draft: { label: '草稿', tone: 'neutral' },
  in_review: { label: '待校验', tone: 'neutral' },
  needs_changes: { label: '需修改', tone: 'danger' },
  validated: { label: '校验通过', tone: 'warn' },
  approved: { label: '已批准', tone: 'ok' },
  superseded: { label: '已被取代', tone: 'neutral' },
  rolled_back: { label: '已回滚', tone: 'neutral' },
};

export type RevisionField = { label: string; value: string };

export type RevisionContent = { title: string; fields: RevisionField[] };

export type Revision = {
  revision_id: string;
  seq: number;
  project_id: string;
  sku_id: string;
  platform: string;
  market: string;
  locale: string;
  parent_revision_id: string;
  restores_revision_id: string;
  created_at: string;
  updated_at: string;
  source: string;
  generator: Record<string, string>;
  product_name: string;
  points: string;
  asset_mode: string;
  content: RevisionContent;
  content_hash: string;
  field_hashes: Record<string, string>;
  state: RevisionState;
  validation_id: string;
  approval_id: string;
};

export type ValidationCheck = {
  id: string;
  label: string;
  state: string;
  detail: string;
  suggestion?: string;
  blocking?: boolean;
  evidence?: string[];
};

export type ValidationRecord = {
  validation_id: string;
  revision_id: string;
  platform: string;
  content_hash: string;
  checks: ValidationCheck[];
  blockers: string[];
  warnings: string[];
  policy_snapshot_ids: string[];
  suggested_title: string;
  ran_at: string;
};

export type ApprovalRecord = {
  approval_id: string;
  revision_id: string;
  sku_id: string;
  platform: string;
  operator: string;
  decision: 'approved' | 'changes_requested' | 'rollback';
  reason: string;
  content_hash: string;
  validation_result_ids: string[];
  policy_snapshot_ids: string[];
  at: string;
};

export type Acknowledgement = {
  ack_id: string;
  revision_id: string;
  validation_id: string;
  warning_ids: string[];
  operator: string;
  reason: string;
  at: string;
};

export type RevisionSummary = {
  revision_id: string;
  state: RevisionState;
  source: string;
  platform: string;
  sku_id: string;
  created_at: string;
  content_hash: string;
  parent_revision_id: string;
  restores_revision_id: string;
};

export type AuditEvent = {
  event_id: string;
  event: string;
  revision_id: string;
  operator: string;
  reason: string;
  detail: Record<string, unknown>;
  at: string;
};

export type RevisionView = {
  revision: Revision;
  validation: ValidationRecord | null;
  approvals: ApprovalRecord[];
  acknowledgements: Acknowledgement[];
  history: RevisionSummary[];
  approved_revision_id: string;
  audit: AuditEvent[];
  superseded?: string[];
  rolled_back?: string[];
};

export type DiffStatus = 'unchanged' | 'added' | 'removed' | 'modified';

export type DiffRow = {
  label: string;
  before: string;
  after: string;
  status: DiffStatus;
};

export type RevisionDiff = {
  base: RevisionSummary;
  target: RevisionSummary;
  rows: DiffRow[];
  counts: Record<DiffStatus, number>;
  identical: boolean;
};

/** A rejected review operation, carrying the backend's safe explanation. */
export class ReviewRejected extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ReviewRejected';
    this.code = code;
    this.status = status;
  }
}

export function isReviewRejected(err: unknown): err is ReviewRejected {
  return err instanceof ReviewRejected;
}

/** Safe message for anything thrown by this client. */
export function reviewErrorMessage(err: unknown): string {
  if (isReviewRejected(err)) return err.message;
  return toSafeMessage(err);
}

type Envelope<T> = { code?: number; error?: string; message?: string; data?: T };

async function request<T>(
  path: string,
  productId: string,
  init: RequestInit = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...evidenceHeaders(productId),
      },
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
    // The review endpoints return their own safe, specific rejection text
    // (why an approval was refused, which warning does not exist). Surfacing
    // it beats replacing it with a generic "服务返回异常".
    if (json?.error && json?.message) {
      throw new ReviewRejected(json.error, json.message, res.status);
    }
    throw new ApiError('http', res.status);
  }
  if (!json || json.code !== 0 || json.data === undefined) {
    throw new ApiError('bad-response', res.status);
  }
  return json.data;
}

function post<T>(path: string, productId: string, payload: unknown): Promise<T> {
  return request<T>(path, productId, { method: 'POST', body: JSON.stringify(payload) });
}

export type CreateRevisionInput = {
  sku_id: string;
  platform: string;
  content: RevisionContent;
  project_id?: string;
  market?: string;
  locale?: string;
  source?: string;
  generator?: Record<string, string>;
  product_name?: string;
  points?: string;
  asset_mode?: string;
};

export async function createRevision(
  input: CreateRevisionInput,
  productId = 'default-product',
): Promise<Revision> {
  const data = await post<{ revision: Revision }>('/api/review/revisions', productId, input);
  return data.revision;
}

export async function listRevisions(
  skuId: string,
  platform: string,
  productId = 'default-product',
  signal?: AbortSignal,
): Promise<Revision[]> {
  const query = new URLSearchParams({ sku_id: skuId, platform });
  const data = await request<{ revisions: Revision[] }>(
    `/api/review/revisions?${query}`,
    productId,
    { signal },
  );
  return data.revisions ?? [];
}

export function fetchRevision(
  revisionId: string,
  productId = 'default-product',
  signal?: AbortSignal,
): Promise<RevisionView> {
  return request<RevisionView>(`/api/review/revisions/${revisionId}`, productId, { signal });
}

export async function saveDraft(
  revisionId: string,
  content: RevisionContent,
  operator: string,
  productId = 'default-product',
): Promise<{ revision: Revision; forked: boolean }> {
  return post(`/api/review/revisions/${revisionId}/draft`, productId, { content, operator });
}

export function submitForValidation(
  revisionId: string,
  operator: string,
  productId = 'default-product',
): Promise<RevisionView> {
  return post(`/api/review/revisions/${revisionId}/validate`, productId, { operator });
}

export function approveRevision(
  revisionId: string,
  operator: string,
  reason: string,
  productId = 'default-product',
): Promise<RevisionView> {
  return post(`/api/review/revisions/${revisionId}/approve`, productId, { operator, reason });
}

export function requestChanges(
  revisionId: string,
  operator: string,
  reason: string,
  productId = 'default-product',
): Promise<RevisionView> {
  return post(`/api/review/revisions/${revisionId}/request-changes`, productId, {
    operator,
    reason,
  });
}

export function rollbackTo(
  revisionId: string,
  operator: string,
  reason: string,
  productId = 'default-product',
): Promise<RevisionView> {
  return post(`/api/review/revisions/${revisionId}/rollback`, productId, { operator, reason });
}

export function acknowledgeWarnings(
  revisionId: string,
  warningIds: string[],
  operator: string,
  reason: string,
  productId = 'default-product',
): Promise<RevisionView> {
  return post(`/api/review/revisions/${revisionId}/acknowledge`, productId, {
    warning_ids: warningIds,
    operator,
    reason,
  });
}

export function fetchDiff(
  base: string,
  target: string,
  productId = 'default-product',
  signal?: AbortSignal,
): Promise<RevisionDiff> {
  const query = new URLSearchParams({ base, target });
  return request<RevisionDiff>(`/api/review/diff?${query}`, productId, { signal });
}

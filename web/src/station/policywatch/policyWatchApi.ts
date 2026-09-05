import { ApiError, apiUrl, toSafeMessage } from '../apiClient';
import { evidenceHeaders } from '../evidenceApi';

// Client for Policy Watch (/api/policy/watch/*) and market coverage.
//
// The client mirrors the backend's central restraint: there is no function here
// that activates a policy. Approving a candidate confirms that a source page
// really changed; writing the snapshot stays a human authoring step.

export type WatchResult = 'unchanged' | 'changed' | 'failed' | '';

export type Watch = {
  watch_id: string;
  platform: string;
  market: string;
  source_url: string;
  source_name: string;
  snapshot_id: string;
  snapshot_hash: string;
  allowed: boolean;
  last_checked_at: string;
  last_status: number;
  etag: string;
  last_modified: string;
  content_hash: string;
  last_result: WatchResult;
  last_error?: string;
  last_error_message?: string;
};

export type PolicyCandidate = {
  candidate_id: string;
  watch_id: string;
  platform: string;
  market: string;
  source_url: string;
  source_name: string;
  retrieved_at: string;
  http_status: number;
  previous_content_hash: string;
  content_hash: string;
  current_snapshot_id: string;
  current_snapshot_hash: string;
  excerpt: string;
  redirect_hops: string[];
  state: 'changed' | 'approved' | 'rejected';
  interpretation: {
    summary: string;
    assisted_by: string;
    provider: string;
    model: string;
    authoritative: boolean;
    note: string;
    at: string;
  } | null;
  reviewed_by: string;
  reviewed_at: string;
  review_note: string;
  activation?: { activated: boolean; note: string };
};

export type WatchEvent = { event: string; at: string; [key: string]: unknown };

export type WatchOverview = {
  watches: Watch[];
  candidates: PolicyCandidate[];
  allowlist: string[];
  events: WatchEvent[];
};

export type CheckResult = {
  result: 'unchanged' | 'changed' | 'failed';
  error?: string;
  message?: string;
  watch: Watch;
  candidate: PolicyCandidate | null;
};

export type MarketCoverage = {
  market: string;
  label: string;
  language: string;
  language_label: string;
  currency: string;
  currency_symbol: string;
  measurement_system: string;
  coverage: 'covered' | 'not_covered';
  covered_platforms: string[];
  uncovered_platforms: string[];
  verifiable: boolean;
  note: string;
};

export const RESULT_META: Record<
  'unchanged' | 'changed' | 'failed',
  { label: string; tone: 'ok' | 'warn' | 'danger' }
> = {
  unchanged: { label: '无变化', tone: 'ok' },
  changed: { label: '检测到变化', tone: 'warn' },
  failed: { label: '检查失败', tone: 'danger' },
};

type Envelope<T> = { code?: number; error?: string; message?: string; data?: T };

export class WatchRejected extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'WatchRejected';
    this.code = code;
    this.status = status;
  }
}

export function watchErrorMessage(err: unknown): string {
  if (err instanceof WatchRejected) return err.message;
  return toSafeMessage(err);
}

async function request<T>(path: string, productId: string, init: RequestInit = {}): Promise<T> {
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
    if (json?.error && json?.message) throw new WatchRejected(json.error, json.message, res.status);
    throw new ApiError('http', res.status);
  }
  if (!json || json.code !== 0 || json.data === undefined) {
    throw new ApiError('bad-response', res.status);
  }
  return json.data;
}

export function fetchWatches(
  productId = 'default-product',
  signal?: AbortSignal,
): Promise<WatchOverview> {
  return request('/api/policy/watch', productId, { signal });
}

export function checkWatch(watchId: string, productId = 'default-product'): Promise<CheckResult> {
  return request(`/api/policy/watch/${watchId}/check`, productId, { method: 'POST' });
}

export function checkAll(
  productId = 'default-product',
): Promise<{ results: CheckResult[] }> {
  return request('/api/policy/watch/check-all', productId, { method: 'POST' });
}

export function approveCandidate(
  candidateId: string,
  operator: string,
  reason: string,
  productId = 'default-product',
): Promise<{ candidate: PolicyCandidate }> {
  return request(`/api/policy/watch/candidates/${candidateId}/approve`, productId, {
    method: 'POST',
    body: JSON.stringify({ operator, reason }),
  });
}

export function rejectCandidate(
  candidateId: string,
  operator: string,
  reason: string,
  productId = 'default-product',
): Promise<{ candidate: PolicyCandidate }> {
  return request(`/api/policy/watch/candidates/${candidateId}/reject`, productId, {
    method: 'POST',
    body: JSON.stringify({ operator, reason }),
  });
}

export function fetchMarkets(
  productId = 'default-product',
  signal?: AbortSignal,
): Promise<{ markets: MarketCoverage[] }> {
  return request('/api/localization/markets', productId, { signal });
}

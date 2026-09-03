import { ApiError, apiUrl, postJson, toSafeMessage } from './apiClient';

// Client for the evidence ledger (/api/evidence/*).
//
// Evidence validation is deliberately a separate axis from platform policy
// validation: a title can satisfy every marketplace formatting rule and still
// assert an uncertified claim. The two never share a check list.

export type FactState =
  | 'verified'
  | 'needs_review'
  | 'unsupported'
  | 'conflicting'
  | 'expired';

export type ClaimType =
  | 'numeric'
  | 'material'
  | 'certification'
  | 'safety'
  | 'performance'
  | 'environmental'
  | 'marketing';

/** How a piece of evidence text was obtained. Never presented as equivalent. */
export type ExtractionMethod =
  | 'deterministic'
  | 'ocr'
  | 'model_assisted'
  | 'manual_review';

export const FACT_STATE_META: Record<
  FactState,
  { label: string; tone: 'ok' | 'warn' | 'danger' }
> = {
  verified: { label: '已核实', tone: 'ok' },
  needs_review: { label: '待确认', tone: 'warn' },
  unsupported: { label: '无证据', tone: 'danger' },
  conflicting: { label: '来源冲突', tone: 'danger' },
  expired: { label: '证据过期', tone: 'danger' },
};

export const METHOD_META: Record<ExtractionMethod, string> = {
  deterministic: '确定性解析',
  ocr: 'OCR 识别',
  model_assisted: '模型辅助',
  manual_review: '需人工阅读',
};

export const CLAIM_TYPE_LABEL: Record<string, string> = {
  numeric: '数值',
  material: '材质',
  certification: '认证',
  safety: '安全',
  performance: '性能',
  environmental: '环保',
  marketing: '营销',
};

export type EvidenceSource = {
  source_id: string;
  sha256: string;
  filename: string;
  label: string;
  mime_type: string;
  family: string;
  size_bytes: number;
  uploaded_at: string;
  expires_on: string;
};

export type FactLink = {
  source_id: string;
  page: number | null;
  sheet: string;
  cell: string;
  excerpt: string;
  method: ExtractionMethod;
  value?: string;
  expires_on?: string;
};

export type ProductFact = {
  fact_id: string;
  key: string;
  value: string;
  unit: string;
  display: string;
  claim_type: ClaimType;
  state: FactState;
  sources: FactLink[];
  updated_at: string;
  note: string;
};

export type Verdict = 'ok' | 'blocked' | 'needs_review';

export type GateClaim = {
  fact_key: string;
  fact_id: string;
  claim_type: ClaimType;
  label: string;
  matched: string;
  verdict: Verdict;
  state: FactState;
  detail: string;
  suggestion: string;
  supporting_sources: FactLink[];
};

export type GateField = { field: string; verdict: Verdict; claims: GateClaim[] };

export type GateResult = {
  platform: string;
  fields: GateField[];
  blocked_fields: string[];
  review_fields: string[];
  verdict: Verdict;
  claim_count: number;
};

export type GateResponse = {
  results: GateResult[];
  checks: Record<string, unknown[]>;
  summary: { blocked: number; needs_review: number; ok: number; claims: number };
};

const EVIDENCE_WORKSPACE_KEY = 'listing.evidence.workspace.v1';
let memoryWorkspace = '';

/**
 * The public demo has no accounts.  A random browser-local workspace plus the
 * current product id prevents unrelated visitors/products from sharing one
 * mutable evidence ledger.  This is isolation, not authentication.
 */
export function evidenceHeaders(productId = 'default-product'): Record<string, string> {
  if (!memoryWorkspace) {
    try {
      memoryWorkspace = localStorage.getItem(EVIDENCE_WORKSPACE_KEY) ?? '';
      if (!memoryWorkspace) {
        memoryWorkspace = crypto.randomUUID();
        localStorage.setItem(EVIDENCE_WORKSPACE_KEY, memoryWorkspace);
      }
    } catch {
      memoryWorkspace = `ephemeral-${crypto.randomUUID()}`;
    }
  }
  return {
    'X-Workspace-ID': memoryWorkspace,
    // Header values must be ByteString-compatible. Product names may contain
    // Chinese characters, so send a bounded ASCII representation; the backend
    // hashes it again before it ever becomes a path segment.
    'X-Product-ID': encodeURIComponent(productId || 'default-product').slice(0, 512),
  };
}

async function getJson<T>(path: string, productId: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), { signal, headers: evidenceHeaders(productId) });
  } catch {
    throw new ApiError('network');
  }
  if (!res.ok) throw new ApiError('http', res.status);
  let json: { code?: number; data?: T } | null = null;
  try {
    json = await res.json();
  } catch {
    throw new ApiError('bad-response', res.status);
  }
  if (!json || json.code !== 0 || json.data === undefined) {
    throw new ApiError('bad-response', res.status);
  }
  return json.data;
}

export async function fetchSources(productId = 'default-product', signal?: AbortSignal): Promise<EvidenceSource[]> {
  const data = await getJson<{ sources: EvidenceSource[] }>('/api/evidence/sources', productId, signal);
  return data.sources ?? [];
}

export async function fetchFacts(productId = 'default-product', signal?: AbortSignal): Promise<ProductFact[]> {
  const data = await getJson<{ facts: ProductFact[] }>('/api/evidence/facts', productId, signal);
  return data.facts ?? [];
}

/** Upload one evidence document. Multipart, so it bypasses postJson. */
export async function uploadEvidence(
  file: File,
  opts: { expiresOn?: string; label?: string; signal?: AbortSignal } = {},
  productId = 'default-product',
): Promise<{ source: EvidenceSource; facts: ProductFact[] }> {
  const form = new FormData();
  form.append('file', file);
  form.append('expires_on', opts.expiresOn ?? '');
  form.append('label', opts.label ?? '');

  let res: Response;
  try {
    res = await fetch(apiUrl('/api/evidence/upload'), {
      method: 'POST',
      body: form,
      signal: opts.signal,
      headers: evidenceHeaders(productId),
    });
  } catch {
    throw new ApiError('network');
  }
  let json: { code?: number; message?: string; data?: any } | null = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    // The backend supplies a safe Chinese message for a rejected upload
    // (wrong type, too large); surface that rather than a generic HTTP error.
    const err = new ApiError('http', res.status);
    if (json?.message) Object.defineProperty(err, 'message', { value: json.message });
    throw err;
  }
  if (!json || json.code !== 0 || !json.data) throw new ApiError('bad-response', res.status);
  return { source: json.data.source, facts: json.data.facts ?? [] };
}

export async function setFactState(
  factId: string,
  state: FactState,
  opts: { value?: string; note?: string } = {},
  productId = 'default-product',
): Promise<ProductFact> {
  const data = await postJson<{ fact: ProductFact }>(
    `/api/evidence/facts/${encodeURIComponent(factId)}/state`,
    { state, value: opts.value ?? null, note: opts.note ?? '' },
    { timeoutMs: 20_000, headers: evidenceHeaders(productId) },
  );
  return data.fact;
}

export async function deleteSource(sourceId: string, productId = 'default-product'): Promise<void> {
  const res = await fetch(apiUrl(`/api/evidence/sources/${encodeURIComponent(sourceId)}`), {
    method: 'DELETE',
    headers: evidenceHeaders(productId),
  });
  if (!res.ok) throw new ApiError('http', res.status);
}

/** Run the release gate over already-generated drafts.
 *
 * `sourcePoints` carries the SKU selling points so a claim asserted in the
 * truth source is gated even when no platform's copy repeats it. */
export async function runGate(
  drafts: unknown[],
  signal?: AbortSignal,
  sourcePoints = '',
  productId = 'default-product',
): Promise<GateResponse> {
  return postJson<GateResponse>(
    '/api/evidence/gate',
    { drafts, source_points: sourcePoints },
    { timeoutMs: 20_000, signal, headers: evidenceHeaders(productId) },
  );
}

/** Human-readable source location, e.g. "第 3 页" or "Sheet1 · row 4". */
export function locationLabel(link: FactLink): string {
  const parts: string[] = [];
  if (link.page != null) parts.push(`第 ${link.page} 页`);
  if (link.sheet) parts.push(link.sheet);
  if (link.cell) parts.push(link.cell);
  return parts.join(' · ') || '整篇文档';
}

export { toSafeMessage };

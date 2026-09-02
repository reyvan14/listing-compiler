import { ApiError, apiUrl, postJson } from '../apiClient';

// Client for the batch portfolio endpoints (/api/portfolio/*).
// Everything here is deterministic on the backend — no model, no publishing.

export type PortfolioSku = {
  sku: string;
  product_name: string;
  points: string;
  platforms: string[];
  evidence_sources: string[];
  row: number;
};

export type ImportError = {
  row: number;
  sku: string;
  error: string;
  severity?: 'warning';
};

export type ImportResult = {
  skus: PortfolioSku[];
  errors: ImportError[];
  summary: { total_rows: number; imported: number; rejected: number };
};

export type RowStatus =
  | 'unaffected'
  | 'safe_patch'
  | 'review_required'
  | 'blocked'
  | 'applied'
  | 'rolled_back';

export const STATUS_META: Record<
  RowStatus,
  { label: string; tone: 'ok' | 'warn' | 'danger' | 'muted' }
> = {
  unaffected: { label: '未受影响', tone: 'muted' },
  safe_patch: { label: '可安全修补', tone: 'ok' },
  review_required: { label: '需人工复核', tone: 'warn' },
  blocked: { label: '阻断', tone: 'danger' },
  applied: { label: '已应用', tone: 'ok' },
  rolled_back: { label: '已回滚', tone: 'muted' },
};

export type MatrixRow = {
  sku: string;
  platform: string;
  field: string;
  artifact_id: string;
  status: RowStatus;
  cause: string | null;
  reason: string;
  previous_value: string;
  candidate_value: string;
  note: string;
};

export type PerSku = {
  sku: string;
  product_name: string;
  affected: boolean;
  safe_patch: number;
  review_required: number;
  blocked: number;
  platforms: string[];
};

export type PortfolioAnalysis = {
  generated_at: string;
  matrix: MatrixRow[];
  per_sku: PerSku[];
  artifacts: Record<string, Record<string, unknown>[]>;
  summary: {
    skus_scanned: number;
    skus_affected: number;
    skus_unaffected: number;
    affected_platforms: string[];
    affected_fields: string[];
    safe_patch: number;
    review_required: number;
    blocked: number;
    unaffected_rows: number;
  };
  policy: { base_version: string | null; candidate_version: string | null };
};

export type ApplyResult = {
  results: Record<string, { artifacts: Record<string, unknown>[]; applied: string[]; review: string[] }>;
  applied_skus: string[];
  needs_review_skus: string[];
  rejected_patches: { sku: string; field: string; reason: string }[];
};

export function templateUrl(): string {
  return apiUrl('/api/portfolio/template');
}

export async function importPortfolio(file: File): Promise<ImportResult> {
  const form = new FormData();
  form.append('file', file);
  let res: Response;
  try {
    res = await fetch(apiUrl('/api/portfolio/import'), { method: 'POST', body: form });
  } catch {
    throw new ApiError('network');
  }
  let json: { code?: number; message?: string; data?: ImportResult } | null = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = new ApiError('http', res.status);
    if (json?.message) Object.defineProperty(err, 'message', { value: json.message });
    throw err;
  }
  if (!json || json.code !== 0 || !json.data) throw new ApiError('bad-response', res.status);
  return json.data;
}

export async function analyzePortfolio(payload: {
  skus: PortfolioSku[];
  basePolicyVersion?: string;
  candidatePolicyVersion?: string;
  pointsOverride?: Record<string, string>;
}): Promise<PortfolioAnalysis> {
  return postJson<PortfolioAnalysis>(
    '/api/portfolio/impact',
    {
      skus: payload.skus,
      base_policy_version: payload.basePolicyVersion ?? null,
      candidate_policy_version: payload.candidatePolicyVersion ?? null,
      points_override: payload.pointsOverride ?? {},
    },
    { timeoutMs: 60_000 },
  );
}

export async function applyPortfolio(payload: {
  artifacts: PortfolioAnalysis['artifacts'];
  approved: MatrixRow[];
  candidatePolicyVersion?: string;
}): Promise<ApplyResult> {
  return postJson<ApplyResult>(
    '/api/portfolio/apply',
    {
      artifacts: payload.artifacts,
      approved: payload.approved,
      candidate_policy_version: payload.candidatePolicyVersion ?? null,
    },
    { timeoutMs: 60_000 },
  );
}

export async function rollbackPortfolio(
  snapshot: unknown,
  sku?: string,
): Promise<{ scope: string; artifacts: Record<string, unknown[]> }> {
  return postJson('/api/portfolio/rollback', { snapshot, sku: sku ?? null }, { timeoutMs: 30_000 });
}

/** Local batch snapshot, mirroring the backend's shape. */
export function snapshotPortfolio(artifacts: PortfolioAnalysis['artifacts']) {
  return { snapshot_id: `local-${Date.now()}`, artifacts: JSON.parse(JSON.stringify(artifacts)) };
}

export async function downloadBatchReport(payload: {
  analysis: PortfolioAnalysis;
  applyResult?: ApplyResult | null;
  status: string;
  approver?: string;
}): Promise<void> {
  const report = await postJson<Record<string, unknown>>(
    '/api/portfolio/report',
    {
      analysis: payload.analysis,
      apply_result: payload.applyResult ?? null,
      status: payload.status,
      approver: payload.approver ?? '',
    },
    { timeoutMs: 30_000 },
  );
  const blob = new Blob([JSON.stringify(report, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `portfolio-migration-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Only rows the backend will actually accept for bulk approval. */
export function safeRows(matrix: MatrixRow[]): MatrixRow[] {
  return matrix.filter(r => r.status === 'safe_patch');
}

export function reviewRows(matrix: MatrixRow[]): MatrixRow[] {
  return matrix.filter(r => r.status === 'review_required');
}

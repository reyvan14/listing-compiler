import { ApiError, apiUrl, toSafeMessage } from '../apiClient';
import { evidenceHeaders } from '../evidenceApi';
import type { InspectionResult, InspectionSummary } from '../media/imageApi';
import type { ApprovalRecord, AuditEvent, ValidationCheck } from '../review/reviewApi';

// Client for the Release Passport (/api/passport/*).
//
// The passport is assembled server-side from stored entity ids. This client
// deliberately does no derivation of its own: anything the UI shows is a field
// the backend computed from records, so the screen cannot claim more than the
// ledger supports.

export type Readiness =
  | 'blocked'
  | 'needs_review'
  | 'ready_for_handoff'
  | 'exported'
  | 'superseded';

export const READINESS_META: Record<
  Readiness,
  { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' }
> = {
  blocked: { label: '阻断', tone: 'danger' },
  needs_review: { label: '待人工确认', tone: 'warn' },
  ready_for_handoff: { label: '可交接', tone: 'ok' },
  exported: { label: '已导出', tone: 'ok' },
  superseded: { label: '已被取代', tone: 'neutral' },
};

export type PassportFactLink = {
  source_id: string;
  present: boolean;
  sha256: string;
  page: number | null;
  sheet: string;
  cell: string;
  method: string;
  expires_on: string;
};

export type PassportFact = {
  fact_id: string;
  key: string;
  value: string;
  display: string;
  claim_type: string;
  state: string;
  sources: PassportFactLink[];
};

export type PassportDocument = {
  source_id: string;
  sha256: string;
  filename: string;
  label: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: string;
  expires_on: string;
  cited: boolean;
};

export type PassportMedia = {
  asset_id: string;
  sha256: string;
  origin: string;
  label: string;
  format: string;
  mime_type: string;
  width: number;
  height: number;
  size_bytes: number;
  policy_snapshot_id: string;
  summary: InspectionSummary;
  results: InspectionResult[];
  checksum_verified: boolean;
  present: boolean;
};

export type PassportSnapshot = {
  snapshot_id: string;
  platform: string;
  market: string;
  status: string;
  effective_date: string;
  excerpt_date: string;
  source_name: string;
  source_url: string;
  rules_sha256: string;
  rule_count: number;
};

export type Passport = {
  schema: string;
  passport_id: string;
  project_id: string;
  sku_id: string;
  platform: string;
  locale: {
    market?: string;
    language?: string;
    currency?: string;
    unit_system?: string;
    declared_by?: string;
    verified?: boolean;
  };
  revision_id: string;
  revision_lineage: string[];
  content_hash: string;
  field_hashes: Record<string, string>;
  listing: { title: string; fields: { label: string; value: string }[] };
  generator: Record<string, string>;
  validation: {
    validation_id?: string;
    blockers?: string[];
    warnings?: string[];
    checks?: ValidationCheck[];
    policy_snapshot_ids?: string[];
    revalidated_at?: string;
  };
  evidence_gate: {
    verdict?: string;
    fields?: { field: string; verdict: string; claims: { label: string; detail: string; verdict: string }[] }[];
  };
  facts: PassportFact[];
  evidence_documents: PassportDocument[];
  media: PassportMedia[];
  policy_snapshots: PassportSnapshot[];
  approvals: ApprovalRecord[];
  acknowledgements: { ack_id: string; operator: string; reason: string; warning_ids: string[]; at: string }[];
  audit: AuditEvent[];
  blockers: string[];
  warnings: string[];
  manual_review: { asset_id?: string; rule_id?: string; state?: string; detail?: string; field?: string; claim?: string }[];
  readiness: Readiness;
  content_readiness: Readiness;
  readiness_reasons: string[];
  built_at: string;
  content_digest: string;
  export: {
    digest: string;
    files: number;
    bytes: number;
    exported_at: string;
    verified: boolean;
  } | null;
};

export type PackageFile = {
  path: string;
  size_bytes: number;
  sha256: string;
  entity: string;
};

export type PackageManifest = {
  schema: string;
  passport_id: string;
  content_digest: string;
  sku_id: string;
  platform: string;
  revision_id: string;
  readiness: Readiness;
  files: PackageFile[];
  note: string;
};

export class PassportRejected extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'PassportRejected';
    this.code = code;
    this.status = status;
  }
}

export function isPassportRejected(err: unknown): err is PassportRejected {
  return err instanceof PassportRejected;
}

export function passportErrorMessage(err: unknown): string {
  if (isPassportRejected(err)) return err.message;
  return toSafeMessage(err);
}

type Envelope<T> = { code?: number; error?: string; message?: string; data?: T };

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
    if (json?.error && json?.message) {
      throw new PassportRejected(json.error, json.message, res.status);
    }
    throw new ApiError('http', res.status);
  }
  if (!json || json.code !== 0 || json.data === undefined) {
    throw new ApiError('bad-response', res.status);
  }
  return json.data;
}

export async function buildPassport(
  input: { sku_id: string; platform: string; project_id?: string; currency?: string; language?: string; unit_system?: string },
  productId = 'default-product',
): Promise<Passport> {
  const data = await request<{ passport: Passport }>('/api/passport/build', productId, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return data.passport;
}

export async function fetchManifest(
  passportId: string,
  productId = 'default-product',
): Promise<PackageManifest> {
  const data = await request<{ manifest: PackageManifest }>(
    `/api/passport/${passportId}/manifest`,
    productId,
  );
  return data.manifest;
}

/**
 * Download the handoff package.
 *
 * `confirm` is required by the endpoint, so an export cannot be produced by a
 * stray or replayed request. The caller must have obtained a real confirmation
 * before calling this.
 */
export async function exportPackage(
  passportId: string,
  productId = 'default-product',
): Promise<{ blob: Blob; digest: string; filename: string }> {
  let res: Response;
  try {
    res = await fetch(apiUrl(`/api/passport/${passportId}/export`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...evidenceHeaders(productId) },
      body: JSON.stringify({ confirm: true }),
    });
  } catch {
    throw new ApiError('network');
  }
  if (!res.ok) {
    let body: Envelope<unknown> | null = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (body?.error && body?.message) {
      throw new PassportRejected(body.error, body.message, res.status);
    }
    throw new ApiError('http', res.status);
  }
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  return {
    blob: await res.blob(),
    digest: res.headers.get('X-Package-Digest') ?? '',
    filename: match?.[1] ?? `${passportId}.zip`,
  };
}

import { ApiError, apiUrl, toSafeMessage } from '../apiClient';
import { evidenceHeaders } from '../evidenceApi';

// Client for multimodal intake (/api/intake/*) and provider capabilities.
//
// Two things this client deliberately does not do: it never derives a fact of
// its own, and it never renders a capability as available unless the backend
// said so. A browser guessing "the provider probably supports reference images"
// is exactly the claim the spec forbids.

export type ReviewState = 'needs_review' | 'approved' | 'rejected' | 'corrected';

export const REVIEW_STATE_META: Record<
  ReviewState,
  { label: string; tone: 'neutral' | 'ok' | 'warn' | 'danger' }
> = {
  needs_review: { label: '待确认', tone: 'warn' },
  approved: { label: '已确认读数', tone: 'ok' },
  corrected: { label: '已更正', tone: 'ok' },
  rejected: { label: '已否决', tone: 'danger' },
};

export type OcrBox = { left: number; top: number; width: number; height: number };

export type OcrWord = {
  text: string;
  confidence: number;
  box: OcrBox;
  line: number;
};

export type OcrResult = {
  state: 'ok' | 'manual_review' | 'failed';
  provider: string;
  method: string;
  text: string;
  words: OcrWord[];
  languages: string[];
  reason: string;
  detail: string;
  page: number | null;
  mean_confidence: number;
};

export type Candidate = {
  candidate_id: string;
  fact_id: string;
  key: string;
  label: string;
  value: string;
  raw_value: string;
  raw_unit: string;
  display: string;
  claim_type: string;
  data_type: string;
  origin: 'user' | 'ocr' | 'document' | 'appearance';
  method: string;
  confidence: number;
  source_id: string;
  page: number | null;
  box: OcrBox | null;
  excerpt: string;
  review_state: ReviewState;
  created_at: string;
  reviewed_by: string;
  reviewed_at: string;
  review_note: string;
  corrected_from?: string;
};

export type ConflictReading = {
  candidate_id: string;
  value: string;
  display: string;
  origin: string;
  method: string;
  confidence: number;
  source_id: string;
  review_state: ReviewState;
};

export type FactConflict = {
  conflict_id: string;
  key: string;
  label: string;
  readings: ConflictReading[];
  origins: string[];
  detected_at: string;
  resolved: boolean;
};

export type ExtractResult = {
  source: Record<string, unknown>;
  ocr: OcrResult | null;
  candidates: Candidate[];
  conflicts: FactConflict[];
  note: string;
};

export type OcrCapability = {
  available: boolean;
  provider: string;
  version: string;
  languages: string[];
  supports_chinese: boolean;
  supports_english: boolean;
  note: string;
};

export type ProviderCapability = {
  provider: string;
  supports_text: boolean;
  supports_vision: boolean;
  supports_reference_image: boolean;
  supports_ocr: boolean;
  supports_image_generation: boolean;
  supports_video_generation: boolean;
  supports_tts: boolean;
  supports_streaming: boolean;
  reference_image_field: string;
  notes: string;
};

export type Capabilities = {
  text: ProviderCapability;
  image: ProviderCapability;
  video: ProviderCapability;
  ocr: OcrCapability;
  reference_image: { supported: boolean; field: string; reason: string };
  vision: { supported: boolean; reason: string };
};

export const ORIGIN_LABEL: Record<string, string> = {
  user: '人工填写',
  ocr: 'OCR 识别',
  document: '文档解析',
  appearance: '外观观察',
};

type Envelope<T> = { code?: number; error?: string; message?: string; data?: T };

export class IntakeRejected extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'IntakeRejected';
    this.code = code;
    this.status = status;
  }
}

export function intakeErrorMessage(err: unknown): string {
  if (err instanceof IntakeRejected) return err.message;
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
    if (json?.error && json?.message) throw new IntakeRejected(json.error, json.message, res.status);
    throw new ApiError('http', res.status);
  }
  if (!json || json.code !== 0 || json.data === undefined) {
    throw new ApiError('bad-response', res.status);
  }
  return json.data;
}

export function fetchCapabilities(
  productId = 'default-product',
  signal?: AbortSignal,
): Promise<Capabilities> {
  return request<Capabilities>('/api/providers/capabilities', productId, { signal });
}

export function extractSource(
  sourceId: string,
  productId = 'default-product',
): Promise<ExtractResult> {
  return request<ExtractResult>(`/api/intake/sources/${sourceId}/extract`, productId, {
    method: 'POST',
  });
}

export function fetchCandidates(
  productId = 'default-product',
  signal?: AbortSignal,
): Promise<{ candidates: Candidate[]; conflicts: FactConflict[] }> {
  return request('/api/intake/candidates', productId, { signal });
}

export function reviewCandidate(
  candidateId: string,
  decision: 'approved' | 'rejected' | 'corrected',
  operator: string,
  options: { value?: string; note?: string } = {},
  productId = 'default-product',
): Promise<{ candidate: Candidate; conflicts: FactConflict[] }> {
  return request(`/api/intake/candidates/${candidateId}/review`, productId, {
    method: 'POST',
    body: JSON.stringify({
      decision,
      operator,
      value: options.value ?? null,
      note: options.note ?? '',
    }),
  });
}

/** URL of a stored evidence document's bytes, for drawing OCR boxes over it. */
export function evidenceBlobUrl(sourceId: string, productId = 'default-product'): string {
  const headers = evidenceHeaders(productId);
  const query = new URLSearchParams({
    workspace: headers['X-Workspace-ID'],
    product: headers['X-Product-ID'],
  });
  return apiUrl(`/api/evidence/sources/${sourceId}/blob?${query}`);
}

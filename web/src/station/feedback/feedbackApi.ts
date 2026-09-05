import { ApiError, apiUrl, toSafeMessage } from '../apiClient';
import { evidenceHeaders } from '../evidenceApi';

// Client for the Feedback Lab (/api/feedback/*).
//
// Every number here was computed by the backend from imported rows. The client
// derives no metric of its own, so nothing on screen can be more confident than
// the arithmetic behind it.

export type FeedbackRow = {
  line: number;
  sku: string;
  platform: string;
  revision_id: string;
  period_start: string;
  period_end: string;
  impressions: number | null;
  clicks: number | null;
  add_to_cart: number | null;
  purchases: number | null;
  revenue: number | null;
  returns: number | null;
  return_reason: string;
  review_text: string;
  rating: number | null;
};

export type RowProblem = { line: number; code: string; message: string };

export type ImportRecord = {
  import_id: string;
  filename: string;
  imported_at: string;
  row_count: number;
  problem_count: number;
  problems: RowProblem[];
  source: string;
  live_integration: boolean;
  note: string;
  rows?: FeedbackRow[];
};

export type Aggregate = {
  rows: number;
  impressions?: number | null;
  clicks?: number | null;
  add_to_cart?: number | null;
  purchases?: number | null;
  revenue?: number | null;
  returns?: number | null;
  ctr?: number | null;
  cvr?: number | null;
  atc_rate?: number | null;
  return_rate?: number | null;
  period_start?: string;
  period_end?: string;
  warnings: string[];
};

export type Signal = {
  signal: 'high_impressions_low_ctr' | 'acceptable_ctr_low_cvr' | 'elevated_return_rate' | 'repeated_theme';
  revision_id: string;
  observed: string;
  measurements: Record<string, unknown>;
  affected_field: string;
  proposal: string;
  supporting_rows: number[];
  quotes: string[];
  confidence: 'low' | 'medium' | 'high';
  risks: string;
  causality: string;
};

export type Analysis = {
  import_id: string;
  overall: Aggregate;
  by_platform: Record<string, Aggregate>;
  by_revision: Record<string, Aggregate>;
  signals: Signal[];
  candidate_count: number;
  problems: RowProblem[];
  live_integration: boolean;
  note: string;
};

export type Delta = { left: number; right: number; absolute: number; relative: number | null } | null;

export type Comparison = {
  left_label: string;
  right_label: string;
  left: Aggregate;
  right: Aggregate;
  deltas: Record<string, Delta>;
  left_sample: { rows: number; impressions: number | null; window: [string, string] };
  right_sample: { rows: number; impressions: number | null; window: [string, string] };
  low_sample: boolean;
  causality_note: string;
  warnings: string[];
};

export type Experiment = {
  experiment_id: string;
  hypothesis: string;
  baseline_revision_id: string;
  candidate_revision_id: string;
  changed_fields: string[];
  start_date: string;
  end_date: string;
  primary_metric: string;
  guardrail_metrics: string[];
  state: 'draft' | 'running' | 'stopped' | 'concluded';
  created_at: string;
  result: { import_id: string; observed: Comparison; interpretation: string } | null;
  note: string;
};

export const SIGNAL_LABEL: Record<Signal['signal'], string> = {
  high_impressions_low_ctr: '曝光高但点击率低',
  acceptable_ctr_low_cvr: '点击尚可但转化低',
  elevated_return_rate: '退货率偏高',
  repeated_theme: '重复出现的反馈主题',
};

export const CONFIDENCE_LABEL: Record<Signal['confidence'], string> = {
  low: '弱',
  medium: '中',
  high: '强',
};

type Envelope<T> = { code?: number; error?: string; message?: string; data?: T };

export class FeedbackRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'FeedbackRejected';
    this.code = code;
  }
}

export function feedbackErrorMessage(err: unknown): string {
  if (err instanceof FeedbackRejected) return err.message;
  return toSafeMessage(err);
}

async function request<T>(path: string, productId: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      ...init,
      headers: {
        ...(init.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
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
    if (json?.error && json?.message) throw new FeedbackRejected(json.error, json.message);
    throw new ApiError('http', res.status);
  }
  if (!json || json.code !== 0 || json.data === undefined) {
    throw new ApiError('bad-response', res.status);
  }
  return json.data;
}

export function templateUrl(): string {
  return apiUrl('/api/feedback/template');
}

export async function importFile(
  file: File,
  productId = 'default-product',
): Promise<ImportRecord> {
  const form = new FormData();
  form.append('file', file);
  const data = await request<{ import: ImportRecord }>('/api/feedback/import', productId, {
    method: 'POST',
    body: form,
  });
  return data.import;
}

export async function listImports(
  productId = 'default-product',
  signal?: AbortSignal,
): Promise<ImportRecord[]> {
  const data = await request<{ imports: ImportRecord[] }>('/api/feedback/imports', productId, {
    signal,
  });
  return data.imports ?? [];
}

export function fetchAnalysis(
  importId: string,
  productId = 'default-product',
): Promise<Analysis> {
  return request(`/api/feedback/imports/${importId}/analysis`, productId);
}

export function fetchComparison(
  importId: string,
  params: { mode: 'revision' | 'platform' | 'period'; left?: string; right?: string; split?: string },
  productId = 'default-product',
): Promise<Comparison> {
  const query = new URLSearchParams({
    mode: params.mode,
    left: params.left ?? '',
    right: params.right ?? '',
    split: params.split ?? '',
  });
  return request(`/api/feedback/imports/${importId}/compare?${query}`, productId);
}

export async function listExperiments(
  productId = 'default-product',
  signal?: AbortSignal,
): Promise<Experiment[]> {
  const data = await request<{ experiments: Experiment[] }>('/api/feedback/experiments', productId, {
    signal,
  });
  return data.experiments ?? [];
}

export async function createExperiment(
  input: {
    hypothesis: string;
    baseline_revision_id: string;
    candidate_revision_id?: string;
    changed_fields?: string[];
    primary_metric?: string;
  },
  productId = 'default-product',
): Promise<Experiment> {
  const data = await request<{ experiment: Experiment }>('/api/feedback/experiments', productId, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return data.experiment;
}

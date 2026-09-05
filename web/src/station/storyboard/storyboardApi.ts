import { ApiError, apiUrl, toSafeMessage } from '../apiClient';
import { evidenceHeaders } from '../evidenceApi';

// Client for the storyboard workflow (/api/storyboard/*).
//
// Progress comes from the backend's count of real per-shot outcomes. There is
// no timer here, and no function that turns elapsed time into a percentage.

export type ShotStatus = 'pending' | 'generating' | 'succeeded' | 'failed' | 'cancelled';

export const SHOT_STATUS_META: Record<
  ShotStatus,
  { label: string; tone: 'neutral' | 'ok' | 'warn' | 'danger' }
> = {
  pending: { label: '待生成', tone: 'neutral' },
  generating: { label: '生成中', tone: 'warn' },
  succeeded: { label: '已生成', tone: 'ok' },
  failed: { label: '失败', tone: 'danger' },
  cancelled: { label: '已取消', tone: 'neutral' },
};

export type Shot = {
  shot_id: string;
  beat: string;
  label: string;
  start_s: number;
  end_s: number;
  duration_s: number;
  instruction: string;
  fact_ids: string[];
  source_image_asset_id: string;
  overlay_text: string;
  narration: string;
  platform: string;
  status: ShotStatus;
  attempts: number;
  provider_task_id: string;
  result_url: string;
  error: string;
  updated_at: string;
};

export type Storyboard = {
  storyboard_id: string;
  sku_id: string;
  platform: string;
  shots: Shot[];
  created_at: string;
  updated_at: string;
  run_token: string;
  cancelled: boolean;
  final_video: { path: string; bytes: number; duration_s: number } | null;
  composition: { available: boolean; tool: string; note: string };
  tts: { available: boolean; provider: string; note: string };
};

export type Validation = {
  ok: boolean;
  problems: string[];
  total_seconds: number;
  shot_count: number;
  expected_model_calls: number;
  requires_confirmation: boolean;
};

export type Progress = {
  storyboard_id: string;
  counts: Record<ShotStatus, number>;
  succeeded: number;
  total: number;
  label: string;
  running: boolean;
  cancelled: boolean;
  complete: boolean;
};

export type GenerationPlan = {
  storyboard_id: string;
  shots_to_generate: string[];
  expected_model_calls: number;
  requires_confirmation: boolean;
  skipped_already_succeeded: string[];
  validation: Validation;
  blocked: boolean;
};

export type ContentPackage = {
  storyboard_id: string;
  platform: string;
  storyboard: { shots: Shot[]; total_seconds: number };
  captions: { webvtt: string; srt: string };
  narration: { script: string; audio: null; tts: Storyboard['tts']; note: string };
  clips: { shot_id: string; url: string; provider_task_id: string; duration_s: number }[];
  final_video: Storyboard['final_video'];
  composed: boolean;
  composition: Storyboard['composition'];
  manifest: {
    shot_count: number;
    generated_clips: number;
    missing_clips: string[];
    captions: string[];
    narration: string;
    final_video: string | null;
    generated_at: string;
  };
  note: string;
};

type Envelope<T> = { code?: number; error?: string; message?: string; data?: T };

export class StoryboardRejected extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'StoryboardRejected';
    this.code = code;
    this.status = status;
  }
}

export function storyboardErrorMessage(err: unknown): string {
  if (err instanceof StoryboardRejected) return err.message;
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
    if (json?.error && json?.message) {
      throw new StoryboardRejected(json.error, json.message, res.status);
    }
    throw new ApiError('http', res.status);
  }
  if (!json || json.code !== 0 || json.data === undefined) {
    throw new ApiError('bad-response', res.status);
  }
  return json.data;
}

export async function createStoryboard(
  skuId: string,
  platform = 'tiktok',
  productId = 'default-product',
): Promise<Storyboard> {
  const data = await request<{ storyboard: Storyboard }>('/api/storyboard', productId, {
    method: 'POST',
    body: JSON.stringify({ sku_id: skuId, platform }),
  });
  return data.storyboard;
}

export async function listStoryboards(
  skuId: string,
  productId = 'default-product',
  signal?: AbortSignal,
): Promise<Storyboard[]> {
  const data = await request<{ storyboards: Storyboard[] }>(
    `/api/storyboard?sku_id=${encodeURIComponent(skuId)}`,
    productId,
    { signal },
  );
  return data.storyboards ?? [];
}

export function fetchStoryboard(
  id: string,
  productId = 'default-product',
  signal?: AbortSignal,
): Promise<{ storyboard: Storyboard; validation: Validation; progress: Progress }> {
  return request(`/api/storyboard/${id}`, productId, { signal });
}

export function saveShots(
  id: string,
  shots: Partial<Shot>[],
  productId = 'default-product',
): Promise<{ storyboard: Storyboard; validation: Validation }> {
  return request(`/api/storyboard/${id}/shots`, productId, {
    method: 'POST',
    body: JSON.stringify({ shots }),
  });
}

export function planGeneration(
  id: string,
  shotIds: string[] = [],
  productId = 'default-product',
): Promise<GenerationPlan> {
  return request(`/api/storyboard/${id}/plan`, productId, {
    method: 'POST',
    body: JSON.stringify({ shot_ids: shotIds }),
  });
}

export function startRun(
  id: string,
  shotIds: string[] = [],
  productId = 'default-product',
): Promise<{ run_token: string; plan: GenerationPlan; storyboard: Storyboard }> {
  return request(`/api/storyboard/${id}/run`, productId, {
    method: 'POST',
    body: JSON.stringify({ shot_ids: shotIds, confirmed: true }),
  });
}

export function cancelRun(
  id: string,
  productId = 'default-product',
): Promise<{ storyboard: Storyboard; progress: Progress }> {
  return request(`/api/storyboard/${id}/cancel`, productId, { method: 'POST' });
}

export function fetchProgress(
  id: string,
  productId = 'default-product',
  signal?: AbortSignal,
): Promise<Progress> {
  return request(`/api/storyboard/${id}/progress`, productId, { signal });
}

export function fetchPackage(
  id: string,
  productId = 'default-product',
): Promise<ContentPackage> {
  return request(`/api/storyboard/${id}/package`, productId);
}

/**
 * Report one shot's outcome.
 *
 * The run token travels with it so the backend can refuse a result that belongs
 * to a cancelled or superseded run — the client asking politely is not enough.
 */
export function reportShot(
  storyboardId: string,
  shotId: string,
  body: { run_token: string; status: 'succeeded' | 'failed' | 'cancelled'; result_url?: string; provider_task_id?: string; error?: string },
  productId = 'default-product',
): Promise<{ accepted: boolean; reason?: string; progress: Progress }> {
  return request(`/api/storyboard/${storyboardId}/shots/${shotId}/result`, productId, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

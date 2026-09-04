import { ApiError, apiUrl, toSafeMessage } from '../apiClient';
import { evidenceHeaders } from '../evidenceApi';

// Client for image compliance inspection (/api/media/assets/*).
//
// Every field here is something the backend measured from decoded pixels. There
// is deliberately no client-side "looks white" shortcut: a verdict the browser
// guessed would be indistinguishable in the UI from one the inspector proved.

export type ResultState = 'pass' | 'fail' | 'warning' | 'manual_review' | 'unavailable';

export const RESULT_STATE_META: Record<
  ResultState,
  { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' }
> = {
  pass: { label: '通过', tone: 'ok' },
  fail: { label: '不通过', tone: 'danger' },
  warning: { label: '提醒', tone: 'warn' },
  // Neither of these is a pass, and neither is styled like one.
  manual_review: { label: '需人工核验', tone: 'neutral' },
  unavailable: { label: '无法判定', tone: 'neutral' },
};

export type ImageMeasurements = {
  sha256: string;
  format: string;
  mime_type: string;
  width: number;
  height: number;
  aspect_ratio: string;
  aspect_value: number;
  size_bytes: number;
  color_mode: string;
  has_alpha: boolean;
  inspected_at: string;
  method: string;
  asset_id: string;
  platform: string;
};

export type BackgroundSample = {
  method: string;
  sampled_regions: { band: string; samples: number; fraction_of_edge: number }[];
  sample_count: number;
  background_rgb: number[];
  background_hex: string;
  uniformity: number;
  tolerance: number;
  confidence: number;
};

export type InspectionResult = {
  rule_id: string;
  kind: string;
  severity: string;
  policy_snapshot_id: string;
  asset_id: string;
  state: ResultState;
  measured: unknown;
  expected: unknown;
  detail: string;
  method: string;
  evidence: Record<string, unknown>;
  description: string;
};

export type InspectionSummary = {
  counts: Record<ResultState, number>;
  blocked: boolean;
  fully_verified: boolean;
  needs_manual_review: boolean;
  unavailable: boolean;
};

export type ImageAsset = {
  asset_id: string;
  sha256: string;
  origin: 'generated' | 'uploaded';
  platform: string;
  revision_id: string;
  node_id: string;
  label: string;
  filename: string;
  measurements: ImageMeasurements;
  background: BackgroundSample | null;
  results: InspectionResult[];
  summary: InspectionSummary;
  policy_snapshot_id: string;
  unavailable_reason: string;
  stored_at: string;
};

/** A rejected image, carrying the backend's safe explanation of why. */
export class ImageRejected extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ImageRejected';
    this.code = code;
    this.status = status;
  }
}

export function isImageRejected(err: unknown): err is ImageRejected {
  return err instanceof ImageRejected;
}

export function imageErrorMessage(err: unknown): string {
  if (isImageRejected(err)) return err.message;
  return toSafeMessage(err);
}

type Envelope<T> = { code?: number; error?: string; message?: string; data?: T };

async function request<T>(path: string, productId: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), { ...init, headers: { ...evidenceHeaders(productId) } });
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
      throw new ImageRejected(json.error, json.message, res.status);
    }
    throw new ApiError('http', res.status);
  }
  if (!json || json.code !== 0 || json.data === undefined) {
    throw new ApiError('bad-response', res.status);
  }
  return json.data;
}

export async function listAssets(
  platform: string,
  productId = 'default-product',
  signal?: AbortSignal,
): Promise<ImageAsset[]> {
  const data = await request<{ assets: ImageAsset[] }>(
    `/api/media/assets?platform=${encodeURIComponent(platform)}`,
    productId,
    { signal },
  );
  return data.assets ?? [];
}

export async function registerDataUrl(
  input: { dataUrl: string; platform: string; origin?: 'generated' | 'uploaded'; label?: string; revisionId?: string },
  productId = 'default-product',
): Promise<ImageAsset> {
  const data = await request<{ asset: ImageAsset }>('/api/media/assets', productId, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data_url: input.dataUrl,
      platform: input.platform,
      origin: input.origin ?? 'generated',
      label: input.label ?? '',
      revision_id: input.revisionId ?? '',
    }),
  });
  return data.asset;
}

export async function uploadImage(
  file: File,
  platform: string,
  productId = 'default-product',
  revisionId = '',
): Promise<ImageAsset> {
  const form = new FormData();
  form.append('file', file);
  form.append('platform', platform);
  form.append('revision_id', revisionId);
  const data = await request<{ asset: ImageAsset }>('/api/media/assets/upload', productId, {
    method: 'POST',
    body: form,
  });
  return data.asset;
}

export function verifyAsset(
  assetId: string,
  productId = 'default-product',
): Promise<{ asset_id: string; present: boolean; matches: boolean; sha256: string }> {
  return request(`/api/media/assets/${assetId}/verify`, productId, { method: 'POST' });
}

/**
 * URL of the exact inspected bytes, for the existing lightbox.
 *
 * The scope travels as query parameters here, not as headers: this URL goes
 * into an `<img src>`, which cannot carry custom headers. The backend accepts
 * either form. These ids are isolation keys, not credentials.
 */
export function originalUrl(assetId: string, productId = 'default-product'): string {
  const headers = evidenceHeaders(productId);
  const query = new URLSearchParams({
    workspace: headers['X-Workspace-ID'],
    product: headers['X-Product-ID'],
  });
  return apiUrl(`/api/media/assets/${assetId}/original?${query}`);
}

/**
 * Read a same-origin image into a data URL so it can be inspected.
 *
 * Only same-origin and data: sources are followed. The browser does the fetch,
 * never the server, so this cannot be turned into a request forwarder.
 */
export async function toDataUrl(src: string): Promise<string> {
  if (src.startsWith('data:')) return src;
  const url = new URL(src, window.location.href);
  if (url.origin !== window.location.origin) {
    throw new ImageRejected('cross_origin', '只能检查同源图片，请先下载后再上传。', 0);
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new ImageRejected('unreadable', '无法读取该图片内容。', res.status);
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new ImageRejected('unreadable', '无法读取该图片内容。', 0));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

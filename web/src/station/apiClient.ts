// Single shared client for every station API call (listing, agent, image, video).
//
// Base-URL resolution — identical for all callers:
//   - default: same-origin relative `/api/...`
//   - optional override: import.meta.env.VITE_LISTING_API
//   - production builds never hardcode localhost
//
// Every failure is turned into an `ApiError` with a stable `category` and a
// safe Chinese `message`. Raw browser errors ("Failed to fetch") and raw
// provider/server bodies are never surfaced to the UI.

export type ApiErrorCategory =
  | 'network' // could not reach the backend at all
  | 'timeout' // our own client-side timeout fired
  | 'aborted' // caller cancelled via its own AbortSignal
  | 'http' // backend reached, non-2xx that is not a known provider category
  | 'provider-unconfigured' // backend: model provider not configured (503)
  | 'provider-timeout' // backend: provider timed out (504)
  | 'provider-failure' // backend/provider failure (502)
  | 'bad-response'; // 2xx but body unparseable / not the expected shape

export const API_ERROR_MESSAGE: Record<ApiErrorCategory, string> = {
  network: '无法连接后端服务，请检查网络后重试。',
  timeout: '请求超时，请重试。',
  aborted: '已取消。',
  http: '服务返回异常，请稍后重试。',
  'provider-unconfigured': '当前未配置模型服务。',
  'provider-timeout': '模型服务响应超时，请稍后重试。',
  'provider-failure': '模型服务暂时不可用，请稍后重试。',
  'bad-response': '服务返回了无法识别的响应，请稍后重试。',
};

export class ApiError extends Error {
  readonly category: ApiErrorCategory;
  readonly status?: number;

  constructor(category: ApiErrorCategory, status?: number) {
    super(API_ERROR_MESSAGE[category]);
    this.name = 'ApiError';
    this.category = category;
    this.status = status;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/** Safe Chinese message for anything a caller might catch. */
export function toSafeMessage(err: unknown): string {
  if (isApiError(err)) return err.message;
  return '发生未知错误，请稍后重试。';
}

/** Configured API base, no trailing slash. Empty string means same-origin. */
export function apiBase(): string {
  const override =
    typeof import.meta !== 'undefined' ? import.meta.env?.VITE_LISTING_API?.trim() : '';
  if (override) return override.replace(/\/+$/, '');
  return '';
}

/** Resolve a `/api/...` path against the configured base. */
export function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return apiBase() + p;
}

export type PostJsonOptions = {
  /** Client-side timeout in ms. Default 60_000. */
  timeoutMs?: number;
  /** Caller cancellation. */
  signal?: AbortSignal;
  /** Additional non-secret request headers (for example an isolation scope). */
  headers?: Record<string, string>;
};

type Envelope<T> = { code?: number; error?: string; message?: string; data?: T };

function categoryForStatus(status: number, slug?: string): ApiErrorCategory {
  if (status === 503 || slug === 'provider_unconfigured') return 'provider-unconfigured';
  if (status === 504 || slug === 'provider_timeout') return 'provider-timeout';
  if (status === 502 || slug === 'provider_failure') return 'provider-failure';
  return 'http';
}

/**
 * POST JSON and return the `data` field of the `{code,data}` envelope.
 * Throws `ApiError` for every failure mode.
 */
export async function postJson<T>(
  path: string,
  payload: unknown,
  opts: PostJsonOptions = {},
): Promise<T> {
  const { timeoutMs = 60_000, signal, headers = {} } = opts;
  const controller = new AbortController();
  let timedOut = false;

  const onCallerAbort = () => controller.abort();
  signal?.addEventListener('abort', onCallerAbort);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    if (signal?.aborted) throw new ApiError('aborted');
    if (timedOut) throw new ApiError('timeout');
    // fetch rejects with a TypeError ("Failed to fetch") on any network failure.
    throw new ApiError('network');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }

  let json: Envelope<T> | null = null;
  try {
    json = (await res.json()) as Envelope<T>;
  } catch {
    json = null;
  }

  if (!res.ok) {
    throw new ApiError(categoryForStatus(res.status, json?.error), res.status);
  }
  if (!json || typeof json !== 'object' || json.code !== 0 || json.data === undefined) {
    throw new ApiError('bad-response', res.status);
  }
  return json.data;
}

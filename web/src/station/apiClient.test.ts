import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiUrl, postJson, toSafeMessage } from './apiClient';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('base URL resolution', () => {
  it('defaults to same-origin relative /api paths', () => {
    expect(apiUrl('/api/listing/generate')).toBe('/api/listing/generate');
  });

  it('uses VITE_LISTING_API when set, trimming trailing slashes', () => {
    vi.stubEnv('VITE_LISTING_API', 'https://api.example.com/');
    expect(apiUrl('/api/agent/chat')).toBe('https://api.example.com/api/agent/chat');
  });
});

function mockFetchResolve(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }),
  );
}

describe('postJson error categories', () => {
  it('network failure -> category "network", safe message, no raw text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const err = await postJson('/api/x', {}).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).category).toBe('network');
    expect((err as ApiError).message).toBe('无法连接后端服务，请检查网络后重试。');
    expect((err as ApiError).message).not.toContain('Failed to fetch');
  });

  it('client-side timeout -> category "timeout"', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      ),
    );
    const p = postJson('/api/x', {}, { timeoutMs: 1000 });
    const assertion = expect(p).rejects.toMatchObject({ category: 'timeout' });
    await vi.advanceTimersByTimeAsync(1200);
    await assertion;
  });

  it('caller abort -> category "aborted"', async () => {
    const ac = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      ),
    );
    const p = postJson('/api/x', {}, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ category: 'aborted' });
  });

  it('HTTP 503 -> "provider-unconfigured"', async () => {
    mockFetchResolve(503, { code: 1, error: 'provider_unconfigured', message: '当前未配置图片模型。' });
    await expect(postJson('/api/x', {})).rejects.toMatchObject({
      category: 'provider-unconfigured',
      status: 503,
    });
  });

  it('HTTP 504 -> "provider-timeout"', async () => {
    mockFetchResolve(504, { code: 1, error: 'provider_timeout' });
    await expect(postJson('/api/x', {})).rejects.toMatchObject({ category: 'provider-timeout' });
  });

  it('HTTP 502 -> "provider-failure", provider body never surfaced', async () => {
    mockFetchResolve(502, { code: 1, error: 'provider_failure', message: 'raw provider blob SECRET' });
    const err = (await postJson('/api/x', {}).catch(e => e)) as ApiError;
    expect(err.category).toBe('provider-failure');
    expect(err.message).toBe('模型服务暂时不可用，请稍后重试。');
    expect(err.message).not.toContain('SECRET');
  });

  it('2xx but wrong envelope -> "bad-response"', async () => {
    mockFetchResolve(200, { nope: true });
    await expect(postJson('/api/x', {})).rejects.toMatchObject({ category: 'bad-response' });
  });

  it('2xx envelope with code 0 returns data', async () => {
    mockFetchResolve(200, { code: 0, data: { reply: 'hi' } });
    await expect(postJson('/api/x', {})).resolves.toEqual({ reply: 'hi' });
  });
});

describe('toSafeMessage', () => {
  it('passes through an ApiError message', () => {
    expect(toSafeMessage(new ApiError('timeout'))).toBe('请求超时，请重试。');
  });
  it('never leaks an arbitrary Error', () => {
    expect(toSafeMessage(new Error('Failed to fetch at http://localhost:8788'))).toBe(
      '发生未知错误，请稍后重试。',
    );
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { isApiError } from '../apiClient';
import {
  approveRevision,
  createRevision,
  fetchDiff,
  isReviewRejected,
  reviewErrorMessage,
  saveDraft,
  type Revision,
} from './reviewApi';

function ok(data: unknown) {
  return { ok: true, status: 200, json: async () => ({ code: 0, data }) };
}

function rejected(status: number, error: string, message: string) {
  return { ok: false, status, json: async () => ({ code: 1, error, message }) };
}

const revision = { revision_id: 'rev-0001', state: 'draft' } as unknown as Revision;

afterEach(() => vi.unstubAllGlobals());

describe('createRevision', () => {
  it('posts the revision payload and unwraps the envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ revision }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createRevision({
      sku_id: 'AERO-350',
      platform: 'amazon',
      content: { title: 't', fields: [] },
    });

    expect(result.revision_id).toBe('rev-0001');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/api/review/revisions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).sku_id).toBe('AERO-350');
  });

  it('sends the workspace isolation headers, and no credential', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ revision }));
    vi.stubGlobal('fetch', fetchMock);

    await createRevision(
      { sku_id: 'S', platform: 'amazon', content: { title: 't', fields: [] } },
      'product-a',
    );

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['X-Workspace-ID']).toBeTruthy();
    expect(headers['X-Product-ID']).toBe('product-a');
    expect(Object.keys(headers).join(' ').toLowerCase()).not.toContain('authorization');
  });
});

describe('rejection handling', () => {
  it('surfaces the backend explanation for a blocked approval', async () => {
    // A generic "服务返回异常" would hide the one thing the operator needs:
    // which gate refused, and why.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        rejected(409, 'blocked_by_validation', '仍有 3 项阻断校验未通过，无法批准。'),
      ),
    );

    const err = await approveRevision('rev-0001', 'lottie', 'ship').catch(e => e);

    expect(isReviewRejected(err)).toBe(true);
    expect(err.code).toBe('blocked_by_validation');
    expect(err.status).toBe(409);
    expect(reviewErrorMessage(err)).toContain('阻断校验');
  });

  it('falls back to a generic ApiError when the body carries no explanation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    );

    const err = await approveRevision('rev-0001', 'lottie', '').catch(e => e);

    expect(isReviewRejected(err)).toBe(false);
    expect(isApiError(err)).toBe(true);
    expect(reviewErrorMessage(err)).toBe('服务返回异常，请稍后重试。');
  });

  it('reports an unreachable backend as a network failure, not a rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const err = await createRevision({
      sku_id: 'S',
      platform: 'amazon',
      content: { title: 't', fields: [] },
    }).catch(e => e);

    expect(isApiError(err)).toBe(true);
    expect(err.category).toBe('network');
    // never the raw browser string
    expect(reviewErrorMessage(err)).not.toContain('Failed to fetch');
  });

  it('rejects a 200 whose envelope is not the expected shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 0 }) }),
    );

    const err = await createRevision({
      sku_id: 'S',
      platform: 'amazon',
      content: { title: 't', fields: [] },
    }).catch(e => e);

    expect(isApiError(err)).toBe(true);
    expect(err.category).toBe('bad-response');
  });
});

describe('saveDraft', () => {
  it('reports whether the save forked a new revision', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(ok({ revision: { ...revision, revision_id: 'rev-0002' }, forked: true })),
    );

    const result = await saveDraft('rev-0001', { title: 't2', fields: [] }, 'lottie');

    expect(result.forked).toBe(true);
    expect(result.revision.revision_id).toBe('rev-0002');
  });
});

describe('fetchDiff', () => {
  it('passes both revision ids as query parameters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ rows: [], counts: {}, identical: true }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchDiff('rev-0001', 'rev-0003');

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      '/api/review/diff?base=rev-0001&target=rev-0003',
    );
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './apiClient';
import {
  LISTING_SOURCE_META,
  fetchListingDrafts,
  localSampleDrafts,
} from './listingApi';

const INPUT = {
  productName: 'Cup',
  points: 'folds',
  platforms: ['amazon', 'tiktok', 'shopify'] as const,
  assetMode: 'compliant' as const,
  uploads: [],
};

function mockGenerate(source: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        code: 0,
        data: {
          source,
          drafts: [
            { id: 'amazon', title: 'A', fields: [], checks: [] },
            { id: 'tiktok', title: 'T', fields: [], checks: [] },
            { id: 'shopify', title: 'S', fields: [], checks: [] },
          ],
        },
      }),
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('backend source mapping', () => {
  it('source "llm" -> "token-plan" (green / model)', async () => {
    mockGenerate('llm');
    const res = await fetchListingDrafts({ ...INPUT, platforms: [...INPUT.platforms] });
    expect(res.source).toBe('token-plan');
    expect(LISTING_SOURCE_META['token-plan'].tone).toBe('ok');
  });

  it('source "upstream" -> "token-plan"', async () => {
    mockGenerate('upstream');
    const res = await fetchListingDrafts({ ...INPUT, platforms: [...INPUT.platforms] });
    expect(res.source).toBe('token-plan');
  });

  it('source "fallback" -> "api-fallback" (amber / rule fallback, not a model result)', async () => {
    mockGenerate('fallback');
    const res = await fetchListingDrafts({ ...INPUT, platforms: [...INPUT.platforms] });
    expect(res.source).toBe('api-fallback');
    expect(LISTING_SOURCE_META['api-fallback'].tone).toBe('warn');
  });
});

describe('unreachable backend is never a success', () => {
  it('rejects with ApiError instead of silently returning sample data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const err = await fetchListingDrafts({ ...INPUT, platforms: [...INPUT.platforms] }).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).category).toBe('network');
  });

  it('localSampleDrafts is explicit and tagged local-sample (danger tone)', () => {
    const res = localSampleDrafts({ ...INPUT, platforms: [...INPUT.platforms] });
    expect(res.source).toBe('local-sample');
    expect(res.drafts.length).toBe(3);
    expect(LISTING_SOURCE_META['local-sample'].tone).toBe('danger');
    expect(LISTING_SOURCE_META['local-sample'].detail).toContain('并非根据你的 SKU');
  });
});

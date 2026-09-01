import { afterEach, describe, expect, it, vi } from 'vitest';
import { postJson } from './apiClient';
import { fetchListingDrafts } from './listingApi';
import { fetchMediaImage, fetchMediaVideo } from './mediaApi';
import { fetchRules } from './rulesApi';

// When VITE_LISTING_API points at a different origin, every client call — listing,
// agent, media(image/video), rules — must resolve against that origin.
// (See docs/DEPLOY.md: the backend CORS config must then allow that origin.)

const ORIGIN = 'https://api.example.com';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function captureFetch(responseBody: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => responseBody,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('VITE_LISTING_API second-origin URL resolution', () => {
  it('listing / agent / media / rules all target the configured origin', async () => {
    vi.stubEnv('VITE_LISTING_API', `${ORIGIN}/`);

    const listing = captureFetch({
      code: 0,
      data: { source: 'llm', drafts: [{ id: 'amazon', title: 'A', fields: [], checks: [] }] },
    });
    await fetchListingDrafts({
      productName: 'C',
      points: 'p',
      platforms: ['amazon'],
      assetMode: 'compliant',
      uploads: [],
    });
    expect(listing.mock.calls[0][0]).toBe(`${ORIGIN}/api/listing/generate`);

    const agent = captureFetch({ code: 0, data: { reply: 'ok' } });
    await postJson('/api/agent/chat', { messages: [] });
    expect(agent.mock.calls[0][0]).toBe(`${ORIGIN}/api/agent/chat`);

    const img = captureFetch({ code: 0, data: { url: 'data:image/png;base64,AA' } });
    await fetchMediaImage({ prompt: 'x', aspectRatio: '1:1', resolution: '2K' });
    expect(img.mock.calls[0][0]).toBe(`${ORIGIN}/api/media/image`);

    const vid = captureFetch({ code: 0, data: { url: 'https://cdn/x.mp4' } });
    await fetchMediaVideo({ prompt: 'x', aspectRatio: '9:16', duration: '5s', resolution: '720p' });
    expect(vid.mock.calls[0][0]).toBe(`${ORIGIN}/api/media/video`);

    const rules = captureFetch({
      code: 0,
      data: { excerpt_date: '2026-08-25', platforms: { amazon: { name: 'Amazon', rule: 'r' } } },
    });
    await fetchRules();
    expect(rules.mock.calls[0][0]).toBe(`${ORIGIN}/api/rules`);
  });

  it('falls back to same-origin relative paths when the var is unset', async () => {
    const f = captureFetch({ code: 0, data: { reply: 'ok' } });
    await postJson('/api/agent/chat', { messages: [] });
    expect(f.mock.calls[0][0]).toBe('/api/agent/chat');
  });
});

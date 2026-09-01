import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMediaVideo } from './mediaApi';

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ code: 0, data: { url: 'data:video/mp4;base64,QQ==' } }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof mockFetch>) {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}

describe('POST /api/media/video body', () => {
  const base = { prompt: 'a cup unfolding', aspectRatio: '9:16', duration: '5s', resolution: '720p' };

  it('sends first_frame_url when a first frame is supplied', async () => {
    const fetchMock = mockFetch();
    await fetchMediaVideo({ ...base, firstFrameUrl: 'https://cdn.test/cup.png' });
    expect(sentBody(fetchMock)).toEqual({
      prompt: 'a cup unfolding',
      aspect_ratio: '9:16',
      duration: '5s',
      resolution: '720p',
      first_frame_url: 'https://cdn.test/cup.png',
    });
  });

  it('omits first_frame_url entirely for a text-to-video request', async () => {
    const fetchMock = mockFetch();
    await fetchMediaVideo(base);
    expect('first_frame_url' in sentBody(fetchMock)).toBe(false);
  });

  it('treats a blank first frame as absent', async () => {
    const fetchMock = mockFetch();
    await fetchMediaVideo({ ...base, firstFrameUrl: '   ' });
    expect('first_frame_url' in sentBody(fetchMock)).toBe(false);
  });
});

import { postJson, type PostJsonOptions } from './apiClient';

// Media (image / video) generation calls. Same base-URL resolution and error
// handling as the listing and agent calls — see apiClient.ts. Callers get an
// `ApiError` (safe Chinese message, stable category) on any failure.

export type MediaImageInput = {
  prompt: string;
  aspectRatio: string;
  resolution: string;
};

export type MediaVideoInput = {
  prompt: string;
  aspectRatio: string;
  duration: string;
  resolution: string;
  /**
   * Optional first frame for an image-to-video request. Must be an HTTP(S) URL
   * or an image data URL — the only forms the provider accepts. When present
   * the backend switches to the image-to-video model and follows the source
   * ratio instead of the requested one.
   */
  firstFrameUrl?: string | null;
};

export async function fetchMediaImage(
  input: MediaImageInput,
  opts: PostJsonOptions = {},
): Promise<{ url: string }> {
  return postJson<{ url: string }>(
    '/api/media/image',
    {
      prompt: input.prompt,
      aspect_ratio: input.aspectRatio,
      resolution: input.resolution,
    },
    { timeoutMs: 120_000, ...opts },
  );
}

export async function fetchMediaVideo(
  input: MediaVideoInput,
  opts: PostJsonOptions = {},
): Promise<{ url: string; poster?: string }> {
  const firstFrameUrl = (input.firstFrameUrl || '').trim();
  return postJson<{ url: string; poster?: string }>(
    '/api/media/video',
    {
      prompt: input.prompt,
      aspect_ratio: input.aspectRatio,
      duration: input.duration,
      resolution: input.resolution,
      ...(firstFrameUrl ? { first_frame_url: firstFrameUrl } : {}),
    },
    { timeoutMs: 180_000, ...opts },
  );
}

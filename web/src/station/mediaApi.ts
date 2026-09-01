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
  return postJson<{ url: string; poster?: string }>(
    '/api/media/video',
    {
      prompt: input.prompt,
      aspect_ratio: input.aspectRatio,
      duration: input.duration,
      resolution: input.resolution,
    },
    { timeoutMs: 180_000, ...opts },
  );
}

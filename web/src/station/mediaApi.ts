const TIMEOUT_MS = 180000

export type MediaImageInput = {
  prompt: string
  aspectRatio: string
  resolution: string
}

export type MediaVideoInput = {
  prompt: string
  aspectRatio: string
  duration: string
  resolution: string
}

function mediaUrl(path: string): string {
  const remote = import.meta.env.VITE_LISTING_API?.trim()
  if (remote) return remote.replace(/\/$/, '') + path
  return path
}

async function postJson<T>(path: string, payload: unknown): Promise<T> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(mediaUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const json = (await res.json().catch(() => null)) as {
      code?: number
      message?: string
      data?: T
    } | null
    if (!res.ok || !json || json.code !== 0 || !json.data) {
      throw new Error(json?.message || `media-api ${res.status}`)
    }
    return json.data
  } finally {
    window.clearTimeout(timer)
  }
}

export async function fetchMediaImage(input: MediaImageInput): Promise<{ url: string }> {
  return postJson<{ url: string }>('/api/media/image', {
    prompt: input.prompt,
    aspect_ratio: input.aspectRatio,
    resolution: input.resolution,
  })
}

export async function fetchMediaVideo(input: MediaVideoInput): Promise<{ url: string; poster?: string }> {
  return postJson<{ url: string; poster?: string }>('/api/media/video', {
    prompt: input.prompt,
    aspect_ratio: input.aspectRatio,
    duration: input.duration,
    resolution: input.resolution,
  })
}

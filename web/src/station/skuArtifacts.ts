import type { PlatformDraft } from './data';

// Downstream artifact package produced by a successful SKU generation.
//
// It is what a connected media node actually consumes: a textual video brief
// assembled from the generated platform drafts, plus the product images that
// really exist for this SKU. Both are persisted on the SKU node so a downstream
// node can read them at execution time instead of re-deriving UI text.

export type SkuArtifacts = {
  /** Human-readable brief handed to the video provider as prompt context. */
  brief: string;
  /** Deduplicated image assets, uploads first, then draft image URLs. */
  images: string[];
};

export type SkuArtifactInput = {
  productName: string;
  points: string;
  uploads: string[];
  drafts: PlatformDraft[];
};

/** Fields worth putting in a video brief; the rest is listing bookkeeping. */
const SKIPPED_FIELD_LABELS = ['标题长度', '详情规划'];

const MAX_FIELD_CHARS = 240;

function clip(value: string, max = MAX_FIELD_CHARS): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function pointLines(points: string): string[] {
  return points
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

/**
 * Build the textual brief. It is assembled only from values that were really
 * generated / entered — no invented shot list, no placeholder copy.
 */
export function buildVideoBrief(input: SkuArtifactInput): string {
  const blocks: string[] = [];
  const name = input.productName.trim();
  if (name) blocks.push(`产品：${name}`);

  const points = pointLines(input.points);
  if (points.length) blocks.push(['卖点：', ...points.map(p => `- ${clip(p, 120)}`)].join('\n'));

  for (const draft of input.drafts) {
    const lines: string[] = [];
    const title = clip(draft.title ?? '');
    if (title) lines.push(`标题：${title}`);
    for (const field of draft.fields ?? []) {
      const label = (field.label ?? '').trim();
      if (!label || SKIPPED_FIELD_LABELS.includes(label)) continue;
      const value = clip(field.value ?? '');
      if (!value) continue;
      lines.push(`${label}：${value}`);
    }
    if (lines.length) blocks.push([`【${draft.name || draft.id} 草稿】`, ...lines].join('\n'));
  }

  return blocks.join('\n\n');
}

/** `true` for values a browser (and the provider) can actually fetch as an image. */
export function isUsableImageAsset(value: string): boolean {
  const v = (value || '').trim();
  if (!v) return false;
  return /^data:image\//i.test(v) || /^https?:\/\//i.test(v) || v.startsWith('/');
}

/**
 * Absolute URL for the provider. Site-relative assets are resolved against the
 * current origin; data URLs and absolute URLs are returned unchanged.
 */
export function absoluteImageUrl(value: string, origin?: string): string {
  const v = (value || '').trim();
  if (!v.startsWith('/')) return v;
  const base = origin ?? (typeof window === 'undefined' ? '' : window.location.origin);
  return base ? `${base}${v}` : v;
}

/** Uploaded product images first, then image URLs returned in platform drafts. */
export function collectImageAssets(input: SkuArtifactInput): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (value: string | undefined) => {
    const v = (value || '').trim();
    if (!v || seen.has(v) || !isUsableImageAsset(v)) return;
    seen.add(v);
    out.push(v);
  };
  for (const upload of input.uploads) push(upload);
  for (const draft of input.drafts) push(draft.imageUrl);
  return out;
}

export function buildSkuArtifacts(input: SkuArtifactInput): SkuArtifacts {
  return { brief: buildVideoBrief(input), images: collectImageAssets(input) };
}

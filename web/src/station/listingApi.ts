import { buildDrafts, type AssetMode, type PlatformDraft, type PlatformId } from './data';

export type ListingSource = 'upstream' | 'llm' | 'fallback';

export type ListingGenerateInput = {
  productName: string;
  points: string;
  platforms: PlatformId[];
  assetMode: AssetMode;
  uploads: string[];
};

const SOURCE_LABEL: Record<ListingSource, string> = {
  upstream: '草稿来自后端 chat',
  llm: '草稿来自本机 LLM',
  fallback: '草稿来自规则表',
};

export function announceListingSource(source: ListingSource) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('station-listing-source', { detail: { source, label: SOURCE_LABEL[source] } }));
}

export function listingSourceLabel(source: ListingSource): string {
  return SOURCE_LABEL[source];
}

async function postGenerate(url: string, payload: unknown, timeoutMs = 180000): Promise<Response | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

function listingApiEndpoints(): string[] {
  const remote = import.meta.env.VITE_LISTING_API?.trim();
  if (remote) return [remote.replace(/\/$/, '') + '/api/listing/generate'];
  return ['/api/listing/generate'];
}

const LANE: Record<PlatformId, Pick<PlatformDraft, 'name' | 'role' | 'imageLabel'>> = {
  amazon: { name: 'Amazon', role: '货架', imageLabel: '白底主图 1:1' },
  tiktok: { name: 'TikTok Shop', role: '货架 · 连着内容', imageLabel: '商品卡主图' },
  shopify: { name: 'Shopify', role: '品牌站', imageLabel: '品牌站生活图' },
};

function normalizeDraft(raw: Partial<PlatformDraft>): PlatformDraft | null {
  if (raw.id !== 'amazon' && raw.id !== 'tiktok' && raw.id !== 'shopify') return null;
  const lane = LANE[raw.id];
  return {
    id: raw.id,
    name: raw.name || lane.name,
    role: raw.role || lane.role,
    title: String(raw.title ?? ''),
    fields: (raw.fields ?? []).map(field => ({
      label: String(field.label ?? ''),
      value: String(field.value ?? ''),
    })),
    imageLabel: raw.imageLabel || lane.imageLabel,
    imageUrl: raw.imageUrl || '',
    checks: (raw.checks ?? []).flatMap(check => {
      if (check.state !== 'pass' && check.state !== 'fix' && check.state !== 'ad-only') return [];
      return [
        {
          id: String(check.id ?? ''),
          label: String(check.label ?? ''),
          state: check.state,
          detail: String(check.detail ?? ''),
        },
      ];
    }),
  };
}

export async function fetchListingDrafts(input: ListingGenerateInput): Promise<{ drafts: PlatformDraft[]; source: ListingSource }> {
  const platforms = input.platforms.length ? input.platforms : (['amazon', 'tiktok', 'shopify'] as PlatformId[]);
  try {
    const payload = {
      product_name: input.productName,
      points: input.points,
      platforms,
      asset_mode: input.assetMode,
      uploads: input.uploads,
    };
    let res: Response | null = null;
    for (const url of listingApiEndpoints()) {
      const next = await postGenerate(url, payload);
      if (next?.ok) {
        res = next;
        break;
      }
    }
    if (!res || !res.ok) throw new Error(`listing-api ${res?.status ?? 'unreachable'}`);
    const json = (await res.json()) as {
      code?: number;
      data?: { drafts?: Partial<PlatformDraft>[]; source?: ListingSource };
    };
    const drafts = (json.data?.drafts ?? []).map(normalizeDraft).filter((d): d is PlatformDraft => !!d);
    if (json.code !== 0 || drafts.length === 0) throw new Error('listing-api empty');
    return { drafts: drafts.filter(d => platforms.includes(d.id)), source: json.data?.source ?? 'fallback' };
  } catch (err) {
    console.warn('[station] listing-api unreachable, local drafts', err);
    return { drafts: buildDrafts(input.assetMode).filter(d => platforms.includes(d.id)), source: 'fallback' };
  }
}

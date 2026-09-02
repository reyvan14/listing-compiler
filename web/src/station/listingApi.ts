import { ApiError, postJson } from './apiClient';
import { buildDrafts, type AssetMode, type PlatformDraft, type PlatformId } from './data';
import { computeFactRefs, parseSkuFacts } from './migration/skuFacts';

// What actually produced the drafts on screen. Persisted and shown on every
// result screen — never a transient toast.
export type ListingResultSource = 'token-plan' | 'api-fallback' | 'local-sample';

// Raw `source` values the backend can report.
type BackendSource = 'upstream' | 'llm' | 'fallback';

export type ListingGenerateInput = {
  productName: string;
  points: string;
  platforms: PlatformId[];
  assetMode: AssetMode;
  uploads: string[];
};

export const LISTING_SOURCE_META: Record<
  ListingResultSource,
  { label: string; tone: 'ok' | 'warn' | 'danger'; detail: string }
> = {
  'token-plan': {
    label: '模型生成 · Token Plan',
    tone: 'ok',
    detail: '内容由指定模型根据你的 SKU 生成。',
  },
  'api-fallback': {
    label: '后端规则兜底',
    tone: 'warn',
    detail: '后端可达，但未配置模型或模型不可用，返回的是规则模板草稿，不是模型生成结果。',
  },
  'local-sample': {
    label: '本地示例数据',
    tone: 'danger',
    detail: '后端服务不可用。当前展示的是内置示例数据，并非根据你的 SKU 生成。',
  },
};

function mapBackendSource(source: BackendSource | undefined): ListingResultSource {
  if (source === 'fallback') return 'api-fallback';
  // 'llm' and 'upstream' are both real model-gateway output.
  return 'token-plan';
}

const SOURCE_EVENT = 'station-listing-source';

export function announceListingSource(source: ListingResultSource) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(SOURCE_EVENT, {
      detail: { source, label: LISTING_SOURCE_META[source].label },
    }),
  );
}

export function onListingSource(cb: (source: ListingResultSource) => void): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ source?: ListingResultSource }>).detail;
    if (detail?.source) cb(detail.source);
  };
  window.addEventListener(SOURCE_EVENT, handler);
  return () => window.removeEventListener(SOURCE_EVENT, handler);
}

const LANE: Record<PlatformId, Pick<PlatformDraft, 'name' | 'role' | 'imageLabel'>> = {
  amazon: { name: 'Amazon', role: '货架', imageLabel: '白底主图 1:1' },
  tiktok: { name: 'TikTok Shop', role: '货架 · 连着内容', imageLabel: '商品卡主图' },
  shopify: { name: 'Shopify', role: '品牌站', imageLabel: '品牌站生活图' },
};

function normalizeDraft(raw: Record<string, any>): PlatformDraft | null {
  if (raw.id !== 'amazon' && raw.id !== 'tiktok' && raw.id !== 'shopify') return null;
  const lane = LANE[raw.id as PlatformId];
  return {
    id: raw.id,
    name: raw.name || lane.name,
    role: raw.role || lane.role,
    title: String(raw.title ?? ''),
    titleFactRefs: Array.isArray(raw.titleFactRefs)
      ? raw.titleFactRefs.map(String)
      : Array.isArray(raw.title_fact_refs)
        ? raw.title_fact_refs.map(String)
        : [],
    policyVersion: String(raw.policyVersion ?? raw.policy_version ?? ''),
    skuRevision: String(raw.skuRevision ?? raw.sku_revision ?? ''),
    factIds: Array.isArray(raw.factIds)
      ? raw.factIds.map(String)
      : Array.isArray(raw.fact_ids)
        ? raw.fact_ids.map(String)
        : [],
    fields: (raw.fields ?? []).map((field: any) => ({
      label: String(field.label ?? ''),
      value: String(field.value ?? ''),
      field: field.field ? String(field.field) : undefined,
      factRefs: Array.isArray(field.factRefs)
        ? field.factRefs.map(String)
        : Array.isArray(field.fact_refs)
          ? field.fact_refs.map(String)
          : undefined,
    })),
    imageLabel: raw.imageLabel || lane.imageLabel,
    imageUrl: raw.imageUrl || '',
    checks: (raw.checks ?? []).flatMap((check: any) => {
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

export type ListingDraftsResult = {
  drafts: PlatformDraft[];
  source: ListingResultSource;
};

type ListingResponse = {
  drafts?: Record<string, unknown>[];
  source?: BackendSource;
};

/**
 * Call the backend. Resolves with real drafts + a source of `token-plan` or
 * `api-fallback`. Rejects with an `ApiError` when the backend is unreachable,
 * times out, or returns an unusable body. It never silently substitutes local
 * sample data — the caller decides what to do with a failure.
 */
export async function fetchListingDrafts(
  input: ListingGenerateInput,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ListingDraftsResult> {
  const platforms = input.platforms.length
    ? input.platforms
    : (['amazon', 'tiktok', 'shopify'] as PlatformId[]);

  const data = await postJson<ListingResponse>(
    '/api/listing/generate',
    {
      product_name: input.productName,
      points: input.points,
      platforms,
      asset_mode: input.assetMode,
      uploads: input.uploads,
    },
    { timeoutMs: opts.timeoutMs ?? 60_000, signal: opts.signal },
  );

  const drafts = (data.drafts ?? [])
    .map(normalizeDraft)
    .filter((d): d is PlatformDraft => !!d)
    .filter(d => platforms.includes(d.id));

  if (drafts.length === 0) throw new ApiError('bad-response');

  return { drafts, source: mapBackendSource(data.source) };
}

/** Explicit local sample data — only used behind a visible user action.
 * Dependency metadata (factRefs) is computed client-side so the self-healing
 * migration workflow still works when the backend is unreachable. */
export function localSampleDrafts(input: ListingGenerateInput): ListingDraftsResult {
  const platforms = input.platforms.length
    ? input.platforms
    : (['amazon', 'tiktok', 'shopify'] as PlatformId[]);
  const facts = parseSkuFacts(input.productName, input.points);
  const drafts = buildDrafts(input.assetMode)
    .filter(d => platforms.includes(d.id))
    .map(d => ({
      ...d,
      titleFactRefs: computeFactRefs(d.title, facts),
      policyVersion: '',
      factIds: Object.keys(facts),
      fields: d.fields.map(f => ({
        ...f,
        factRefs: computeFactRefs(`${f.label} ${f.value}`, facts),
      })),
    }));
  return { drafts, source: 'local-sample' };
}

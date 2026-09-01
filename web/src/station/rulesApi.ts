import { ApiError, apiUrl, toSafeMessage } from './apiClient';

// Rules are fetched from the backend `/api/rules` (single source of truth,
// backed by api/rules.yaml). The frontend keeps only a tiny built-in copy as a
// last-resort fallback, and when the fallback is shown it is clearly labelled
// as not-current.

export type RuleRow = {
  platformId: string;
  ruleId: string;
  platform: string;
  role: string;
  image: string;
  rule: string;
  source: string;
  sourceUrl: string;
  /** optional secondary official reference (e.g. the canonical policy page) */
  reference?: string;
  referenceUrl?: string;
  excerptDate: string;
};

export type RulesResult = {
  rows: RuleRow[];
  excerptDate: string;
  stale: boolean; // true => came from the built-in fallback, not the backend
};

type RulesEnvelope = {
  code?: number;
  data?: {
    excerpt_date?: string;
    platforms?: Record<
      string,
      {
        platform_id?: string;
        rule_id?: string;
        name?: string;
        role?: string;
        image?: string;
        rule?: string;
        source?: string;
        source_url?: string;
        reference?: string;
        reference_url?: string;
        excerpt_date?: string;
      }
    >;
  };
};

const ORDER = ['amazon', 'tiktok', 'shopify'];

// Minimal built-in fallback — only used when /api/rules is unreachable, and the
// UI marks it as "规则加载失败".
const FALLBACK: RulesResult = {
  excerptDate: '2026-08-25',
  stale: true,
  rows: [
    {
      platformId: 'amazon',
      ruleId: 'amazon.main-image',
      platform: 'Amazon',
      role: '货架',
      image: '纯白 RGB 255,255,255 · 主体约 85% · 主图禁加字',
      rule: '商品主图需纯白背景（RGB 255,255,255），主体占据画面 85% 或以上，不得叠加文字、logo、边框或水印。',
      source: 'Amazon 官方产品拍摄要求 (sell.amazon.com)',
      sourceUrl: 'https://sell.amazon.com/blog/product-photos',
      reference: 'Amazon Seller Central 产品图片要求 (G1881)',
      referenceUrl: 'https://sellercentral.amazon.com/help/hub/reference/external/G1881',
      excerptDate: '2026-08-25',
    },
    {
      platformId: 'tiktok',
      ruleId: 'tiktok.listing-basics',
      platform: 'TikTok Shop',
      role: '货架（连着内容）',
      image: '商品卡主图偏白底、无加字；≠ 信息流广告封面',
      rule: '标题 25–200 字符；商品卡主图偏白底、无加字。',
      source: 'TikTok Shop 美国卖家大学 Listing',
      sourceUrl:
        'https://seller-us.tiktok.com/university/essay?knowledge_id=7073362639816491&lang=en',
      excerptDate: '2026-08-25',
    },
    {
      platformId: 'shopify',
      ruleId: 'shopify.product-media',
      platform: 'Shopify',
      role: '品牌站',
      image: '无强制白底，生活图可用',
      rule: '无强制白底，生活图可用；品牌标题 + 长描述。',
      source: 'Shopify 商品媒体帮助',
      sourceUrl:
        'https://help.shopify.com/en/manual/products/product-media/product-media-types',
      excerptDate: '2026-08-25',
    },
  ],
};

export function fallbackRules(): RulesResult {
  return { ...FALLBACK, rows: FALLBACK.rows.map(r => ({ ...r })) };
}

export async function fetchRules(signal?: AbortSignal): Promise<RulesResult> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => controller.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(apiUrl('/api/rules'), { signal: controller.signal });
  } catch {
    throw new ApiError('network');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  if (!res.ok) throw new ApiError('http', res.status);

  let json: RulesEnvelope | null = null;
  try {
    json = (await res.json()) as RulesEnvelope;
  } catch {
    throw new ApiError('bad-response', res.status);
  }
  const platforms = json?.data?.platforms;
  if (json?.code !== 0 || !platforms) throw new ApiError('bad-response', res.status);

  const excerptDate = json.data?.excerpt_date ?? '';
  const keys = Object.keys(platforms).sort(
    (a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99),
  );
  const rows: RuleRow[] = keys.map(key => {
    const p = platforms[key] ?? {};
    return {
      platformId: p.platform_id ?? key,
      ruleId: p.rule_id ?? key,
      platform: p.name ?? key,
      role: p.role ?? '',
      image: p.image ?? '',
      rule: p.rule ?? p.image ?? '',
      source: p.source ?? '',
      sourceUrl: p.source_url ?? '',
      reference: p.reference || undefined,
      referenceUrl: p.reference_url || undefined,
      excerptDate: p.excerpt_date ?? excerptDate,
    };
  });
  if (rows.length === 0) throw new ApiError('bad-response', res.status);
  return { rows, excerptDate, stale: false };
}

export { toSafeMessage };

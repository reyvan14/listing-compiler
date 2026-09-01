import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './apiClient';
import { fallbackRules, fetchRules } from './rulesApi';

afterEach(() => vi.unstubAllGlobals());

const BACKEND = {
  code: 0,
  data: {
    excerpt_date: '2026-08-25',
    platforms: {
      amazon: {
        platform_id: 'amazon',
        rule_id: 'amazon.main-image',
        name: 'Amazon',
        role: '货架',
        image: '纯白 · 禁加字',
        rule: '主图纯白背景、禁加字；标题 ≤ 200 字符。',
        source: 'Seller Central 主图规范',
        source_url: 'https://sellercentral.amazon.com/',
        excerpt_date: '2026-08-25',
      },
      shopify: { name: 'Shopify', rule: '无强制白底' },
    },
  },
};

describe('fetchRules', () => {
  it('parses /api/rules into rows with source title, url, id, date', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => BACKEND }),
    );
    const res = await fetchRules();
    expect(res.stale).toBe(false);
    expect(res.excerptDate).toBe('2026-08-25');
    const amazon = res.rows.find(r => r.platformId === 'amazon')!;
    expect(amazon.platform).toBe('Amazon');
    expect(amazon.ruleId).toBe('amazon.main-image');
    expect(amazon.sourceUrl).toBe('https://sellercentral.amazon.com/');
    expect(amazon.rule).toContain('≤ 200');
  });

  it('rejects with ApiError when /api/rules is unreachable (no stale data passed off as current)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(fetchRules()).rejects.toBeInstanceOf(ApiError);
  });

  it('rejects on a bad envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 0, data: {} }) }),
    );
    await expect(fetchRules()).rejects.toMatchObject({ category: 'bad-response' });
  });
});

describe('fallbackRules', () => {
  it('is marked stale so the UI can flag it as not-current', () => {
    const fb = fallbackRules();
    expect(fb.stale).toBe(true);
    expect(fb.rows.length).toBeGreaterThan(0);
  });
});

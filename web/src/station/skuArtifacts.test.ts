import { describe, expect, it } from 'vitest';
import type { PlatformDraft } from './data';
import {
  absoluteImageUrl,
  buildSkuArtifacts,
  buildVideoBrief,
  collectImageAssets,
  isUsableImageAsset,
} from './skuArtifacts';

const drafts: PlatformDraft[] = [
  {
    id: 'amazon',
    name: 'Amazon',
    role: '货架',
    title: 'Collapsible Silicone Travel Cup 350ml',
    fields: [
      { label: '五点 1', value: 'Folds flat to 4cm.' },
      { label: '标题长度', value: '97 字符' },
      { label: '详情规划', value: 'Hero → 防漏测试' },
      { label: '搜索词', value: '' },
    ],
    imageLabel: '白底主图 1:1',
    imageUrl: 'https://cdn.test/amazon-white.png',
    checks: [],
  },
  {
    id: 'shopify',
    name: 'Shopify',
    role: '品牌站',
    title: 'Pocket Cup 350',
    fields: [{ label: '长描述', value: 'A cup that disappears into a pocket.' }],
    imageLabel: '品牌站生活图',
    imageUrl: 'https://cdn.test/amazon-white.png',
    checks: [],
  },
];

const input = {
  productName: '折叠硅胶水杯 350ml',
  points: '折叠到 4cm\n\n食品级硅胶',
  uploads: ['data:image/png;base64,AAAA'],
  drafts,
};

describe('buildVideoBrief', () => {
  it('assembles the product, its selling points and the generated drafts', () => {
    const brief = buildVideoBrief(input);
    expect(brief).toContain('产品：折叠硅胶水杯 350ml');
    expect(brief).toContain('- 折叠到 4cm');
    expect(brief).toContain('- 食品级硅胶');
    expect(brief).toContain('【Amazon 草稿】');
    expect(brief).toContain('标题：Collapsible Silicone Travel Cup 350ml');
    expect(brief).toContain('五点 1：Folds flat to 4cm.');
    expect(brief).toContain('【Shopify 草稿】');
    expect(brief).toContain('长描述：A cup that disappears into a pocket.');
  });

  it('drops listing bookkeeping fields and empty values', () => {
    const brief = buildVideoBrief(input);
    expect(brief).not.toContain('标题长度');
    expect(brief).not.toContain('详情规划');
    expect(brief).not.toContain('搜索词');
  });

  it('never invents content for an empty SKU', () => {
    expect(buildVideoBrief({ productName: '', points: '', uploads: [], drafts: [] })).toBe('');
  });

  it('clips very long field values', () => {
    const long = 'x'.repeat(400);
    const brief = buildVideoBrief({
      ...input,
      drafts: [{ ...drafts[0], fields: [{ label: '描述', value: long }] }],
    });
    expect(brief).toContain('…');
    expect(brief).not.toContain(long);
  });
});

describe('collectImageAssets', () => {
  it('prefers uploads, then draft images, and deduplicates', () => {
    expect(collectImageAssets(input)).toEqual([
      'data:image/png;base64,AAAA',
      'https://cdn.test/amazon-white.png',
    ]);
  });

  it('skips values a browser cannot load as an image', () => {
    const assets = collectImageAssets({
      ...input,
      uploads: ['', '   ', 'not a url', 'data:text/plain;base64,AA=='],
      drafts: [{ ...drafts[0], imageUrl: '/station/cup-white.svg' }],
    });
    expect(assets).toEqual(['/station/cup-white.svg']);
  });
});

describe('image asset helpers', () => {
  it('classifies usable image assets', () => {
    expect(isUsableImageAsset('https://a.test/x.png')).toBe(true);
    expect(isUsableImageAsset('data:image/png;base64,AA==')).toBe(true);
    expect(isUsableImageAsset('/station/cup.svg')).toBe(true);
    expect(isUsableImageAsset('cup.svg')).toBe(false);
    expect(isUsableImageAsset('')).toBe(false);
  });

  it('resolves site-relative assets against the origin and leaves others alone', () => {
    expect(absoluteImageUrl('/station/cup.svg', 'https://shop.test')).toBe(
      'https://shop.test/station/cup.svg',
    );
    expect(absoluteImageUrl('https://a.test/x.png', 'https://shop.test')).toBe(
      'https://a.test/x.png',
    );
    expect(absoluteImageUrl('data:image/png;base64,AA==', 'https://shop.test')).toBe(
      'data:image/png;base64,AA==',
    );
  });
});

describe('buildSkuArtifacts', () => {
  it('returns the brief and the images as one package', () => {
    const artifacts = buildSkuArtifacts(input);
    expect(artifacts.brief).toBe(buildVideoBrief(input));
    expect(artifacts.images).toEqual(collectImageAssets(input));
  });
});

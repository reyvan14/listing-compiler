import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchListingDrafts } from './listingApi';
import type { CheckItem, PlatformId } from './data';

// The exact title a production API test generated and the old validator let
// through: emoji + hashtags + clickbait opening + social-caption phrasing.
const FAILED_TITLE =
  'Stop carrying bulky mugs! 🧘‍♀️✨ Meet the AeroFold Silicone Travel Cup. ' +
  'Folds to just 4.5cm! Fits anywhere. ☕🎒 ' +
  '#travelhacks #campinggear #ecofriendly #coffeehack';

const SUGGESTED = 'AeroFold Silicone Travel Cup, Folds to just 4.5cm, Fits anywhere';

const INPUT = {
  productName: 'AeroFold Silicone Travel Cup',
  points: 'Folds to 4.5cm\n350ml',
  platforms: ['tiktok'] as PlatformId[],
  assetMode: 'compliant' as const,
  uploads: [],
};

/** Backend response shaped exactly like checker.apply_checks output. */
function mockTiktokResponse(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        code: 0,
        data: {
          source: 'llm',
          drafts: [
            {
              id: 'tiktok',
              title: FAILED_TITLE,
              suggestedTitle: SUGGESTED,
              hasBlockingViolations: true,
              fields: [
                { label: '描述', value: 'Folds to 4.5cm', field: 'description', factRefs: [] },
                {
                  label: '社交文案',
                  value: '#travelhacks #campinggear #ecofriendly #coffeehack',
                  field: 'social-caption',
                  factRefs: [],
                },
              ],
              checks: [
                {
                  id: 'no_emoji',
                  label: '标题禁表情符号',
                  state: 'fix',
                  detail: '标题包含 4 个表情符号：🧘‍♀️ ✨ ☕ 🎒',
                  suggestion: '从商品标题中删除全部表情符号。',
                  blocking: true,
                  evidence: ['🧘‍♀️', '✨', '☕', '🎒'],
                },
                {
                  id: 'no_hashtags',
                  label: '标题禁话题标签',
                  state: 'fix',
                  detail: '标题包含话题标签：#travelhacks',
                  suggestion: '把话题标签移到「社交文案」字段。',
                  blocking: true,
                  evidence: ['#travelhacks'],
                },
                {
                  id: 'img',
                  label: '商品卡主图无加字',
                  state: 'pass',
                  detail: '商品卡主图无加字。',
                },
              ],
              ...overrides,
            },
          ],
        },
      }),
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('TikTok compliance metadata survives the API boundary', () => {
  it('carries suggestion, blocking and evidence onto every check', async () => {
    mockTiktokResponse();
    const { drafts } = await fetchListingDrafts(INPUT);
    const checks = drafts[0].checks as CheckItem[];

    const emoji = checks.find(c => c.id === 'no_emoji')!;
    expect(emoji.blocking).toBe(true);
    expect(emoji.detail).toContain('表情符号');
    expect(emoji.suggestion).toBeTruthy();
    expect(emoji.evidence).toEqual(['🧘‍♀️', '✨', '☕', '🎒']);

    const hashtags = checks.find(c => c.id === 'no_hashtags')!;
    expect(hashtags.blocking).toBe(true);
    expect(hashtags.suggestion).toContain('社交文案');
  });

  it('defaults the compliance fields for a passing check rather than dropping it', async () => {
    mockTiktokResponse();
    const { drafts } = await fetchListingDrafts(INPUT);
    const img = (drafts[0].checks as CheckItem[]).find(c => c.id === 'img')!;
    expect(img.blocking).toBe(false);
    expect(img.suggestion).toBe('');
    expect(img.evidence).toEqual([]);
  });

  it('surfaces the draft-level blocking flag and the suggested title', async () => {
    mockTiktokResponse();
    const { drafts } = await fetchListingDrafts(INPUT);
    expect(drafts[0].hasBlockingViolations).toBe(true);
    expect(drafts[0].suggestedTitle).toBe(SUGGESTED);
  });

  it('keeps hashtags in the separate social-caption field, not the title', async () => {
    mockTiktokResponse();
    const { drafts } = await fetchListingDrafts(INPUT);
    const caption = drafts[0].fields.find(f => f.field === 'social-caption')!;
    expect(caption.label).toBe('社交文案');
    expect(caption.value).toBe('#travelhacks #campinggear #ecofriendly #coffeehack');
  });

  it('a clean draft reports no blocking violations and no suggested title', async () => {
    mockTiktokResponse({
      title: 'AeroFold Collapsible Silicone Travel Cup, Leak-Proof Lid, 350ml',
      suggestedTitle: '',
      hasBlockingViolations: false,
      checks: [{ id: 'title', label: '标题规则', state: 'pass', detail: '长度合规。' }],
    });
    const { drafts } = await fetchListingDrafts(INPUT);
    expect(drafts[0].hasBlockingViolations).toBe(false);
    expect(drafts[0].suggestedTitle).toBe('');
    expect((drafts[0].checks as CheckItem[]).every(c => !c.blocking)).toBe(true);
  });
});

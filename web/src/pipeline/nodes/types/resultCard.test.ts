import { describe, expect, it } from 'vitest'
import type { CheckItem } from '@/station/data'
import {
  COMPACT_BLOCKING_ROW_PX,
  COMPACT_BODY_HEIGHT_PX,
  COMPACT_FIELD_LIMIT,
  blockingChecks,
  checkSummaryText,
  isResultExpanded,
  resultBodyHeightPx,
  type ListingResultNode,
  type StoredCheckItem,
} from './skuStation'

function check(over: Partial<StoredCheckItem> = {}): StoredCheckItem {
  return {
    id: 'title',
    label: '标题规则',
    state: 'pass',
    detail: 'ok',
    suggestion: '',
    blocking: false,
    evidence: [],
    ...over,
  }
}

function card(over: Partial<ListingResultNode> = {}): ListingResultNode {
  return {
    type: 'listing_result',
    platform: 'amazon',
    name: 'Amazon',
    role: '货架',
    title: 'Collapsible Silicone Travel Cup 350ml, Leak-Proof Lid, Heat-Resistant Pocket Cup',
    fields: [
      { label: '五点 1', value: 'Folds flat to 4cm — slips into a jacket pocket.' },
      { label: '五点 2', value: 'Food-grade silicone; dishwasher-safe; -40°C to 200°C.' },
      { label: '五点 3', value: 'Leak-proof lid with sip hole.' },
      { label: '五点 4', value: '350ml / 12oz.' },
      { label: '搜索词', value: 'collapsible cup; silicone travel mug' },
    ],
    imageUrl: '/station/cup-white.svg',
    imageLabel: '白底主图 1:1',
    checks: [check(), check({ id: 'bullets', label: '五点齐全' })],
    script: [],
    note: '',
    suggestedTitle: '',
    expanded: false,
    artifactId: 'amazon',
    policyVersion: 'amazon-us-2025.03',
    factRefs: [],
    fieldMeta: [],
    migrationStatus: 'current',
    staleReason: '',
    ...over,
  }
}

describe('compact summary card', () => {
  it('every platform card has the same fixed default height', () => {
    const amazon = card({ platform: 'amazon' })
    const tiktok = card({
      platform: 'tiktok',
      name: 'TikTok Shop',
      title: '350ml foldable silicone travel cup — leak-proof lid, pocket size',
      fields: [{ label: '描述', value: 'Pack a real cup, not a disposable.' }],
      checks: [check()],
    })
    const shopify = card({
      platform: 'shopify',
      name: 'Shopify',
      title: 'Pocket Cup 350',
      fields: [{ label: '长描述', value: 'A cup that disappears into a pocket.' }],
      checks: [check(), check({ id: 'img' }), check({ id: 'copy' })],
    })

    expect(resultBodyHeightPx(amazon)).toBe(COMPACT_BODY_HEIGHT_PX)
    expect(resultBodyHeightPx(tiktok)).toBe(COMPACT_BODY_HEIGHT_PX)
    expect(resultBodyHeightPx(shopify)).toBe(COMPACT_BODY_HEIGHT_PX)
  })

  it('height is independent of how long the title or how many fields there are', () => {
    const short = card({ title: 'Cup', fields: [] })
    const huge = card({
      title: 'x'.repeat(400),
      fields: Array.from({ length: 12 }, (_, i) => ({ label: `五点 ${i}`, value: 'y'.repeat(300) })),
    })
    expect(resultBodyHeightPx(short)).toBe(resultBodyHeightPx(huge))
  })

  it('adds exactly one fixed row when the card carries blocking violations', () => {
    const clean = card()
    const blocked = card({
      checks: [check({ id: 'no_emoji', blocking: true, state: 'fix' })],
    })
    expect(resultBodyHeightPx(blocked)).toBe(
      COMPACT_BODY_HEIGHT_PX + COMPACT_BLOCKING_ROW_PX,
    )
    expect(resultBodyHeightPx(blocked)).toBeGreaterThan(resultBodyHeightPx(clean))
  })

  it('a long Amazon card is far shorter compact than expanded', () => {
    const long = card({
      checks: [
        check({ id: 'a', state: 'fix', detail: 'd'.repeat(120), suggestion: 's'.repeat(120) }),
        check({ id: 'b', state: 'fix', detail: 'd'.repeat(120), suggestion: 's'.repeat(120) }),
        check({ id: 'c', state: 'fix', detail: 'd'.repeat(120), suggestion: 's'.repeat(120) }),
      ],
    })
    const compactH = resultBodyHeightPx(long)
    const expandedH = resultBodyHeightPx({ ...long, expanded: true })
    expect(compactH).toBe(COMPACT_BODY_HEIGHT_PX)
    expect(expandedH).toBeGreaterThan(compactH)
  })

  it('the ad card keeps its own fixed height and is never expandable', () => {
    const ad = card({ platform: 'ad', expanded: true })
    expect(isResultExpanded(ad)).toBe(false)
    expect(resultBodyHeightPx(ad)).toBe(268)
  })
})

describe('isResultExpanded', () => {
  it('is false by default and true only when the flag is set', () => {
    expect(isResultExpanded(card())).toBe(false)
    expect(isResultExpanded(card({ expanded: true }))).toBe(true)
  })
})

describe('checkSummaryText', () => {
  it('summarises passes and revisions instead of listing every explanation', () => {
    const checks: CheckItem[] = [
      { id: 'a', label: 'a', state: 'pass', detail: '' },
      { id: 'b', label: 'b', state: 'pass', detail: '' },
      { id: 'c', label: 'c', state: 'pass', detail: '' },
      { id: 'd', label: 'd', state: 'fix', detail: '' },
    ]
    expect(checkSummaryText(checks)).toBe('3 通过 / 1 需改')
  })

  it('mentions ad-only items only when there are some', () => {
    expect(checkSummaryText([{ id: 'a', label: 'a', state: 'pass', detail: '' }])).toBe(
      '1 通过 / 0 需改',
    )
    expect(
      checkSummaryText([{ id: 'a', label: 'a', state: 'ad-only', detail: '' }]),
    ).toBe('0 通过 / 0 需改 / 1 只能去投放')
  })
})

describe('blockingChecks', () => {
  it('returns only the blocking violations', () => {
    const node = card({
      checks: [
        check({ id: 'ok' }),
        check({ id: 'no_emoji', state: 'fix', blocking: true }),
        check({ id: 'no_hashtags', state: 'fix', blocking: true }),
      ],
    })
    expect(blockingChecks(node).map(c => c.id)).toEqual(['no_emoji', 'no_hashtags'])
    expect(blockingChecks(card())).toEqual([])
  })
})

describe('compact field limit', () => {
  it('caps the key fields shown on a summary card at three', () => {
    expect(COMPACT_FIELD_LIMIT).toBe(3)
    // the fixture deliberately has more fields than the cap
    expect(card().fields.length).toBeGreaterThan(COMPACT_FIELD_LIMIT)
  })
})

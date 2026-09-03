import { describe, expect, it } from 'vitest'
import type { CheckItem } from '@/station/data'
import {
  COMPACT_BLOCKING_ROW_PX,
  COMPACT_BODY_HEIGHT_PX,
  COMPACT_FIELD_LIMIT,
  blockingChecks,
  checkSummaryText,
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

  it('a card with many long checks stays exactly the compact height', () => {
    // Detail lives in the viewport-level inspector, so no amount of check copy
    // can make the node outgrow the viewport.
    const long = card({
      checks: [
        check({ id: 'a', state: 'fix', detail: 'd'.repeat(120), suggestion: 's'.repeat(120) }),
        check({ id: 'b', state: 'fix', detail: 'd'.repeat(120), suggestion: 's'.repeat(120) }),
        check({ id: 'c', state: 'fix', detail: 'd'.repeat(120), suggestion: 's'.repeat(120) }),
      ],
    })
    expect(resultBodyHeightPx(long)).toBe(COMPACT_BODY_HEIGHT_PX)
  })

  it('the ad card keeps its own fixed height', () => {
    expect(resultBodyHeightPx(card({ platform: 'ad' }))).toBe(268)
  })

  it('the migration status banner does not change the card height', () => {
    // The banner is an absolutely-positioned overlay precisely so that marking
    // one card stale cannot push the cards below it down: unaffected cards keep
    // their exact positions through a migration.
    const plain = card()
    const stale = card({ migrationStatus: 'stale' })
    const staleWithReason = card({ migrationStatus: 'stale', staleReason: '政策变更 · title' })

    expect(resultBodyHeightPx(stale)).toBe(resultBodyHeightPx(plain))
    expect(resultBodyHeightPx(staleWithReason)).toBe(resultBodyHeightPx(plain))
  })

  it('only a blocking violation changes the height, and only once', () => {
    const heights = new Set(
      [
        card(),
        card({ migrationStatus: 'applied' }),
        card({ title: 'x'.repeat(400) }),
        card({ fields: [] }),
      ].map(resultBodyHeightPx),
    )
    expect([...heights]).toHaveLength(1)
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

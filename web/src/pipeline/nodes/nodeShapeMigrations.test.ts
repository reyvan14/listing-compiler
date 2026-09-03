import { describe, expect, it } from 'vitest'
import { backfillNodeProps } from './nodeShapeMigrations'

describe('image_generation backfill', () => {
  it('adds resultAspectRatio so an old canvas starts from the neutral preview', () => {
    const node = backfillNodeProps({ type: 'image_generation', aspectRatio: '9:16' })
    expect(node.resultAspectRatio).toBeNull()
  })

  it('keeps an already-measured ratio and is idempotent', () => {
    const once = backfillNodeProps({ type: 'image_generation', resultAspectRatio: '1600:900' })
    const twice = backfillNodeProps({ ...once })
    expect(twice.resultAspectRatio).toBe('1600:900')
  })
})

describe('sku_listing backfill', () => {
  it('drops the retired fake-phase index', () => {
    const node = backfillNodeProps({ type: 'sku_listing', stepIndex: 3 })
    expect('stepIndex' in node).toBe(false)
  })

  it('adds the downstream artifact package fields', () => {
    const node = backfillNodeProps({ type: 'sku_listing', productName: '杯子' })
    expect(node.videoBrief).toBe('')
    expect(node.imageAssets).toEqual([])
    expect(node.productName).toBe('杯子')
  })

  it('keeps existing artifacts and is idempotent', () => {
    const once = backfillNodeProps({
      type: 'sku_listing',
      videoBrief: '产品：杯子',
      imageAssets: ['https://a.test/1.png'],
    })
    const twice = backfillNodeProps({ ...once })
    expect(twice.videoBrief).toBe('产品：杯子')
    expect(twice.imageAssets).toEqual(['https://a.test/1.png'])
  })
})

describe('listing_result compliance backfill', () => {
  it('materialises the compliance fields on an old cards checks', () => {
    const node = backfillNodeProps({
      type: 'listing_result',
      platform: 'tiktok',
      checks: [{ id: 'title', label: '标题 25–200', state: 'pass', detail: 'ok' }],
    })
    const checks = node.checks as Record<string, unknown>[]
    expect(checks[0].suggestion).toBe('')
    expect(checks[0].blocking).toBe(false)
    expect(checks[0].evidence).toEqual([])
    expect(node.suggestedTitle).toBe('')
    // the migration metadata from the previous version is still applied
    expect(node.artifactId).toBe('tiktok')
    expect(node.migrationStatus).toBe('current')
  })

  it('keeps real compliance data and is idempotent', () => {
    const once = backfillNodeProps({
      type: 'listing_result',
      platform: 'tiktok',
      suggestedTitle: 'AeroFold Travel Cup 350ml',
      checks: [
        {
          id: 'no_emoji',
          label: '标题禁表情符号',
          state: 'fix',
          detail: '包含表情',
          suggestion: '删除表情',
          blocking: true,
          evidence: ['☕'],
        },
      ],
    })
    const twice = backfillNodeProps({ ...once })
    const checks = twice.checks as Record<string, unknown>[]
    expect(checks[0].blocking).toBe(true)
    expect(checks[0].evidence).toEqual(['☕'])
    expect(twice.suggestedTitle).toBe('AeroFold Travel Cup 350ml')
  })
})

describe('listing_result compact-card backfill', () => {
  it('drops the retired expanded flag — cards are permanently compact', () => {
    // T.object rejects unknown keys, so a persisted `expanded` must be deleted,
    // not merely ignored, or the old canvas fails validation on load.
    const node = backfillNodeProps({
      type: 'listing_result',
      platform: 'amazon',
      expanded: true,
      checks: [],
    })
    expect('expanded' in node).toBe(false)
  })

  it('is idempotent for a card that never had the flag', () => {
    const once = backfillNodeProps({ type: 'listing_result', platform: 'amazon', checks: [] })
    const twice = backfillNodeProps({ ...once })
    expect('expanded' in twice).toBe(false)
    expect(twice.artifactId).toBe('amazon')
  })
})

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

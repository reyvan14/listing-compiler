import { describe, expect, it } from 'vitest'
import { GENERATE_STEPS } from '@/station/data'
import { defaultSkuNode, skuRunStatusText } from './skuStation'

describe('SKU run status', () => {
  it('states that generation is running, the real elapsed time, and that it waits for the model', () => {
    expect(skuRunStatusText(0)).toBe('生成中 · 已用 0s · 正在等待模型返回')
    expect(skuRunStatusText(12)).toBe('生成中 · 已用 12s · 正在等待模型返回')
  })

  it('never claims a backend phase the server did not report', () => {
    for (const seconds of [0, 2, 5, 30, 120]) {
      const text = skuRunStatusText(seconds)
      for (const step of GENERATE_STEPS) {
        expect(text).not.toContain(step)
      }
    }
  })

  it('rounds down a fractional timer and never shows a negative time', () => {
    expect(skuRunStatusText(3.9)).toContain('已用 3s')
    expect(skuRunStatusText(-4)).toContain('已用 0s')
    expect(skuRunStatusText(Number.NaN)).toContain('已用 0s')
  })

  it('no longer carries a phase index to rotate through', () => {
    expect('stepIndex' in defaultSkuNode()).toBe(false)
  })
})

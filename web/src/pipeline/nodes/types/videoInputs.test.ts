import { describe, expect, it } from 'vitest'
import { composeVideoPrompt, videoUpstreamSummary, EMPTY_VIDEO_UPSTREAM } from './videoInputs'

describe('composeVideoPrompt', () => {
  it('keeps both the upstream brief and the user prompt', () => {
    const prompt = composeVideoPrompt({
      brief: '产品：折叠硅胶水杯',
      texts: [],
      userPrompt: '镜头从桌面缓慢推近',
    })
    expect(prompt).toContain('【上游素材】')
    expect(prompt).toContain('产品：折叠硅胶水杯')
    expect(prompt).toContain('【创意指令】镜头从桌面缓慢推近')
  })

  it('uses the user prompt alone when there is no upstream', () => {
    expect(composeVideoPrompt({ brief: '', texts: [], userPrompt: '一只水杯' })).toBe('一只水杯')
  })

  it('uses the upstream brief alone when the node has no prompt', () => {
    expect(composeVideoPrompt({ brief: '产品：杯子', texts: [], userPrompt: '  ' })).toBe(
      '【上游素材】\n产品：杯子',
    )
  })

  it('includes other upstream text values', () => {
    const prompt = composeVideoPrompt({ brief: '', texts: ['来自文本节点'], userPrompt: '推近' })
    expect(prompt).toContain('来自文本节点')
    expect(prompt).toContain('【创意指令】推近')
  })

  it('is empty when nothing at all is connected or typed', () => {
    expect(composeVideoPrompt({ brief: '', texts: [], userPrompt: '' })).toBe('')
  })
})

describe('videoUpstreamSummary', () => {
  it('says nothing when nothing is connected', () => {
    expect(videoUpstreamSummary(EMPTY_VIDEO_UPSTREAM)).toBe('')
  })

  it('reports the real text/image counts and the first frame', () => {
    expect(
      videoUpstreamSummary({
        brief: '产品：杯子',
        texts: [],
        images: ['https://a.test/1.png', 'https://a.test/2.png'],
        firstFrameUrl: 'https://a.test/1.png',
      }),
    ).toBe('已接入上游文本素材 · 2 张图片 · 第 1 张作为首帧')
  })

  it('does not claim a first frame when no image URL is usable', () => {
    const summary = videoUpstreamSummary({
      brief: '产品：杯子',
      texts: [],
      images: ['blob-only'],
      firstFrameUrl: null,
    })
    expect(summary).toContain('1 张图片')
    expect(summary).not.toContain('第 1 张作为首帧')
  })

  it('does not claim text artifacts when only images are connected', () => {
    expect(
      videoUpstreamSummary({
        brief: '',
        texts: [],
        images: ['https://a.test/1.png'],
        firstFrameUrl: 'https://a.test/1.png',
      }),
    ).toBe('上游暂无文本素材 · 1 张图片 · 第 1 张作为首帧')
  })
})

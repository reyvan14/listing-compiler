import { describe, expect, it } from 'vitest'
import {
  composeVideoPrompt,
  sourceNodeContext,
  videoUpstreamSummary,
  EMPTY_VIDEO_UPSTREAM,
} from './videoInputs'

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

  it('reports an image-only connection as ready to run, not as missing text', () => {
    const summary = videoUpstreamSummary({
      brief: '',
      texts: [],
      images: ['https://a.test/1.png'],
      firstFrameUrl: 'https://a.test/1.png',
    })
    expect(summary).toBe('已连接首帧图片 · 1 张图片 · 第 1 张作为首帧 · 可直接生成，运镜描述可留空')
    expect(summary).not.toContain('上游暂无文本素材')
  })

  it('still reports missing text when no image is usable as a first frame', () => {
    expect(
      videoUpstreamSummary({
        brief: '',
        texts: [],
        images: ['blob-only'],
        firstFrameUrl: null,
      }),
    ).toBe('上游暂无文本素材 · 1 张图片 · 图片地址不可直接作首帧')
  })

  it('reports both sources when an image node contributes its prompt', () => {
    expect(
      videoUpstreamSummary({
        brief: '',
        texts: ['白色背景上的折叠水杯'],
        images: ['https://a.test/1.png'],
        firstFrameUrl: 'https://a.test/1.png',
      }),
    ).toBe('已接入上游文本素材 · 1 张图片 · 第 1 张作为首帧')
  })
})

describe('sourceNodeContext', () => {
  it('uses an image node prompt as upstream text context', () => {
    expect(sourceNodeContext({ type: 'image_generation', prompt: ' 白色背景上的折叠水杯 ' })).toEqual({
      brief: '',
      text: '白色背景上的折叠水杯',
      images: [],
    })
  })

  it('contributes nothing extra when the image node prompt is blank', () => {
    expect(sourceNodeContext({ type: 'image_generation', prompt: '   ' })).toEqual({
      brief: '',
      text: '',
      images: [],
    })
  })

  it('reads the brief and image assets off a SKU node', () => {
    expect(
      sourceNodeContext({
        type: 'sku_listing',
        videoBrief: '产品：杯子',
        imageAssets: ['https://a.test/1.png'],
      }),
    ).toEqual({ brief: '产品：杯子', text: '', images: ['https://a.test/1.png'] })
  })

  it('ignores node types that carry no upstream context', () => {
    expect(sourceNodeContext({ type: 'listing_result' })).toEqual({
      brief: '',
      text: '',
      images: [],
    })
  })
})

describe('composeVideoPrompt with an image node upstream', () => {
  it('keeps the image node prompt when the video node has none', () => {
    expect(composeVideoPrompt({ brief: '', texts: ['白色背景上的折叠水杯'], userPrompt: '' })).toBe(
      '白色背景上的折叠水杯',
    )
  })

  it('is empty when the image node prompt is blank too — the first frame carries the request', () => {
    expect(composeVideoPrompt({ brief: '', texts: [], userPrompt: '' })).toBe('')
  })
})

import { describe, expect, it } from 'vitest'
import {
  NODE_HEADER_HEIGHT_PX,
  NODE_ROW_BOTTOM_PADDING_PX,
  NODE_ROW_HEADER_GAP_PX,
} from '../../constants'
import {
  IMAGE_FORM_CHROME_PX,
  IMAGE_PREVIEW_WIDTH_PX,
  NEUTRAL_PREVIEW_RATIO,
  defaultImageNode,
  imageBodyHeightPx,
  imageDisplayRatio,
  imageNodeWidthPx,
  imagePreviewHeightPx,
  intrinsicAspectRatio,
  mediaSidePortY,
} from './mediaStation'

const NEUTRAL_HEIGHT = imagePreviewHeightPx(NEUTRAL_PREVIEW_RATIO)

describe('image preview geometry', () => {
  it.each([
    ['1:1', 408],
    ['16:9', 230],
    ['9:16', 725],
    ['4:3', 306],
    ['3:4', 544],
    ['3:2', 272],
  ])('derives the box height from the %s ratio', (ratio, expectedHeight) => {
    expect(IMAGE_PREVIEW_WIDTH_PX).toBe(408)
    expect(imagePreviewHeightPx(ratio)).toBe(expectedHeight)
  })

  it('clamps degenerate ratios instead of collapsing or exploding the node', () => {
    expect(imagePreviewHeightPx('3000:200')).toBe(96)
    expect(imagePreviewHeightPx('1:20')).toBe(725)
  })

  it('keeps the model height and visible side-port center in sync', () => {
    const node = { ...defaultImageNode(), aspectRatio: '1:1' }
    const body = imageBodyHeightPx(node)
    const fullNodeHeight =
      NODE_HEADER_HEIGHT_PX + NODE_ROW_HEADER_GAP_PX + body + NODE_ROW_BOTTOM_PADDING_PX

    expect(body).toBe(NEUTRAL_HEIGHT + IMAGE_FORM_CHROME_PX)
    expect(mediaSidePortY(body)).toBe((NODE_HEADER_HEIGHT_PX + fullNodeHeight) / 2)
  })

  it('falls back to a square preview for malformed ratios', () => {
    expect(imagePreviewHeightPx('bad')).toBe(408)
  })
})

describe('the requested ratio is a request parameter only', () => {
  it.each(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2'])(
    'keeps the neutral 16:9 preview when %s is requested and no result exists',
    aspectRatio => {
      const node = { ...defaultImageNode(), aspectRatio }
      expect(imageDisplayRatio(node)).toBe('16:9')
      expect(imageBodyHeightPx(node)).toBe(NEUTRAL_HEIGHT + IMAGE_FORM_CHROME_PX)
    },
  )

  it('renders a 1600x900 result as 16:9 even though 1:1 was requested', () => {
    const node = {
      ...defaultImageNode(),
      aspectRatio: '1:1',
      imageUrls: ['data:image/png;base64,AA=='],
      resultAspectRatio: intrinsicAspectRatio(1600, 900),
    }
    expect(node.resultAspectRatio).toBe('1600:900')
    expect(imageDisplayRatio(node)).toBe('1600:900')
    // 1600:900 is 16:9, so the box height matches the 16:9 height exactly.
    expect(imagePreviewHeightPx(imageDisplayRatio(node))).toBe(imagePreviewHeightPx('16:9'))
    expect(imageBodyHeightPx(node)).toBe(imagePreviewHeightPx('16:9') + IMAGE_FORM_CHROME_PX)
  })

  it('renders a portrait result from a 16:9 request at the real ratio', () => {
    const node = {
      ...defaultImageNode(),
      aspectRatio: '16:9',
      imageUrls: ['x.png'],
      resultAspectRatio: intrinsicAspectRatio(1024, 1536),
    }
    expect(imagePreviewHeightPx(imageDisplayRatio(node))).toBe(imagePreviewHeightPx('2:3'))
  })

  it('stays neutral while the intrinsic ratio is unknown or unusable', () => {
    const base = { ...defaultImageNode(), aspectRatio: '9:16', imageUrls: ['x.png'] }
    expect(imageDisplayRatio({ ...base, resultAspectRatio: null })).toBe('16:9')
    expect(imageDisplayRatio({ ...base, resultAspectRatio: '0:0' })).toBe('16:9')
    expect(imageDisplayRatio({ ...base, resultAspectRatio: 'bad' })).toBe('16:9')
  })

  it('rejects unusable natural dimensions', () => {
    expect(intrinsicAspectRatio(0, 900)).toBeNull()
    expect(intrinsicAspectRatio(1600, 0)).toBeNull()
    expect(intrinsicAspectRatio(Number.NaN, 900)).toBeNull()
  })
})

describe('result-card geometry follows the asset', () => {
  it('sizes a result card from the real ratio, not the requested one', () => {
    const node = {
      ...defaultImageNode(),
      isResultNode: true,
      aspectRatio: '1:1',
      imageUrls: ['x.png'],
      resultAspectRatio: '1600:900',
    }
    expect(imageNodeWidthPx(node)).toBe(569)
    expect(imageBodyHeightPx(node)).toBe(320)
  })

  it('keeps generators at the fixed node width', () => {
    expect(imageNodeWidthPx(defaultImageNode())).toBe(432)
  })
})

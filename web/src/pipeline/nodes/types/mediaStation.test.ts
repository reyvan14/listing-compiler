import { describe, expect, it } from 'vitest'
import {
  NODE_HEADER_HEIGHT_PX,
  NODE_ROW_BOTTOM_PADDING_PX,
  NODE_ROW_HEADER_GAP_PX,
} from '../../constants'
import {
  IMAGE_FORM_CHROME_PX,
  IMAGE_PREVIEW_WIDTH_PX,
  defaultImageNode,
  imageBodyHeightPx,
  imagePreviewHeightPx,
  mediaSidePortY,
} from './mediaStation'

describe('image preview geometry', () => {
  it.each([
    ['1:1', 408],
    ['16:9', 230],
    ['9:16', 725],
    ['4:3', 306],
    ['3:4', 544],
    ['3:2', 272],
  ])('uses the selected %s ratio', (ratio, expectedHeight) => {
    expect(IMAGE_PREVIEW_WIDTH_PX).toBe(408)
    expect(imagePreviewHeightPx(ratio)).toBe(expectedHeight)
  })

  it('keeps the model height and visible side-port center in sync', () => {
    const node = { ...defaultImageNode(), aspectRatio: '1:1' }
    const body = imageBodyHeightPx(node)
    const fullNodeHeight =
      NODE_HEADER_HEIGHT_PX + NODE_ROW_HEADER_GAP_PX + body + NODE_ROW_BOTTOM_PADDING_PX

    expect(body).toBe(408 + IMAGE_FORM_CHROME_PX)
    expect(mediaSidePortY(body)).toBe((NODE_HEADER_HEIGHT_PX + fullNodeHeight) / 2)
  })

  it('falls back to a square preview for malformed ratios', () => {
    expect(imagePreviewHeightPx('bad')).toBe(408)
  })
})

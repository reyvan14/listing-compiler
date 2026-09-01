import { createShapeId, Editor } from 'tldraw'
import {
  NODE_HEADER_HEIGHT_PX,
  NODE_ROW_BOTTOM_PADDING_PX,
  NODE_ROW_HEADER_GAP_PX,
} from '../../constants'
import type { NodeShape } from '../NodeShapeUtil'
import type { ImageGenerationNode } from './ImageGenerationNode'
import type { VideoGenerationNode } from './VideoGenerationNode'

export const IMAGE_NODE_WIDTH_PX = 432
export const IMAGE_PREVIEW_HORIZONTAL_INSET_PX = 24
export const IMAGE_PREVIEW_WIDTH_PX = IMAGE_NODE_WIDTH_PX - IMAGE_PREVIEW_HORIZONTAL_INSET_PX
// imageBox margins (4px top + 12px bottom) plus prompt/form chrome.
// Keep this in step with mediaForm.module.scss so the tldraw geometry and DOM
// have the same height and connection endpoints land on the visible ports.
export const IMAGE_FORM_CHROME_PX = 140
export const VIDEO_NODE_WIDTH_PX = 280
export const VIDEO_BOX_AREA_PX = 320
export const RESULT_NODE_WIDTH_PX = 320
export const RESULT_BOX_SHORT_PX = 320
export const MEDIA_GAP_PX = 48
export const SKU_MEDIA_ORIGIN = { x: 36, y: 36 }
export const SKU_MEDIA_SKU_WIDTH = 300

export const IMAGE_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2'] as const
export const VIDEO_ASPECT_RATIOS = ['9:16', '16:9', '1:1'] as const

export function mediaSidePortY(bodyPx: number, hasHeading = true): number {
  if (!hasHeading) return bodyPx / 2
  const total = NODE_HEADER_HEIGHT_PX + NODE_ROW_HEADER_GAP_PX + bodyPx + NODE_ROW_BOTTOM_PADDING_PX
  return (NODE_HEADER_HEIGHT_PX + total) / 2
}

export function parseAspect(aspectRatio: string): { w: number; h: number } {
  const [aw, ah] = (aspectRatio || '').split(':').map(Number)
  if (aw && ah) return { w: aw, h: ah }
  return { w: 1, h: 1 }
}

export function resultBoxSizePx(aspectRatio: string): { w: number; h: number } {
  const { w: rw, h: rh } = parseAspect(aspectRatio)
  if (rw <= rh) {
    return { w: RESULT_BOX_SHORT_PX, h: Math.round((RESULT_BOX_SHORT_PX * rh) / rw) }
  }
  return { w: Math.round((RESULT_BOX_SHORT_PX * rw) / rh), h: RESULT_BOX_SHORT_PX }
}

export function imagePreviewHeightPx(aspectRatio: string): number {
  const { w, h } = parseAspect(aspectRatio)
  return Math.round((IMAGE_PREVIEW_WIDTH_PX * h) / w)
}

export function defaultImageNode(): ImageGenerationNode {
  return {
    type: 'image_generation',
    mode: 'text2img',
    model: 'image-2',
    imageType: 'ArtGen',
    aspectRatio: '1:1',
    resolution: '2K',
    count: 1,
    prompt: '',
    referenceImages: [],
    lastResult: null,
    imageUrls: [],
    spawnedNodeIds: [],
    text2imgDone: false,
    isResultNode: false,
    name: '图片节点',
  }
}

export function defaultVideoNode(): VideoGenerationNode {
  return {
    type: 'video_generation',
    mode: 'text2video',
    model: 'seedance-2.0',
    videoType: 'QuickClip',
    platform: 'TikTok',
    aspectRatio: '9:16',
    duration: '5s',
    resolution: '720p',
    audio: false,
    cameraMode: '固定',
    count: 1,
    prompt: '',
    referenceImages: [],
    referenceVideos: [],
    referenceAudios: [],
    firstFrameUrl: null,
    lastFrameUrl: null,
    referenceVideoUrl: null,
    lastResult: null,
    videoUrls: [],
    posterUrls: [],
    isResultNode: false,
    crop: null,
  }
}

function isGenerator(shape: NodeShape, type: 'image_generation' | 'video_generation') {
  const node = shape.props.node
  return node.type === type && !node.isResultNode
}

function findSku(editor: Editor) {
  return editor.getCurrentPageShapes().find(shape => {
    return editor.isShapeOfType(shape, 'node') && shape.props.node.type === 'sku_listing'
  })
}

export function listingStartX(editor: Editor): number {
  let x = SKU_MEDIA_ORIGIN.x + SKU_MEDIA_SKU_WIDTH + 96
  for (const shape of editor.getCurrentPageShapes()) {
    if (!editor.isShapeOfType(shape, 'node')) continue
    const type = shape.props.node.type
    if (type !== 'image_generation' && type !== 'video_generation') continue
    const bounds = editor.getShapePageBounds(shape.id)
    if (bounds) x = Math.max(x, bounds.maxX + MEDIA_GAP_PX)
  }
  return x
}

function nextMediaPoint(editor: Editor): { x: number; y: number } {
  const sku = findSku(editor)
  const skuRight = sku
    ? (editor.getShapePageBounds(sku.id)?.maxX ?? SKU_MEDIA_ORIGIN.x + SKU_MEDIA_SKU_WIDTH)
    : SKU_MEDIA_ORIGIN.x + SKU_MEDIA_SKU_WIDTH
  let x = skuRight + MEDIA_GAP_PX
  let y = SKU_MEDIA_ORIGIN.y

  for (const shape of editor.getCurrentPageShapes()) {
    if (!editor.isShapeOfType(shape, 'node')) continue
    const type = shape.props.node.type
    if (type !== 'image_generation' && type !== 'video_generation') continue
    const bounds = editor.getShapePageBounds(shape.id)
    if (bounds) {
      x = Math.max(x, bounds.maxX + MEDIA_GAP_PX)
      y = Math.min(y, bounds.y)
    }
  }
  return { x, y }
}

export function placeMediaNode(editor: Editor, type: 'image_generation' | 'video_generation') {
  const node = type === 'image_generation' ? defaultImageNode() : defaultVideoNode()
  const point = nextMediaPoint(editor)
  const id = createShapeId()
  editor.run(() => {
    editor.createShape({
      id,
      type: 'node',
      x: point.x,
      y: point.y,
      props: { node },
    })
    editor.select(id)
  })
  return id
}

export function ensureMediaNodes(editor: Editor) {
  const shapes = editor.getCurrentPageShapes().filter((shape): shape is NodeShape => {
    return editor.isShapeOfType(shape, 'node')
  })
  const hasImage = shapes.some(shape => isGenerator(shape, 'image_generation'))
  const hasVideo = shapes.some(shape => isGenerator(shape, 'video_generation'))
  if (hasImage && hasVideo) return

  editor.run(() => {
    if (!hasImage) {
      const point = nextMediaPoint(editor)
      editor.createShape({
        id: createShapeId(),
        type: 'node',
        x: point.x,
        y: point.y,
        props: { node: defaultImageNode() },
      })
    }
    if (!hasVideo) {
      const point = nextMediaPoint(editor)
      editor.createShape({
        id: createShapeId(),
        type: 'node',
        x: point.x,
        y: point.y,
        props: { node: defaultVideoNode() },
      })
    }
  })
}

export function imageBodyHeightPx(node: ImageGenerationNode): number {
  if (node.isResultNode) return resultBoxSizePx(node.aspectRatio).h
  return imagePreviewHeightPx(node.aspectRatio) + IMAGE_FORM_CHROME_PX
}

export function videoBodyHeightPx(node: VideoGenerationNode): number {
  if (node.isResultNode) return resultBoxSizePx(node.aspectRatio).h
  return VIDEO_BOX_AREA_PX
}

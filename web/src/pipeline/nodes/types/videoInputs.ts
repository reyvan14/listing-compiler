import { absoluteImageUrl, isUsableImageAsset } from '@/station/skuArtifacts'
import { Editor, TLShapeId } from 'tldraw'
import type { PortId } from '../../ports/Port'
import { classifyPortInputs, getNodePortConnections } from '../nodePorts'
import type { NodeShape } from '../NodeShapeUtil'

/**
 * What a 视频生成 node actually receives from its upstream connections.
 *
 * The SKU listing compiler persists an artifact package (`videoBrief` +
 * `imageAssets`) on every successful run; a connected video node reads it here
 * and feeds it into the real provider request — the brief becomes prompt
 * context and the first usable image becomes the first frame.
 *
 * A 图片生成 node upstream contributes its generated image the same way, plus
 * the prompt that created it as text context, so "this image, moving" is a
 * complete request even when the video node's own prompt is empty.
 */
export type VideoUpstream = {
  /** Textual brief assembled by the upstream SKU node ('' when there is none). */
  brief: string
  /** Other upstream text values (prompt nodes, …), in connection order. */
  texts: string[]
  /** Deduplicated upstream images: SKU artifacts first, then image nodes. */
  images: string[]
  /** First image the provider can actually fetch, absolute; null when none. */
  firstFrameUrl: string | null
}

export const EMPTY_VIDEO_UPSTREAM: VideoUpstream = {
  brief: '',
  texts: [],
  images: [],
  firstFrameUrl: null,
}

function pickFirstFrame(images: string[], origin?: string): string | null {
  for (const image of images) {
    if (!isUsableImageAsset(image)) continue
    const url = absoluteImageUrl(image, origin)
    // The provider accepts HTTP(S) URLs and image data URLs.
    if (/^https?:\/\//i.test(url) || /^data:image\//i.test(url)) return url
  }
  return null
}

/**
 * Text and images a source node contributes beyond its port value.
 *
 * Kept separate from `collectVideoUpstream` so the per-node-type rules can be
 * unit tested without a live editor.
 */
export type UpstreamSourceNode = {
  type: string
  videoBrief?: string
  imageAssets?: string[]
  prompt?: string
}

export function sourceNodeContext(node: UpstreamSourceNode): {
  brief: string
  text: string
  images: string[]
} {
  if (node.type === 'sku_listing') {
    return { brief: node.videoBrief ?? '', text: '', images: node.imageAssets ?? [] }
  }
  if (node.type === 'image_generation') {
    // The description that produced the image is the best available text
    // context for animating it; the image itself arrives via the port value.
    return { brief: '', text: (node.prompt ?? '').trim(), images: [] }
  }
  return { brief: '', text: '', images: [] }
}

export function collectVideoUpstream(
  editor: Editor,
  shape: NodeShape | TLShapeId,
  portId: PortId = 'input',
): VideoUpstream {
  const id = typeof shape === 'string' ? shape : shape.id
  const classified = classifyPortInputs(editor, id, portId)

  const briefs: string[] = []
  const sourceTexts: string[] = []
  const images: string[] = []
  const push = (value: string) => {
    if (value && !images.includes(value)) images.push(value)
  }

  const connections = getNodePortConnections(editor, id)
    .filter(c => c.terminal === 'end' && c.ownPortId === portId)
    .sort((a, b) => a.order - b.order)
  for (const connection of connections) {
    const source = editor.getShape(connection.connectedShapeId)
    if (!source || !editor.isShapeOfType(source, 'node')) continue
    const context = sourceNodeContext(source.props.node)
    if (context.brief) briefs.push(context.brief)
    if (context.text && !sourceTexts.includes(context.text)) sourceTexts.push(context.text)
    for (const image of context.images) push(image)
  }
  for (const image of classified.images) push(image)

  const brief = briefs.join('\n\n')
  // The SKU `output` port carries the brief as its text value; don't repeat it.
  const portTexts = classified.texts.filter(
    text => !briefs.includes(text) && !sourceTexts.includes(text),
  )
  return {
    brief,
    texts: [...sourceTexts, ...portTexts],
    images,
    firstFrameUrl: pickFirstFrame(images),
  }
}

/**
 * Merge upstream context with the node's own prompt. Neither source is dropped:
 * the upstream artifacts are the context, the user's prompt is the creative
 * instruction on top of it.
 */
export function composeVideoPrompt(input: {
  brief: string
  texts: string[]
  userPrompt: string
}): string {
  const blocks: string[] = []
  if (input.brief.trim()) blocks.push(`【上游素材】\n${input.brief.trim()}`)
  for (const text of input.texts) {
    if (text.trim()) blocks.push(text.trim())
  }
  const userPrompt = input.userPrompt.trim()
  if (userPrompt) blocks.push(blocks.length ? `【创意指令】${userPrompt}` : userPrompt)
  return blocks.join('\n\n')
}

/**
 * A short Chinese line describing what is really connected. It never claims a
 * source that is absent, and only claims a first frame when a usable image URL
 * was actually found.
 *
 * A usable first frame with no upstream text is a complete image-to-video
 * request on its own, so it is reported as ready to run rather than as a
 * missing-text problem.
 */
export function videoUpstreamSummary(upstream: VideoUpstream): string {
  const hasText = Boolean(upstream.brief.trim()) || upstream.texts.some(t => t.trim())
  if (!hasText && upstream.images.length === 0) return ''
  if (!hasText && upstream.firstFrameUrl) {
    return [
      '已连接首帧图片',
      `${upstream.images.length} 张图片`,
      '第 1 张作为首帧',
      '可直接生成，运镜描述可留空',
    ].join(' · ')
  }
  const parts = [hasText ? '已接入上游文本素材' : '上游暂无文本素材']
  parts.push(`${upstream.images.length} 张图片`)
  if (upstream.firstFrameUrl) parts.push('第 1 张作为首帧')
  else if (upstream.images.length > 0) parts.push('图片地址不可直接作首帧')
  return parts.join(' · ')
}

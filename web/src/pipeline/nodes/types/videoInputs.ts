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

export function collectVideoUpstream(
  editor: Editor,
  shape: NodeShape | TLShapeId,
  portId: PortId = 'input',
): VideoUpstream {
  const id = typeof shape === 'string' ? shape : shape.id
  const classified = classifyPortInputs(editor, id, portId)

  const briefs: string[] = []
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
    const node = source.props.node
    if (node.type !== 'sku_listing') continue
    if (node.videoBrief) briefs.push(node.videoBrief)
    for (const image of node.imageAssets) push(image)
  }
  for (const image of classified.images) push(image)

  const brief = briefs.join('\n\n')
  return {
    brief,
    // The SKU `output` port carries the brief as its text value; don't repeat it.
    texts: classified.texts.filter(text => !briefs.includes(text)),
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
 */
export function videoUpstreamSummary(upstream: VideoUpstream): string {
  const hasText = Boolean(upstream.brief.trim()) || upstream.texts.some(t => t.trim())
  if (!hasText && upstream.images.length === 0) return ''
  const parts = [hasText ? '已接入上游文本素材' : '上游暂无文本素材']
  parts.push(`${upstream.images.length} 张图片`)
  if (upstream.firstFrameUrl) parts.push('第 1 张作为首帧')
  else if (upstream.images.length > 0) parts.push('图片地址不可直接作首帧')
  return parts.join(' · ')
}

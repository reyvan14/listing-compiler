import { createShapeId, Editor, TLShapeId } from 'tldraw'
import {
  AD_CUT,
  DEMO_SKU,
  IMAGES,
  buildDrafts,
  type AssetMode,
  type CheckItem,
  type PlatformDraft,
  type PlatformId,
} from '@/station/data'
import { spawnConnectedNode } from '../../connection/spawnConnectedNode'
import { executionState } from '../../execution/executionState'
import type { NodeShape } from '../NodeShapeUtil'
import { getNodeHeightPx } from '../nodeTypes'
import { updateNode } from './shared'

export type SkuListingNode = {
  type: 'sku_listing'
  productName: string
  points: string
  amazon: boolean
  tiktok: boolean
  shopify: boolean
  uploads: string[]
  assetMode: AssetMode
  spawnedIds: string[]
  adSpawnedId: string | null
  stepIndex: number
}

export type ListingResultNode = {
  type: 'listing_result'
  platform: PlatformId | 'ad'
  name: string
  role: string
  title: string
  fields: { label: string; value: string }[]
  imageUrl: string
  imageLabel: string
  checks: CheckItem[]
  script: string[]
  note: string
}

export const SKU_NODE_WIDTH = 300
export const RESULT_NODE_WIDTH = 320
export const AD_NODE_WIDTH = 500
export const STATION_ORIGIN = { x: 36, y: 36 }
export const STATION_INNER_PAD = 24

export function estimateTextLines(text: string, widthPx: number, fontPx: number): number {
  const blocks = (text || '').split('\n')
  if (blocks.length === 0) return 1
  let lines = 0
  for (const block of blocks) {
    let width = 0
    let row = 1
    for (const ch of block) {
      width += /[\u4e00-\u9fff]/.test(ch) ? fontPx : fontPx * 0.58
      if (width > widthPx) {
        row += 1
        width = /[\u4e00-\u9fff]/.test(ch) ? fontPx : fontPx * 0.58
      }
    }
    lines += Math.max(1, row)
  }
  return lines
}

export function skuPointsRows(node: SkuListingNode): number {
  return Math.min(8, Math.max(4, estimateTextLines(node.points, SKU_NODE_WIDTH - STATION_INNER_PAD, 13)))
}

export const LANES: { id: PlatformId; name: string; role: string }[] = [
  { id: 'amazon', name: 'Amazon', role: '货架' },
  { id: 'tiktok', name: 'TikTok Shop', role: '货架' },
  { id: 'shopify', name: 'Shopify', role: '品牌站' },
]

export const STAMP: Record<CheckItem['state'], string> = {
  pass: '能贴',
  fix: '需改',
  'ad-only': '只能去投放',
}

export type StationScreen = 'empty' | 'generating' | 'result' | 'conflict' | 'ad'

export function defaultSkuNode(): SkuListingNode {
  return {
    type: 'sku_listing',
    productName: '',
    points: '',
    amazon: true,
    tiktok: true,
    shopify: true,
    uploads: [],
    assetMode: 'compliant',
    spawnedIds: [],
    adSpawnedId: null,
    stepIndex: 0,
  }
}

export function selectedPlatforms(node: SkuListingNode): PlatformId[] {
  return (['amazon', 'tiktok', 'shopify'] as const).filter(id => node[id])
}

export function skuBodyHeightPx(node: SkuListingNode): number {
  const pointRows = skuPointsRows(node)
  const role = 20
  const drop = 102
  const nameField = 60
  const pointsField = 22 + 16 + pointRows * 20
  const chips = 36
  const step = 28
  const actions = 46
  return role + drop + nameField + pointsField + chips + step + actions + 28
}

export function frameStation(editor: Editor) {
  editor.setCameraOptions({ isLocked: false })
  const ids = editor.getCurrentPageShapes().filter(s => editor.isShapeOfType(s, 'node')).map(s => s.id)
  const bounds = ids.length ? editor.getShapesPageBounds(ids) : null
  if (!bounds) {
    editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
    return
  }
  editor.zoomToBounds(
    {
      x: bounds.x - 72,
      y: bounds.y,
      w: bounds.w + 72 + 380,
      h: bounds.h,
    },
    { inset: 40, targetZoom: 1, animation: { duration: 260 } },
  )
}

export function worstCheckItem(checks: CheckItem[]): CheckItem | undefined {
  return checks.find(c => c.state === 'ad-only') ?? checks.find(c => c.state === 'fix') ?? checks[0]
}

export function resultBodyHeightPx(node: ListingResultNode): number {
  if (node.platform === 'ad') return 268
  const inner = RESULT_NODE_WIDTH - STATION_INNER_PAD
  const titleLines = Math.min(3, estimateTextLines(node.title, inner - 40, 12))
  const fieldsH = node.fields.slice(0, 3).reduce((sum, field) => {
    return sum + 16 + Math.min(2, estimateTextLines(field.value, inner, 12)) * 17 + 8
  }, 0)
  const reason = worstCheckItem(node.checks)
  const reasonH = reason && reason.state !== 'pass' && reason.detail ? 36 : 0
  const checksH = node.checks.reduce((sum, check) => {
    const detailLines = check.detail ? Math.min(2, estimateTextLines(check.detail, inner - 8, 11)) : 0
    return sum + 20 + detailLines * 15
  }, 18)
  return 28 + reasonH + 118 + 16 + titleLines * 17 + 10 + fieldsH + checksH + 28
}

export function resultImageUrl(platform: ListingResultNode['platform'], mode: AssetMode): string {
  if (platform === 'ad') return mode === 'promo' ? IMAGES.promo : IMAGES.lifestyle
  if (platform === 'shopify') return IMAGES.lifestyle
  return mode === 'promo' ? IMAGES.promo : IMAGES.white
}

export function worstCheck(checks: CheckItem[]): CheckItem['state'] {
  if (checks.some(c => c.state === 'ad-only')) return 'ad-only'
  if (checks.some(c => c.state === 'fix')) return 'fix'
  return 'pass'
}

function draftToResult(draft: PlatformDraft, mode: AssetMode): ListingResultNode {
  return {
    type: 'listing_result',
    platform: draft.id,
    name: draft.name,
    role: draft.role,
    title: draft.title,
    fields: draft.fields,
    imageUrl: draft.imageUrl || resultImageUrl(draft.id, mode),
    imageLabel: draft.imageLabel,
    checks: draft.checks,
    script: [],
    note: '',
  }
}

function adResult(mode: AssetMode): ListingResultNode {
  return {
    type: 'listing_result',
    platform: 'ad',
    name: '投放条',
    role: '15 秒 · 9:16',
    title: 'Pocket Cup 350 · 投放成片',
    fields: [
      { label: '去向', value: AD_CUT.destinations },
      { label: '规格', value: `${AD_CUT.duration}  ${AD_CUT.ratio}` },
    ],
    imageUrl: resultImageUrl('ad', mode),
    imageLabel: '9:16 封面',
    checks: [
      {
        id: 'ad',
        label: '投放条',
        state: 'ad-only',
        detail: AD_CUT.note,
      },
    ],
    script: AD_CUT.script,
    note: AD_CUT.note,
  }
}

export function findSkuShape(editor: Editor): NodeShape | undefined {
  return editor.getCurrentPageShapes().find((shape): shape is NodeShape => {
    return editor.isShapeOfType(shape, 'node') && shape.props.node.type === 'sku_listing'
  })
}

function deleteShapeTree(editor: Editor, id: string) {
  const shapeId = id as TLShapeId
  if (editor.getShape(shapeId)) editor.deleteShape(shapeId)
}

export function fillSkuDemo(editor: Editor, shape: NodeShape) {
  updateNode<SkuListingNode>(
    editor,
    shape,
    n => ({
      ...n,
      productName: n.productName.trim() || DEMO_SKU.name,
      points: n.points.trim() || DEMO_SKU.points,
      uploads: n.uploads.length ? n.uploads : [IMAGES.white, IMAGES.lifestyle],
    }),
    false,
  )
}

export function spawnPlatformResults(editor: Editor, source: NodeShape, drafts?: PlatformDraft[]) {
  const live = (editor.getShape(source.id) as NodeShape | undefined) ?? source
  const node = live.props.node as SkuListingNode
  const platforms = selectedPlatforms(node)
  if (platforms.length === 0) return

  editor.run(() => {
    for (const id of node.spawnedIds) deleteShapeTree(editor, id)
    if (node.adSpawnedId) deleteShapeTree(editor, node.adSpawnedId)

    const startX = mediaAwareListingStartX(editor)
    const ids: string[] = []
    const resolved = (drafts ?? buildDrafts(node.assetMode)).filter(d => platforms.includes(d.id))

    let y = STATION_ORIGIN.y
    for (const draft of resolved) {
      const id = spawnConnectedNode({
        editor,
        sourceShapeId: live.id,
        sourcePortId: `output_${draft.id}`,
        dataType: 'text',
        nodeProps: draftToResult(draft, node.assetMode),
        inputPortTarget: { x: startX, y: y + 20 },
      })
      ids.push(id)
      const spawned = editor.getShape(id as TLShapeId)
      const height =
        spawned && editor.isShapeOfType(spawned, 'node') ? getNodeHeightPx(editor, spawned) : 360
      y += height + 28
    }

    updateNode<SkuListingNode>(
      editor,
      live,
      n => ({
        ...n,
        spawnedIds: ids,
        adSpawnedId: null,
      }),
      false,
    )
  })

  editor.selectNone()
  requestAnimationFrame(() => frameStation(editor))
}

export function applyPromoConflict(editor: Editor, source: NodeShape) {
  const live = (editor.getShape(source.id) as NodeShape | undefined) ?? source
  const node = live.props.node as SkuListingNode

  editor.run(() => {
    updateNode<SkuListingNode>(
      editor,
      live,
      n => ({
        ...n,
        assetMode: 'promo',
        uploads: [IMAGES.promo, IMAGES.lifestyle],
      }),
      false,
    )

    const drafts = buildDrafts('promo')
    for (const id of node.spawnedIds) {
      const shape = editor.getShape(id as TLShapeId)
      if (!shape || !editor.isShapeOfType(shape, 'node')) continue
      const current = shape.props.node as ListingResultNode
      if (current.type !== 'listing_result' || current.platform === 'ad') continue
      const draft = drafts.find(d => d.id === current.platform)
      if (!draft) continue
      updateNode<ListingResultNode>(editor, shape, () => draftToResult(draft, 'promo'), false)
    }

    if (node.adSpawnedId) {
      const ad = editor.getShape(node.adSpawnedId as TLShapeId)
      if (ad && editor.isShapeOfType(ad, 'node')) {
        updateNode<ListingResultNode>(editor, ad, () => adResult('promo'), false)
      }
    }
  })
  editor.selectNone()
  requestAnimationFrame(() => frameStation(editor))
}

export function spawnAdResult(editor: Editor, source: NodeShape) {
  const live = (editor.getShape(source.id) as NodeShape | undefined) ?? source
  const node = live.props.node as SkuListingNode
  if (node.adSpawnedId && editor.getShape(node.adSpawnedId as TLShapeId)) {
    return
  }

  const x = STATION_ORIGIN.x
  const y = STATION_ORIGIN.y + 510

  editor.run(() => {
    const id = spawnConnectedNode({
      editor,
      sourceShapeId: live.id,
      sourcePortId: 'output',
      dataType: 'text',
      nodeProps: adResult(node.assetMode),
      inputPortTarget: { x, y: y + 20 },
    })
    updateNode<SkuListingNode>(editor, live, n => ({ ...n, adSpawnedId: id }), false)
  })
  editor.selectNone()
  requestAnimationFrame(() => frameStation(editor))
}

export function downloadAdCut(name: string) {
  const body = [
    '跨境上架编译器 · 投放条（下载，不发布）',
    `SKU: ${name || DEMO_SKU.name}`,
    `时长: ${AD_CUT.duration}  ${AD_CUT.ratio}`,
    `去向: ${AD_CUT.destinations}`,
    '',
    ...AD_CUT.script,
    '',
    AD_CUT.note,
  ].join('\n')
  const blob = new Blob([body], { type: 'text/plain;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'pocket-cup-350-15s.txt'
  a.click()
  URL.revokeObjectURL(a.href)
}

function mediaAwareListingStartX(editor: Editor): number {
  let x = STATION_ORIGIN.x + SKU_NODE_WIDTH + 96
  for (const shape of editor.getCurrentPageShapes()) {
    if (!editor.isShapeOfType(shape, 'node')) continue
    const type = shape.props.node.type
    if (type !== 'image_generation' && type !== 'video_generation') continue
    const bounds = editor.getShapePageBounds(shape.id)
    if (bounds) x = Math.max(x, bounds.maxX + 48)
  }
  return x
}

export function resetStationCanvas(editor: Editor) {
  editor.run(() => {
    const ids = editor.getCurrentPageShapes().map(s => s.id)
    if (ids.length) editor.deleteShapes(ids)
    const id = createShapeId()
    editor.createShape({
      id,
      type: 'node',
      x: STATION_ORIGIN.x,
      y: STATION_ORIGIN.y,
      props: { node: defaultSkuNode() },
    })
    editor.selectNone()
  })
  void import('./mediaStation').then(({ ensureMediaNodes }) => {
    ensureMediaNodes(editor)
    requestAnimationFrame(() => frameStation(editor))
  })
}

export function ensureSkuNode(editor: Editor) {
  if (findSkuShape(editor)) return
  resetStationCanvas(editor)
}

export function deriveStationScreen(editor: Editor): StationScreen {
  let sku: NodeShape | undefined
  let hasPlatform = false
  let hasAd = false
  let promo = false

  for (const shape of editor.getCurrentPageShapes()) {
    if (!editor.isShapeOfType(shape, 'node')) continue
    const node = shape.props.node
    if (node.type === 'sku_listing') {
      sku = shape
      promo = node.assetMode === 'promo'
    }
    if (node.type === 'listing_result') {
      if (node.platform === 'ad') hasAd = true
      else hasPlatform = true
    }
  }

  const executing = sku
    ? executionState.get(editor).runningGraph?.getNodeStatus(sku.id) === 'executing'
    : false
  if (executing) return 'generating'
  if (hasAd) return 'ad'
  if (hasPlatform) return promo ? 'conflict' : 'result'
  return 'empty'
}

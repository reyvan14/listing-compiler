import { createShapeId, Editor, TLShape, TLShapeId } from 'tldraw'
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
import { getNodeWidthPx } from '../nodeTypes'
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
  lastError: string
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Auto-frame must never drop below a readable zoom. */
export const MIN_STATION_ZOOM = 0.8

export const AGENT_COLLAPSE_KEY = 'station.agent.collapsed'

/** Horizontal px the collapsible Agent panel occupies on the right.
 * Must agree with readAgentCollapsed() in StationApp: explicit localStorage
 * choice wins, otherwise collapsed on desktops ≤ 1280px wide. */
export function agentGutterPx(): number {
  const OPEN = 372
  const COLLAPSED = 56
  try {
    const stored = localStorage.getItem(AGENT_COLLAPSE_KEY)
    if (stored === '1') return COLLAPSED
    if (stored === '0') return OPEN
  } catch {
    return OPEN
  }
  return typeof window !== 'undefined' && window.innerWidth <= 1280 ? COLLAPSED : OPEN
}

function isListingShape(editor: Editor, s: TLShape): boolean {
  if (!editor.isShapeOfType(s, 'node')) return false
  const t = (s as NodeShape).props.node.type
  return t === 'sku_listing' || t === 'listing_result'
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
    lastError: '',
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
  // room for inline validation rows + the run-error / local-sample block
  const validationBuffer = 24
  const errorBlock = node.lastError ? 104 : 0
  return role + drop + nameField + pointsField + chips + step + actions + validationBuffer + errorBlock + 28
}

type FrameOpts = {
  minZoom: number
  maxZoom: number
  gutter: number
  inset?: number
  /** 'both' fits width & height; 'width' fits width only (tall content scrolls). */
  fitAxis?: 'both' | 'width'
}

/**
 * Centre `bounds` in the viewport area left of the Agent gutter, at a zoom
 * clamped to [minZoom, maxZoom]. tldraw maps a page point `p` to the screen as
 * `(p + camera) * z`, so `camera = screenTarget / z - p`.
 */
function frameToBounds(editor: Editor, bounds: { x: number; y: number; w: number; h: number }, opts: FrameOpts) {
  // Default inset clears the left icon rail (~60px) as well as giving breathing room.
  const inset = opts.inset ?? 76
  const vsb = editor.getViewportScreenBounds()
  const availW = Math.max(220, vsb.w - opts.gutter - inset * 2)
  const availH = Math.max(220, vsb.h - inset * 2)
  const fit =
    opts.fitAxis === 'width'
      ? availW / bounds.w
      : Math.min(availW / bounds.w, availH / bounds.h)
  const z = clamp(fit, opts.minZoom, opts.maxZoom)

  // When content is wider/taller than the available area (zoom was clamped up),
  // align its top-left to the inset so the overflow spills off the right/bottom
  // edge — never under the Agent gutter — instead of centring it.
  const overflowX = bounds.w * z > availW
  const overflowY = bounds.h * z > availH
  const camX = overflowX
    ? inset / z - bounds.x
    : (vsb.w - opts.gutter) / 2 / z - (bounds.x + bounds.w / 2)
  const camY = overflowY ? inset / z - bounds.y : vsb.h / 2 / z - (bounds.y + bounds.h / 2)

  editor.setCamera({ x: camX, y: camY, z }, { animation: { duration: 240 } })
}

/** Default framing: SKU input + all listing results, never below MIN_STATION_ZOOM. */
export function frameStation(editor: Editor) {
  editor.setCameraOptions({ isLocked: false })
  const shapes = editor.getCurrentPageShapes().filter(s => isListingShape(editor, s))
  const bounds = shapes.length ? editor.getShapesPageBounds(shapes.map(s => s.id)) : null
  if (!bounds) {
    editor.setCamera({ x: 0, y: 0, z: 1 }, { immediate: true })
    return
  }
  frameToBounds(editor, bounds, { minZoom: MIN_STATION_ZOOM, maxZoom: 1, gutter: agentGutterPx() })
}

/** Explicit "聚焦输入": zoom to the SKU input node. Floor is low enough that the
 * taller error-recovery state still fits fully in view. */
export function focusSkuInput(editor: Editor) {
  const sku = findSkuShape(editor)
  const b = sku ? editor.getShapePageBounds(sku.id) : null
  if (!b) return frameStation(editor)
  frameToBounds(editor, b, { minZoom: 0.6, maxZoom: 1.1, gutter: agentGutterPx() })
}

/** Explicit "查看全部结果": fit the result cards, allowing a lower floor so all fit. */
export function focusAllResults(editor: Editor) {
  const results = editor
    .getCurrentPageShapes()
    .filter(s => editor.isShapeOfType(s, 'node') && (s as NodeShape).props.node.type === 'listing_result')
  if (results.length === 0) return frameStation(editor)
  const b = editor.getShapesPageBounds(results.map(s => s.id))
  if (!b) return
  // Fit all cards across the width at a readable zoom; tall cards scroll.
  frameToBounds(editor, b, { minZoom: 0.72, maxZoom: 1, gutter: agentGutterPx(), fitAxis: 'width' })
}

export function worstCheckItem(checks: CheckItem[]): CheckItem | undefined {
  return checks.find(c => c.state === 'ad-only') ?? checks.find(c => c.state === 'fix') ?? checks[0]
}

export function resultBodyHeightPx(node: ListingResultNode): number {
  if (node.platform === 'ad') return 268
  const inner = RESULT_NODE_WIDTH - STATION_INNER_PAD
  // font sizes bumped for readability (see skuStation.module.scss) — keep the
  // geometry estimate in step so cards don't clip.
  const titleLines = Math.min(4, estimateTextLines(node.title, inner - 40, 14))
  const fieldsH = node.fields.slice(0, 3).reduce((sum, field) => {
    return sum + 18 + Math.min(3, estimateTextLines(field.value, inner, 13)) * 19 + 8
  }, 0)
  const reason = worstCheckItem(node.checks)
  const reasonH = reason && reason.state !== 'pass' && reason.detail ? 40 : 0
  const checksH = node.checks.reduce((sum, check) => {
    const detailLines = check.detail ? Math.min(2, estimateTextLines(check.detail, inner - 8, 12)) : 0
    return sum + 22 + detailLines * 16
  }, 18)
  return 28 + reasonH + 118 + 16 + titleLines * 20 + 10 + fieldsH + checksH + 32
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

    // Horizontal platform lanes: one row, cards side by side. Keeps each card at
    // a readable width and lets the auto-frame fit width instead of stacking
    // three tall cards and fitting the whole height.
    const laneGap = 28
    let x = startX
    for (const draft of resolved) {
      const id = spawnConnectedNode({
        editor,
        sourceShapeId: live.id,
        sourcePortId: `output_${draft.id}`,
        dataType: 'text',
        nodeProps: draftToResult(draft, node.assetMode),
        inputPortTarget: { x, y: STATION_ORIGIN.y + 20 },
      })
      ids.push(id)
      const spawned = editor.getShape(id as TLShapeId)
      const width =
        spawned && editor.isShapeOfType(spawned, 'node')
          ? getNodeWidthPx(editor, spawned)
          : RESULT_NODE_WIDTH
      x += width + laneGap
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
  requestAnimationFrame(() => focusAllResults(editor))
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
  requestAnimationFrame(() => focusAllResults(editor))
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
  requestAnimationFrame(() => focusAllResults(editor))
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
  // Media (image / video) nodes are no longer auto-created — the initial
  // workflow stays focused on the SKU listing compiler. Users add them via
  // the sidebar "添加节点".
  requestAnimationFrame(() => frameStation(editor))
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

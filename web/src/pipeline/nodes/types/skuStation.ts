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
  lastError: string
  videoBrief: string
  imageAssets: string[]
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

/** A CheckItem as persisted on a shape: the optional compliance fields are
 * always materialised, because the tldraw T.object validator is strict. */
export type StoredCheckItem = CheckItem & {
  suggestion: string
  blocking: boolean
  evidence: string[]
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
  checks: StoredCheckItem[]
  script: string[]
  note: string
  suggestedTitle: string
  // self-healing Listing CI/CD dependency metadata (see ListingResultNode.tsx)
  artifactId: string
  policyVersion: string
  factRefs: string[]
  fieldMeta: { name: string; factRefs: string[] }[]
  migrationStatus: string
  staleReason: string
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
    lastError: '',
    videoBrief: '',
    imageAssets: [],
  }
}

/**
 * The status line shown while a run is in flight. The elapsed seconds are a real
 * client-side timer; the backend reports no stage progress, so the text says
 * only that generation is running and that we are waiting for the model.
 */
export function skuRunStatusText(elapsedSeconds: number): string {
  const seconds = Number.isFinite(elapsedSeconds) ? Math.max(0, Math.floor(elapsedSeconds)) : 0
  return `生成中 · 已用 ${seconds}s · 正在等待模型返回`
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
  // Default inset clears both the left icon rail and tldraw's floating bottom
  // action toolbar. With the old 76px margin, filling the SKU demo grew the
  // textarea just enough for its Generate button to sit behind Undo at 1280×720.
  const inset = opts.inset ?? 96
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

/** Zoom to one shape by id (used by the migration panel's "click to focus"). */
export function focusShape(editor: Editor, shapeId: string) {
  const b = editor.getShapePageBounds(shapeId as TLShapeId)
  if (!b) return frameStation(editor)
  frameToBounds(editor, b, { minZoom: 0.6, maxZoom: 1.1, gutter: agentGutterPx() })
}

/** Zoom to the union of several shapes (used by the Agent's "定位改动"). */
export function focusShapes(editor: Editor, shapeIds: string[]) {
  let box: { x: number; y: number; w: number; h: number } | null = null
  for (const id of shapeIds) {
    const b = editor.getShapePageBounds(id as TLShapeId)
    if (!b) continue
    box = box
      ? {
          x: Math.min(box.x, b.x),
          y: Math.min(box.y, b.y),
          w: Math.max(box.x + box.w, b.x + b.w) - Math.min(box.x, b.x),
          h: Math.max(box.y + box.h, b.y + b.h) - Math.min(box.y, b.y),
        }
      : { x: b.x, y: b.y, w: b.w, h: b.h }
  }
  if (!box) return frameStation(editor)
  frameToBounds(editor, box, { minZoom: 0.5, maxZoom: 1.1, gutter: agentGutterPx() })
}

/** All listing_result shapes on the page, keyed by their artifactId (platform). */
export function listingResultShapes(editor: Editor): Map<string, NodeShape> {
  const out = new Map<string, NodeShape>()
  for (const shape of editor.getCurrentPageShapes()) {
    if (!editor.isShapeOfType(shape, 'node')) continue
    const node = (shape as NodeShape).props.node
    if (node.type !== 'listing_result') continue
    out.set(node.artifactId || node.platform, shape as NodeShape)
  }
  return out
}

/**
 * Stamp migration status on the matching result cards. Cards NOT named in
 * `statuses` are left completely untouched — no updateNode call, so their
 * values, ids and canvas positions never change.
 */
export function markMigrationStatus(
  editor: Editor,
  statuses: { artifactId: string; status: string; reason?: string }[],
) {
  const shapes = listingResultShapes(editor)
  editor.run(() => {
    for (const { artifactId, status, reason } of statuses) {
      const shape = shapes.get(artifactId)
      if (!shape) continue
      updateNode<ListingResultNode>(
        editor,
        shape,
        n => ({ ...n, migrationStatus: status, staleReason: reason ?? '' }),
        false,
      )
    }
  })
}

/** Reset every result card back to 'current' with no stale reason. */
export function clearMigrationStatus(editor: Editor) {
  const shapes = listingResultShapes(editor)
  editor.run(() => {
    for (const shape of shapes.values()) {
      const node = shape.props.node as ListingResultNode
      if (node.migrationStatus === 'current' && !node.staleReason) continue
      updateNode<ListingResultNode>(
        editor,
        shape,
        n => ({ ...n, migrationStatus: 'current', staleReason: '' }),
        false,
      )
    }
  })
}

/** Overwrite the title / fields of one result card (used when a migration is applied). */
export function applyResultPatch(
  editor: Editor,
  artifactId: string,
  patch: { title?: string; fields?: { label: string; value: string }[]; policyVersion?: string },
) {
  const shape = listingResultShapes(editor).get(artifactId)
  if (!shape) return
  updateNode<ListingResultNode>(
    editor,
    shape,
    n => ({
      ...n,
      title: patch.title ?? n.title,
      fields: patch.fields ?? n.fields,
      policyVersion: patch.policyVersion ?? n.policyVersion,
    }),
    false,
  )
}

export function worstCheckItem(checks: CheckItem[]): CheckItem | undefined {
  return checks.find(c => c.state === 'ad-only') ?? checks.find(c => c.state === 'fix') ?? checks[0]
}

// --------------------------------------------------------------------------- //
// Compact summary card                                                         //
//                                                                              //
// Every platform result starts as a fixed-size summary so the three cards line //
// up and the canvas stays readable. The budget below is the contract with      //
// skuStation.module.scss (.compactCard) — change both together.                //
// --------------------------------------------------------------------------- //

/** Rows of the compact card, in px. Sums to COMPACT_BODY_HEIGHT_PX.
 *
 * Deliberately lean: the compact card shows only what requirement 1 lists, so
 * three of them stack inside a 900px-tall viewport without the auto-frame
 * having to zoom below the readability floor. The copy-title button lives in
 * expanded mode. */
const COMPACT_ROWS = {
  head: 26, // platform role / status + the 查看详情 toggle, on one row
  art: 72, // product image (64px) + margin
  title: 46, // "标题" label + 2 clamped lines
  fields: 54, // up to 3 key fields, one clamped line each
  summary: 20, // "3 通过 / 1 需改"
  pad: 8,
} as const

export const COMPACT_BODY_HEIGHT_PX = Object.values(COMPACT_ROWS).reduce((a, b) => a + b, 0)

/** One extra fixed row when the card carries blocking violations. Blocking
 * status is never hidden, so this row exists in compact mode too. */
export const COMPACT_BLOCKING_ROW_PX = 34

/** How many key fields a compact card shows. */
export const COMPACT_FIELD_LIMIT = 3

export function blockingChecks(node: ListingResultNode): StoredCheckItem[] {
  return node.checks.filter(c => c.blocking)
}

/** "3 通过 / 1 需改" — the compact validation summary. */
export function checkSummaryText(checks: CheckItem[]): string {
  const pass = checks.filter(c => c.state === 'pass').length
  const fix = checks.filter(c => c.state === 'fix').length
  const adOnly = checks.filter(c => c.state === 'ad-only').length
  const parts = [`${pass} 通过`, `${fix} 需改`]
  if (adOnly) parts.push(`${adOnly} 只能去投放`)
  return parts.join(' / ')
}

/**
 * Result cards are permanently compact.
 *
 * Detail lives in the viewport-level inspector (station/ListingInspector.tsx),
 * not in a taller node: a node that outgrows the viewport can only be read by
 * scrolling inside it, and wheel-scrolling inside a canvas node fights the
 * canvas's own pan/zoom. Height therefore varies only with the two banners the
 * compact card may carry, never with content length.
 */
export function resultBodyHeightPx(node: ListingResultNode): number {
  if (node.platform === 'ad') return 268
  return COMPACT_BODY_HEIGHT_PX + (blockingChecks(node).length ? COMPACT_BLOCKING_ROW_PX : 0)
}

/** Vertical gap between stacked result cards. */
export const RESULT_STACK_GAP = 24

/**
 * Stack `ids` vertically at `x`, vertically centred on the SKU node.
 *
 * Positions are assigned after creation so real measured heights are used. The
 * cards keep their bindings — a connection follows its port, not a coordinate —
 * so moving a card here cannot break the fan-out.
 */
export function layoutResultStack(
  editor: Editor,
  skuShape: NodeShape,
  ids: string[],
  x: number,
): void {
  const shapes = ids
    .map(id => editor.getShape(id as TLShapeId))
    .filter((s): s is NodeShape => !!s && editor.isShapeOfType(s, 'node'))
  if (shapes.length === 0) return

  const heights = shapes.map(s => editor.getShapePageBounds(s.id)?.h ?? 0)
  const total = heights.reduce((a, b) => a + b, 0) + RESULT_STACK_GAP * (shapes.length - 1)

  const skuBounds = editor.getShapePageBounds(skuShape.id)
  const skuCentreY = skuBounds ? skuBounds.y + skuBounds.h / 2 : STATION_ORIGIN.y
  // Never start above the station origin: a tall stack should grow downward
  // rather than push the group off the top of the page.
  const startY = Math.max(STATION_ORIGIN.y, skuCentreY - total / 2)

  placeStack(editor, shapes, x, startY)
}

/** Lay `shapes` out top-to-bottom at `x`, starting at `startY`, RESULT_STACK_GAP apart. */
function placeStack(editor: Editor, shapes: NodeShape[], x: number, startY: number): void {
  let y = startY
  for (const shape of shapes) {
    editor.updateShape({ id: shape.id, type: shape.type, x, y })
    // Height is read *after* the move so it reflects the shape's current props
    // (an expanded card is taller than the compact one it replaced).
    y += (editor.getShapePageBounds(shape.id)?.h ?? 0) + RESULT_STACK_GAP
  }
}

/** All listing_result shapes, ad card excluded. */
function platformResultShapes(editor: Editor): NodeShape[] {
  return editor.getCurrentPageShapes().filter((s): s is NodeShape => {
    if (!editor.isShapeOfType(s, 'node')) return false
    const n = (s as NodeShape).props.node
    return n.type === 'listing_result' && n.platform !== 'ad'
  })
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

/** Fill in the optional compliance fields so every persisted check matches the
 * strict ListingResultNode validator. */
function normalizeChecks(checks: CheckItem[]): StoredCheckItem[] {
  return (checks ?? []).map(c => ({
    id: c.id,
    label: c.label,
    state: c.state,
    detail: c.detail,
    suggestion: c.suggestion ?? '',
    blocking: c.blocking ?? false,
    evidence: c.evidence ?? [],
  }))
}

function draftToResult(draft: PlatformDraft, mode: AssetMode): ListingResultNode {
  return {
    type: 'listing_result',
    platform: draft.id,
    name: draft.name,
    role: draft.role,
    title: draft.title,
    fields: draft.fields.map(f => ({ label: f.label, value: f.value })),
    imageUrl: draft.imageUrl || resultImageUrl(draft.id, mode),
    imageLabel: draft.imageLabel,
    checks: normalizeChecks(draft.checks),
    script: [],
    note: '',
    suggestedTitle: draft.suggestedTitle ?? '',
    artifactId: draft.id,
    policyVersion: draft.policyVersion ?? '',
    factRefs: draft.titleFactRefs ?? [],
    fieldMeta: draft.fields.map((f, i) => ({
      name: f.field || `field-${i + 1}`,
      factRefs: f.factRefs ?? [],
    })),
    migrationStatus: 'current',
    staleReason: '',
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
    checks: normalizeChecks([
      {
        id: 'ad',
        label: '投放条',
        state: 'ad-only',
        detail: AD_CUT.note,
      },
    ]),
    script: AD_CUT.script,
    note: AD_CUT.note,
    suggestedTitle: '',
    artifactId: 'ad',
    policyVersion: '',
    factRefs: [],
    fieldMeta: [],
    migrationStatus: 'current',
    staleReason: '',
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

    // Vertical fan-out: the SKU compiler stays on the left and the platform
    // cards stack on the right, all sharing one X. Compact cards have a fixed
    // height, so the stack is short enough to read without zooming out — a
    // single wide row forced the auto-frame to shrink everything.
    for (const draft of resolved) {
      const id = spawnConnectedNode({
        editor,
        sourceShapeId: live.id,
        sourcePortId: `output_${draft.id}`,
        dataType: 'text',
        nodeProps: draftToResult(draft, node.assetMode),
        inputPortTarget: { x: startX, y: STATION_ORIGIN.y + 20 },
      })
      ids.push(id)
    }
    layoutResultStack(editor, live, ids, startX)

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
  // Frame the whole station (SKU on the left + the result stack on the right).
  // Framing the results alone used to push the SKU off-screen and, with a wide
  // row of cards, zoomed far enough out that the copy stopped being readable.
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

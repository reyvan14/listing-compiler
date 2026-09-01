import { GENERATE_STEPS } from '@/station/data'
import { announceListingSource, fetchListingDrafts } from '@/station/listingApi'
import { T, useEditor, useValue } from 'tldraw'
import { NODE_HEADER_HEIGHT_PX } from '../../constants'
import { executionState, startExecution, stopExecution } from '../../execution/executionState'
import { ShapePort } from '../../ports/Port'
import { NodeShape } from '../NodeShapeUtil'
import {
  defaultSkuNode,
  fillSkuDemo,
  LANES,
  selectedPlatforms,
  SKU_NODE_WIDTH,
  skuBodyHeightPx,
  skuPointsRows,
  spawnPlatformResults,
  type SkuListingNode,
} from './skuStation'
import styles from './skuStation.module.scss'
import {
  ExecutionResult,
  InfoValues,
  NodeComponentProps,
  NodeDefinition,
  updateNode,
} from './shared'

export type { SkuListingNode }
export const SkuListingNode = T.object({
  type: T.literal('sku_listing'),
  productName: T.string,
  points: T.string,
  amazon: T.boolean,
  tiktok: T.boolean,
  shopify: T.boolean,
  uploads: T.arrayOf(T.string),
  assetMode: T.literalEnum('compliant', 'promo'),
  spawnedIds: T.arrayOf(T.string),
  adSpawnedId: T.string.nullable(),
  stepIndex: T.number,
})

function GoldMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="3" y="3" width="10" height="10" rx="2" fill="#ffc249" />
    </svg>
  )
}

export class SkuListingNodeDefinition extends NodeDefinition<SkuListingNode> {
  static type = 'sku_listing'
  static validator = SkuListingNode
  title = '上架编译器'
  heading = '上架编译器'
  icon = <GoldMark />
  category = 'utility'
  hidden = true
  override showFooter = false

  getDefault(): SkuListingNode {
    return defaultSkuNode()
  }

  override getWidthPx() {
    return SKU_NODE_WIDTH
  }

  getBodyHeightPx(_shape: NodeShape, node: SkuListingNode) {
    return skuBodyHeightPx(node)
  }

  getPorts(_shape: NodeShape, node: SkuListingNode): Record<string, ShapePort> {
    const platforms = selectedPlatforms(node)
    const body = skuBodyHeightPx(node)
    const ports: Record<string, ShapePort> = {}
    platforms.forEach((id, i) => {
      const t = (i + 0.5) / Math.max(platforms.length, 1)
      ports[`output_${id}`] = {
        id: `output_${id}`,
        x: SKU_NODE_WIDTH,
        y: NODE_HEADER_HEIGHT_PX + t * body,
        terminal: 'start',
        dataType: 'text',
      }
    })
    ports.output = {
      id: 'output',
      x: SKU_NODE_WIDTH,
      y: NODE_HEADER_HEIGHT_PX + body - 8,
      terminal: 'start',
      dataType: 'text',
    }
    return ports
  }

  async execute(shape: NodeShape, node: SkuListingNode): Promise<ExecutionResult> {
    fillSkuDemo(this.editor, shape)
    const filled = (this.editor.getShape(shape.id) as NodeShape | undefined) ?? shape
    const sku = filled.props.node as SkuListingNode
    const pending = fetchListingDrafts({
      productName: sku.productName,
      points: sku.points,
      platforms: selectedPlatforms(sku),
      assetMode: sku.assetMode,
      uploads: sku.uploads,
    })
    let stepIndex = 0
    updateNode<SkuListingNode>(this.editor, shape, n => ({ ...n, stepIndex: 0 }), false)
    const tick = window.setInterval(() => {
      stepIndex = Math.min(stepIndex + 1, GENERATE_STEPS.length - 1)
      updateNode<SkuListingNode>(this.editor, shape, n => ({ ...n, stepIndex }), false)
    }, 1800)
    try {
      const { drafts, source } = await pending
      spawnPlatformResults(this.editor, shape, drafts)
      announceListingSource(source)
    } finally {
      window.clearInterval(tick)
    }
    const live = (this.editor.getShape(shape.id) as NodeShape | undefined) ?? shape
    const current = live.props.node as SkuListingNode
    const name = current.productName || node.productName
    const result: ExecutionResult = { output: name }
    for (const id of selectedPlatforms(current)) result[`output_${id}`] = name
    return result
  }

  getOutputInfo(shape: NodeShape, node: SkuListingNode): InfoValues {
    const info: InfoValues = {
      output: {
        value: '',
        isOutOfDate: shape.props.isOutOfDate,
        dataType: 'text',
      },
    }
    for (const id of selectedPlatforms(node)) {
      info[`output_${id}`] = {
        value: node.productName,
        isOutOfDate: shape.props.isOutOfDate,
        dataType: 'text',
      }
    }
    return info
  }

  Component = SkuListingNodeComponent
}

function keepOnControl(e: { stopPropagation: () => void }) {
  e.stopPropagation()
}

function SkuListingNodeComponent({ shape, node }: NodeComponentProps<SkuListingNode>) {
  const editor = useEditor()
  const isExecuting = useValue(
    'sku executing',
    () => executionState.get(editor).runningGraph?.getNodeStatus(shape.id) === 'executing',
    [editor, shape.id],
  )
  const isGraphRunning = useValue(
    'sku graph',
    () => executionState.get(editor).runningGraph !== null,
    [editor],
  )

  const patch = (update: Partial<SkuListingNode>) =>
    updateNode<SkuListingNode>(editor, shape, n => ({ ...n, ...update }), false)

  const onFiles = (files: FileList | null) => {
    if (!files?.length) return
    const next = [...node.uploads]
    Array.from(files)
      .slice(0, 3 - next.length)
      .forEach(file => {
        const reader = new FileReader()
        reader.onload = () => {
          if (typeof reader.result === 'string') {
            next.push(reader.result)
            patch({ uploads: [...next] })
          }
        }
        reader.readAsDataURL(file)
      })
  }

  const generate = () => {
    if (isGraphRunning) {
      stopExecution(editor)
      return
    }
    if (selectedPlatforms(node).length === 0) return
    fillSkuDemo(editor, shape)
    startExecution(editor, new Set([shape.id]))
  }

  const pointRows = skuPointsRows(node)

  return (
    <div className={styles.body}>
      <p className={styles.role}>SKU 输入 · 点一下，三台按节点长出来</p>
      <label className={styles.drop} htmlFor={`sku-files-${shape.id}`} onPointerDown={keepOnControl}>
        <input
          id={`sku-files-${shape.id}`}
          type="file"
          accept="image/*"
          multiple
          disabled={isExecuting}
          onChange={e => onFiles(e.target.files)}
        />
        {node.uploads.length === 0 ? (
          <span>
            上传产品图
            <small>演示：折叠硅胶水杯 350ml</small>
          </span>
        ) : (
          <span className={styles.thumbs}>
            {node.uploads.map((src, i) => (
              <img key={src + i} src={src} alt={`产品图 ${i + 1}`} />
            ))}
          </span>
        )}
      </label>
      <label className={styles.field} onPointerDown={keepOnControl}>
        品名
        <input
          value={node.productName}
          disabled={isExecuting}
          placeholder="折叠硅胶水杯 350ml"
          onChange={e => patch({ productName: e.target.value })}
          onFocus={() => editor.setSelectedShapes([shape.id])}
        />
      </label>
      <label className={styles.field} onPointerDown={keepOnControl}>
        卖点
        <textarea
          rows={pointRows}
          value={node.points}
          disabled={isExecuting}
          placeholder={'折叠到 4cm\n食品级硅胶\n防漏盖 350ml\nBPA-Free'}
          onChange={e => patch({ points: e.target.value })}
          onFocus={() => editor.setSelectedShapes([shape.id])}
          onWheel={e => e.stopPropagation()}
        />
      </label>
      <div className={styles.chips}>
        {LANES.map(lane => (
          <label key={lane.id} className={styles.chip} onPointerDown={keepOnControl}>
            <input
              type="checkbox"
              checked={node[lane.id]}
              disabled={isExecuting}
              onChange={e => patch({ [lane.id]: e.target.checked })}
            />
            {lane.name}
          </label>
        ))}
      </div>
      <p className={styles.stepNow}>
        {isExecuting
          ? GENERATE_STEPS[node.stepIndex]
          : node.assetMode === 'promo'
            ? '带字竖版不能当 Amazon / TikTok Shop 商品主图。'
            : '\u00a0'}
      </p>
      <div className={styles.actions} onPointerDown={keepOnControl}>
        <button
          type="button"
          className={styles.btnGhost}
          id="station-fill"
          disabled={isExecuting}
          onClick={() => fillSkuDemo(editor, shape)}
        >
          填入演示
        </button>
        <button
          type="button"
          className={styles.btnPrimary}
          id="station-generate"
          disabled={isExecuting && !isGraphRunning}
          onClick={generate}
        >
          {isExecuting ? '生成中…' : '生成'}
        </button>
      </div>
    </div>
  )
}

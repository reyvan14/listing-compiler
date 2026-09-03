import { useEffect, useRef, useState } from 'react'
import { ApiError, toSafeMessage } from '@/station/apiClient'
import { useImageLightbox } from '@/components/useImageLightbox'
import { buildSkuArtifacts } from '@/station/skuArtifacts'
import {
  announceListingSource,
  fetchListingDrafts,
  localSampleDrafts,
} from '@/station/listingApi'
import {
  fieldError,
  firstInvalidField,
  validateSkuForm,
  type SkuFieldError,
} from '@/station/skuValidation'
import { T, useEditor, useValue } from 'tldraw'
import { NODE_HEADER_HEIGHT_PX } from '../../constants'
import { executionState, startExecution, stopExecution } from '../../execution/executionState'
import { ShapePort } from '../../ports/Port'
import { NodeShape } from '../NodeShapeUtil'
import {
  defaultSkuNode,
  fillSkuDemo,
  focusSkuInput,
  LANES,
  selectedPlatforms,
  SKU_NODE_WIDTH,
  skuBodyHeightPx,
  skuPointsRows,
  skuRunStatusText,
  spawnPlatformResults,
} from './skuStation'
import styles from './skuStation.module.scss'
import {
  ExecutionResult,
  InfoValues,
  InputValues,
  NodeComponentProps,
  NodeDefinition,
  updateNode,
} from './shared'

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
  // safe Chinese message from the last run that could not reach / use the backend
  lastError: T.string,
  // Downstream artifact package from the last successful run: a textual video
  // brief assembled from the generated drafts, plus the SKU's real images.
  // Consumed by a connected 视频生成 node (see videoInputs.ts).
  videoBrief: T.string,
  imageAssets: T.arrayOf(T.string),
})
// Structurally identical to the hand-written type in ./skuStation; derived here
// from the validator so the shape and its schema can't drift.
export type SkuListingNode = T.TypeOf<typeof SkuListingNode>

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

  async execute(
    shape: NodeShape,
    node: SkuListingNode,
    _inputs: InputValues,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    // No demo data is injected here. The component validates the form before
    // it ever calls startExecution, so the values below are the user's own.
    updateNode<SkuListingNode>(this.editor, shape, n => ({ ...n, lastError: '' }), false)
    const live0 = (this.editor.getShape(shape.id) as NodeShape | undefined) ?? shape
    const sku = live0.props.node as SkuListingNode

    // No phase ticker: the backend reports no stage progress, so the node only
    // shows the real elapsed time and that it is waiting for the model.
    try {
      const { drafts, source } = await fetchListingDrafts(
        {
          productName: sku.productName,
          points: sku.points,
          platforms: selectedPlatforms(sku),
          assetMode: sku.assetMode,
          uploads: sku.uploads,
        },
        { timeoutMs: 60_000, signal },
      )
      // A cancelled or superseded run must never create cards or move the badge.
      if (signal?.aborted) return { output: '' }
      spawnPlatformResults(this.editor, shape, drafts)
      announceListingSource(source)
      // Persist the downstream artifact package for connected media nodes.
      const artifacts = buildSkuArtifacts({
        productName: sku.productName,
        points: sku.points,
        uploads: sku.uploads,
        drafts,
      })
      updateNode<SkuListingNode>(
        this.editor,
        shape,
        n => ({ ...n, videoBrief: artifacts.brief, imageAssets: artifacts.images }),
        false,
      )
    } catch (err) {
      const cancelled =
        signal?.aborted || (err instanceof ApiError && err.category === 'aborted')
      if (!cancelled) {
        // Do not spawn results, do not mutate the form. Surface a safe message;
        // the component then offers Retry / Use-local-sample.
        updateNode<SkuListingNode>(
          this.editor,
          shape,
          n => ({ ...n, lastError: toSafeMessage(err) }),
          false,
        )
      }
    }

    const live = (this.editor.getShape(shape.id) as NodeShape | undefined) ?? shape
    const current = live.props.node as SkuListingNode
    const name = current.productName || node.productName
    // The generic output carries the generated brief so downstream text
    // consumers get the real artifact, not just the product name.
    const result: ExecutionResult = { output: current.videoBrief || name }
    for (const id of selectedPlatforms(current)) result[`output_${id}`] = name
    return result
  }

  getOutputInfo(shape: NodeShape, node: SkuListingNode): InfoValues {
    const info: InfoValues = {
      output: {
        value: node.videoBrief || node.productName,
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

  const uploadLightbox = useImageLightbox()
  const [zoomed, setZoomed] = useState('')
  const [errors, setErrors] = useState<SkuFieldError[]>([])
  const [elapsed, setElapsed] = useState(0)
  const nameRef = useRef<HTMLInputElement>(null)
  const pointsRef = useRef<HTMLTextAreaElement>(null)
  const chipsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isExecuting) {
      setElapsed(0)
      return
    }
    setElapsed(0)
    const started = Date.now()
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => window.clearInterval(id)
  }, [isExecuting])

  // When a run error appears the node grows; make sure the recovery actions
  // (Retry / Use-local-sample) are brought fully into view.
  useEffect(() => {
    if (node.lastError) requestAnimationFrame(() => focusSkuInput(editor))
  }, [node.lastError, editor])

  const patch = (update: Partial<SkuListingNode>) =>
    updateNode<SkuListingNode>(editor, shape, n => ({ ...n, ...update }), false)

  const clearFieldError = (field: SkuFieldError['field']) =>
    setErrors(prev => (prev.some(e => e.field === field) ? prev.filter(e => e.field !== field) : prev))

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

  const focusField = (field: SkuFieldError['field'] | null) => {
    if (field === 'productName') nameRef.current?.focus()
    else if (field === 'points') pointsRef.current?.focus()
    else if (field === 'platforms') chipsRef.current?.querySelector('input')?.focus()
  }

  const generate = () => {
    if (isGraphRunning) {
      stopExecution(editor)
      return
    }
    const found = validateSkuForm({
      productName: node.productName,
      points: node.points,
      platforms: selectedPlatforms(node),
    })
    if (found.length > 0) {
      setErrors(found)
      focusField(firstInvalidField(found))
      return // never mutate the form on invalid submit
    }
    setErrors([])
    patch({ lastError: '' })
    startExecution(editor, new Set([shape.id]))
  }

  const retry = () => {
    patch({ lastError: '' })
    startExecution(editor, new Set([shape.id]))
  }

  const useLocalSample = () => {
    const { drafts, source } = localSampleDrafts({
      productName: node.productName,
      points: node.points,
      platforms: selectedPlatforms(node),
      assetMode: node.assetMode,
      uploads: node.uploads,
    })
    spawnPlatformResults(editor, shape, drafts)
    announceListingSource(source)
    // Downstream media nodes read the same artifact package either way; here it
    // is assembled from the local sample drafts the user explicitly asked for.
    const artifacts = buildSkuArtifacts({
      productName: node.productName,
      points: node.points,
      uploads: node.uploads,
      drafts,
    })
    patch({ lastError: '', videoBrief: artifacts.brief, imageAssets: artifacts.images })
  }

  const pointRows = skuPointsRows(node)
  const nameErr = fieldError(errors, 'productName')
  const pointsErr = fieldError(errors, 'points')
  const platformsErr = fieldError(errors, 'platforms')

  return (
    <div className={styles.body}>
      <p className={styles.role}>SKU 输入 · 填好品名、卖点、平台后点「生成」</p>
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
            上传产品图（可选）
            <small>不影响文字草稿生成</small>
          </span>
        ) : (
          <span className={styles.thumbs}>
            {node.uploads.map((src, i) => (
              // Double-click opens the original. The thumbnails are too small
              // for a labelled button, and the surrounding <label> would
              // otherwise open the file picker, so the click is swallowed.
              <img
                key={src + i}
                src={src}
                alt={`产品图 ${i + 1}`}
                title="双击查看原图"
                style={{ cursor: 'zoom-in' }}
                onPointerDown={keepOnControl}
                onDoubleClick={event => {
                  event.stopPropagation()
                  event.preventDefault()
                  setZoomed(src)
                  uploadLightbox.openLightbox(event.currentTarget as unknown as HTMLElement)
                }}
              />
            ))}
          </span>
        )}
      </label>
      <label className={styles.field} onPointerDown={keepOnControl}>
        品名
        <input
          ref={nameRef}
          value={node.productName}
          disabled={isExecuting}
          placeholder="折叠硅胶水杯 350ml"
          aria-invalid={nameErr ? true : undefined}
          onChange={e => {
            patch({ productName: e.target.value })
            clearFieldError('productName')
          }}
          onFocus={() => editor.setSelectedShapes([shape.id])}
        />
        {nameErr && <span className={styles.fieldError}>{nameErr}</span>}
      </label>
      <label className={styles.field} onPointerDown={keepOnControl}>
        卖点
        <textarea
          ref={pointsRef}
          rows={pointRows}
          value={node.points}
          disabled={isExecuting}
          placeholder={'折叠到 4cm\n食品级硅胶\n防漏盖 350ml\nBPA-Free'}
          aria-invalid={pointsErr ? true : undefined}
          onChange={e => {
            patch({ points: e.target.value })
            clearFieldError('points')
          }}
          onFocus={() => editor.setSelectedShapes([shape.id])}
          onWheel={e => e.stopPropagation()}
        />
        {pointsErr && <span className={styles.fieldError}>{pointsErr}</span>}
      </label>
      <div className={styles.chips} ref={chipsRef}>
        {LANES.map(lane => (
          <label key={lane.id} className={styles.chip} onPointerDown={keepOnControl}>
            <input
              type="checkbox"
              checked={node[lane.id]}
              disabled={isExecuting}
              onChange={e => {
                patch({ [lane.id]: e.target.checked })
                clearFieldError('platforms')
              }}
            />
            {lane.name}
          </label>
        ))}
      </div>
      {platformsErr && <span className={styles.fieldError}>{platformsErr}</span>}

      <p className={styles.stepNow}>
        {isExecuting
          ? skuRunStatusText(elapsed)
          : node.assetMode === 'promo'
            ? '带字竖版不能当 Amazon / TikTok Shop 商品主图。'
            : ' '}
      </p>

      {!isExecuting && node.lastError && (
        <div className={styles.runError} role="alert" onPointerDown={keepOnControl}>
          <p>{node.lastError}</p>
          <div className={styles.runErrorActions}>
            <button type="button" className={styles.btnPrimary} id="station-retry" onClick={retry}>
              重试
            </button>
            <button
              type="button"
              className={styles.btnGhost}
              id="station-use-local-sample"
              onClick={useLocalSample}
            >
              使用本地示例数据
            </button>
          </div>
        </div>
      )}

      {uploadLightbox.render(zoomed, '产品图原图', '上传的产品图原图')}

      <div className={styles.actions} onPointerDown={keepOnControl}>
        <button
          type="button"
          className={styles.btnGhost}
          id="station-fill"
          disabled={isExecuting}
          onClick={() => {
            fillSkuDemo(editor, shape)
            setErrors([])
          }}
        >
          填入演示
        </button>
        <button
          type="button"
          className={styles.btnPrimary}
          id="station-generate"
          onClick={generate}
        >
          {isExecuting ? '取消' : '生成'}
        </button>
      </div>
    </div>
  )
}

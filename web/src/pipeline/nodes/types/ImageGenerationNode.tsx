import { fetchMediaImage } from '@/station/mediaApi'
import { toSafeMessage } from '@/station/apiClient'
import { T, useEditor, useValue } from 'tldraw'
import { ImageGenerateIcon } from '../../components/icons/ImageGenerateIcon'
import { executionState, startExecution, stopExecution } from '../../execution/executionState'
import { classifyPortInputs } from '../nodePorts'
import { ShapePort } from '../../ports/Port'
import { NodeShape } from '../NodeShapeUtil'
import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_NODE_WIDTH_PX,
  defaultImageNode,
  imageBodyHeightPx,
  mediaSidePortY,
  RESULT_NODE_WIDTH_PX,
} from './mediaStation'
import form from './mediaForm.module.scss'
import {
  areAnyInputsOutOfDate,
  ExecutionResult,
  InfoValues,
  NodeComponentProps,
  NodeDefinition,
  updateNode,
} from './shared'

export type ImageGenerationNode = T.TypeOf<typeof ImageGenerationNode>
export const ImageGenerationNode = T.object({
  type: T.literal('image_generation'),
  mode: T.string,
  model: T.string,
  imageType: T.string,
  aspectRatio: T.string,
  resolution: T.string,
  count: T.number,
  prompt: T.string,
  referenceImages: T.arrayOf(T.string),
  lastResult: T.string.nullable(),
  imageUrls: T.arrayOf(T.string),
  spawnedNodeIds: T.arrayOf(T.string),
  text2imgDone: T.boolean,
  isResultNode: T.boolean,
  name: T.string,
})

function keepOnControl(e: { stopPropagation: () => void }) {
  e.stopPropagation()
}

export class ImageGenerationNodeDefinition extends NodeDefinition<ImageGenerationNode> {
  static type = 'image_generation'
  static validator = ImageGenerationNode
  title = '图片生成'
  heading = '图片生成'
  icon = <ImageGenerateIcon />
  category = 'process'
  override resultKeys = ['lastResult'] as const
  override showFooter = false

  getHeading(node: ImageGenerationNode) {
    return node.name || this.heading || this.title
  }

  getDefault(): ImageGenerationNode {
    return defaultImageNode()
  }

  override getWidthPx(_shape: NodeShape, node: ImageGenerationNode) {
    return node.isResultNode ? RESULT_NODE_WIDTH_PX : IMAGE_NODE_WIDTH_PX
  }

  getBodyHeightPx(_shape: NodeShape, node: ImageGenerationNode) {
    return imageBodyHeightPx(node)
  }

  getPorts(_shape: NodeShape, node: ImageGenerationNode): Record<string, ShapePort> {
    const width = node.isResultNode ? RESULT_NODE_WIDTH_PX : IMAGE_NODE_WIDTH_PX
    const midY = mediaSidePortY(imageBodyHeightPx(node))
    return {
      input: {
        id: 'input',
        x: 0,
        y: midY,
        terminal: 'end',
        dataType: node.isResultNode ? 'image' : 'any',
        multi: !node.isResultNode,
      },
      output: { id: 'output', x: width, y: midY, terminal: 'start', dataType: 'image' },
    }
  }

  async execute(shape: NodeShape, node: ImageGenerationNode): Promise<ExecutionResult> {
    const portInputs = classifyPortInputs(this.editor, shape, 'input')
    const prompt = (portInputs.texts[0] || node.prompt || '').trim()
    if (!prompt) {
      updateNode<ImageGenerationNode>(this.editor, shape, n => ({
        ...n,
        lastResult: '请先填写提示词',
      }))
      return { output: null }
    }
    try {
      const { url } = await fetchMediaImage({
        prompt,
        aspectRatio: node.aspectRatio,
        resolution: node.resolution,
      })
      updateNode<ImageGenerationNode>(this.editor, shape, n => ({
        ...n,
        imageUrls: [url],
        lastResult: '已生成 1 张图片',
        text2imgDone: true,
      }))
      return { output: url }
    } catch (err) {
      updateNode<ImageGenerationNode>(this.editor, shape, n => ({
        ...n,
        imageUrls: [],
        lastResult: toSafeMessage(err),
      }))
      return { output: null }
    }
  }

  getOutputInfo(shape: NodeShape, node: ImageGenerationNode, inputs: InfoValues): InfoValues {
    return {
      output: {
        value: node.imageUrls?.[0] ?? null,
        isOutOfDate: areAnyInputsOutOfDate(inputs) || shape.props.isOutOfDate,
        dataType: 'image',
      },
    }
  }

  Component = ImageGenerationNodeComponent
}

function ImagePlaceholderIcon() {
  return (
    <svg width="60" height="60" viewBox="0 0 60 60" fill="none" opacity="0.6">
      <rect x="6" y="12" width="48" height="36" rx="4" stroke="#A8A49B" strokeWidth="2" />
      <circle cx="20" cy="24" r="4" fill="#A8A49B" />
      <path d="M10 44l14-14 10 10 8-8 8 8" stroke="#A8A49B" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  )
}

function ImageGenerationNodeComponent({ shape, node }: NodeComponentProps<ImageGenerationNode>) {
  const editor = useEditor()
  const isExecuting = useValue(
    'image executing',
    () => executionState.get(editor).runningGraph?.getNodeStatus(shape.id) === 'executing',
    [editor, shape.id],
  )
  const isGraphRunning = useValue(
    'image graph',
    () => executionState.get(editor).runningGraph !== null,
    [editor],
  )

  const patch = (update: Partial<ImageGenerationNode>) =>
    updateNode<ImageGenerationNode>(editor, shape, n => ({ ...n, ...update }), false)

  const preview = node.imageUrls[0]
  const generate = () => {
    if (isGraphRunning) {
      stopExecution(editor)
      return
    }
    startExecution(editor, new Set([shape.id]))
  }

  return (
    <div className="ImageGenNode">
      <div className="ImageGenNode-imageBox">
        {preview ? (
          <img className="ImageGenNode-image" src={preview} alt="generated" />
        ) : isExecuting ? (
          <div className="ImageGenNode-status">生成中…</div>
        ) : node.lastResult ? (
          <div className="ImageGenNode-status">{node.lastResult}</div>
        ) : (
          <ImagePlaceholderIcon />
        )}
      </div>
      {!node.isResultNode && (
        <div className={form.form} onPointerDown={keepOnControl}>
          <textarea
            className={form.prompt}
            value={node.prompt}
            disabled={isExecuting}
            maxLength={2000}
            placeholder="描述你想生成的画面，例如：一只折叠硅胶水杯放在白桌上。"
            onChange={e => patch({ prompt: e.target.value.slice(0, 2000) })}
            onFocus={() => editor.setSelectedShapes([shape.id])}
            onWheel={e => e.stopPropagation()}
          />
          <div className={form.row}>
            <div className={form.pills}>
              {IMAGE_ASPECT_RATIOS.map(ratio => (
                <button
                  key={ratio}
                  type="button"
                  className={`${form.pill}${node.aspectRatio === ratio ? ` ${form.pillActive}` : ''}`}
                  disabled={isExecuting}
                  onClick={() => patch({ aspectRatio: ratio })}
                >
                  {ratio}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={form.run}
              disabled={isExecuting && !isGraphRunning}
              onClick={generate}
            >
              {isExecuting ? '停止' : '生成'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

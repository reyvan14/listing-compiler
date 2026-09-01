import { fetchMediaVideo } from '@/station/mediaApi'
import { toSafeMessage } from '@/station/apiClient'
import { T, useEditor, useValue } from 'tldraw'
import { VideoGenerateIcon } from '../../components/icons/VideoGenerateIcon'
import { executionState, startExecution, stopExecution } from '../../execution/executionState'
import { classifyPortInputs } from '../nodePorts'
import { ShapePort } from '../../ports/Port'
import { NodeShape } from '../NodeShapeUtil'
import {
  defaultVideoNode,
  mediaSidePortY,
  resultBoxSizePx,
  VIDEO_ASPECT_RATIOS,
  VIDEO_NODE_WIDTH_PX,
  videoBodyHeightPx,
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

const VideoCropRect = T.object({
  x: T.number,
  y: T.number,
  w: T.number,
  h: T.number,
})

export type VideoGenerationNode = T.TypeOf<typeof VideoGenerationNode>
export const VideoGenerationNode = T.object({
  type: T.literal('video_generation'),
  mode: T.string,
  model: T.string,
  videoType: T.string,
  platform: T.string,
  aspectRatio: T.string,
  duration: T.string,
  resolution: T.string,
  audio: T.boolean,
  cameraMode: T.string,
  count: T.number,
  prompt: T.string,
  referenceImages: T.arrayOf(T.string),
  referenceVideos: T.arrayOf(T.string),
  referenceAudios: T.arrayOf(T.string),
  firstFrameUrl: T.string.nullable(),
  lastFrameUrl: T.string.nullable(),
  referenceVideoUrl: T.string.nullable(),
  lastResult: T.string.nullable(),
  videoUrls: T.arrayOf(T.string),
  posterUrls: T.arrayOf(T.string),
  isResultNode: T.boolean,
  crop: VideoCropRect.nullable(),
})

function keepOnControl(e: { stopPropagation: () => void }) {
  e.stopPropagation()
}

export class VideoGenerationNodeDefinition extends NodeDefinition<VideoGenerationNode> {
  static type = 'video_generation'
  static validator = VideoGenerationNode
  title = '视频生成'
  heading = '视频生成'
  icon = <VideoGenerateIcon />
  category = 'process'
  override resultKeys = ['lastResult'] as const
  override showFooter = false

  getDefault(): VideoGenerationNode {
    return defaultVideoNode()
  }

  override getWidthPx(_shape: NodeShape, node: VideoGenerationNode) {
    return node.isResultNode ? resultBoxSizePx(node.aspectRatio).w : VIDEO_NODE_WIDTH_PX
  }

  getBodyHeightPx(_shape: NodeShape, node: VideoGenerationNode) {
    return videoBodyHeightPx(node)
  }

  getPorts(_shape: NodeShape, node: VideoGenerationNode): Record<string, ShapePort> {
    const width = node.isResultNode ? resultBoxSizePx(node.aspectRatio).w : VIDEO_NODE_WIDTH_PX
    const midY = node.isResultNode
      ? videoBodyHeightPx(node) / 2
      : mediaSidePortY(videoBodyHeightPx(node))
    return {
      input: {
        id: 'input',
        x: 0,
        y: midY,
        terminal: 'end',
        dataType: node.isResultNode ? 'video' : 'any',
        multi: !node.isResultNode,
      },
      output: { id: 'output', x: width, y: midY, terminal: 'start', dataType: 'video' },
    }
  }

  async execute(shape: NodeShape, node: VideoGenerationNode): Promise<ExecutionResult> {
    const portInputs = classifyPortInputs(this.editor, shape, 'input')
    const prompt = (portInputs.texts[0] || node.prompt || '').trim()
    if (!prompt) {
      updateNode<VideoGenerationNode>(this.editor, shape, n => ({
        ...n,
        lastResult: '请先填写提示词',
      }))
      return { output: null }
    }
    try {
      const { url, poster } = await fetchMediaVideo({
        prompt,
        aspectRatio: node.aspectRatio,
        duration: node.duration,
        resolution: node.resolution,
      })
      updateNode<VideoGenerationNode>(this.editor, shape, n => ({
        ...n,
        videoUrls: [url],
        posterUrls: poster ? [poster] : [],
        lastResult: '已生成 1 条视频',
      }))
      return { output: url }
    } catch (err) {
      updateNode<VideoGenerationNode>(this.editor, shape, n => ({
        ...n,
        videoUrls: [],
        posterUrls: [],
        lastResult: toSafeMessage(err),
      }))
      return { output: null }
    }
  }

  getOutputInfo(shape: NodeShape, node: VideoGenerationNode, inputs: InfoValues): InfoValues {
    return {
      output: {
        value: node.videoUrls?.[0] ?? null,
        isOutOfDate: areAnyInputsOutOfDate(inputs) || shape.props.isOutOfDate,
        dataType: 'video',
      },
    }
  }

  Component = VideoGenerationNodeComponent
}

function VideoPlaceholderIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" opacity="0.6">
      <circle cx="24" cy="24" r="18" stroke="#A8A49B" strokeWidth="2" />
      <path d="M20 16l12 8-12 8V16z" fill="#A8A49B" />
    </svg>
  )
}

function VideoGenerationNodeComponent({ shape, node }: NodeComponentProps<VideoGenerationNode>) {
  const editor = useEditor()
  const isExecuting = useValue(
    'video executing',
    () => executionState.get(editor).runningGraph?.getNodeStatus(shape.id) === 'executing',
    [editor, shape.id],
  )
  const isGraphRunning = useValue(
    'video graph',
    () => executionState.get(editor).runningGraph !== null,
    [editor],
  )

  const patch = (update: Partial<VideoGenerationNode>) =>
    updateNode<VideoGenerationNode>(editor, shape, n => ({ ...n, ...update }), false)

  const preview = node.videoUrls[0]
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
          <video
            className="ImageGenNode-image"
            src={preview}
            poster={node.posterUrls[0] || undefined}
            controls
            playsInline
            onPointerDown={keepOnControl}
          />
        ) : isExecuting ? (
          <div className="ImageGenNode-status">生成中…</div>
        ) : node.lastResult ? (
          <div className="ImageGenNode-status">{node.lastResult}</div>
        ) : (
          <VideoPlaceholderIcon />
        )}
      </div>
      {!node.isResultNode && (
        <div className={form.form} onPointerDown={keepOnControl}>
          <textarea
            className={form.prompt}
            value={node.prompt}
            disabled={isExecuting}
            maxLength={2000}
            placeholder="描述你想生成的镜头，例如：水杯从桌面展开，阳光扫过杯身。"
            onChange={e => patch({ prompt: e.target.value.slice(0, 2000) })}
            onFocus={() => editor.setSelectedShapes([shape.id])}
            onWheel={e => e.stopPropagation()}
          />
          <div className={form.row}>
            <div className={form.pills}>
              {VIDEO_ASPECT_RATIOS.map(ratio => (
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

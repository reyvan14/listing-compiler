import { useState } from 'react'
import { T } from 'tldraw'
import { NODE_HEADER_HEIGHT_PX } from '../../constants'
import { Port, ShapePort } from '../../ports/Port'
import { NodeShape } from '../NodeShapeUtil'
import {
  AD_NODE_WIDTH,
  downloadAdCut,
  RESULT_NODE_WIDTH,
  resultBodyHeightPx,
  STAMP,
  worstCheck,
  worstCheckItem,
} from './skuStation'
import styles from './skuStation.module.scss'
import {
  ExecutionResult,
  InfoValues,
  NodeComponentProps,
  NodeDefinition,
} from './shared'

export const ListingResultNode = T.object({
  type: T.literal('listing_result'),
  platform: T.literalEnum('amazon', 'tiktok', 'shopify', 'ad'),
  name: T.string,
  role: T.string,
  title: T.string,
  fields: T.arrayOf(T.object({ label: T.string, value: T.string })),
  imageUrl: T.string,
  imageLabel: T.string,
  checks: T.arrayOf(
    T.object({
      id: T.string,
      label: T.string,
      state: T.literalEnum('pass', 'fix', 'ad-only'),
      detail: T.string,
    }),
  ),
  script: T.arrayOf(T.string),
  note: T.string,
})
// Structurally identical to the hand-written type in ./skuStation; derived here
// from the validator so the shape and its schema can't drift.
export type ListingResultNode = T.TypeOf<typeof ListingResultNode>

function GoldMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="3" y="3" width="10" height="10" rx="2" fill="#ffc249" />
    </svg>
  )
}

export class ListingResultNodeDefinition extends NodeDefinition<ListingResultNode> {
  static type = 'listing_result'
  static validator = ListingResultNode
  title = '上新草稿'
  heading = '上新草稿'
  icon = <GoldMark />
  category = 'utility'
  hidden = true
  override showFooter = false

  getHeading(node: ListingResultNode) {
    return node.name
  }

  getDefault(): ListingResultNode {
    return {
      type: 'listing_result',
      platform: 'amazon',
      name: 'Amazon',
      role: '货架',
      title: '',
      fields: [],
      imageUrl: '',
      imageLabel: '',
      checks: [],
      script: [],
      note: '',
    }
  }

  override getWidthPx(_shape: NodeShape, node: ListingResultNode) {
    return node.platform === 'ad' ? AD_NODE_WIDTH : RESULT_NODE_WIDTH
  }

  getBodyHeightPx(_shape: NodeShape, node: ListingResultNode) {
    return resultBodyHeightPx(node)
  }

  getPorts(_shape: NodeShape, _node: ListingResultNode): Record<string, ShapePort> {
    return {
      input: {
        id: 'input',
        x: 0,
        y: NODE_HEADER_HEIGHT_PX / 2,
        terminal: 'end',
        dataType: 'text',
      },
    }
  }

  async execute(_shape: NodeShape, node: ListingResultNode): Promise<ExecutionResult> {
    return { output: node.title }
  }

  getOutputInfo(shape: NodeShape, node: ListingResultNode): InfoValues {
    return {
      output: {
        value: '',
        isOutOfDate: shape.props.isOutOfDate,
        dataType: 'text',
      },
    }
  }

  Component = ListingResultNodeComponent
}

function keepOnControl(e: { stopPropagation: () => void }) {
  e.stopPropagation()
}

function ListingResultNodeComponent({ shape, node }: NodeComponentProps<ListingResultNode>) {
  const stamp = node.checks.length ? worstCheck(node.checks) : null
  const worst = worstCheckItem(node.checks)
  const hold =
    node.platform !== 'shopify' &&
    node.platform !== 'ad' &&
    node.checks.some(c => c.id === 'img' && c.state === 'fix')

  const [copied, setCopied] = useState<null | 'ok' | 'err'>(null)
  const copyTitle = async () => {
    try {
      await navigator.clipboard.writeText(node.title)
      setCopied('ok')
    } catch {
      setCopied('err')
    }
    window.setTimeout(() => setCopied(null), 2000)
  }
  const copyLabel =
    copied === 'ok' ? '已复制标题' : copied === 'err' ? '复制失败，请手动选择' : '复制标题'

  return (
    <div className={styles.body}>
      <Port shapeId={shape.id} portId="input" />
      <p className={styles.role}>{node.role}</p>
      {stamp && <b className={`${styles.stamp} ${styles[stamp]}`}>{STAMP[stamp]}</b>}
      {worst && worst.state !== 'pass' && worst.detail && (
        <p className={styles.reason}>{worst.detail}</p>
      )}

      {node.platform === 'ad' ? (
        <div className={styles.adBody}>
          <div className={styles.phone}>
            <img src={node.imageUrl} alt="15 秒竖版封面" />
            <div>
              <span>00:15</span>
              <em>演示成片位</em>
            </div>
          </div>
          <div>
            <ol className={styles.script}>
              {node.script.map(line => (
                <li key={line}>{line}</li>
              ))}
            </ol>
            <p className={styles.help}>{node.note}</p>
            <button
              type="button"
              className={styles.btnPrimary}
              onPointerDown={keepOnControl}
              onClick={() => downloadAdCut(node.title)}
            >
              下载 15 秒成片
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className={`${styles.art} ${hold ? styles.hold : ''}`}>
            <img src={node.imageUrl} alt={`${node.name} ${node.imageLabel}`} />
            {hold && <div className={styles.holdMark}>货架主图不可用</div>}
            <span>{node.imageLabel}</span>
          </div>
          <div className={styles.titleBlock}>
            <small>标题</small>
            <p>{node.title}</p>
            <button
              type="button"
              data-copied={copied ?? undefined}
              aria-live="polite"
              onPointerDown={keepOnControl}
              onClick={copyTitle}
            >
              {copyLabel}
            </button>
          </div>
          <dl className={styles.fields}>
            {node.fields.slice(0, 3).map(f => (
              <div key={f.label}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
          <ul className={styles.checks}>
            {node.checks.map(c => (
              <li key={c.id}>
                <b className={styles[c.state]}>{STAMP[c.state]}</b>
                <span>
                  {c.label}
                  {c.detail ? <small>{c.detail}</small> : null}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

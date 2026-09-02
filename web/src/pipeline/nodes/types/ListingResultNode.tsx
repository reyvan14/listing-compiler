import { T, useEditor } from 'tldraw'
import { NODE_HEADER_HEIGHT_PX } from '../../constants'
import { Port, ShapePort } from '../../ports/Port'
import { NodeShape } from '../NodeShapeUtil'
import {
  AD_NODE_WIDTH,
  blockingChecks,
  checkSummaryText,
  COMPACT_FIELD_LIMIT,
  downloadAdCut,
  RESULT_NODE_WIDTH,
  resultBodyHeightPx,
  STAMP,
  worstCheck,
} from './skuStation'
import { openListingInspector } from './listingInspector'
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
      // Compliance-violation extras. Always present (possibly empty) so the
      // strict T.object validator accepts every persisted card.
      suggestion: T.string,
      blocking: T.boolean,
      evidence: T.arrayOf(T.string),
    }),
  ),
  script: T.arrayOf(T.string),
  note: T.string,
  /** Deterministic suggested replacement title, when one can be derived. */
  suggestedTitle: T.string,
  // ---- self-healing Listing CI/CD dependency metadata --------------------
  // Stable artifact id (= platform for a listing card), the policy version this
  // card was compiled against, the SKU fact IDs the title depends on, and a
  // per-field fact-ref map parallel to `fields`.
  artifactId: T.string,
  policyVersion: T.string,
  factRefs: T.arrayOf(T.string),
  fieldMeta: T.arrayOf(T.object({ name: T.string, factRefs: T.arrayOf(T.string) })),
  // '' | current | stale | candidate | applied | rolled-back | needs-human-review
  migrationStatus: T.string,
  staleReason: T.string,
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
      suggestedTitle: '',
      artifactId: '',
      policyVersion: '',
      factRefs: [],
      fieldMeta: [],
      migrationStatus: '',
      staleReason: '',
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
  const editor = useEditor()
  const stamp = node.checks.length ? worstCheck(node.checks) : null
  const hold =
    node.platform !== 'shopify' &&
    node.platform !== 'ad' &&
    node.checks.some(c => c.id === 'img' && c.state === 'fix')

  const blocking = blockingChecks(node)
  const migration =
    node.migrationStatus && node.migrationStatus !== 'current' ? node.migrationStatus : ''
  const MIGRATION_LABEL: Record<string, string> = {
    stale: '已过期',
    candidate: '候选补丁待批',
    applied: '已应用',
    'rolled-back': '已回滚',
    'needs-human-review': '需人工复核',
  }

  // Detail opens the viewport-level inspector. The node itself never resizes,
  // so the stack never re-flows and the camera never moves.
  const openDetail = () => openListingInspector(editor, node.platform, shape.id)

  return (
    <div
      className={`${styles.body} ${styles.compactCard}`}
      data-platform={node.platform}
      data-testid="listing-result"
      // Double-click also opens the inspector, via NodeShapeUtil.onDoubleClick:
      // the card body has pointer-events disabled so the node stays draggable,
      // so a DOM handler here would never fire.
    >
      <Port shapeId={shape.id} portId="input" />
      {migration && (
        <div className={styles.migBanner} data-status={migration} role="status">
          {MIGRATION_LABEL[migration] ?? migration}
          {node.staleReason ? <small>{node.staleReason}</small> : null}
        </div>
      )}
      <div className={styles.cardHead}>
        <p className={styles.role}>{node.role}</p>
        {node.platform !== 'ad' && (
          <button
            type="button"
            className={styles.btnGhost}
            data-testid="open-details"
            onPointerDown={keepOnControl}
            onClick={openDetail}
          >
            查看详情
          </button>
        )}
      </div>
      {stamp && <b className={`${styles.stamp} ${styles[stamp]}`}>{STAMP[stamp]}</b>}

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
          </div>
          <dl className={styles.fields}>
            {node.fields.slice(0, COMPACT_FIELD_LIMIT).map(f => (
              <div key={f.label}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>

          {/* Blocking status is never hidden or downgraded: the compact card
              keeps a one-line red banner; the explanations live in the
              inspector's Compliance tab. */}
          {blocking.length > 0 && (
            <p
              className={styles.blockBadge}
              role="alert"
              data-testid="blocking-badge"
              title="打开详情查看每条违规的说明与改法"
            >
              {blocking.length} 项阻断违规 · 需人工复核
            </p>
          )}

          <p className={styles.checkSummary} data-testid="check-summary">
            {checkSummaryText(node.checks)}
          </p>
        </>
      )}
    </div>
  )
}

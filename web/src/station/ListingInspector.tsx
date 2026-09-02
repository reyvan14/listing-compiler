import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useValue, type Editor } from 'tldraw'
import type { NodeShape } from '@/pipeline/nodes/NodeShapeUtil'
import {
  closeListingInspector,
  listingInspectorState,
  selectInspectorPlatform,
} from '@/pipeline/nodes/types/listingInspector'
import {
  blockingChecks,
  checkSummaryText,
  STAMP,
  type ListingResultNode,
} from '@/pipeline/nodes/types/skuStation'
import styles from './listingInspector.module.scss'

// Viewport-level detail inspector.
//
// The canvas node stays permanently compact; everything long lives here. This
// is deliberately NOT a taller node: a node that outgrows the viewport can only
// be read by scrolling inside it, and a wheel event inside a canvas node fights
// the canvas's own pan/zoom. Opening this reads the shapes but never writes to
// them, so no node moves, no connection re-binds and the camera is untouched.

type Tab = 'content' | 'compliance' | 'policy'

const TABS: { id: Tab; label: string }[] = [
  { id: 'content', label: '内容' },
  { id: 'compliance', label: '合规' },
  { id: 'policy', label: '政策与历史' },
]

const PLATFORM_ORDER = ['amazon', 'tiktok', 'shopify']

const MIGRATION_LABEL: Record<string, string> = {
  current: '当前版本',
  stale: '已过期',
  candidate: '候选补丁待批',
  applied: '已应用',
  'rolled-back': '已回滚',
  'needs-human-review': '需人工复核',
}

/** Field labels that belong in the "bullets" group rather than the field list. */
const BULLET_PREFIX = '五点'
const SEARCH_LABELS = ['搜索词']
const LONG_LABELS = ['长描述', '描述', '详情规划']

function orderPlatforms(nodes: ListingResultNode[]): ListingResultNode[] {
  return [...nodes].sort(
    (a, b) =>
      (PLATFORM_ORDER.indexOf(a.platform) + 1 || 99) -
      (PLATFORM_ORDER.indexOf(b.platform) + 1 || 99),
  )
}

export function ListingInspector({ editor }: { editor: Editor }) {
  const state = useValue('inspector state', () => listingInspectorState.get(editor), [editor])

  // Read the result cards straight off the canvas — the shapes stay the single
  // source of truth, so the inspector can never show stale copy.
  const cards = useValue(
    'inspector cards',
    () =>
      orderPlatforms(
        editor
          .getCurrentPageShapes()
          .filter((s): s is NodeShape => {
            if (!editor.isShapeOfType(s, 'node')) return false
            const n = (s as NodeShape).props.node
            return n.type === 'listing_result' && n.platform !== 'ad'
          })
          .map(s => s.props.node as ListingResultNode),
      ),
    [editor],
  )

  const [tab, setTab] = useState<Tab>('content')
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  const open = state.platform !== null
  const node = cards.find(c => c.platform === state.platform) ?? null

  const close = useCallback(() => closeListingInspector(editor), [editor])

  // Opening from a node selects that platform; reopening resets to the first
  // tab so the reader always lands on the listing content.
  useEffect(() => {
    if (open) setTab('content')
  }, [open, state.platform === null])

  // Focus: remember what had it, move into the dialog, restore on close.
  useEffect(() => {
    if (!open) return
    restoreFocusRef.current = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    return () => {
      const target = restoreFocusRef.current
      restoreFocusRef.current = null
      // The originating card is still mounted (it never resized), so its
      // 查看详情 button is the natural place to land.
      if (target && document.contains(target)) target.focus()
    }
  }, [open])

  // Escape to close + focus trap.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        close()
        return
      }
      if (e.key !== 'Tab' || !dialogRef.current) return
      const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, close])

  if (!open || !node) return null

  return (
    <div className={styles.overlay} data-testid="listing-inspector">
      <div className={styles.backdrop} data-testid="inspector-backdrop" onClick={close} />
      <div
        ref={dialogRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="inspector-title"
      >
        <header className={styles.head}>
          <div className={styles.headTop}>
            <div>
              <div className={styles.kicker}>上新草稿详情</div>
              <h2 id="inspector-title">
                {node.name}
                <span className={styles.headRole}>{node.role}</span>
              </h2>
            </div>
            <button
              ref={closeRef}
              type="button"
              className={styles.close}
              data-testid="inspector-close"
              aria-label="关闭详情"
              onClick={close}
            >
              关闭
            </button>
          </div>

          <div className={styles.platformTabs} role="tablist" aria-label="平台">
            {cards.map(c => (
              <button
                key={c.platform}
                type="button"
                role="tab"
                aria-selected={c.platform === node.platform}
                data-testid="inspector-platform-tab"
                data-platform={c.platform}
                className={c.platform === node.platform ? styles.tabActive : styles.tab}
                onClick={() => selectInspectorPlatform(editor, c.platform)}
              >
                {c.name}
                {blockingChecks(c).length > 0 && <i className={styles.tabDot} aria-hidden="true" />}
              </button>
            ))}
          </div>

          <div className={styles.sectionTabs} role="tablist" aria-label="详情分区">
            {TABS.map(t => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === tab}
                data-testid="inspector-tab"
                data-tab={t.id}
                className={t.id === tab ? styles.tabActive : styles.tab}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {t.id === 'compliance' && blockingChecks(node).length > 0 && (
                  <i className={styles.tabDot} aria-hidden="true" />
                )}
              </button>
            ))}
          </div>
        </header>

        <div className={styles.content} data-testid="inspector-content" data-tab={tab}>
          {tab === 'content' && <ContentTab node={node} />}
          {tab === 'compliance' && <ComplianceTab node={node} />}
          {tab === 'policy' && <PolicyTab node={node} />}
        </div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //

function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<null | 'ok' | 'err'>(null)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setState('ok')
    } catch {
      setState('err')
    }
    window.setTimeout(() => setState(null), 2000)
  }
  return (
    <button
      type="button"
      className={styles.copyBtn}
      data-copied={state ?? undefined}
      aria-live="polite"
      disabled={!value}
      onClick={copy}
    >
      {state === 'ok' ? `已复制${label}` : state === 'err' ? '复制失败，请手动选择' : `复制${label}`}
    </button>
  )
}

function ContentTab({ node }: { node: ListingResultNode }) {
  const bullets = node.fields.filter(f => f.label.startsWith(BULLET_PREFIX))
  const search = node.fields.filter(f => SEARCH_LABELS.includes(f.label))
  const long = node.fields.filter(f => LONG_LABELS.includes(f.label))
  const rest = node.fields.filter(
    f => !bullets.includes(f) && !search.includes(f) && !long.includes(f),
  )

  return (
    <div className={styles.contentGrid}>
      <div className={styles.colNarrow}>
        <section className={styles.block}>
          <h3>主图</h3>
          <div className={styles.art}>
            <img src={node.imageUrl} alt={`${node.name} ${node.imageLabel}`} />
          </div>
          <p className={styles.meta}>{node.imageLabel}</p>
        </section>
      </div>

      <div className={styles.colWide}>
        <section className={styles.block}>
          <div className={styles.blockHead}>
            <h3>标题</h3>
            <CopyButton value={node.title} label="标题" />
          </div>
          <p className={styles.titleText} data-testid="inspector-title-text">
            {node.title}
          </p>
          <p className={styles.meta}>{node.title.length} 字符</p>
        </section>

        {bullets.length > 0 && (
          <section className={styles.block}>
            <div className={styles.blockHead}>
              <h3>卖点</h3>
              <CopyButton value={bullets.map(b => b.value).join('\n')} label="卖点" />
            </div>
            <ol className={styles.bullets}>
              {bullets.map(b => (
                <li key={b.label}>{b.value}</li>
              ))}
            </ol>
          </section>
        )}

        {long.map(f => (
          <section className={styles.block} key={f.label}>
            <div className={styles.blockHead}>
              <h3>{f.label}</h3>
              <CopyButton value={f.value} label={f.label} />
            </div>
            <p className={styles.longText}>{f.value}</p>
          </section>
        ))}

        {search.map(f => (
          <section className={styles.block} key={f.label}>
            <div className={styles.blockHead}>
              <h3>{f.label}</h3>
              <CopyButton value={f.value} label={f.label} />
            </div>
            <p className={styles.longText}>{f.value}</p>
          </section>
        ))}

        {rest.length > 0 && (
          <section className={styles.block}>
            <h3>其他字段</h3>
            <dl className={styles.fieldGrid}>
              {rest.map(f => (
                <div key={f.label}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
      </div>
    </div>
  )
}

function ComplianceTab({ node }: { node: ListingResultNode }) {
  const blocking = blockingChecks(node)
  const others = node.checks.filter(c => !c.blocking)

  return (
    <div className={styles.stack}>
      <section className={styles.block}>
        <h3>校验汇总</h3>
        <p className={styles.summaryLine} data-testid="inspector-summary">
          {checkSummaryText(node.checks)}
        </p>
        {blocking.length > 0 ? (
          <div className={styles.gate} role="alert" data-testid="inspector-blocking-gate">
            <b>{blocking.length} 项阻断违规 · 已保留待人工复核</b>
            <small>未通过平台硬性规则，不会自动上架，也不会被静默沿用。</small>
            {node.suggestedTitle && (
              <span className={styles.suggestTitle} data-testid="inspector-suggested-title">
                建议标题：{node.suggestedTitle}
              </span>
            )}
          </div>
        ) : (
          <p className={styles.okLine}>未发现阻断违规。机械检查通过，不等于平台终审。</p>
        )}
      </section>

      {blocking.length > 0 && (
        <section className={styles.block}>
          <h3>阻断违规</h3>
          <ul className={styles.checkList}>
            {blocking.map(c => (
              <li key={c.id} data-blocking="1" data-testid="inspector-violation">
                <div className={styles.checkHead}>
                  <b className={styles.fix}>{STAMP[c.state]}</b>
                  <span>{c.label}</span>
                  <i className={styles.blockTag}>阻断</i>
                </div>
                {c.detail && <p className={styles.checkDetail}>{c.detail}</p>}
                {c.evidence.length > 0 && (
                  <p className={styles.evidence}>问题片段：{c.evidence.join('  ')}</p>
                )}
                {c.suggestion && <p className={styles.suggestion}>改法：{c.suggestion}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {others.length > 0 && (
        <section className={styles.block}>
          <h3>其他检查</h3>
          <ul className={styles.checkList}>
            {others.map(c => (
              <li key={c.id} data-testid="inspector-check">
                <div className={styles.checkHead}>
                  <b className={styles[c.state]}>{STAMP[c.state]}</b>
                  <span>{c.label}</span>
                </div>
                {c.detail && <p className={styles.checkDetail}>{c.detail}</p>}
                {c.suggestion && <p className={styles.suggestion}>改法：{c.suggestion}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function PolicyTab({ node }: { node: ListingResultNode }) {
  const status = node.migrationStatus || 'current'
  return (
    <div className={styles.stack}>
      <section className={styles.block}>
        <h3>政策版本</h3>
        <dl className={styles.fieldGrid}>
          <div>
            <dt>平台</dt>
            <dd>{node.name}</dd>
          </div>
          <div>
            <dt>编译所依据的政策版本</dt>
            <dd>
              <code data-testid="inspector-policy-version">{node.policyVersion || '—'}</code>
            </dd>
          </div>
          <div>
            <dt>产物 ID</dt>
            <dd>
              <code>{node.artifactId || node.platform}</code>
            </dd>
          </div>
          <div>
            <dt>出处</dt>
            <dd>
              规则条文与出处链接见「规则表」，按平台快照维护于 <code>api/policy/snapshots</code>。
            </dd>
          </div>
        </dl>
      </section>

      <section className={styles.block}>
        <h3>迁移状态</h3>
        <p className={styles.statusLine} data-status={status} data-testid="inspector-migration">
          {MIGRATION_LABEL[status] ?? status}
        </p>
        {node.staleReason ? (
          <p className={styles.checkDetail}>{node.staleReason}</p>
        ) : (
          <p className={styles.meta}>
            没有待处理的规则变更。运行「规则变更 / 迁移」可计算影响面并生成候选补丁。
          </p>
        )}
        <p className={styles.meta}>
          状态用词只取这六种，如实反映产物在编译流水线中的位置：current / stale / candidate /
          applied / rolled back / needs human review。本工具不做平台发布，也不代表平台审核结论。
        </p>
      </section>

      <section className={styles.block}>
        <h3>SKU 事实依赖</h3>
        {node.factRefs.length > 0 ? (
          <p className={styles.meta}>
            标题依赖：
            {node.factRefs.reduce<ReactNode[]>(
              (acc, r, i) => [...acc, i > 0 ? ' ' : null, <code key={r}>{r}</code>],
              [],
            )}
          </p>
        ) : (
          <p className={styles.meta}>标题未记录 SKU 事实依赖。</p>
        )}
        {node.fieldMeta.length > 0 && (
          <dl className={styles.fieldGrid}>
            {node.fieldMeta
              .filter(m => m.factRefs.length > 0)
              .map(m => (
                <div key={m.name}>
                  <dt>
                    <code>{m.name}</code>
                  </dt>
                  <dd>{m.factRefs.join('、')}</dd>
                </div>
              ))}
          </dl>
        )}
      </section>
    </div>
  )
}

export function useInspectorOpen(editor: Editor | null): boolean {
  return useValue(
    'inspector open',
    () => (editor ? listingInspectorState.get(editor).platform !== null : false),
    [editor],
  )
}

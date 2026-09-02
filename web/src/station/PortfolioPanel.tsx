import { useMemo, useRef, useState } from 'react'
import { toSafeMessage } from './apiClient'
import {
  STATUS_META,
  analyzePortfolio,
  applyPortfolio,
  downloadBatchReport,
  importPortfolio,
  reviewRows,
  rollbackPortfolio,
  safeRows,
  snapshotPortfolio,
  templateUrl,
  type ApplyResult,
  type ImportResult,
  type MatrixRow,
  type PortfolioAnalysis,
  type RowStatus,
} from './migration/portfolioApi'
import styles from './nodes.module.scss'

// Batch migration centre: import a portfolio, see the blast radius across every
// SKU, approve the safe patches in bulk, and roll back a SKU or the whole batch.
//
// Deliberately a compact dashboard + filterable table rather than hundreds of
// canvas nodes: a portfolio migration is a table-shaped problem, and putting
// 500 SKUs on the canvas would make both the canvas and the migration unusable.

const AMAZON_BASE = 'amazon-us-pre-2025.01.21'
const AMAZON_CANDIDATE = 'amazon-us-2025.01.21'

type Phase = 'idle' | 'imported' | 'analyzed' | 'applied' | 'rolled-back'
type Busy = '' | 'import' | 'analyze' | 'apply' | 'rollback' | 'report'

const STATUS_ORDER: RowStatus[] = [
  'safe_patch',
  'review_required',
  'blocked',
  'unaffected',
]

export function PortfolioPanel({ onClose }: { onClose: () => void }) {
  const [imported, setImported] = useState<ImportResult | null>(null)
  const [analysis, setAnalysis] = useState<PortfolioAnalysis | null>(null)
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null)
  const [snapshot, setSnapshot] = useState<unknown>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [busy, setBusy] = useState<Busy>('')
  const [error, setError] = useState('')
  const [statusFilter, setStatusFilter] = useState<RowStatus | 'all'>('all')
  const [skuFilter, setSkuFilter] = useState('')
  const [driftCapacity, setDriftCapacity] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const matrix = analysis?.matrix ?? []
  const visible = useMemo(
    () =>
      matrix.filter(
        r =>
          (statusFilter === 'all' || r.status === statusFilter) &&
          (!skuFilter || r.sku.toLowerCase().includes(skuFilter.toLowerCase())),
      ),
    [matrix, statusFilter, skuFilter],
  )

  const safe = safeRows(matrix)
  const risky = reviewRows(matrix)

  const onImport = async (files: FileList | null) => {
    if (!files?.length) return
    setBusy('import')
    setError('')
    try {
      const res = await importPortfolio(files[0])
      setImported(res)
      setAnalysis(null)
      setApplyResult(null)
      setPhase('imported')
    } catch (err) {
      setError(toSafeMessage(err))
    } finally {
      setBusy('')
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const onAnalyze = async () => {
    if (!imported?.skus.length) return
    setBusy('analyze')
    setError('')
    try {
      const pointsOverride: Record<string, string> = {}
      if (driftCapacity) {
        for (const s of imported.skus) {
          if (s.points.includes('350ml')) {
            pointsOverride[s.sku] = s.points.split('350ml').join('300ml')
          }
        }
      }
      const res = await analyzePortfolio({
        skus: imported.skus,
        basePolicyVersion: driftCapacity ? undefined : AMAZON_BASE,
        candidatePolicyVersion: driftCapacity ? undefined : AMAZON_CANDIDATE,
        pointsOverride,
      })
      setAnalysis(res)
      setSnapshot(snapshotPortfolio(res.artifacts))
      setApplyResult(null)
      setPhase('analyzed')
    } catch (err) {
      setError(toSafeMessage(err))
    } finally {
      setBusy('')
    }
  }

  const onApplySafe = async () => {
    if (!analysis || safe.length === 0) return
    setBusy('apply')
    setError('')
    try {
      const res = await applyPortfolio({
        artifacts: analysis.artifacts,
        approved: safe,
        candidatePolicyVersion: analysis.policy.candidate_version ?? undefined,
      })
      setApplyResult(res)
      setPhase('applied')
    } catch (err) {
      setError(toSafeMessage(err))
    } finally {
      setBusy('')
    }
  }

  const onRollback = async (sku?: string) => {
    if (!snapshot) return
    setBusy('rollback')
    setError('')
    try {
      await rollbackPortfolio(snapshot, sku)
      setApplyResult(null)
      setPhase('rolled-back')
    } catch (err) {
      setError(toSafeMessage(err))
    } finally {
      setBusy('')
    }
  }

  const onReport = async () => {
    if (!analysis) return
    setBusy('report')
    try {
      await downloadBatchReport({
        analysis,
        applyResult,
        status: phase === 'applied' ? 'applied' : phase === 'rolled-back' ? 'rolled_back' : 'candidate',
      })
    } catch (err) {
      setError(toSafeMessage(err))
    } finally {
      setBusy('')
    }
  }

  const su = analysis?.summary

  return (
    <div
      className={`${styles.drawer} ${styles.migrationDrawer} ${styles.portfolioDrawer}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="portfolio-title"
      id="portfolio-panel"
    >
      <div className={styles.mask} aria-hidden="true" onClick={onClose} />
      <aside>
        <header>
          <div>
            <div className={styles.kicker}>批量迁移中心 · 组合级影响面</div>
            <h2 id="portfolio-title">导入 SKU 组合 → 影响面 → 批量补丁 → 应用 / 回滚</h2>
          </div>
          <button type="button" className={styles.btnGhost} onClick={onClose}>
            关闭
          </button>
        </header>

        <p className={styles.rulesNote} id="portfolio-status">
          状态：{PHASE_LABEL[phase]}
        </p>
        {error && (
          <p className={styles.rulesError} role="alert">
            {error}
          </p>
        )}

        {/* 1. import ------------------------------------------------- */}
        <section className={styles.migSection}>
          <div className={styles.menuTitle}>1 · 导入组合（CSV / XLSX）</div>
          <div className={styles.migActions}>
            <a className={styles.btnGhost} href={templateUrl()} download id="portfolio-template">
              下载模板
            </a>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx"
              disabled={busy !== ''}
              id="portfolio-import"
              onChange={e => onImport(e.target.files)}
            />
          </div>
          {imported && (
            <div data-testid="import-report">
              <p className={styles.rulesNote}>
                共 {imported.summary.total_rows} 行 · 导入 <b>{imported.summary.imported}</b> 个
                SKU · 拒绝 <b>{imported.summary.rejected}</b> 行
              </p>
              {imported.errors.length > 0 && (
                <ul className={styles.migDiff}>
                  {imported.errors.map((e, i) => (
                    <li
                      key={`${e.row}-${i}`}
                      data-kind={e.severity === 'warning' ? 'changed' : 'removed'}
                      data-testid="import-error"
                    >
                      第 {e.row} 行{e.sku && <> · <code>{e.sku}</code></>}：{e.error}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>

        {/* 2. blast radius -------------------------------------------- */}
        {imported && imported.skus.length > 0 && (
          <section className={styles.migSection}>
            <div className={styles.menuTitle}>2 · 影响面分析</div>
            <label className={styles.help}>
              <input
                type="checkbox"
                checked={driftCapacity}
                disabled={busy !== ''}
                onChange={e => setDriftCapacity(e.target.checked)}
                id="portfolio-drift"
              />{' '}
              改为演示 SKU 事实漂移（350ml → 300ml），不勾选则演示 Amazon 政策迁移回放
            </label>
            <div className={styles.migActions}>
              <button
                type="button"
                className={styles.btnPrimary}
                id="portfolio-analyze"
                disabled={busy !== ''}
                onClick={onAnalyze}
              >
                {busy === 'analyze' ? '分析中…' : '计算组合影响面'}
              </button>
            </div>
          </section>
        )}

        {su && (
          <section className={styles.migSection} id="portfolio-summary">
            <div className={styles.menuTitle}>影响面汇总</div>
            <div className={styles.statRow} data-testid="portfolio-stats">
              <Stat label="扫描 SKU" value={su.skus_scanned} />
              <Stat label="受影响" value={su.skus_affected} tone="warn" />
              <Stat label="未受影响" value={su.skus_unaffected} />
              <Stat label="可安全修补" value={su.safe_patch} tone="ok" />
              <Stat label="需人工" value={su.review_required} tone="warn" />
              <Stat label="阻断" value={su.blocked} tone="danger" />
            </div>
            <p className={styles.rulesNote}>
              受影响平台：{su.affected_platforms.join('、') || '—'}
              {su.affected_fields.length > 0 && <> · 字段：{su.affected_fields.join('、')}</>}
            </p>
          </section>
        )}

        {/* 3. matrix --------------------------------------------------- */}
        {analysis && (
          <section className={styles.migSection} id="portfolio-matrix">
            <div className={styles.menuTitle}>SKU × 平台 × 字段 × 状态</div>
            <div className={styles.migActions}>
              <select
                value={statusFilter}
                id="portfolio-filter-status"
                onChange={e => setStatusFilter(e.target.value as RowStatus | 'all')}
              >
                <option value="all">全部状态</option>
                {STATUS_ORDER.map(s => (
                  <option key={s} value={s}>
                    {STATUS_META[s].label}
                  </option>
                ))}
              </select>
              <input
                type="search"
                placeholder="筛选 SKU"
                value={skuFilter}
                id="portfolio-filter-sku"
                onChange={e => setSkuFilter(e.target.value)}
              />
              <span className={styles.help}>
                {visible.length} / {matrix.length} 行
              </span>
            </div>
            <div className={styles.matrixScroll}>
              <table className={styles.matrix}>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>平台</th>
                    <th>字段</th>
                    <th>状态</th>
                    <th>原因</th>
                    <th>补丁</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r, i) => (
                    <tr key={`${r.artifact_id}-${r.field}-${i}`} data-testid="matrix-row" data-status={r.status}>
                      <td><code>{r.sku}</code></td>
                      <td>{r.platform}</td>
                      <td>{r.field}</td>
                      <td>
                        <span className={styles.statusPill} data-tone={STATUS_META[r.status].tone}>
                          {STATUS_META[r.status].label}
                        </span>
                      </td>
                      <td className={styles.matrixReason}>{r.reason}</td>
                      <td className={styles.matrixDiff}>
                        {r.candidate_value ? (
                          <>
                            <span className={styles.migPrev}>{r.previous_value}</span>
                            <span className={styles.migNext}>{r.candidate_value}</span>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* 4. batch actions -------------------------------------------- */}
        {analysis && (
          <section className={styles.migSection}>
            <div className={styles.menuTitle}>3 · 批量批准与回滚</div>
            <div className={styles.migActions}>
              <button
                type="button"
                className={styles.btnPrimary}
                id="portfolio-apply-safe"
                disabled={busy !== '' || safe.length === 0}
                onClick={onApplySafe}
              >
                {busy === 'apply' ? '应用中…' : `批准并应用 ${safe.length} 项安全补丁`}
              </button>
              <button
                type="button"
                className={styles.btnGhost}
                id="portfolio-rollback-batch"
                disabled={busy !== '' || !snapshot}
                onClick={() => onRollback()}
              >
                回滚整批
              </button>
              <button
                type="button"
                className={styles.btnGhost}
                id="portfolio-report"
                disabled={busy !== ''}
                onClick={onReport}
              >
                下载审计报告
              </button>
            </div>
            {risky.length > 0 && (
              <p className={styles.rulesNote} data-testid="review-notice">
                另有 <b>{risky.length}</b> 项标记为「需人工复核」，不会被批量批准应用，
                需逐项在单 SKU 迁移面板中处理。
              </p>
            )}
            {applyResult && (
              <div data-testid="apply-result">
                <p className={styles.rulesNote}>
                  已应用 SKU：{applyResult.applied_skus.join('、') || '—'}
                  {applyResult.rejected_patches.length > 0 && (
                    <> · 拒绝 {applyResult.rejected_patches.length} 项（需人工复核）</>
                  )}
                </p>
                <ul className={styles.migList}>
                  {applyResult.applied_skus.map(sku => (
                    <li key={sku} data-tone="ok">
                      <div className={styles.migRow}>
                        <span className={styles.migRowHead}>
                          <b>{sku}</b>
                          <span className={styles.migKeep}>已应用</span>
                        </span>
                        <button
                          type="button"
                          className={styles.btnGhost}
                          data-testid="rollback-one"
                          data-sku={sku}
                          disabled={busy !== ''}
                          onClick={() => onRollback(sku)}
                        >
                          仅回滚此 SKU
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className={styles.help}>
              本工具不会把任何内容发布到平台。应用只改写本地产物，且随时可回滚。
            </p>
          </section>
        )}
      </aside>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'ok' | 'warn' | 'danger'
}) {
  return (
    <div className={styles.stat} data-tone={tone} data-testid="portfolio-stat" data-label={label}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  )
}

const PHASE_LABEL: Record<Phase, string> = {
  idle: '等待导入组合',
  imported: '已导入，待分析',
  analyzed: '已完成影响面分析',
  applied: '已应用安全补丁',
  'rolled-back': '已回滚',
}

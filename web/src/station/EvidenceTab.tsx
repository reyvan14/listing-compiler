import { useCallback, useEffect, useRef, useState } from 'react'
import type { ListingResultNode } from '@/pipeline/nodes/types/skuStation'
import {
  CLAIM_TYPE_LABEL,
  FACT_STATE_META,
  METHOD_META,
  deleteSource,
  fetchFacts,
  fetchSources,
  locationLabel,
  setFactState,
  toSafeMessage,
  uploadEvidence,
  type EvidenceSource,
  type GateClaim,
  type ProductFact,
} from './evidenceApi'
import type { GateState } from './useEvidenceGate'
import { IntakeReview } from './intake/IntakeReview'
import styles from './listingInspector.module.scss'

// Evidence tab: the ledger behind every commercial claim in this card.
//
// Three sections, in the order an operator actually works through them:
//   1. the claims this card makes, and whether each is backed
//   2. the atomic facts, with the source location each came from
//   3. the uploaded documents themselves
//
// Verifying a fact is an explicit operator action — the backend refuses to
// promote anything to `verified` on its own, and this UI never offers a
// shortcut that would bypass that.

export function EvidenceTab({
  node,
  gate,
  productId,
  onLedgerChange,
}: {
  node: ListingResultNode
  gate: GateState
  productId: string
  onLedgerChange: () => void
}) {
  const [facts, setFacts] = useState<ProductFact[]>([])
  const [sources, setSources] = useState<EvidenceSource[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [expiresOn, setExpiresOn] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const reload = useCallback(async () => {
    try {
      const [f, s] = await Promise.all([fetchFacts(productId), fetchSources(productId)])
      setFacts(f)
      setSources(s)
      setError('')
    } catch (err) {
      setError(toSafeMessage(err))
    }
  }, [productId])

  useEffect(() => {
    void reload()
  }, [reload])

  const onUpload = async (files: FileList | null) => {
    if (!files?.length) return
    setBusy(true)
    setError('')
    try {
      for (const file of Array.from(files)) {
        await uploadEvidence(file, { expiresOn }, productId)
      }
      await reload()
      onLedgerChange()
    } catch (err) {
      setError(toSafeMessage(err))
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const confirmFact = async (fact: ProductFact, state: ProductFact['state']) => {
    setBusy(true)
    setError('')
    try {
      await setFactState(fact.fact_id, state, {}, productId)
      await reload()
      onLedgerChange()
    } catch (err) {
      setError(toSafeMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const removeSource = async (sourceId: string) => {
    setBusy(true)
    try {
      await deleteSource(sourceId, productId)
      await reload()
      onLedgerChange()
    } catch (err) {
      setError(toSafeMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const claims = (gate.result?.fields ?? []).flatMap(f =>
    f.claims.map(c => ({ ...c, field: f.field })),
  )
  const byId = new Map(facts.map(f => [f.fact_id, f]))

  return (
    <div className={styles.stack} data-testid="evidence-tab">
      {error && (
        <p className={styles.gateError} role="alert">
          {error}
        </p>
      )}

      {/* 1. what this card claims -------------------------------------- */}
      <section className={styles.block}>
        <h3>本卡片的商业宣称</h3>
        {gate.status === 'loading' && <p className={styles.meta}>正在核对证据账本…</p>}
        {gate.status === 'error' && (
          <p className={styles.gateError} role="alert">
            {gate.error}
          </p>
        )}
        {gate.status === 'ready' && claims.length === 0 && (
          <p className={styles.meta}>
            未检测到需要证据支撑的宣称。普通营销文案不进入证据闸门。
          </p>
        )}
        {claims.length > 0 && (
          <ul className={styles.claimList}>
            {claims.map(claim => (
              <ClaimRow
                key={`${claim.field}:${claim.fact_id}`}
                claim={claim}
                field={claim.field}
                fact={byId.get(claim.fact_id)}
              />
            ))}
          </ul>
        )}
      </section>

      {/* 2. the fact ledger ------------------------------------------- */}
      <section className={styles.block}>
        <div className={styles.blockHead}>
          <h3>产品事实账本</h3>
          <span className={styles.meta}>{facts.length} 条</span>
        </div>
        {facts.length === 0 ? (
          <p className={styles.meta}>账本为空。上传规格表、说明书或证书后会自动提取。</p>
        ) : (
          <ul className={styles.factList}>
            {facts.map(fact => (
              <li key={fact.fact_id} data-testid="evidence-fact" data-fact={fact.fact_id}>
                <div className={styles.factHead}>
                  <b>{fact.key}</b>
                  <span className={styles.factValue}>{fact.display || fact.value || '—'}</span>
                  <em className={styles.claimType}>
                    {CLAIM_TYPE_LABEL[fact.claim_type] ?? fact.claim_type}
                  </em>
                  <span
                    className={styles.factState}
                    data-tone={FACT_STATE_META[fact.state]?.tone}
                    data-state={fact.state}
                  >
                    {FACT_STATE_META[fact.state]?.label ?? fact.state}
                  </span>
                </div>
                {fact.note && <p className={styles.checkDetail}>{fact.note}</p>}
                {fact.sources.map((link, i) => (
                  <p className={styles.sourceLine} key={`${link.source_id}-${i}`}>
                    <code>{link.source_id}</code> · {locationLabel(link)} ·{' '}
                    <span className={styles.method}>
                      {METHOD_META[link.method] ?? link.method}
                    </span>
                    {link.excerpt && <span className={styles.excerpt}>「{link.excerpt}」</span>}
                  </p>
                ))}
                {fact.state !== 'verified' && fact.state !== 'conflicting' && fact.sources.length > 0 && (
                  <button
                    type="button"
                    className={styles.copyBtn}
                    data-testid="verify-fact"
                    disabled={busy}
                    onClick={() => confirmFact(fact, 'verified')}
                  >
                    确认为已核实
                  </button>
                )}
                {fact.state === 'conflicting' && (
                  <p className={styles.gateError}>请先移除错误来源，再确认剩余事实。</p>
                )}
                {fact.state === 'verified' && (
                  <button
                    type="button"
                    className={styles.copyBtn}
                    disabled={busy}
                    onClick={() => confirmFact(fact, 'needs_review')}
                  >
                    撤回确认
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className={styles.meta}>
          提取只说明文档「写了什么」，不代表事实成立；只有人工确认才会转为「已核实」。
        </p>
      </section>

      {/* 3. the documents --------------------------------------------- */}
      <section className={styles.block}>
        <div className={styles.blockHead}>
          <h3>证据文件</h3>
          <span className={styles.meta}>{sources.length} 份</span>
        </div>
        <div className={styles.uploadRow}>
          <label className={styles.uploadLabel}>
            有效期至
            <input
              type="date"
              value={expiresOn}
              onChange={e => setExpiresOn(e.target.value)}
              data-testid="evidence-expiry"
            />
          </label>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".pdf,.jpg,.jpeg,.png,.txt,.md,.csv,.xlsx"
            disabled={busy}
            data-testid="evidence-upload"
            onChange={e => onUpload(e.target.files)}
          />
        </div>
        {sources.length > 0 && (
          <ul className={styles.sourceList}>
            {sources.map(src => (
              <li key={src.source_id} data-testid="evidence-source">
                <div className={styles.factHead}>
                  <b>{src.filename}</b>
                  <span className={styles.meta}>{Math.ceil(src.size_bytes / 1024)} KB</span>
                  {src.expires_on && (
                    <span className={styles.meta}>有效期至 {src.expires_on}</span>
                  )}
                </div>
                <p className={styles.sourceLine}>
                  <code>{src.source_id}</code> · {src.mime_type} · SHA-256{' '}
                  <code>{src.sha256.slice(0, 16)}…</code> · 上传于 {src.uploaded_at}
                </p>
                <button
                  type="button"
                  className={styles.copyBtn}
                  disabled={busy}
                  onClick={() => removeSource(src.source_id)}
                >
                  移除
                </button>
                {/* Reading the upload is a separate, opt-in step: it produces
                    candidates for review, never facts. */}
                <IntakeReview
                  sourceId={src.source_id}
                  sourceMime={src.mime_type}
                  productId={productId}
                  onLedgerChange={onLedgerChange}
                />
              </li>
            ))}
          </ul>
        )}
        <p className={styles.meta}>
          支持 PDF、JPG/PNG、TXT/Markdown、CSV、XLSX。图片可用「读取并提取事实」做 OCR
          （未安装引擎时会如实说明），读出的内容一律是待确认的候选事实，
          经人工确认读数后仍需在本页核实才算已核实。
        </p>
      </section>
    </div>
  )
}

/** One claim, expandable to the fact and source location behind it. */
function ClaimRow({
  claim,
  field,
  fact,
}: {
  claim: GateClaim
  field: string
  fact?: ProductFact
}) {
  const [open, setOpen] = useState(false)
  return (
    <li data-testid="evidence-claim" data-verdict={claim.verdict} data-fact={claim.fact_id}>
      <button
        type="button"
        className={styles.claimHead}
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <span className={styles.claimField}>{field}</span>
        <b>{claim.label}</b>
        <span
          className={styles.factState}
          data-tone={FACT_STATE_META[claim.state]?.tone}
          data-state={claim.state}
        >
          {FACT_STATE_META[claim.state]?.label ?? claim.state}
        </span>
        <span className={styles.claimToggle}>{open ? '收起' : '查看依据'}</span>
      </button>
      <p className={styles.checkDetail}>{claim.detail}</p>
      {open && (
        <div className={styles.claimBody} data-testid="claim-evidence">
          <p className={styles.meta}>
            文案片段：<span className={styles.excerpt}>「{claim.matched}」</span>
          </p>
          {fact && (
            <p className={styles.meta}>
              对应事实：<code>{fact.fact_id}</code> = {fact.display || fact.value || '—'}
            </p>
          )}
          {claim.supporting_sources.length === 0 ? (
            <p className={styles.gateError}>没有任何证据来源支撑该宣称。</p>
          ) : (
            claim.supporting_sources.map((link, i) => (
              <p className={styles.sourceLine} key={`${link.source_id}-${i}`}>
                <code>{link.source_id}</code> · {locationLabel(link)} ·{' '}
                <span className={styles.method}>{METHOD_META[link.method] ?? link.method}</span>
                {link.expires_on && <span className={styles.meta}> · 至 {link.expires_on}</span>}
                {link.excerpt && <span className={styles.excerpt}>「{link.excerpt}」</span>}
              </p>
            ))
          )}
          {claim.suggestion && <p className={styles.suggestion}>改法：{claim.suggestion}</p>}
        </div>
      )}
    </li>
  )
}

/** Compact evidence verdict shown at the top of the Compliance tab, so the
 * two validation axes are visible together but never conflated. */
export function EvidenceVerdictSummary({ gate }: { gate: GateState }) {
  if (gate.status !== 'ready' || !gate.result) return null
  const r = gate.result
  const tone = r.verdict === 'blocked' ? 'danger' : r.verdict === 'needs_review' ? 'warn' : 'ok'
  const label =
    r.verdict === 'blocked'
      ? `${r.blocked_fields.length} 个字段的宣称缺少证据支撑`
      : r.verdict === 'needs_review'
        ? `${r.review_fields.length} 个字段的证据待人工确认`
        : '全部宣称均有已核实证据支撑'

  return (
    <section className={styles.block} data-testid="evidence-verdict" data-verdict={r.verdict}>
      <div className={styles.blockHead}>
        <h3>证据校验（独立于平台政策）</h3>
        <span className={styles.factState} data-tone={tone}>
          {label}
        </span>
      </div>
      <p className={styles.meta}>
        平台政策校验回答「是否符合平台格式规则」；证据校验回答「宣称是否有据可依」。
        两者互不替代，详情见「证据」标签页。
      </p>
    </section>
  )
}

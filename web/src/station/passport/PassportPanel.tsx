import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from 'tldraw';
import {
  findSkuShape,
  type SkuListingNode,
} from '@/pipeline/nodes/types/skuStation';
import { RESULT_STATE_META } from '../media/imageApi';
import {
  READINESS_META,
  buildPassport,
  exportPackage,
  fetchManifest,
  passportErrorMessage,
  type PackageManifest,
  type Passport,
} from './passportApi';
import {
  HANDOFF_DISCLAIMER,
  canExport,
  coverage,
  formatBytes,
  hasSource,
  mediaProblem,
} from './passportModel';
import styles from './passportPanel.module.scss';

// The Release Passport view.
//
// Every section is rendered from stored entity ids the backend resolved; this
// component derives no verdicts of its own. Where a section has no records it
// says so — an unchecked area and an empty list must not look the same.

const PLATFORMS = [
  { id: 'amazon', name: 'Amazon' },
  { id: 'tiktok', name: 'TikTok Shop' },
  { id: 'shopify', name: 'Shopify' },
];

export function PassportPanel({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [platform, setPlatform] = useState('amazon');
  const [passport, setPassport] = useState<Passport | null>(null);
  const [manifest, setManifest] = useState<PackageManifest | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);

  const sku = useMemo(() => {
    const shape = findSkuShape(editor);
    const node = shape?.props.node;
    if (!shape || !node || node.type !== 'sku_listing') {
      return { skuId: 'default-sku', productId: 'default-product' };
    }
    const name = (node as SkuListingNode).productName.trim();
    return {
      skuId: name || shape.id,
      productId: `${shape.id}|${name.toLowerCase()}`,
    };
  }, [editor]);

  useEffect(() => {
    mounted.current = true;
    closeRef.current?.focus();
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const build = useCallback(async () => {
    setBusy(true);
    setError('');
    setNotice('');
    setManifest(null);
    setConfirming(false);
    try {
      const record = await buildPassport(
        { sku_id: sku.skuId, platform },
        sku.productId,
      );
      if (!mounted.current) return;
      setPassport(record);
      if (canExport(record)) {
        try {
          setManifest(await fetchManifest(record.passport_id, sku.productId));
        } catch {
          setManifest(null); // contents preview is a convenience, not a verdict
        }
      }
    } catch (err) {
      if (mounted.current) setError(passportErrorMessage(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [platform, sku.skuId, sku.productId]);

  useEffect(() => {
    void build();
  }, [build]);

  const doExport = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await exportPackage(passport!.passport_id, sku.productId);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      // build() clears transient messages, so refresh first and announce after.
      await build();
      if (mounted.current) {
        setNotice(`已导出交接包（摘要 ${result.digest.slice(0, 12)}…）。未向任何平台发布。`);
        setConfirming(false);
      }
    } catch (err) {
      if (mounted.current) setError(passportErrorMessage(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const meta = passport ? READINESS_META[passport.readiness] : null;

  return (
    <div
      ref={dialogRef}
      className={styles.drawer}
      role="dialog"
      aria-modal="true"
      aria-labelledby="passport-title"
      id="passport-panel"
      data-testid="passport-panel"
    >
      <div className={styles.mask} aria-hidden="true" onClick={onClose} />
      <aside>
        <header>
          <div>
            <div className={styles.kicker}>发布护照 · 交接包</div>
            <h2 id="passport-title">交接什么、凭什么、谁批的、还差什么</h2>
          </div>
          <button ref={closeRef} type="button" className={styles.ghost} onClick={onClose}>
            关闭
          </button>
        </header>

        <div className={styles.platformTabs} role="tablist" aria-label="平台">
          {PLATFORMS.map(p => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={p.id === platform}
              data-testid="passport-platform"
              data-platform={p.id}
              className={p.id === platform ? styles.tabActive : styles.tab}
              onClick={() => setPlatform(p.id)}
            >
              {p.name}
            </button>
          ))}
        </div>

        <div className={styles.disclaimer} data-testid="passport-disclaimer">
          {HANDOFF_DISCLAIMER.map(line => (
            <p key={line}>{line}</p>
          ))}
        </div>

        {error && (
          <p className={styles.error} role="alert" data-testid="passport-error">
            {error}
          </p>
        )}
        {notice && !error && (
          <p className={styles.notice} role="status" data-testid="passport-notice">
            {notice}
          </p>
        )}

        {busy && !passport && <p className={styles.muted}>正在按当前记录计算交接状态…</p>}

        {passport && meta && (
          <>
            <section className={styles.section} data-testid="passport-summary">
              <div className={styles.sectionHead}>
                <h3>概览</h3>
                <span
                  className={styles.state}
                  data-tone={meta.tone}
                  data-readiness={passport.readiness}
                  data-testid="passport-readiness"
                >
                  {meta.label}
                </span>
              </div>
              {passport.readiness_reasons.length > 0 && (
                <ul className={styles.reasons} data-testid="passport-reasons">
                  {passport.readiness_reasons.map(r => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
              <dl className={styles.grid}>
                <div>
                  <dt>护照 ID</dt>
                  <dd>
                    <code data-testid="passport-id">{passport.passport_id}</code>
                  </dd>
                </div>
                <div>
                  <dt>SKU / 平台</dt>
                  <dd>
                    {passport.sku_id} · {passport.platform}
                  </dd>
                </div>
                <div>
                  <dt>已批准修订</dt>
                  <dd>{passport.revision_id ? <code>{passport.revision_id}</code> : '—'}</dd>
                </div>
                <div>
                  <dt>内容指纹</dt>
                  <dd>
                    <code>{passport.content_digest.slice(0, 16) || '—'}</code>
                  </dd>
                </div>
                <div>
                  <dt>市场 / 语言 / 币种</dt>
                  <dd>
                    {passport.locale.market ?? '—'} · {passport.locale.language ?? '—'} ·{' '}
                    {passport.locale.currency ?? '—'}
                    <small className={styles.declared}>
                      （由操作者声明，未经核验）
                    </small>
                  </dd>
                </div>
                <div>
                  <dt>生成方</dt>
                  <dd>
                    {[passport.generator.provider, passport.generator.model]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </dd>
                </div>
              </dl>
            </section>

            <section className={styles.section} data-testid="passport-coverage">
              <h3>覆盖范围</h3>
              <ul className={styles.coverage}>
                {coverage(passport).map(c => (
                  <li key={c.label} data-covered={c.covered}>
                    <b>{c.label}</b>
                    <i>{c.covered ? '已覆盖' : '未覆盖'}</i>
                    <span>{c.note}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section className={styles.section} data-testid="passport-content">
              <h3>内容</h3>
              {passport.revision_id ? (
                <>
                  <p className={styles.title}>{passport.listing.title || '（无标题）'}</p>
                  <dl className={styles.grid}>
                    {passport.listing.fields.map(f => (
                      <div key={f.label}>
                        <dt>{f.label}</dt>
                        <dd>{f.value || '（空）'}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className={styles.muted}>
                    修订谱系：{passport.revision_lineage.join(' → ') || '—'}
                  </p>
                </>
              ) : (
                <p className={styles.muted}>没有已批准的修订，无内容可交接。</p>
              )}
            </section>

            <section className={styles.section} data-testid="passport-facts">
              <h3>事实与证据</h3>
              {passport.facts.length === 0 ? (
                <p className={styles.muted}>
                  账本中没有任何产品事实。文案里的宣称**未被任何证据支撑**。
                </p>
              ) : (
                <ul className={styles.records}>
                  {passport.facts.map(f => (
                    <li key={f.fact_id}>
                      <div className={styles.recordHead}>
                        <code>{f.fact_id}</code>
                        <b>{f.display || f.value || f.key}</b>
                        <i data-state={f.state}>{f.state}</i>
                      </div>
                      {f.sources.length === 0 ? (
                        <span className={styles.muted}>无证据来源</span>
                      ) : (
                        <ul className={styles.links}>
                          {f.sources.map(s => (
                            <li key={s.source_id}>
                              {/* A link is offered only when the record exists. */}
                              {hasSource(passport, s.source_id) ? (
                                <code>{s.source_id}</code>
                              ) : (
                                <span className={styles.gone}>
                                  {s.source_id}（文件已不存在）
                                </span>
                              )}
                              <small>{s.method || '—'}</small>
                              {s.sha256 && <small>sha256 {s.sha256.slice(0, 12)}…</small>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className={styles.section} data-testid="passport-media">
              <h3>图片检查</h3>
              {passport.media.length === 0 ? (
                <p className={styles.muted} data-testid="passport-media-empty">
                  未检查任何图片。这一项**未覆盖**，不代表图片没有问题。
                </p>
              ) : (
                <ul className={styles.records}>
                  {passport.media.map(asset => {
                    const problem = mediaProblem(asset);
                    return (
                      <li key={asset.asset_id} data-problem={problem || undefined}>
                        <div className={styles.recordHead}>
                          <code>{asset.asset_id}</code>
                          <b>{asset.label}</b>
                          <span className={styles.muted}>
                            {asset.format} {asset.width}×{asset.height} ·{' '}
                            {formatBytes(asset.size_bytes)}
                          </span>
                          {problem && <i data-state="fail">{problem}</i>}
                        </div>
                        <ul className={styles.links}>
                          {asset.results
                            .filter(r => r.state !== 'pass')
                            .map(r => (
                              <li key={r.rule_id}>
                                <span data-tone={RESULT_STATE_META[r.state].tone}>
                                  {RESULT_STATE_META[r.state].label}
                                </span>
                                <code>{r.rule_id}</code>
                                <small>{r.detail}</small>
                              </li>
                            ))}
                        </ul>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className={styles.section} data-testid="passport-compliance">
              <h3>合规</h3>
              <p className={styles.muted}>
                政策快照：
                {passport.policy_snapshots.map(s => (
                  <code key={s.snapshot_id}>{s.snapshot_id}</code>
                ))}
                {passport.policy_snapshots.length === 0 && '—'}
              </p>
              {passport.blockers.length > 0 && (
                <p className={styles.bad}>阻断项：{passport.blockers.join('、')}</p>
              )}
              {passport.warnings.length > 0 && (
                <p className={styles.warn}>提醒项：{passport.warnings.join('、')}</p>
              )}
              {passport.manual_review.length > 0 && (
                <ul className={styles.manual} data-testid="passport-manual">
                  {passport.manual_review.map((m, i) => (
                    <li key={`${m.rule_id ?? m.field}-${i}`}>
                      <code>{m.rule_id ?? m.field}</code>
                      <span>{m.detail ?? m.claim}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className={styles.muted}>
                「需人工核验」既不是通过也不是不通过，它们不会因为导出而消失。
              </p>
            </section>

            <section className={styles.section} data-testid="passport-approvals">
              <h3>审批</h3>
              {passport.approvals.length === 0 ? (
                <p className={styles.muted}>没有审批记录。</p>
              ) : (
                <ul className={styles.records}>
                  {passport.approvals.map(a => (
                    <li key={a.approval_id}>
                      <div className={styles.recordHead}>
                        <code>{a.approval_id}</code>
                        <b>{a.decision}</b>
                        <span className={styles.muted}>
                          {a.operator} · {a.at}
                        </span>
                      </div>
                      {a.reason && <span className={styles.muted}>{a.reason}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className={styles.section} data-testid="passport-history">
              <h3>历史</h3>
              <ul className={styles.audit}>
                {passport.audit.slice(-12).map(e => (
                  <li key={e.event_id}>
                    <code>{e.event}</code>
                    <span>{e.revision_id}</span>
                    <small>
                      {e.operator || '系统'} · {e.at}
                    </small>
                  </li>
                ))}
                {passport.audit.length === 0 && <li className={styles.muted}>暂无事件。</li>}
              </ul>
            </section>

            <section className={styles.section} data-testid="passport-package">
              <h3>交接包内容</h3>
              {!canExport(passport) ? (
                <p className={styles.muted} data-testid="passport-no-export">
                  {passport.readiness === 'superseded'
                    ? '该护照已被更新版本取代，请重新生成后再导出。'
                    : '存在阻断项，未生成交接包。'}
                </p>
              ) : manifest ? (
                <>
                  <table className={styles.manifest} data-testid="passport-manifest">
                    <thead>
                      <tr>
                        <th>文件</th>
                        <th>字节</th>
                        <th>SHA-256</th>
                        <th>来源实体</th>
                      </tr>
                    </thead>
                    <tbody>
                      {manifest.files.map(f => (
                        <tr key={f.path}>
                          <td>
                            <code>{f.path}</code>
                          </td>
                          <td>{f.size_bytes}</td>
                          <td>
                            <code>{f.sha256.slice(0, 12)}…</code>
                          </td>
                          <td>
                            <code>{f.entity}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className={styles.muted}>{manifest.note}</p>
                </>
              ) : (
                <p className={styles.muted}>交接包内容预览暂不可用。</p>
              )}

              {canExport(passport) && (
                <div className={styles.exportBox}>
                  {!confirming ? (
                    <button
                      type="button"
                      className={styles.primary}
                      disabled={busy}
                      data-testid="passport-export"
                      onClick={() => setConfirming(true)}
                    >
                      导出交接包
                    </button>
                  ) : (
                    <div
                      className={styles.confirm}
                      role="alertdialog"
                      aria-label="确认导出交接包"
                      data-testid="passport-confirm"
                    >
                      <b>确认导出？</b>
                      <p>
                        这会把已批准的文案、已检查的图片原件、证据索引与审批记录打成一个 ZIP。
                        <strong>不会发布到任何平台</strong>；
                        {passport.manual_review.length > 0 &&
                          `包内仍有 ${passport.manual_review.length} 项需人工核验，由你负责确认。`}
                      </p>
                      <div className={styles.confirmBtns}>
                        <button
                          type="button"
                          className={styles.primary}
                          disabled={busy}
                          data-testid="passport-export-confirm"
                          onClick={doExport}
                        >
                          确认导出
                        </button>
                        <button
                          type="button"
                          className={styles.ghost}
                          disabled={busy}
                          data-testid="passport-export-cancel"
                          onClick={() => setConfirming(false)}
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  )}
                  {passport.export && (
                    <p className={styles.muted} data-testid="passport-export-record">
                      上次导出 {passport.export.exported_at} · {passport.export.files} 个文件 ·{' '}
                      {formatBytes(passport.export.bytes)} · 摘要{' '}
                      <code>{passport.export.digest.slice(0, 16)}…</code> · 已校验
                    </p>
                  )}
                </div>
              )}
            </section>
          </>
        )}
      </aside>
    </div>
  );
}

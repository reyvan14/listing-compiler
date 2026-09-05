import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useValue, type Editor } from 'tldraw';
import type { NodeShape } from '@/pipeline/nodes/NodeShapeUtil';
import {
  closeStoryboardPanel,
  storyboardPanelState,
} from '@/pipeline/nodes/types/storyboardPanel';
import { fetchFacts, type ProductFact } from '../evidenceApi';
import { fetchMediaVideo } from '../mediaApi';
import { listAssets, originalUrl, type ImageAsset } from '../media/imageApi';
import {
  SHOT_STATUS_META,
  cancelRun,
  createStoryboard,
  reportShot,
  fetchPackage,
  fetchProgress,
  fetchStoryboard,
  listStoryboards,
  planGeneration,
  saveShots,
  startRun,
  storyboardErrorMessage,
  type ContentPackage,
  type GenerationPlan,
  type Progress,
  type Shot,
  type Storyboard,
  type Validation,
} from './storyboardApi';
import {
  addShot,
  moveShot,
  packageSummary,
  progressLabel,
  removeShot,
  validationSummary,
} from './storyboardModel';
import styles from './storyboardPanel.module.scss';

// The storyboard workflow.
//
// A viewport-level panel rather than a taller node: it reads the canvas to find
// which video node opened it and never writes to the editor, so opening or
// closing it cannot move a shape or the camera.
//
// Every button here calls the real backend. The panel derives no status of its
// own — statuses, the model-call count and the progress sentence all come from
// the API, so nothing on screen can be more confident than the records behind it.

export function StoryboardPanel({ editor }: { editor: Editor }) {
  const panel = useValue('storyboard panel', () => storyboardPanelState.get(editor), [editor]);
  const open = panel.shapeId !== null;

  if (!open) return null;
  return (
    <StoryboardWorkflow
      editor={editor}
      skuId={panel.skuId}
      platform={panel.platform}
      onClose={() => closeStoryboardPanel(editor)}
    />
  );
}

function StoryboardWorkflow({
  editor,
  skuId,
  platform,
  onClose,
}: {
  editor: Editor;
  skuId: string;
  platform: string;
  onClose: () => void;
}) {
  const [board, setBoard] = useState<Storyboard | null>(null);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [plan, setPlan] = useState<GenerationPlan | null>(null);
  const [pkg, setPkg] = useState<ContentPackage | null>(null);
  const [facts, setFacts] = useState<ProductFact[]>([]);
  const [assets, setAssets] = useState<ImageAsset[]>([]);
  const [draft, setDraft] = useState<Shot[]>([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirming, setConfirming] = useState(false);
  const mounted = useRef(true);
  /** Aborts every in-flight provider call when the run is cancelled. */
  const runAbort = useRef<AbortController | null>(null);
  /**
   * Serialises draft writes while discarding queued snapshots that have already
   * been superseded by a later keystroke. Inputs stay editable while a save is
   * in flight, but an older response can never replace a newer draft.
   */
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const saveGeneration = useRef(0);
  const closeRef = useRef<HTMLButtonElement>(null);

  // The product scope the evidence and media ledgers are keyed by.
  const productId = useMemo(() => {
    const sku = editor
      .getCurrentPageShapes()
      .find(s => editor.isShapeOfType(s, 'node') && (s as NodeShape).props.node.type === 'sku_listing');
    if (!sku) return 'default-product';
    const node = (sku as NodeShape).props.node as { productName?: string };
    return `${sku.id}|${(node.productName ?? '').trim().toLowerCase()}`;
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

  const adopt = useCallback(
    (next: Storyboard, nextValidation?: Validation) => {
      setBoard(next);
      setDraft(next.shots);
      if (nextValidation) setValidation(nextValidation);
    },
    [],
  );

  // Load or create the storyboard for this SKU, plus the facts and images a
  // shot may reference.
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    (async () => {
      const existing = await listStoryboards(skuId, productId);
      const board = existing.length > 0 ? existing[existing.length - 1] : await createStoryboard(skuId, platform, productId);
      const full = await fetchStoryboard(board.storyboard_id, productId);
      if (cancelled || !mounted.current) return;
      adopt(full.storyboard, full.validation);
      setProgress(full.progress);
      const [factRows, assetRows] = await Promise.all([
        fetchFacts(productId).catch(() => []),
        listAssets(platform, productId).catch(() => []),
      ]);
      if (!cancelled && mounted.current) {
        setFacts(factRows);
        setAssets(assetRows);
      }
    })()
      .catch(err => {
        if (!cancelled && mounted.current) setError(storyboardErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled && mounted.current) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [skuId, platform, productId, adopt]);

  const refresh = useCallback(async () => {
    if (!board) return;
    const full = await fetchStoryboard(board.storyboard_id, productId);
    if (!mounted.current) return;
    adopt(full.storyboard, full.validation);
    setProgress(full.progress);
  }, [board, productId, adopt]);

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await refresh();
      if (mounted.current) setNotice(done);
    } catch (err) {
      if (mounted.current) setError(storyboardErrorMessage(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const persist = (shots: Shot[]) => {
    setDraft(shots);
    if (!board) return;
    const generation = ++saveGeneration.current;
    setSaving(true);
    setError('');
    setNotice('');

    const queued = saveQueue.current
      .catch(() => undefined)
      .then(async () => {
        // A newer edit arrived before this request started. Only the newest
        // queued snapshot needs to reach the server.
        if (generation !== saveGeneration.current) return;
        const res = await saveShots(board.storyboard_id, shots, productId);
        if (generation === saveGeneration.current && mounted.current) {
          setBoard(res.storyboard);
          setValidation(res.validation);
          setNotice('已保存分镜。');
        }
      })
      .catch(err => {
        if (generation === saveGeneration.current && mounted.current) {
          setError(storyboardErrorMessage(err));
        }
      })
      .finally(() => {
        if (generation === saveGeneration.current && mounted.current) setSaving(false);
      });
    saveQueue.current = queued;
  };

  const editShot = (shotId: string, patch: Partial<Shot>) => {
    persist(draft.map(s => (s.shot_id === shotId ? { ...s, ...patch } : s)));
  };

  const preview = async () => {
    if (!board) return;
    setError('');
    try {
      // A plan must be calculated from the latest text the operator sees, not
      // the last request that happened to finish.
      await saveQueue.current;
      const next = await planGeneration(board.storyboard_id, [], productId);
      if (mounted.current) {
        setPlan(next);
        setConfirming(next.requires_confirmation);
        if (!next.requires_confirmation && next.expected_model_calls === 0) {
          setNotice('所有分镜都已生成，无需再次调用。');
        }
      }
    } catch (err) {
      if (mounted.current) setError(storyboardErrorMessage(err));
    }
  };

  /**
   * Generate the planned shots, one real provider call each.
   *
   * The run token comes from the backend and travels with every result, so a
   * reply that arrives after a cancel is refused server-side rather than
   * overwriting the current state. Each shot is reported as soon as it settles,
   * which is what makes "shot 2/4" a real count rather than an estimate.
   */
  const generate = (shotIds: string[] = []) =>
    run(async () => {
      if (!board) return;
      const started = await startRun(board.storyboard_id, shotIds, productId);
      setConfirming(false);
      setPlan(null);

      const controller = new AbortController();
      runAbort.current = controller;
      adopt(started.storyboard);
      const startedProgress = await fetchProgress(board.storyboard_id, productId);
      if (mounted.current) setProgress(startedProgress);
      const targets = started.storyboard.shots.filter(s =>
        started.plan.shots_to_generate.includes(s.shot_id),
      );

      for (const shot of targets) {
        if (controller.signal.aborted) break;
        try {
          const media = await fetchMediaVideo(
            {
              prompt: shotPrompt(shot),
              aspectRatio: shot.platform === 'tiktok' ? '9:16' : '1:1',
              duration: `${Math.max(1, Math.round(shot.duration_s))}s`,
              resolution: '720p',
              firstFrameUrl: shot.source_image_asset_id
                ? originalUrl(shot.source_image_asset_id, productId)
                : null,
            },
            { signal: controller.signal },
          );
          await reportShot(board.storyboard_id, shot.shot_id, {
            run_token: started.run_token,
            status: 'succeeded',
            result_url: media.url,
          }, productId);
        } catch (err) {
          if (controller.signal.aborted) break;
          await reportShot(board.storyboard_id, shot.shot_id, {
            run_token: started.run_token,
            status: 'failed',
            error: storyboardErrorMessage(err),
          }, productId).catch(() => undefined);
        }
        // Refresh after each shot so progress moves as results actually land.
        await refresh().catch(() => undefined);
      }
      runAbort.current = null;
    }, shotIds.length === 1 ? '已重跑该分镜。' : '生成流程已结束。');

/** The instruction sent to the provider, assembled from the shot's own fields. */
  const shotPrompt = (shot: Shot): string =>
    [shot.instruction, shot.overlay_text && `画面文字：${shot.overlay_text}`]
      .filter(Boolean)
      .join('。')
      .slice(0, 2000) || shot.label;

  const downloadText = (name: string, body: string, mime: string) => {
    const blob = new Blob([body], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const verifiedFacts = facts.filter(f => f.state === 'verified');

  return (
    <div
      className={styles.drawer}
      role="dialog"
      aria-modal="true"
      aria-labelledby="storyboard-title"
      data-testid="storyboard-panel"
    >
      <div className={styles.mask} aria-hidden="true" onClick={onClose} />
      <aside>
        <header>
          <div>
            <div className={styles.kicker}>故事板 · {platform}</div>
            <h2 id="storyboard-title">分镜编辑 → 校验 → 确认 → 逐镜生成</h2>
          </div>
          <button ref={closeRef} type="button" className={styles.ghost} onClick={onClose}>
            关闭
          </button>
        </header>

        {error && (
          <p className={styles.error} role="alert" data-testid="storyboard-error">
            {error}
          </p>
        )}
        {notice && !error && (
          <p className={styles.notice} role="status" data-testid="storyboard-notice">
            {notice}
          </p>
        )}

        {!board && busy && <p className={styles.muted}>正在读取故事板…</p>}

        {board && (
          <>
            <section className={styles.section}>
              <div className={styles.sectionHead}>
                <h3>分镜（{draft.length}）</h3>
                <span className={styles.progress} data-testid="storyboard-progress">
                  {progressLabel(progress)}
                </span>
                {saving && <span className={styles.muted}>正在保存…</span>}
              </div>
              <p className={styles.muted} data-testid="storyboard-validation">
                {validationSummary(validation)}
              </p>

              <ol className={styles.shots} data-testid="storyboard-shots">
                {draft.map((shot, index) => {
                  const meta = SHOT_STATUS_META[shot.status];
                  return (
                    <li
                      key={shot.shot_id}
                      data-testid="storyboard-shot"
                      data-shot={shot.shot_id}
                      data-status={shot.status}
                    >
                      <div className={styles.shotHead}>
                        <b>
                          {index + 1}. {shot.label}
                        </b>
                        <span className={styles.time}>
                          {shot.start_s.toFixed(1)}s – {shot.end_s.toFixed(1)}s
                        </span>
                        <span className={styles.status} data-tone={meta.tone}>
                          {meta.label}
                        </span>
                        <span className={styles.muted}>{shot.platform}</span>
                      </div>

                      <div className={styles.shotGrid}>
                        <label>
                          <span>时长（秒）</span>
                          <input
                            type="number"
                            min={1}
                            max={15}
                            step={0.5}
                            value={shot.duration_s}
                            disabled={busy}
                            data-testid="shot-duration"
                            onChange={e =>
                              editShot(shot.shot_id, { duration_s: Number(e.target.value) })
                            }
                          />
                        </label>
                        <label className={styles.wide}>
                          <span>画面指令</span>
                          <input
                            type="text"
                            value={shot.instruction}
                            disabled={busy}
                            data-testid="shot-instruction"
                            onChange={e => editShot(shot.shot_id, { instruction: e.target.value })}
                          />
                        </label>
                        <label className={styles.wide}>
                          <span>字幕文字</span>
                          <input
                            type="text"
                            value={shot.overlay_text}
                            disabled={busy}
                            data-testid="shot-overlay"
                            onChange={e => editShot(shot.shot_id, { overlay_text: e.target.value })}
                          />
                        </label>
                        <label className={styles.wide}>
                          <span>旁白</span>
                          <input
                            type="text"
                            value={shot.narration}
                            disabled={busy}
                            data-testid="shot-narration"
                            onChange={e => editShot(shot.shot_id, { narration: e.target.value })}
                          />
                        </label>
                        <label>
                          <span>来源图片</span>
                          <select
                            value={shot.source_image_asset_id}
                            disabled={busy}
                            data-testid="shot-image"
                            onChange={e =>
                              editShot(shot.shot_id, { source_image_asset_id: e.target.value })
                            }
                          >
                            <option value="">（无）</option>
                            {assets.map(asset => (
                              <option key={asset.asset_id} value={asset.asset_id}>
                                {asset.label || asset.asset_id}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          <span>引用已核实事实</span>
                          <select
                            multiple
                            size={3}
                            value={shot.fact_ids}
                            disabled={busy}
                            data-testid="shot-facts"
                            onChange={e =>
                              editShot(shot.shot_id, {
                                fact_ids: [...e.target.selectedOptions].map(o => o.value),
                              })
                            }
                          >
                            {verifiedFacts.map(fact => (
                              <option key={fact.fact_id} value={fact.fact_id}>
                                {fact.display || fact.key}
                              </option>
                            ))}
                          </select>
                          {verifiedFacts.length === 0 && (
                            <small className={styles.muted}>
                              还没有已核实事实，先在「证据」里确认后才能引用。
                            </small>
                          )}
                        </label>
                      </div>

                      {shot.source_image_asset_id && (
                        <img
                          className={styles.thumb}
                          src={originalUrl(shot.source_image_asset_id, productId)}
                          alt="来源图片"
                          data-testid="shot-image-preview"
                        />
                      )}

                      {shot.error && (
                        <p className={styles.shotError} data-testid="shot-error">
                          {shot.error}
                        </p>
                      )}
                      {shot.result_url && (
                        <p className={styles.muted} data-testid="shot-result">
                          片段已生成 · 尝试 {shot.attempts} 次
                          {shot.provider_task_id && ` · 任务 ${shot.provider_task_id}`}
                        </p>
                      )}

                      <div className={styles.shotActions}>
                        <button
                          type="button"
                          disabled={busy || index === 0}
                          data-testid="shot-up"
                          onClick={() => persist(moveShot(draft, index, index - 1))}
                        >
                          上移
                        </button>
                        <button
                          type="button"
                          disabled={busy || index === draft.length - 1}
                          data-testid="shot-down"
                          onClick={() => persist(moveShot(draft, index, index + 1))}
                        >
                          下移
                        </button>
                        <button
                          type="button"
                          disabled={busy || draft.length <= 1}
                          data-testid="shot-remove"
                          onClick={() => persist(removeShot(draft, shot.shot_id))}
                        >
                          删除
                        </button>
                        {shot.status === 'failed' && (
                          <button
                            type="button"
                            className={styles.primary}
                            disabled={busy}
                            data-testid="shot-retry"
                            onClick={() => generate([shot.shot_id])}
                          >
                            重跑此镜（1 次调用）
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>

              <div className={styles.actions}>
                <button
                  type="button"
                  disabled={busy}
                  data-testid="storyboard-add-shot"
                  onClick={() => persist(addShot(draft))}
                >
                  添加分镜
                </button>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={busy || !validation?.ok}
                  data-testid="storyboard-preview-plan"
                  onClick={preview}
                >
                  校验并预览生成
                </button>
                {progress?.running && (
                  <button
                    type="button"
                    data-testid="storyboard-cancel"
                    onClick={() => {
                      // Stop the client polling as well as the server run, so a
                      // reply already in flight cannot land after the cancel.
                      runAbort.current?.abort();
                      runAbort.current = null;
                      setError('');
                      setNotice('正在取消…');
                      void cancelRun(board.storyboard_id, productId)
                        .then(refresh)
                        .then(() => mounted.current && setNotice('已取消本次生成。'))
                        .catch(err => mounted.current && setError(storyboardErrorMessage(err)));
                    }}
                  >
                    取消生成
                  </button>
                )}
              </div>
              {validation && !validation.ok && (
                <ul className={styles.problems} data-testid="storyboard-problems">
                  {validation.problems.map(p => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </section>

            {plan && confirming && (
              <div
                className={styles.confirm}
                role="alertdialog"
                aria-label="确认开始生成"
                data-testid="storyboard-confirm"
              >
                <b>确认开始生成？</b>
                <p>
                  本次将产生 <strong>{plan.expected_model_calls}</strong> 次付费生成调用
                  （分镜 {plan.shots_to_generate.join('、')}）。
                  {plan.skipped_already_succeeded.length > 0 &&
                    ` 已生成的 ${plan.skipped_already_succeeded.length} 个分镜不会重复付费。`}
                </p>
                <div className={styles.confirmBtns}>
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={busy}
                    data-testid="storyboard-confirm-yes"
                    onClick={() => generate()}
                  >
                    确认生成
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    data-testid="storyboard-confirm-cancel"
                    onClick={() => {
                      setConfirming(false);
                      setPlan(null);
                    }}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}

            <section className={styles.section} data-testid="storyboard-package">
              <h3>字幕与内容包</h3>
              <div className={styles.actions}>
                <button
                  type="button"
                  disabled={busy}
                  data-testid="storyboard-load-package"
                  onClick={() =>
                    fetchPackage(board.storyboard_id, productId)
                      .then(p => mounted.current && setPkg(p))
                      .catch(err => mounted.current && setError(storyboardErrorMessage(err)))
                  }
                >
                  读取内容包
                </button>
                {pkg && pkg.captions.webvtt.trim() !== 'WEBVTT' && (
                  <>
                    <button
                      type="button"
                      data-testid="storyboard-download-vtt"
                      onClick={() => downloadText('captions.vtt', pkg.captions.webvtt, 'text/vtt')}
                    >
                      下载 WebVTT
                    </button>
                    <button
                      type="button"
                      data-testid="storyboard-download-srt"
                      onClick={() =>
                        downloadText('captions.srt', pkg.captions.srt, 'application/x-subrip')
                      }
                    >
                      下载 SRT
                    </button>
                  </>
                )}
                {pkg && (
                  <button
                    type="button"
                    data-testid="storyboard-download-package"
                    onClick={() =>
                      downloadText(
                        `${pkg.storyboard_id}-content-package.json`,
                        JSON.stringify(pkg, null, 2),
                        'application/json',
                      )
                    }
                  >
                    下载内容包
                  </button>
                )}
              </div>

              {pkg ? (
                <>
                  <p className={styles.muted} data-testid="storyboard-package-summary">
                    {packageSummary(pkg)}
                  </p>
                  {pkg.captions.webvtt.trim() === 'WEBVTT' && (
                    <p className={styles.muted} data-testid="storyboard-no-captions">
                      还没有字幕文字或旁白，暂无可下载的字幕。
                    </p>
                  )}
                  {/* Only rendered when a composition step really produced a file. */}
                  {pkg.composed && pkg.final_video ? (
                    <p className={styles.notice} data-testid="storyboard-final-video">
                      已合成成片 · {pkg.final_video.duration_s}s
                    </p>
                  ) : (
                    <p className={styles.muted} data-testid="storyboard-not-composed">
                      {pkg.composition.note}
                    </p>
                  )}
                  <p className={styles.muted}>{pkg.narration.note}</p>
                </>
              ) : (
                <p className={styles.muted}>点「读取内容包」查看当前已生成的片段与字幕。</p>
              )}
            </section>
          </>
        )}
      </aside>
    </div>
  );
}

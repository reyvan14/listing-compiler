'use client';
/* station-tldraw */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DefaultToolbar,
  Editor,
  HandToolbarItem,
  SelectToolbarItem,
  Tldraw,
  TldrawOptions,
  TldrawUiToastsProvider,
  useEditor,
} from 'tldraw';
import { keepConnectionsAtBottom } from '@/pipeline/connection/keepConnectionsAtBottom';
import { disableTransparency } from '@/pipeline/disableTransparency';
import {
  AGENT_COLLAPSE_KEY,
  applyPromoConflict,
  deriveStationScreen,
  ensureSkuNode,
  findSkuShape,
  focusAllResults,
  focusSkuInput,
  frameStation,
  downloadAdCut,
  spawnAdResult,
  type StationScreen,
} from '@/pipeline/nodes/types/skuStation';
import { pipelineBindingUtils, pipelineShapeUtils } from '@/pipeline/pipelineTldrawUtils';
import { PointingPort } from '@/pipeline/ports/PointingPort';
import {
  LISTING_SOURCE_META,
  onListingSource,
  type ListingResultSource,
} from './listingApi';
import { fallbackRules, fetchRules, toSafeMessage, type RulesResult } from './rulesApi';
import { ListingInspector } from './ListingInspector';
import { MigrationPanel } from './MigrationPanel';
import { PortfolioPanel } from './PortfolioPanel';
import { FeedbackPanel } from './feedback/FeedbackPanel';
import { PassportPanel } from './passport/PassportPanel';
import { StoryboardPanel } from './storyboard/StoryboardPanel';
import { ProjectMenu } from './project/ProjectMenu';
import { useProjectPersistence } from './project/useProjectPersistence';
import { StationAgent } from './StationAgent';
import { StationSidebar } from './StationSidebar';
import styles from './nodes.module.scss';

const tldrawOptions: Partial<TldrawOptions> = {
  maxPages: 1,
  actionShortcutsLocation: 'toolbar',
};

const STATION_LICENSE =
  'tldraw-2026-08-25/WyI5WWVGX1dlciIsWyIqIl0sMTYsIjIwMjYtMDgtMjUiXQ.7jo9pTeLDXid0Qeg7Wgv8ICbAv/ZXAR5MTqAknAUBVksg5OW5pRacYKfhPhlxH2z8oT9aNGmjVNsGLGO232X1w';

const DESKTOP_MIN_WIDTH = 1180;

function StationScreenSync({ onScreen }: { onScreen: (screen: StationScreen) => void }) {
  const editor = useEditor();
  useEffect(() => {
    const push = () => {
      ensureSkuNode(editor);
      onScreen(deriveStationScreen(editor));
    };
    push();
    return editor.store.listen(push);
  }, [editor, onScreen]);
  return null;
}

function StationCanvas({
  onScreen,
  onEditor,
  onRestore,
}: {
  onScreen: (screen: StationScreen) => void;
  onEditor: (editor: Editor) => void;
  /** Load a stored project. Returns true when one was restored. */
  onRestore: (editor: Editor) => boolean;
}) {
  const components = useMemo(
    () => ({
      StylePanel: null,
      MenuPanel: null,
      HelperButtons: null,
      SharePanel: null,
      PageMenu: null,
      Toolbar: () => (
        <DefaultToolbar>
          <SelectToolbarItem />
          <HandToolbarItem />
        </DefaultToolbar>
      ),
    }),
    [],
  );

  return (
    <TldrawUiToastsProvider>
      <Tldraw
        licenseKey={STATION_LICENSE}
        className="station-tldraw"
        colorScheme="dark"
        options={tldrawOptions}
        shapeUtils={pipelineShapeUtils}
        bindingUtils={pipelineBindingUtils}
        components={components}
        onMount={next => {
          (window as unknown as { editor?: Editor }).editor = next;
          onEditor(next);
          next.setCameraOptions({ isLocked: false });
          next.updateInstanceState({ isGridMode: true });
          next.user.updateUserPreferences({
            colorScheme: 'dark',
            isSnapMode: true,
            locale: 'zh-cn',
          });
          const selectTool = next.getStateDescendant('select');
          if (selectTool && !next.getStateDescendant('select.pointing_port')) {
            selectTool.addChild(PointingPort);
          }
          keepConnectionsAtBottom(next);
          disableTransparency(next, ['connection']);
          // Restore first, then seed only if there was nothing to restore.
          // Seeding before restoring would either duplicate the SKU node or
          // discard it a moment later — and re-running the code that built the
          // graph would mint new nodes for work the operator already did.
          const restored = onRestore(next);
          if (!restored) {
            // Only the SKU listing node is seeded. Media (image / video) nodes
            // are added on demand via the sidebar, not on first load.
            ensureSkuNode(next);
          }
          next.selectNone();
          requestAnimationFrame(() => frameStation(next));
        }}
      >
        <StationScreenSync onScreen={onScreen} />
      </Tldraw>
    </TldrawUiToastsProvider>
  );
}

function readAgentCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(AGENT_COLLAPSE_KEY);
    if (stored === '1') return true;
    if (stored === '0') return false;
  } catch {
    /* ignore */
  }
  // default: collapsed on desktops ≤ 1280px wide so result cards get full width
  // and don't need the Agent moved out of the way. Must match agentGutterPx().
  return typeof window !== 'undefined' && window.innerWidth <= 1280;
}

export function StationApp() {
  const [screen, setScreen] = useState<StationScreen>('empty');
  const [rulesOpen, setRulesOpen] = useState(false);
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [portfolioOpen, setPortfolioOpen] = useState(false);
  const [passportOpen, setPassportOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [source, setSource] = useState<ListingResultSource | null>(null);
  // Browser-local project persistence. Owns auto-save and restore; the
  // server keeps its own durable records and is not duplicated here.
  const project = useProjectPersistence(editor);
  const [agentCollapsed, setAgentCollapsed] = useState<boolean>(() => readAgentCollapsed());
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < DESKTOP_MIN_WIDTH,
  );
  const rulesBtnRef = useRef<HTMLButtonElement>(null);

  const onScreen = useCallback((next: StationScreen) => {
    setScreen(next);
    if (next === 'empty') setSource(null);
  }, []);

  useEffect(() => {
    document.body.dataset.phase =
      screen === 'generating' ? 'generating' : screen === 'ad' ? 'ad' : screen === 'empty' ? 'intake' : 'result';
    document.body.dataset.mode = screen === 'conflict' ? 'promo' : 'compliant';
  }, [screen]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(''), 2200);
    return () => window.clearTimeout(t);
  }, [toast]);

  // Persistent source state (not a transient toast).
  useEffect(() => onListingSource(setSource), []);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < DESKTOP_MIN_WIDTH);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const toggleAgent = useCallback(() => {
    setAgentCollapsed(prev => {
      const next = !prev;
      try {
        localStorage.setItem(AGENT_COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      // The Agent is an absolute overlay and does not resize the tldraw
      // viewport. Reframing here changed the camera, which made the canvas
      // appear to jump whenever the panel was toggled.
      return next;
    });
  }, []);

  const withSku = (fn: (editor: Editor) => void) => {
    const ed = (window as unknown as { editor?: Editor }).editor;
    if (!ed) return;
    if (!findSkuShape(ed)) return;
    fn(ed);
  };

  const sourceMeta = source ? LISTING_SOURCE_META[source] : null;

  return (
    <div className={styles.page} data-screen={screen}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span>跨境上架编译器</span>
          <em>SKU 上新编译流程</em>
        </div>
        <p className={styles.headerLine}>拖标题或卡片空白可移动。空格拖动画布，或切手型。</p>
        <div className={styles.headerMeta}>
          <span>市场 US</span>
          <span>不自动上架 · 不担保过审</span>

          {sourceMeta && source !== 'local-sample' && (
            <span
              className={styles.sourceBadge}
              data-tone={sourceMeta.tone}
              title={sourceMeta.detail}
            >
              {sourceMeta.label}
            </span>
          )}

          <button
            type="button"
            className={styles.btnGhost}
            id="station-focus-input"
            onClick={() => editor && focusSkuInput(editor)}
          >
            聚焦输入
          </button>
          {(screen === 'result' || screen === 'conflict' || screen === 'ad') && (
            <button
              type="button"
              className={styles.btnGhost}
              id="station-focus-results"
              onClick={() => editor && focusAllResults(editor)}
            >
              查看全部结果
            </button>
          )}

          {(screen === 'result' || screen === 'conflict') && (
            <>
              <button
                type="button"
                className={styles.btnGhost}
                id="station-conflict"
                onClick={() =>
                  withSku(ed => {
                    const sku = findSkuShape(ed);
                    if (sku) applyPromoConflict(ed, sku);
                    setToast('已换成带字竖版，两台货架主图打红');
                  })
                }
              >
                换带字竖版
              </button>
              <button
                type="button"
                className={styles.btnPrimary}
                id="station-cut-ad"
                onClick={() =>
                  withSku(ed => {
                    const sku = findSkuShape(ed);
                    if (sku) spawnAdResult(ed, sku);
                  })
                }
              >
                切 15 秒投放
              </button>
            </>
          )}
          {screen === 'ad' && (
            <button
              type="button"
              className={styles.btnPrimary}
              id="station-download-ad"
              onClick={() => {
                const ed = (window as unknown as { editor?: Editor }).editor;
                const sku = ed ? findSkuShape(ed) : undefined;
                const name = sku && sku.props.node.type === 'sku_listing' ? sku.props.node.productName : '';
                downloadAdCut(name);
                setToast('已下载 15 秒投放条');
              }}
            >
              下载 15 秒成片
            </button>
          )}
          <button
            ref={rulesBtnRef}
            type="button"
            className={styles.btnPrimary}
            id="station-rules"
            onClick={() => setRulesOpen(true)}
          >
            规则表
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            id="station-migration"
            onClick={() => setMigrationOpen(true)}
          >
            规则变更 / 迁移
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            id="station-portfolio"
            onClick={() => setPortfolioOpen(true)}
          >
            批量迁移
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            id="station-passport"
            onClick={() => setPassportOpen(true)}
          >
            发布护照
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            id="station-feedback"
            onClick={() => setFeedbackOpen(true)}
          >
            反馈实验室
          </button>
          {editor && (
            <ProjectMenu
              editor={editor}
              status={project.status}
              onSaveNow={project.saveNow}
              onRestoreBackup={project.restoreBackup}
              onApply={project.applySnapshot}
              onForget={project.forget}
            />
          )}
        </div>
      </header>

      {narrow && (
        <p className={styles.banner} style={{ margin: 0, borderRadius: 0 }} role="status">
          当前窗口偏窄，建议在 ≥ {DESKTOP_MIN_WIDTH}px 宽度的桌面端使用。可折叠右侧 Agent 面板以腾出空间。
        </p>
      )}

      {source === 'local-sample' && (
        <p className={styles.sampleBanner} role="alert" id="station-local-sample-banner">
          ⚠ 当前展示的是<strong>本地示例数据</strong>，并非根据你的 SKU 生成。后端服务不可用，这不是模型生成结果。
        </p>
      )}

      {screen === 'conflict' && (
        <p className={styles.banner} style={{ margin: 0, borderRadius: 0 }}>
          带字竖版不能当 Amazon / TikTok Shop 商品主图。Shopify 和投放条可以用。
        </p>
      )}

      <div className={styles.canvas}>
        <StationCanvas onScreen={onScreen} onEditor={setEditor} onRestore={project.restoreInto} />
        {editor && <StationSidebar editor={editor} />}
        <StationAgent editor={editor} collapsed={agentCollapsed} onToggle={toggleAgent} />
      </div>

      {rulesOpen && <RulesDrawer onClose={() => setRulesOpen(false)} returnFocusTo={rulesBtnRef} />}

      {migrationOpen && editor && (
        <MigrationPanel editor={editor} onClose={() => setMigrationOpen(false)} />
      )}

      {/* Portfolio-wide migration. A table-shaped problem, so it is a compact
          dashboard rather than hundreds of canvas nodes. */}
      {portfolioOpen && <PortfolioPanel onClose={() => setPortfolioOpen(false)} />}

      {/* Release Passport. Reads stored records only; exporting a handoff
          package is a confirmed action and publishes to nothing. */}
      {passportOpen && editor && (
        <PassportPanel editor={editor} onClose={() => setPassportOpen(false)} />
      )}

      {/* Analytics live in their own panel: tables of numbers need columns, and
          the canvas gets at most a concise candidate node. */}
      {feedbackOpen && <FeedbackPanel onClose={() => setFeedbackOpen(false)} />}

      {/* Viewport-level listing detail. Reads the shapes, never writes them, so
          the canvas geometry and camera are untouched while it is open. */}
      {editor && <ListingInspector editor={editor} />}

      {/* Same rule for the storyboard: a shot list belongs in a panel, not in a
          node that would have to grow taller than the viewport. */}
      {editor && <StoryboardPanel editor={editor} />}

      {toast && (
        <div className={styles.toast} role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function RulesDrawer({
  onClose,
  returnFocusTo,
}: {
  onClose: () => void;
  returnFocusTo: React.RefObject<HTMLButtonElement | null>;
}) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; data: RulesResult }
    | { kind: 'error'; message: string; data: RulesResult }
  >({ kind: 'loading' });
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchRules(controller.signal)
      .then(data => setState({ kind: 'ready', data }))
      .catch(err =>
        setState({ kind: 'error', message: toSafeMessage(err), data: fallbackRules() }),
      );
    return () => controller.abort();
  }, []);

  // focus into the dialog on open; restore focus to the Rules button on close
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      (returnFocusTo.current ?? prev)?.focus?.();
    };
  }, [returnFocusTo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const data = state.kind === 'loading' ? null : state.data;
  const stale = state.kind === 'error' || (data?.stale ?? false);

  return (
    <div
      ref={dialogRef}
      className={styles.drawer}
      role="dialog"
      aria-modal="true"
      aria-labelledby="rules-title"
    >
      <div className={styles.mask} aria-hidden="true" onClick={onClose} />
      <aside>
        <header>
          <div>
            <div className={styles.kicker}>/api/rules · policy/snapshots</div>
            <h2 id="rules-title">公开条文，带出处和摘录日期</h2>
          </div>
          <button ref={closeRef} type="button" className={styles.btnGhost} onClick={onClose}>
            关闭
          </button>
        </header>

        {state.kind === 'loading' && <p className={styles.rulesNote}>正在从 /api/rules 加载…</p>}

        {stale && (
          <p className={styles.rulesError} role="alert">
            规则加载失败{state.kind === 'error' ? `（${state.message}）` : ''}，以下为内置备份，可能不是最新政策。
          </p>
        )}

        {data && (
          <>
            <p className={styles.rulesNote}>
              摘录日期 <code>{data.excerptDate || '—'}</code>
              {!stale && ' · 来自后端 /api/rules'}
            </p>
            <table>
              <thead>
                <tr>
                  <th>台 / 规则 ID</th>
                  <th>角色</th>
                  <th>规则摘录</th>
                  <th>出处</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map(r => (
                  <tr key={r.ruleId}>
                    <td>
                      {r.platform}
                      <br />
                      <code>{r.ruleId}</code>
                    </td>
                    <td>{r.role}</td>
                    <td>
                      {r.rule}
                      {r.image && r.image !== r.rule ? (
                        <>
                          <br />
                          <small>{r.image}</small>
                        </>
                      ) : null}
                    </td>
                    <td>
                      {r.sourceUrl ? (
                        <a href={r.sourceUrl} target="_blank" rel="noreferrer noopener">
                          {r.source || r.sourceUrl}
                        </a>
                      ) : (
                        r.source
                      )}
                      {r.referenceUrl && (
                        <>
                          <br />
                          <a href={r.referenceUrl} target="_blank" rel="noreferrer noopener">
                            {r.reference || r.referenceUrl}
                          </a>
                        </>
                      )}
                      <br />
                      <code>{r.excerptDate}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </aside>
    </div>
  );
}

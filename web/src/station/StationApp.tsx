'use client';
/* station-tldraw */

import { useCallback, useEffect, useMemo, useState } from 'react';
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
  applyPromoConflict,
  deriveStationScreen,
  ensureSkuNode,
  findSkuShape,
  frameStation,
  downloadAdCut,
  spawnAdResult,
  type StationScreen,
} from '@/pipeline/nodes/types/skuStation';
import { ensureMediaNodes } from '@/pipeline/nodes/types/mediaStation';
import { pipelineBindingUtils, pipelineShapeUtils } from '@/pipeline/pipelineTldrawUtils';
import { PointingPort } from '@/pipeline/ports/PointingPort';
import { RULE_ROWS } from './data';
import { StationAgent } from './StationAgent';
import { StationSidebar } from './StationSidebar';
import styles from './nodes.module.scss';

const tldrawOptions: Partial<TldrawOptions> = {
  maxPages: 1,
  actionShortcutsLocation: 'toolbar',
};

const STATION_LICENSE =
  'tldraw-2026-08-25/WyI5WWVGX1dlciIsWyIqIl0sMTYsIjIwMjYtMDgtMjUiXQ.7jo9pTeLDXid0Qeg7Wgv8ICbAv/ZXAR5MTqAknAUBVksg5OW5pRacYKfhPhlxH2z8oT9aNGmjVNsGLGO232X1w';

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
}: {
  onScreen: (screen: StationScreen) => void;
  onEditor: (editor: Editor) => void;
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
          ensureSkuNode(next);
          ensureMediaNodes(next);
          next.selectNone();
          requestAnimationFrame(() => frameStation(next));
        }}
      >
        <StationScreenSync onScreen={onScreen} />
      </Tldraw>
    </TldrawUiToastsProvider>
  );
}

export function StationApp() {
  const [screen, setScreen] = useState<StationScreen>('empty');
  const [rulesOpen, setRulesOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);

  const onScreen = useCallback((next: StationScreen) => {
    setScreen(next);
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

  useEffect(() => {
    const onSource = (event: Event) => {
      const detail = (event as CustomEvent<{ label?: string }>).detail;
      if (detail?.label) setToast(detail.label);
    };
    window.addEventListener('station-listing-source', onSource);
    return () => window.removeEventListener('station-listing-source', onSource);
  }, []);

  const withSku = (fn: (editor: Editor) => void) => {
    const editor = (window as unknown as { editor?: Editor }).editor;
    if (!editor) return;
    const sku = findSkuShape(editor);
    if (!sku) return;
    fn(editor);
  };

  return (
    <div className={styles.page} data-screen={screen}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span>跨境上架编译器</span>
          <em>SKU 上新工位</em>
        </div>
        <p className={styles.headerLine}>拖标题或卡片空白可移动。空格拖动画布，或切手型。</p>
        <div className={styles.headerMeta}>
          <span>市场 US</span>
          <span>不自动上架 · 不担保过审</span>
          {(screen === 'result' || screen === 'conflict') && (
            <>
              <button
                type="button"
                className={styles.btnGhost}
                id="station-conflict"
                onClick={() =>
                  withSku(editor => {
                    const sku = findSkuShape(editor);
                    if (sku) applyPromoConflict(editor, sku);
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
                  withSku(editor => {
                    const sku = findSkuShape(editor);
                    if (sku) spawnAdResult(editor, sku);
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
                const editor = (window as unknown as { editor?: Editor }).editor;
                const sku = editor ? findSkuShape(editor) : undefined;
                const name = sku && sku.props.node.type === 'sku_listing' ? sku.props.node.productName : '';
                downloadAdCut(name);
                setToast('已下载 15 秒投放条');
              }}
            >
              下载 15 秒成片
            </button>
          )}
          <button type="button" className={styles.btnPrimary} id="station-rules" onClick={() => setRulesOpen(true)}>
            规则表
          </button>
        </div>
      </header>

      {screen === 'conflict' && (
        <p className={styles.banner} style={{ margin: 0, borderRadius: 0 }}>
          带字竖版不能当 Amazon / TikTok Shop 商品主图。Shopify 和投放条可以用。
        </p>
      )}

      <div className={styles.canvas}>
        <StationCanvas onScreen={onScreen} onEditor={setEditor} />
        {editor && <StationSidebar editor={editor} />}
        <StationAgent />
      </div>

      {rulesOpen && (
        <div className={styles.drawer} role="dialog" aria-label="规则表">
          <button type="button" className={styles.mask} onClick={() => setRulesOpen(false)} aria-label="关闭" />
          <aside>
            <header>
              <div>
                <div className={styles.kicker}>rules.yaml</div>
                <h2>公开条文，带出处和摘录日期</h2>
              </div>
              <button type="button" className={styles.btnGhost} onClick={() => setRulesOpen(false)}>
                关闭
              </button>
            </header>
            <table>
              <thead>
                <tr>
                  <th>台</th>
                  <th>工位</th>
                  <th>主图</th>
                  <th>出处</th>
                </tr>
              </thead>
              <tbody>
                {RULE_ROWS.map(r => (
                  <tr key={r.platform}>
                    <td>{r.platform}</td>
                    <td>{r.role}</td>
                    <td>{r.image}</td>
                    <td>
                      {r.source}
                      <br />
                      <code>{r.date}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </aside>
        </div>
      )}

      {toast && <div className={styles.toast}>{toast}</div>}
    </div>
  );
}

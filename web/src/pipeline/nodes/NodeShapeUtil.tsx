import classNames from 'classnames';
import { i18n, I18nProvider } from '@/lib/i18n';
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import {
  Circle2d,
  Group2d,
  HTMLContainer,
  type IndexKey,
  RecordProps,
  Rectangle2d,
  resizeBox,
  ShapeUtil,
  T,
  TldrawUiContextProvider,
  TLResizeInfo,
  TLShape,
  useEditor,
  useValue,
} from 'tldraw';
import { PlayIcon } from '../components/icons/PlayIcon';
import { StopIcon } from '../components/icons/StopIcon';
import {
  NODE_FOOTER_HEIGHT_PX,
  NODE_HEADER_HEIGHT_PX,
  NODE_ROW_BOTTOM_PADDING_PX,
  NODE_ROW_HEADER_GAP_PX,
  PORT_RADIUS_PX,
} from '../constants';
import { executionState, startExecution, stopExecution } from '../execution/executionState';
import { guardRequiredInputs } from '../execution/requiredInputs';
import { Port } from '../ports/Port';
import { nodeShapeMigrations } from './nodeShapeMigrations';
import { getNodeOutputPortInfo, getNodePorts } from './nodePorts';
import {
  getNodeDefinition,
  getNodeHeightPx,
  getNodeTypePorts,
  getNodeWidthPx,
  NodeBody,
  NodeType,
} from './nodeTypes';
import { resizeNode } from './resizeNode';
import { NodeValue, parsePayload, STOP_EXECUTION } from './types/shared';

const NODE_TYPE = 'node';

declare module 'tldraw' {
  export interface TLGlobalShapePropsMap {
    [NODE_TYPE]: { node: NodeType; isOutOfDate: boolean };
  }
}

export type NodeShape = TLShape<typeof NODE_TYPE>;

function StationSkuPorts({ shape }: { shape: NodeShape }) {
  const editor = useEditor();
  const ports = useValue('sku ports', () => getNodeTypePorts(editor, shape), [shape, editor]);
  return (
    <>
      {Object.values(ports)
        .filter(port => port.id !== 'output')
        .map(port => (
          <Port key={port.id} shapeId={shape.id} portId={port.id} />
        ))}
    </>
  );
}

export class NodeShapeUtil extends ShapeUtil<NodeShape> {
  static override type = NODE_TYPE;
  static override props: RecordProps<NodeShape> = {
    node: NodeType,
    isOutOfDate: T.boolean,
  };
  // node 类型 props 迁移序列（单一事实源见 nodeShapeMigrations.ts）。
  static override migrations = nodeShapeMigrations;

  getDefaultProps(): NodeShape['props'] {
    return {
      node: getNodeDefinition(this.editor, 'sku_listing').getDefault(),
      isOutOfDate: false,
    };
  }

  override canEdit(_shape: NodeShape) {
    return false;
  }
  override canResize(shape: NodeShape) {
    return getNodeDefinition(this.editor, shape.props.node).canResizeNode;
  }
  override hideResizeHandles(shape: NodeShape) {
    return !this.canResize(shape);
  }
  override hideRotateHandle(_shape: NodeShape) {
    return true;
  }
  override hideSelectionBoundsBg(shape: NodeShape) {
    return !this.canResize(shape);
  }
  override hideSelectionBoundsFg(shape: NodeShape) {
    return !this.canResize(shape);
  }
  // 选中指示器：画 body 矩形 + 各端口圆圈。
  // 媒体节点(图片/视频，含结果节点)已用常驻 DOM <Port>「+」端口，这里不再画端口圈，避免叠成「两个圈」。
  // 注意：tldraw 5 实际渲染走的是下面的 getIndicatorPath()，indicator() 已不生效，仅保留两者逻辑一致。
  override indicator(shape: NodeShape) {
    const type = shape.props.node.type;
    const isMedia = type === 'image_generation' || type === 'video_generation';
    // 媒体节点：不画选区框也不画端口圈（与 getIndicatorPath 一致）。
    if (isMedia) return <g />;
    const width = getNodeWidthPx(this.editor, shape);
    const height = getNodeHeightPx(this.editor, shape);
    const ports = Object.values(getNodePorts(this.editor, shape));
    return (
      <g>
        <rect width={width} height={height} />
        {ports.map(port => (
          <circle key={port.id} cx={port.x} cy={port.y} r={PORT_RADIUS_PX} />
        ))}
      </g>
    );
  }
  override isAspectRatioLocked(_shape: NodeShape) {
    return false;
  }
  override getBoundsSnapGeometry(_shape: NodeShape) {
    return {
      points: [{ x: 0, y: 0 }],
    };
  }

  getGeometry(shape: NodeShape) {
    const ports = getNodePorts(this.editor, shape);
    const width = getNodeWidthPx(this.editor, shape);

    const portGeometries = Object.values(ports).map(
      port =>
        new Circle2d({
          x: port.x - PORT_RADIUS_PX,
          y: port.y - PORT_RADIUS_PX,
          radius: PORT_RADIUS_PX,
          isFilled: true,
          isLabel: true,
          excludeFromShapeBounds: true,
        }),
    );

    const bodyGeometry = new Rectangle2d({
      width,
      height: getNodeHeightPx(this.editor, shape),
      isFilled: true,
    });

    return new Group2d({
      children: [bodyGeometry, ...portGeometries],
    });
  }

  override onResize(shape: any, info: TLResizeInfo<any>) {
    const definition = getNodeDefinition(this.editor, shape.props.node);
    if (definition.canResizeNode) {
      const node = shape.props.node as { w: number; h: number; type: string };
      const prevW = getNodeWidthPx(this.editor, shape);
      const prevH = getNodeHeightPx(this.editor, shape);
      const newW = Math.max(200, Math.round(prevW * info.scaleX));
      const newH = Math.max(120, Math.round(prevH * info.scaleY));
      const bodyH =
        newH -
        NODE_HEADER_HEIGHT_PX -
        NODE_ROW_HEADER_GAP_PX -
        NODE_ROW_BOTTOM_PADDING_PX -
        NODE_FOOTER_HEIGHT_PX;

      return {
        ...resizeNode(shape, info),
        props: {
          ...shape.props,
          node: {
            ...node,
            w: newW,
            h:
              NODE_HEADER_HEIGHT_PX +
              NODE_ROW_HEADER_GAP_PX +
              Math.max(0, bodyH) +
              NODE_ROW_BOTTOM_PADDING_PX +
              NODE_FOOTER_HEIGHT_PX,
          },
        },
      };
    }
    return resizeBox(shape, info);
  }

  component(shape: NodeShape) {
    // return <NodeShapeComponent shape={shape} />
    return (
      <I18nProvider i18n={i18n}>
        <TldrawUiContextProvider>
          <NodeShapeComponent shape={shape} />
        </TldrawUiContextProvider>
      </I18nProvider>
    );
  }

  getIndicatorPath(shape: NodeShape) {
    const type = shape.props.node.type;
    const isMedia = type === 'image_generation' || type === 'video_generation';
    const path = new Path2D();
    // 媒体节点（图片/视频，含结果节点）：选中不画蓝色选区框——用面板弹出 + 自身 #A8A49B 边框作
    // 选中反馈（对齐设计意图）。返回空 path，tldraw 直接跳过描边、不回退默认框。
    if (isMedia) return path;
    const width = getNodeWidthPx(this.editor, shape);
    const height = getNodeHeightPx(this.editor, shape);
    path.rect(0, 0, width, height);
    const ports = Object.values(getNodePorts(this.editor, shape));
    for (const port of ports) {
      path.moveTo(port.x + PORT_RADIUS_PX, port.y);
      path.arc(port.x, port.y, PORT_RADIUS_PX, 0, Math.PI * 2);
    }
    return path;
  }
}

function NodeShapeComponent({ shape }: { shape: NodeShape }) {
  const editor = useEditor();

  const output = useValue(
    'output',
    () => getNodeOutputPortInfo(editor, shape.id)?.output ?? undefined,
    [editor, shape.id],
  );

  const isExecuting = useValue(
    'is executing',
    () => executionState.get(editor).runningGraph?.getNodeStatus(shape.id) === 'executing',
    [editor, shape.id],
  );

  const isGraphRunning = useValue(
    'is graph running',
    () => executionState.get(editor).runningGraph !== null,
    [editor],
  );

  // 媒体节点（图片/视频）选中态：用于切换「选中样式」（描边/标题/端口高亮）。
  // 媒体节点不画 tldraw 蓝框（见 getIndicatorPath），选中反馈靠自身 #A8A49B 描边等，需按选中态 gate。
  const isSelected = useValue(
    'is selected',
    () => editor.getSelectedShapeIds().includes(shape.id),
    [editor, shape.id],
  );

  // 选中即置顶：避免功能弹窗（配置面板/工具栏/裁剪条）被相邻更高 z 序的节点遮挡。
  // tldraw 遮挡按 shape 的 index 决定，弹窗的 z-index 仅在自身 stacking context 内有效，故须真正抬高 index。
  // 取消选中 / 卸载时恢复原 index（history:'ignore' 不进撤销栈；bringToFront 只改本 shape index，恢复即还原相对层级）。
  const prevIndexRef = useRef<IndexKey | null>(null);
  useEffect(() => {
    if (!isSelected) return;
    const original = editor.getShape(shape.id)?.index ?? null;
    prevIndexRef.current = original;
    editor.run(() => editor.bringToFront([shape.id]), { history: 'ignore' });
    return () => {
      const orig = prevIndexRef.current;
      prevIndexRef.current = null;
      if (orig && editor.getShape(shape.id)) {
        editor.run(() => editor.updateShape({ id: shape.id, type: shape.type, index: orig }), {
          history: 'ignore',
        });
      }
    };
  }, [isSelected, editor, shape.id, shape.type]);

  const nodeDefinition = getNodeDefinition(editor, shape.props.node);
  // 基础节点（图片/视频 Run 后 spawn 的结果节点）：去掉 header 输出端口（紫点），改为左右两侧常驻端口。
  const isResultNode = (shape.props.node as { isResultNode?: boolean }).isResultNode === true;
  // 媒体生成节点（图片/视频）：初始态也用左右两侧「+」端口（input 左 / output 右），header 不再画输出圆点。
  const isMedia =
    shape.props.node.type === 'image_generation' || shape.props.node.type === 'video_generation';
  // 本轮「选中态高亮 / 结果节点结构重构」只作用于视频节点：图片节点由同事 #40 重做、维持其原样，避免冲突。
  const isVideo = shape.props.node.type === 'video_generation';
  const isVideoResult = isVideo && isResultNode;
  const isStation =
    shape.props.node.type === 'sku_listing' || shape.props.node.type === 'listing_result';

  return (
    <HTMLContainer
      className={classNames('NodeShape', {
        NodeShape_executing: isExecuting,
        NodeShape_chromeless: !nodeDefinition.showHeading && !nodeDefinition.showFooter,
        NodeShape_image_generation: shape.props.node.type === 'image_generation',
        NodeShape_video_generation: shape.props.node.type === 'video_generation',
        // 选中态高亮（描边/标题/端口）——仅视频节点（图片节点维持 #40 原样）。
        NodeShape_selected: isVideo && isSelected,
        // 视频结果节点：卡片只装媒体（铺满）、标题浮到卡外上方、无卡内 header。
        NodeShape_mediaResult: isVideoResult,
        NodeShape_station: isStation,
      })}
      onContextMenu={e => {
        const target = e.target as HTMLElement;
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
          e.stopPropagation();
        }
      }}
    >
      {/* 视频结果节点：标题浮到卡片【外部上方】（不进卡内 header，卡片只装媒体）。 */}
      {isVideoResult && (
        <div className="NodeShape-mediaTitle">
          <div className="NodeShape-icon">{nodeDefinition.icon}</div>
          <div className="NodeShape-label">{nodeDefinition.heading ?? nodeDefinition.title}</div>
        </div>
      )}
      {nodeDefinition.showHeading && !isVideoResult && (
        <div className="NodeShape-heading">
          <div className="NodeShape-icon">{nodeDefinition.icon}</div>
          <div className="NodeShape-label">
            {nodeDefinition.getHeading(shape.props.node) ??
              nodeDefinition.heading ??
              nodeDefinition.title}
          </div>
          {output !== undefined &&
            !isResultNode &&
            !isMedia &&
            !isStation &&
            getNodePorts(editor, shape).output && (
            <>
              {/* 图片/视频输出在 header 里显示 URL 文本没意义，只保留端口圆点。 */}
              {output.dataType !== 'image' && output.dataType !== 'video' && (
                <div className="NodeShape-output">
                  <NodeValue
                    value={
                      output.isOutOfDate
                        ? STOP_EXECUTION
                        : output.multi
                          ? output.value[0]
                          : output.value
                    }
                  />
                </div>
              )}
              <Port shapeId={shape.id} portId="output" />
            </>
          )}
        </div>
      )}
      <NodeBody shape={shape} />
      {/* 结果节点 / 媒体生成节点：左右两侧常驻「+」端口（input 左 / output 右，垂直居中）。 */}
      {(isResultNode || isMedia) && (
        <div className="NodeShape-sidePorts">
          <Port shapeId={shape.id} portId="input" />
          <Port shapeId={shape.id} portId="output" />
        </div>
      )}
      {nodeDefinition.showFooter && (
        <div className="NodeShape-footer">
          <button
            className={classNames('NodeShape-footer-action', {
              'NodeShape-footer-action_executing': isExecuting,
            })}
            onPointerDown={e => e.stopPropagation()}
            onClick={() => {
              if (isGraphRunning) {
                stopExecution(editor);
              } else {
                const ids = new Set([shape.id]);
                if (guardRequiredInputs(editor, ids)) {
                  startExecution(editor, ids);
                }
              }
            }}
          >
            {isExecuting ? <StopIcon /> : <PlayIcon />}
            <span>{isExecuting ? 'Stop' : 'Play from here'}</span>
          </button>
          <NodeFooterMenu shape={shape} />
        </div>
      )}

      {shape.props.node.type === 'sku_listing' && <StationSkuPorts shape={shape} />}
    </HTMLContainer>
  );
}

function NodeFooterMenu({ shape }: { shape: NodeShape }) {
  const editor = useEditor();

  const outputInfo = useValue('output info', () => getNodeOutputPortInfo(editor, shape.id), [
    editor,
    shape.id,
  ]);

  // Find any image output that has a valid URL
  const imageUrl = Object.values(outputInfo).find(
    info =>
      info.dataType === 'image' &&
      typeof info.value === 'string' &&
      info.value &&
      info.value !== '',
  )?.value as string | undefined;

  const node = shape.props.node as Record<string, unknown>;
  const definition = getNodeDefinition(editor, shape.props.node);
  const resultKeys = definition.resultKeys;
  const defaults = definition.getDefault() as Record<string, unknown>;
  const hasResult = resultKeys ? resultKeys.some(key => node[key] !== defaults[key]) : false;
  const textOutput = Object.values(outputInfo).find(
    info => info.dataType === 'text' && typeof info.value === 'string' && info.value !== '',
  )?.value as string | undefined;
  // 结构化节点（圈层画像等）的 text 输出是 payload JSON 串，复制/展示只取 summary。
  const summaryOutput = textOutput != null ? parsePayload(textOutput).summary : '';
  const textResult =
    (summaryOutput !== '' ? summaryOutput : undefined) ??
    (typeof node.lastResultText === 'string' && node.lastResultText !== ''
      ? (node.lastResultText as string)
      : null);

  const handleDuplicate = useCallback(() => {
    editor.markHistoryStoppingPoint('duplicate node');
    editor.duplicateShapes([shape.id]);
  }, [editor, shape.id]);

  const handleDownloadImage = useCallback(async () => {
    if (!imageUrl) return;
    const response = await fetch(imageUrl);
    const blob = await response.blob();
    const ext = blob.type.split('/')[1] ?? 'png';
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `image.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  }, [imageUrl]);

  const handleCopyText = useCallback(async () => {
    if (!textResult) return;
    await navigator.clipboard.writeText(textResult);
  }, [textResult]);

  const handleClearResult = useCallback(() => {
    if (!resultKeys || resultKeys.length === 0) return;
    const updates: Record<string, unknown> = {};
    for (const key of resultKeys) {
      updates[key] = defaults[key];
    }

    editor.updateShape({
      id: shape.id,
      type: shape.type,
      props: {
        node: { ...(shape.props.node as any), ...updates },
        isOutOfDate: true,
      },
    });
  }, [editor, resultKeys, defaults, shape]);

  // Plain-HTML dropdown. Node shape components render outside the tldraw UI
  // context, so tldraw UI primitives (TldrawUi*) can't be used here — they'd
  // throw "useCurrentTranslation must be used inside of <TldrawUiContextProvider />".
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [open]);

  const runItem = useCallback((fn: () => void) => {
    fn();
    setOpen(false);
  }, []);

  return (
    <div
      ref={menuRef}
      className="NodeFooterMenu"
      style={{ position: 'relative' }}
      onPointerDown={e => e.stopPropagation()}
    >
      <button
        type="button"
        className="NodeFooterMenu-trigger"
        title="More options"
        onClick={() => setOpen(o => !o)}
      >
        <svg width="12" height="12" viewBox="0 0 12 12">
          <circle cx="6" cy="2" r="1.2" fill="currentColor" />
          <circle cx="6" cy="6" r="1.2" fill="currentColor" />
          <circle cx="6" cy="10" r="1.2" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div
          className="NodeFooterMenu-content"
          style={NODE_FOOTER_MENU_CONTENT_STYLE}
          onWheel={e => e.stopPropagation()}
        >
          <button
            type="button"
            className="NodeFooterMenu-item"
            style={NODE_FOOTER_MENU_ITEM_STYLE}
            onClick={() => runItem(handleDuplicate)}
          >
            Duplicate
          </button>
          {imageUrl && (
            <button
              type="button"
              className="NodeFooterMenu-item"
              style={NODE_FOOTER_MENU_ITEM_STYLE}
              onClick={() => runItem(handleDownloadImage)}
            >
              Download image
            </button>
          )}
          {textResult && (
            <button
              type="button"
              className="NodeFooterMenu-item"
              style={NODE_FOOTER_MENU_ITEM_STYLE}
              onClick={() => runItem(handleCopyText)}
            >
              Copy text
            </button>
          )}
          {hasResult && (
            <button
              type="button"
              className="NodeFooterMenu-item"
              style={NODE_FOOTER_MENU_ITEM_STYLE}
              onClick={() => runItem(handleClearResult)}
            >
              Clear result
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const NODE_FOOTER_MENU_CONTENT_STYLE: CSSProperties = {
  position: 'absolute',
  bottom: 'calc(100% + 4px)',
  right: 0,
  minWidth: 140,
  padding: 4,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  background: 'var(--color-panel, #2b2b2b)',
  border: '1px solid var(--color-divider, rgba(255,255,255,0.12))',
  borderRadius: 8,
  boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
  zIndex: 1000,
};

const NODE_FOOTER_MENU_ITEM_STYLE: CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '6px 10px',
  background: 'transparent',
  border: 'none',
  borderRadius: 4,
  color: 'var(--color-text, inherit)',
  fontSize: 12,
  lineHeight: 1.4,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

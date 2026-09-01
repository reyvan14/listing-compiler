import { getInputs } from '@/lib/pipeline-spec';
import classNames from 'classnames';
import {
  CubicBezier2d,
  Editor,
  IndexKey,
  Mat,
  RecordProps,
  SVGContainer,
  ShapeUtil,
  TLHandle,
  TLHandleDragInfo,
  TLShape,
  TLShapeId,
  Vec,
  VecLike,
  VecModel,
  clamp,
  createShapeId,
  useEditor,
  useValue,
  vecModelValidator,
} from 'tldraw';
import { onCanvasNodePickerState } from '../components/OnCanvasNodePicker';
import { PORT_TYPE_COLORS, PortDataType } from '../constants';
import {
  getAllConnectedNodes,
  getNodeOutputPortInfo,
  getNodePorts,
  getPortDataType,
} from '../nodes/nodePorts';
import { STOP_EXECUTION } from '../nodes/types/shared';
import { getPortAtPoint } from '../ports/getPortAtPoint';
import { findFirstCompatiblePort } from '../ports/portCompatibility';
import { updatePortState } from '../ports/portState';
import {
  createOrUpdateConnectionBinding,
  getConnectionBindingPositionInPageSpace,
  getConnectionBindings,
  removeConnectionBinding,
} from './ConnectionBindingUtil';

const CONNECTION_TYPE = 'connection';

/**
 * T0.6a 语义校验：输入端口仅接受 @yidooo/pipeline-spec 声明的来源节点类型。
 * 返回 true 表示「不兼容、应拒绝」。仅当输入端口在 spec 中声明了非空 acceptsNodeTypes 时生效；
 * 未登记的端口（如尚未对齐的技术型端口）返回 false（按 dataType 兼容性放行），避免误伤。
 */
function isNodeTypeIncompatible(
  editor: Editor,
  inputNodeId: TLShapeId | undefined,
  inputPortId: string | undefined,
  sourceNodeId: TLShapeId | undefined,
): boolean {
  if (!inputNodeId || !inputPortId || !sourceNodeId) return false;
  const inputNode = editor.getShape(inputNodeId);
  const sourceNode = editor.getShape(sourceNodeId);
  if (!inputNode || !editor.isShapeOfType(inputNode, 'node')) return false;
  if (!sourceNode || !editor.isShapeOfType(sourceNode, 'node')) return false;
  const spec = getInputs(inputNode.props.node.type).find(i => i.portId === inputPortId);
  if (!spec || spec.acceptsNodeTypes.length === 0) return false;
  return !spec.acceptsNodeTypes.includes(sourceNode.props.node.type);
}

declare module 'tldraw' {
  export interface TLGlobalShapePropsMap {
    [CONNECTION_TYPE]: {
      start: VecModel;
      end: VecModel;
    };
  }
}

export type ConnectionShape = TLShape<typeof CONNECTION_TYPE>;

export class ConnectionShapeUtil extends ShapeUtil<ConnectionShape> {
  static override type = CONNECTION_TYPE;
  static override props: RecordProps<ConnectionShape> = {
    start: vecModelValidator,
    end: vecModelValidator,
  };

  /** Connection ID that will be replaced if the current drag completes on an occupied port. */
  private pendingReplacementId: TLShapeId | null = null;

  getDefaultProps(): ConnectionShape['props'] {
    return {
      start: { x: 0, y: 0 },
      end: { x: 100, y: 100 },
    };
  }

  override canEdit(_shape: ConnectionShape) {
    return false;
  }
  override canResize(_shape: ConnectionShape) {
    return false;
  }
  override hideResizeHandles(_shape: ConnectionShape) {
    return true;
  }
  override hideRotateHandle(_shape: ConnectionShape) {
    return true;
  }
  override hideSelectionBoundsBg(_shape: ConnectionShape) {
    return true;
  }
  override hideSelectionBoundsFg(_shape: ConnectionShape) {
    return true;
  }
  override canSnap(_shape: ConnectionShape) {
    return false;
  }
  override getBoundsSnapGeometry(_shape: ConnectionShape) {
    return {
      points: [],
    };
  }

  getGeometry(connection: ConnectionShape) {
    const { start, end } = getConnectionTerminals(this.editor, connection);
    const [cp1, cp2] = getConnectionControlPoints(start, end);
    return new CubicBezier2d({
      start: Vec.From(start),
      cp1: Vec.From(cp1),
      cp2: Vec.From(cp2),
      end: Vec.From(end),
    });
  }

  getHandles(connection: ConnectionShape): TLHandle[] {
    const { start, end } = getConnectionTerminals(this.editor, connection);
    return [
      {
        id: 'start',
        type: 'vertex',
        index: 'a0' as IndexKey,
        x: start.x,
        y: start.y,
      },
      {
        id: 'end',
        type: 'vertex',
        index: 'a1' as IndexKey,
        x: end.x,
        y: end.y,
      },
    ];
  }

  onHandleDrag(connection: ConnectionShape, { handle }: TLHandleDragInfo<ConnectionShape>) {
    console.log('onHandleDrag');
    const existingBindings = getConnectionBindings(this.editor, connection);
    const draggingTerminal = handle.id as 'start' | 'end';
    const oppositeTerminal = draggingTerminal === 'start' ? 'end' : 'start';
    const oppositeTerminalShapeId = existingBindings[oppositeTerminal]?.toId;

    const shapeTransform = this.editor.getShapePageTransform(connection);
    const handlePagePosition = shapeTransform.applyToPoint(handle);

    const target = getPortAtPoint(this.editor, handlePagePosition, {
      margin: 8,
      terminal: handle.id as 'start' | 'end',
    });

    const existingConnectionOnTarget =
      target?.existingConnections.find(c => c.connectionId !== connection.id) ?? null;

    const nodesWhichWouldCreateACycle = oppositeTerminalShapeId
      ? getAllConnectedNodes(this.editor, oppositeTerminalShapeId, draggingTerminal)
      : null;

    // Determine the data type of the opposite end for type-checking
    const oppositeBinding = existingBindings[oppositeTerminal];
    let dragDataType: PortDataType | null = null;
    if (oppositeBinding) {
      dragDataType = getPortDataType(
        this.editor,
        oppositeBinding.toId,
        oppositeBinding.props.portId,
      );
    }

    updatePortState(this.editor, {
      eligiblePorts: {
        terminal: draggingTerminal,
        excludeNodes: nodesWhichWouldCreateACycle,
        dataType: dragDataType,
      },
    });

    // Check type compatibility
    const isTypeIncompatible =
      target &&
      dragDataType &&
      dragDataType !== 'any' &&
      target.port.dataType !== 'any' &&
      target.port.dataType !== dragDataType;

    // 语义校验（T0.6a）：输入端口仅接受 spec 声明的来源节点类型。
    // 找出「输入端口侧」与「来源节点侧」：target 端口为 'end' 时它本身是输入端口，
    // 来源为对侧已绑定节点；target 端口为 'start' 时输入端口在对侧。
    let isNodeKindIncompatible = false;
    if (target) {
      if (target.port.terminal === 'end') {
        isNodeKindIncompatible = isNodeTypeIncompatible(
          this.editor,
          target.shape.id,
          target.port.id,
          oppositeTerminalShapeId,
        );
      } else {
        const oppositeEndBinding = existingBindings[oppositeTerminal];
        isNodeKindIncompatible = isNodeTypeIncompatible(
          this.editor,
          oppositeEndBinding?.toId,
          oppositeEndBinding?.props.portId,
          target.shape.id,
        );
      }
    }

    const wouldCreateACycle =
      (target && nodesWhichWouldCreateACycle?.has(target.shape.id)) ?? false;
    if (!target || wouldCreateACycle || isTypeIncompatible || isNodeKindIncompatible) {
      this.pendingReplacementId = null;
      updatePortState(this.editor, { hintingPort: null });

      removeConnectionBinding(this.editor, connection, draggingTerminal);

      return {
        ...connection,
        props: {
          [handle.id]: { x: handle.x, y: handle.y },
        },
      };
    }

    // Track the connection that would be replaced, but don't delete it yet.
    // Multi-ports accept multiple connections, so skip replacement for them.
    this.pendingReplacementId =
      existingConnectionOnTarget && draggingTerminal === 'end' && !target.port.multi
        ? existingConnectionOnTarget.connectionId
        : null;

    updatePortState(this.editor, {
      hintingPort: { portId: target.port.id, shapeId: target.shape.id },
    });

    createOrUpdateConnectionBinding(this.editor, connection, target.shape, {
      portId: target.port.id,
      terminal: draggingTerminal,
    });

    return connection;
  }

  onHandleDragEnd(connection: ConnectionShape, data: TLHandleDragInfo<ConnectionShape>) {
    const { handle, isCreatingShape } = data;
    // Delete the connection being replaced now that the drag is committed.
    if (this.pendingReplacementId) {
      this.editor.deleteShapes([this.pendingReplacementId]);
      this.pendingReplacementId = null;
    }

    updatePortState(this.editor, { hintingPort: null, eligiblePorts: null });

    const draggingTerminal = handle.id as 'start' | 'end';

    const bindings = getConnectionBindings(this.editor, connection);
    const endBinding = bindings.end;
    const sourceShape = endBinding ? this.editor.getShape(endBinding.toId) : null;
    if (bindings[draggingTerminal]) {
      return;
    }
    /**
     * 从 chatBlot start 拉起连接线，连接到 chatBlot
     */
    const isToMessageNode =
      draggingTerminal === 'start' && sourceShape?.props?.node?.type === 'message';
    if ((isCreatingShape && draggingTerminal === 'end') || isToMessageNode) {
      this.editor.selectNone();
      onCanvasNodePickerState.set(this.editor, {
        connectionShapeId: connection.id,
        location: draggingTerminal,
        onClose: () => {
          const bindings = getConnectionBindings(this.editor, connection);
          if (!bindings.start || !bindings.end) {
            this.editor.deleteShapes([connection.id]);
          }
        },
        onPick: (nodeType, terminalInPageSpace) => {
          const newNodeId = createShapeId();

          this.editor.createShape({
            type: 'node',
            id: newNodeId,
            x: terminalInPageSpace.x,
            y: terminalInPageSpace.y,
            props: {
              node: nodeType,
            },
          });

          this.editor.select(newNodeId);

          const bindings = getConnectionBindings(this.editor, connection);
          const ports = getNodePorts(this.editor, newNodeId);

          if (draggingTerminal === 'end') {
            const sourceDataType = bindings.start
              ? (getPortDataType(this.editor, bindings.start.toId, bindings.start.props.portId) ??
                'any')
              : 'any';

            const firstCompatibleInputPort = findFirstCompatiblePort(
              Object.values(ports),
              'end',
              sourceDataType,
            );

            if (!firstCompatibleInputPort) {
              this.editor.deleteShapes([newNodeId]);
              return;
            }

            this.editor.updateShape({
              id: newNodeId,
              type: 'node',
              x: terminalInPageSpace.x - firstCompatibleInputPort.x,
              y: terminalInPageSpace.y - firstCompatibleInputPort.y,
            });

            createOrUpdateConnectionBinding(this.editor, connection, newNodeId, {
              portId: firstCompatibleInputPort.id,
              terminal: 'end',
            });

            return;
          }

          if (draggingTerminal === 'start') {
            const targetDataType = bindings.end
              ? (getPortDataType(this.editor, bindings.end.toId, bindings.end.props.portId) ??
                'any')
              : 'any';

            const firstCompatibleOutputPort = findFirstCompatiblePort(
              Object.values(ports),
              'start',
              targetDataType,
            );

            if (!firstCompatibleOutputPort) {
              this.editor.deleteShapes([newNodeId]);
              return;
            }

            this.editor.updateShape({
              id: newNodeId,
              type: 'node',
              x: terminalInPageSpace.x - firstCompatibleOutputPort.x,
              y: terminalInPageSpace.y - firstCompatibleOutputPort.y,
            });

            createOrUpdateConnectionBinding(this.editor, connection, newNodeId, {
              portId: firstCompatibleOutputPort.id,
              terminal: 'start',
            });

            return;
          }
        },
      });
    } else {
      if (!bindings.start || !bindings.end) {
        this.editor.deleteShapes([connection.id]);
      }
    }
  }

  onHandleDragCancel() {
    this.pendingReplacementId = null;
    updatePortState(this.editor, { hintingPort: null, eligiblePorts: null });
  }

  component(connection: ConnectionShape) {
    return <ConnectionShapeComponent connection={connection} />;
  }

  getIndicatorPath(connection: ConnectionShape) {
    const { start, end } = getConnectionTerminals(this.editor, connection);
    return new Path2D(getConnectionPath(start, end));
  }
}

function ConnectionShapeComponent({ connection }: { connection: ConnectionShape }) {
  const editor = useEditor();

  const { start, end } = useValue('terminals', () => getConnectionTerminals(editor, connection), [
    editor,
    connection,
  ]);

  // Get the data type color for this connection from its start binding
  const connectionColor = useValue(
    'connectionColor',
    () => {
      const bindings = getConnectionBindings(editor, connection.id);
      if (!bindings.start) return null;
      const dataType = getPortDataType(editor, bindings.start.toId, bindings.start.props.portId);
      return dataType ? PORT_TYPE_COLORS[dataType] : null;
    },
    [connection.id, editor],
  );

  const isInactive = useValue(
    'isInactive',
    () => {
      const bindings = getConnectionBindings(editor, connection.id);
      if (!bindings.start) return false;
      const originShapeId = bindings.start?.toId;
      if (!originShapeId) return false;
      const outputs = getNodeOutputPortInfo(editor, originShapeId);
      const output = outputs[bindings.start.props.portId];
      return output?.value === STOP_EXECUTION;
    },
    [connection.id, editor],
  );

  return (
    <SVGContainer
      className={classNames('ConnectionShape', isInactive && 'ConnectionShape_inactive')}
    >
      <path
        d={getConnectionPath(start, end)}
        style={connectionColor ? { stroke: connectionColor } : undefined}
      />
    </SVGContainer>
  );
}

export function getConnectionControlPoints(start: VecLike, end: VecLike): [Vec, Vec] {
  const distance = end.x - start.x;
  const adjustedDistance = Math.max(
    30,
    distance > 0 ? distance / 3 : clamp(Math.abs(distance) + 30, 0, 100),
  );
  return [new Vec(start.x + adjustedDistance, start.y), new Vec(end.x - adjustedDistance, end.y)];
}

/**
 * Page-space midpoint of a connection's bezier curve, for positioning the
 * center insert handle. Returns null when the connection isn't fully bound.
 */
export function getConnectionPageCenter(editor: Editor, connection: ConnectionShape): Vec | null {
  const bindings = getConnectionBindings(editor, connection);
  if (!bindings.start || !bindings.end) return null;
  const startPage = getConnectionBindingPositionInPageSpace(editor, bindings.start);
  const endPage = getConnectionBindingPositionInPageSpace(editor, bindings.end);
  if (!startPage || !endPage) return null;
  const [cp1, cp2] = getConnectionControlPoints(startPage, endPage);
  // Cubic bezier midpoint at t=0.5: (P0 + 3·P1 + 3·P2 + P3) / 8
  return new Vec(
    (startPage.x + 3 * cp1.x + 3 * cp2.x + endPage.x) / 8,
    (startPage.y + 3 * cp1.y + 3 * cp2.y + endPage.y) / 8,
  );
}

function getConnectionPath(start: VecLike, end: VecLike) {
  const [cp1, cp2] = getConnectionControlPoints(start, end);
  return `M ${start.x} ${start.y} C ${cp1.x} ${cp1.y} ${cp2.x} ${cp2.y} ${end.x} ${end.y}`;
}

export function getConnectionTerminals(editor: Editor, connection: ConnectionShape) {
  let start, end;

  const bindings = getConnectionBindings(editor, connection);
  const shapeTransform = Mat.Inverse(editor.getShapePageTransform(connection));
  if (bindings.start) {
    const inPageSpace = getConnectionBindingPositionInPageSpace(editor, bindings.start);
    if (inPageSpace) {
      start = Mat.applyToPoint(shapeTransform, inPageSpace);
    }
  }
  if (bindings.end) {
    const inPageSpace = getConnectionBindingPositionInPageSpace(editor, bindings.end);
    if (inPageSpace) {
      end = Mat.applyToPoint(shapeTransform, inPageSpace);
    }
  }

  if (!start) start = connection.props.start;
  if (!end) end = connection.props.end;

  return { start, end };
}

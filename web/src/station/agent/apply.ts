import { createShapeId, type Editor, type TLShapeId } from 'tldraw';
import type { NodeShape } from '@/pipeline/nodes/NodeShapeUtil';
import { getNodePorts } from '@/pipeline/nodes/nodePorts';
import { createOrUpdateConnectionBinding } from '@/pipeline/connection/ConnectionBindingUtil';
import { getNextConnectionIndex } from '@/pipeline/connection/keepConnectionsAtBottom';
import { arePortDataTypesCompatible } from '@/pipeline/ports/portCompatibility';
import { defaultImageNode, defaultVideoNode } from '@/pipeline/nodes/types/mediaStation';
import { defaultSkuNode, focusShapes } from '@/pipeline/nodes/types/skuStation';
import { startExecution } from '@/pipeline/execution/executionState';
import { validatePlan } from './validate';
import type { AgentNodeType, AgentOperation, AgentPlan } from './types';

// Applies a validated plan inside ONE editor transaction.
//
// The contract that matters: either every operation lands, or none does. A
// partial canvas is worse than a rejected plan, so any failure mid-way throws
// and the undo record we captured up to that point is replayed immediately.

export type ApplyResult = {
  createdNodeIds: string[];
  updatedNodeIds: string[];
  connectionIds: string[];
  /** Restores the canvas to exactly the state before apply(). */
  undo: () => void;
  /** Nodes the plan asked to run, resolved to real shape ids. */
  runNodeIds: string[];
  /** Nodes the plan asked to focus, resolved to real shape ids. */
  focusNodeIds: string[];
};

export class AgentApplyError extends Error {}

const FACTORIES: Record<AgentNodeType, () => Record<string, unknown>> = {
  sku_listing: defaultSkuNode as unknown as () => Record<string, unknown>,
  image_generation: defaultImageNode as unknown as () => Record<string, unknown>,
  video_generation: defaultVideoNode as unknown as () => Record<string, unknown>,
};

/** Where a newly created node goes when the plan gives no position. */
const FALLBACK_ORIGIN = { x: 480, y: 36 };
const LANE_STEP = 360;

type Snapshot = {
  createdShapeIds: TLShapeId[];
  createdConnectionIds: TLShapeId[];
  previousNodes: Array<{ id: TLShapeId; node: unknown; x: number; y: number }>;
  previousSelection: TLShapeId[];
};

/**
 * Apply `plan`. Re-validates first: the caller may have validated earlier, but
 * the canvas can change between proposing and approving.
 */
export function applyPlan(editor: Editor, plan: AgentPlan): ApplyResult {
  const check = validatePlan(editor, plan);
  if (!check.ok) {
    throw new AgentApplyError(`计划校验未通过：${check.errors.join('；')}`);
  }

  const snapshot: Snapshot = {
    createdShapeIds: [],
    createdConnectionIds: [],
    previousNodes: [],
    previousSelection: editor.getSelectedShapeIds().slice(),
  };
  const tempToReal = new Map<string, TLShapeId>();
  const updated: TLShapeId[] = [];
  const runIds: string[] = [];
  const focusIds: string[] = [];

  const resolve = (id: string): TLShapeId => {
    const mapped = tempToReal.get(id);
    if (mapped) return mapped;
    return id as TLShapeId;
  };

  const rollback = () => {
    editor.run(
      () => {
        const ids = [...snapshot.createdConnectionIds, ...snapshot.createdShapeIds].filter(id =>
          editor.getShape(id),
        );
        if (ids.length) editor.deleteShapes(ids);
        for (const prev of snapshot.previousNodes) {
          if (!editor.getShape(prev.id)) continue;
          editor.updateShape({
            id: prev.id,
            type: 'node',
            x: prev.x,
            y: prev.y,
            props: { node: prev.node as never },
          });
        }
        editor.setSelectedShapes(snapshot.previousSelection.filter(id => editor.getShape(id)));
      },
      { history: 'ignore' },
    );
  };

  // One stopping point for the whole plan, so a native Cmd+Z undoes the Agent's
  // change as a unit rather than unpicking it operation by operation.
  editor.markHistoryStoppingPoint('agent plan');

  try {
    editor.run(() => {
      let lane = 0;
      for (const op of plan.operations) {
        switch (op.type) {
          case 'create_node': {
            const id = createShapeId();
            const base = FACTORIES[op.nodeType]();
            const node = { ...base, ...sanitiseFields(op.nodeType, op.fields) };
            const position = op.position ?? {
              x: FALLBACK_ORIGIN.x,
              y: FALLBACK_ORIGIN.y + lane * LANE_STEP,
            };
            lane += 1;
            editor.createShape({
              id,
              type: 'node',
              x: position.x,
              y: position.y,
              props: { node: node as never },
            });
            if (!editor.getShape(id)) {
              throw new AgentApplyError(`创建 ${op.nodeType} 节点失败`);
            }
            snapshot.createdShapeIds.push(id);
            tempToReal.set(op.tempId, id);
            break;
          }

          case 'update_node': {
            const id = resolve(op.nodeId);
            const shape = editor.getShape(id);
            if (!shape || !editor.isShapeOfType(shape, 'node')) {
              throw new AgentApplyError(`要更新的节点不存在：${op.nodeId}`);
            }
            const bounds = editor.getShapePageBounds(id);
            snapshot.previousNodes.push({
              id,
              node: structuredClone((shape as NodeShape).props.node),
              x: bounds?.x ?? shape.x,
              y: bounds?.y ?? shape.y,
            });
            const current = (shape as NodeShape).props.node as Record<string, unknown>;
            editor.updateShape({
              id,
              type: 'node',
              props: {
                node: { ...current, ...sanitiseFields(op.nodeType, op.fields) } as never,
              },
            });
            updated.push(id);
            break;
          }

          case 'connect_nodes': {
            const fromId = resolve(op.from.nodeId);
            const toId = resolve(op.to.nodeId);
            const fromPort = getNodePorts(editor, fromId)[op.from.portId];
            const toPort = getNodePorts(editor, toId)[op.to.portId];
            if (!fromPort || !toPort) {
              throw new AgentApplyError(
                `端口不存在：${!fromPort ? op.from.portId : op.to.portId}`,
              );
            }
            if (!arePortDataTypesCompatible(fromPort.dataType, toPort.dataType)) {
              throw new AgentApplyError(
                `端口类型不兼容：${fromPort.dataType} → ${toPort.dataType}`,
              );
            }
            const connectionId = createShapeId();
            editor.createShape({
              type: 'connection',
              id: connectionId,
              x: 0,
              y: 0,
              index: getNextConnectionIndex(editor),
            });
            createOrUpdateConnectionBinding(editor, connectionId, fromId, {
              portId: op.from.portId,
              terminal: 'start',
            });
            createOrUpdateConnectionBinding(editor, connectionId, toId, {
              portId: op.to.portId,
              terminal: 'end',
            });
            snapshot.createdConnectionIds.push(connectionId);
            break;
          }

          case 'focus_nodes':
            focusIds.push(...op.nodeIds.map(resolve));
            break;

          case 'run_nodes':
            // Collected only. Running is a separate, explicitly confirmed step.
            runIds.push(...op.nodeIds.map(resolve));
            break;
        }
      }
    });
  } catch (error) {
    rollback();
    throw error instanceof AgentApplyError
      ? error
      : new AgentApplyError('应用计划时出错，已回滚全部改动。');
  }

  return {
    createdNodeIds: snapshot.createdShapeIds.slice(),
    updatedNodeIds: [...new Set(updated)],
    connectionIds: snapshot.createdConnectionIds.slice(),
    runNodeIds: [...new Set(runIds)],
    focusNodeIds: [...new Set(focusIds)],
    undo: rollback,
  };
}

/** Drop anything not writable, defensively — validatePlan already refused it. */
function sanitiseFields(
  nodeType: AgentNodeType,
  fields: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const allowed: Record<AgentNodeType, string[]> = {
    sku_listing: ['productName', 'points', 'amazon', 'tiktok', 'shopify'],
    image_generation: ['prompt', 'aspectRatio', 'name', 'count'],
    video_generation: ['prompt', 'aspectRatio', 'duration', 'platform', 'count'],
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (allowed[nodeType].includes(key)) out[key] = value;
  }
  return out;
}

/** Frame the changed nodes. Only ever called from an explicit user action. */
export function focusAgentNodes(editor: Editor, nodeIds: string[]): void {
  const live = nodeIds.filter(id => editor.getShape(id as TLShapeId));
  if (live.length === 0) return;
  focusShapes(editor, live);
}

/**
 * Run exactly the given nodes. Reuses the existing ExecutionGraph, which walks
 * downstream dependents itself — so an affected branch reruns and the rest of
 * the canvas does not.
 */
export async function runAgentNodes(editor: Editor, nodeIds: string[]): Promise<void> {
  const live = nodeIds.filter(id => editor.getShape(id as TLShapeId)) as TLShapeId[];
  if (live.length === 0) return;
  await startExecution(editor, new Set(live));
}

import type { Editor } from 'tldraw';
import type { NodeShape } from '@/pipeline/nodes/NodeShapeUtil';
import { getNodePortConnections, getNodePorts } from '@/pipeline/nodes/nodePorts';
import { arePortDataTypesCompatible } from '@/pipeline/ports/portCompatibility';
import { AGENT_NODE_TYPES, type AgentNodeType, type AgentOperation, type AgentPlan } from './types';

// The client's own validator. The backend validates too, but this is the gate
// that actually protects the editor: a plan reaching the executor has passed
// THIS, not merely the server's copy of the rules. A compromised or mocked
// backend response is still just data here.

export const MAX_OPERATIONS = 24;
export const MAX_CREATED_NODES = 8;
export const MAX_PROMPT_CHARS = 600;
export const MAX_TEXT_CHARS = 2000;
export const MAX_NODE_REFS = MAX_CREATED_NODES * 2;

const NODE_REF_RE = /^[A-Za-z0-9:_-]{1,80}$/;

const IMAGE_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2'];
const VIDEO_RATIOS = ['9:16', '16:9', '1:1'];
const VIDEO_DURATIONS = ['5s', '10s', '15s'];

type FieldKind = 'str' | 'text' | 'prompt' | 'bool' | 'count' | 'image_ratio' | 'video_ratio' | 'duration';

/** Mirrors WRITABLE_FIELDS in api/agent_plan.py. Anything absent is rejected. */
const WRITABLE: Record<AgentNodeType, Record<string, FieldKind>> = {
  sku_listing: {
    productName: 'str',
    points: 'text',
    amazon: 'bool',
    tiktok: 'bool',
    shopify: 'bool',
  },
  image_generation: {
    prompt: 'prompt',
    aspectRatio: 'image_ratio',
    name: 'str',
    count: 'count',
  },
  video_generation: {
    prompt: 'prompt',
    aspectRatio: 'video_ratio',
    duration: 'duration',
    platform: 'str',
    count: 'count',
  },
};

export type ValidationResult =
  | { ok: true; plan: AgentPlan }
  | { ok: false; errors: string[] };

function validateField(
  nodeType: AgentNodeType,
  key: string,
  value: unknown,
  errors: string[],
): boolean {
  // hasOwnProperty, not a plain lookup: `fields["__proto__"]` would otherwise
  // resolve to Object.prototype through the chain and read as a known field.
  const kind = Object.prototype.hasOwnProperty.call(WRITABLE[nodeType], key)
    ? WRITABLE[nodeType][key]
    : undefined;
  if (!kind) {
    errors.push(`${nodeType} 不接受字段 ${key}`);
    return false;
  }
  switch (kind) {
    case 'bool':
      if (typeof value !== 'boolean') errors.push(`${key} 必须是布尔值`);
      return typeof value === 'boolean';
    case 'count':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 4) {
        errors.push(`${key} 必须是 1–4 的整数`);
        return false;
      }
      return true;
    case 'image_ratio':
      if (!IMAGE_RATIOS.includes(String(value))) {
        errors.push(`图片比例 ${value} 不受支持`);
        return false;
      }
      return true;
    case 'video_ratio':
      if (!VIDEO_RATIOS.includes(String(value))) {
        errors.push(`视频比例 ${value} 不受支持`);
        return false;
      }
      return true;
    case 'duration':
      if (!VIDEO_DURATIONS.includes(String(value))) {
        errors.push(`视频时长 ${value} 不受支持`);
        return false;
      }
      return true;
    case 'prompt':
    case 'text':
    case 'str': {
      if (typeof value !== 'string') {
        errors.push(`${key} 必须是字符串`);
        return false;
      }
      const limit = kind === 'prompt' ? MAX_PROMPT_CHARS : kind === 'text' ? MAX_TEXT_CHARS : 200;
      if (value.length > limit) {
        errors.push(`${key} 超过 ${limit} 字符上限`);
        return false;
      }
      return true;
    }
    default:
      return false;
  }
}

/** Does `nodeId` name a real node shape on the canvas? */
function liveNode(editor: Editor, nodeId: string): NodeShape | null {
  const shape = editor.getShape(nodeId as never);
  if (!shape || !editor.isShapeOfType(shape, 'node')) return null;
  return shape as NodeShape;
}

/**
 * Full plan validation against the live editor.
 *
 * Checks: allow-listed node types, writable fields only, bounded lengths and
 * enums, referenced nodes exist (or are temp ids created by this same plan),
 * ports exist and are type-compatible, no cycles, and the operation ceilings.
 */
export function validatePlan(editor: Editor, plan: AgentPlan): ValidationResult {
  const errors: string[] = [];
  const ops = Array.isArray(plan?.operations) ? plan.operations : [];

  if (ops.length === 0) errors.push('计划里没有任何操作');
  if (ops.length > MAX_OPERATIONS) errors.push(`操作数量超过上限（${MAX_OPERATIONS}）`);

  const tempIds = new Set<string>();
  let created = 0;
  for (const op of ops) {
    if (op.type !== 'create_node') continue;
    created += 1;
    if (!AGENT_NODE_TYPES.includes(op.nodeType)) {
      errors.push(`不支持的节点类型：${op.nodeType}`);
      continue;
    }
    if (!NODE_REF_RE.test(op.tempId)) {
      errors.push(`tempId 不是合法的节点引用：${String(op.tempId)}`);
    } else {
      if (tempIds.has(op.tempId)) errors.push(`tempId 重复：${op.tempId}`);
      tempIds.add(op.tempId);
    }
  }
  if (created > MAX_CREATED_NODES) {
    errors.push(`新建节点数量超过上限（${MAX_CREATED_NODES}）`);
  }

  /** A reference is valid if it is a live shape or a temp id this plan creates. */
  const resolvable = (id: string) => tempIds.has(id) || liveNode(editor, id) !== null;

  // ---- per-operation checks ---------------------------------------------
  for (const op of ops) {
    switch (op.type) {
      case 'create_node':
        if (
          op.position != null &&
          (!Number.isFinite(op.position.x) ||
            !Number.isFinite(op.position.y) ||
            Math.abs(op.position.x) >= 100_000 ||
            Math.abs(op.position.y) >= 100_000)
        ) {
          errors.push('position 需要画布范围内的有限数值 x / y');
        }
        if (AGENT_NODE_TYPES.includes(op.nodeType)) {
          for (const [key, value] of Object.entries(op.fields ?? {})) {
            validateField(op.nodeType, key, value, errors);
          }
        }
        break;

      case 'update_node': {
        if (!AGENT_NODE_TYPES.includes(op.nodeType)) {
          errors.push(`不支持的节点类型：${op.nodeType}`);
          break;
        }
        if (!NODE_REF_RE.test(op.nodeId)) {
          errors.push(`nodeId 不是合法的节点引用：${String(op.nodeId)}`);
          break;
        }
        const shape = liveNode(editor, op.nodeId);
        if (!shape) {
          errors.push(`要更新的节点不存在：${op.nodeId}`);
          break;
        }
        const actual = (shape.props.node as { type: string }).type;
        if (actual !== op.nodeType) {
          errors.push(`节点 ${op.nodeId} 是 ${actual}，与计划中的 ${op.nodeType} 不符`);
          break;
        }
        for (const [key, value] of Object.entries(op.fields ?? {})) {
          validateField(op.nodeType, key, value, errors);
        }
        break;
      }

      case 'connect_nodes': {
        for (const end of [op.from, op.to]) {
          if (!NODE_REF_RE.test(end.nodeId) || !NODE_REF_RE.test(end.portId)) {
            errors.push(`连接包含不合法的节点或端口引用`);
          } else if (!resolvable(end.nodeId)) {
            errors.push(`连接引用了不存在的节点：${end.nodeId}`);
          }
        }
        // Ports can only be checked for nodes that already exist; a node this
        // plan is about to create gets its ports checked at apply time, where
        // the executor resolves the port or aborts the whole transaction.
        const fromShape = liveNode(editor, op.from.nodeId);
        const toShape = liveNode(editor, op.to.nodeId);
        if (fromShape && toShape) {
          const fromPort = getNodePorts(editor, fromShape)[op.from.portId];
          const toPort = getNodePorts(editor, toShape)[op.to.portId];
          if (!fromPort) errors.push(`端口不存在：${op.from.portId}`);
          if (!toPort) errors.push(`端口不存在：${op.to.portId}`);
          if (fromPort && toPort) {
            if (fromPort.terminal !== 'start') errors.push(`${op.from.portId} 不是输出端口`);
            if (toPort.terminal !== 'end') errors.push(`${op.to.portId} 不是输入端口`);
            if (!arePortDataTypesCompatible(fromPort.dataType, toPort.dataType)) {
              errors.push(`端口类型不兼容：${fromPort.dataType} → ${toPort.dataType}`);
            }
          }
        }
        break;
      }

      case 'focus_nodes':
      case 'run_nodes': {
        if (!Array.isArray(op.nodeIds) || op.nodeIds.length === 0) {
          errors.push(`${op.type} 需要 nodeIds 数组`);
          break;
        }
        if (op.nodeIds.length > MAX_NODE_REFS) {
          errors.push(`${op.type} 的节点数量超过上限`);
        }
        for (const id of op.nodeIds) {
          if (!NODE_REF_RE.test(id)) errors.push(`不是合法的节点引用：${String(id)}`);
          else if (!resolvable(id)) errors.push(`引用了不存在的节点：${id}`);
        }
        break;
      }

      default:
        errors.push(`不支持的操作类型：${(op as { type: string }).type}`);
    }
  }

  if (hasCycle(editor, ops)) errors.push('这些连接会在画布上形成环');

  return errors.length === 0
    ? { ok: true, plan }
    : { ok: false, errors: [...new Set(errors)].slice(0, 12) };
}

/**
 * Would applying `ops` create a directed cycle?
 *
 * Seeds the graph with the connections already on the canvas so a new edge that
 * closes a loop through existing nodes is caught too, not only a loop made
 * entirely of new edges.
 */
export function hasCycle(editor: Editor, ops: AgentOperation[]): boolean {
  const edges = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string) => {
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from)!.add(to);
  };

  for (const shape of editor.getCurrentPageShapes()) {
    if (!editor.isShapeOfType(shape, 'node')) continue;
    for (const conn of getNodePortConnectionsSafe(editor, shape as NodeShape)) {
      if (conn.terminal === 'start') addEdge(shape.id, conn.connectedShapeId);
    }
  }
  for (const op of ops) {
    if (op.type === 'connect_nodes') addEdge(op.from.nodeId, op.to.nodeId);
  }

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();

  const visit = (node: string): boolean => {
    const state = colour.get(node) ?? WHITE;
    if (state === GREY) return true; // back-edge: cycle
    if (state === BLACK) return false;
    colour.set(node, GREY);
    for (const next of edges.get(node) ?? []) {
      if (visit(next)) return true;
    }
    colour.set(node, BLACK);
    return false;
  };

  for (const node of edges.keys()) {
    if (visit(node)) return true;
  }
  return false;
}

function getNodePortConnectionsSafe(editor: Editor, shape: NodeShape) {
  try {
    return getNodePortConnections(editor, shape);
  } catch {
    return [];
  }
}

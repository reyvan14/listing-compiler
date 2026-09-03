import type { Editor } from 'tldraw';
import type { NodeShape } from '@/pipeline/nodes/NodeShapeUtil';
import { getNodePortConnections } from '@/pipeline/nodes/nodePorts';
import { executionState } from '@/pipeline/execution/executionState';
import type { AgentCanvasContext, NodeStatus } from './types';

// Serialises the canvas into a compact snapshot for the Agent.
//
// Two things this must never do: send image or video payloads (a single data
// URL can be megabytes and would dwarf the useful signal), and send unbounded
// product text. Media is replaced by metadata — a count, a MIME family, and a
// short reference id — and every text field is clipped.

const MAX_TEXT = 600;
const MAX_NODES = 40;
const MAX_CONNECTIONS = 80;

/** Anything that could carry a payload rather than a description. */
const MEDIA_FIELDS = new Set([
  'uploads',
  'imageUrls',
  'videoUrls',
  'posterUrls',
  'referenceImages',
  'referenceVideos',
  'referenceAudios',
  'imageUrl',
  'firstFrameUrl',
  'lastFrameUrl',
  'referenceVideoUrl',
  'imageAssets',
]);

export function isMediaSource(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return /^data:/i.test(value) || /^https?:\/\//i.test(value) || value.startsWith('/');
}

/** `data:image/png;base64,…` → `image/png`; a URL → its extension family. */
export function mediaMime(value: string): string {
  const data = /^data:([^;,]+)/i.exec(value);
  if (data) return data[1];
  const ext = /\.([a-z0-9]+)(?:\?|$)/i.exec(value)?.[1]?.toLowerCase();
  if (!ext) return 'unknown';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext)) {
    return `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  }
  if (['mp4', 'webm', 'mov'].includes(ext)) return `video/${ext}`;
  return 'unknown';
}

/** Stable, short, non-reversible handle for one media item. */
export function mediaRef(value: string, index: number): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return `media-${index}-${Math.abs(hash).toString(36).slice(0, 6)}`;
}

/**
 * Replace a media field with metadata. The Agent learns that two 1:1 images
 * exist without ever receiving their bytes.
 */
export function describeMedia(value: unknown): unknown {
  const list = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
  const items = list.filter(isMediaSource) as string[];
  if (items.length === 0) return { count: 0 };
  return {
    count: items.length,
    items: items.slice(0, 6).map((src, i) => ({
      ref: mediaRef(src, i),
      mimeType: mediaMime(src),
      // a data URL's length is a rough proxy for size; never the content
      approxBytes: src.startsWith('data:') ? Math.round((src.length * 3) / 4) : null,
    })),
  };
}

function clip(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
}

/** The fields the Agent may see and reason about, per node type. */
export function editableFieldsOf(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type') continue;
    if (MEDIA_FIELDS.has(key)) {
      const described = describeMedia(value) as { count: number };
      // collapse to a plain count for the common empty case
      out[`${key}Meta`] = described;
      if (key === 'uploads') out.uploadCount = described.count;
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length > 12) continue; // checks / fieldMeta etc: not Agent input
      out[key] = value.map(clip);
      continue;
    }
    if (typeof value === 'object' && value !== null) continue;
    out[key] = clip(value);
  }
  return out;
}

function statusOf(editor: Editor, shape: NodeShape): NodeStatus {
  const graph = executionState.get(editor).runningGraph;
  const running = graph?.getNodeStatus(shape.id);
  if (running === 'executing') return 'running';

  const node = shape.props.node as Record<string, unknown>;
  if (node.type === 'sku_listing' && node.lastError) return 'error';
  if (typeof node.lastResult === 'string' && node.lastResult) {
    const bad = /失败|不可用|超时|未配置|错误/.test(node.lastResult);
    if (bad) return 'error';
  }
  if (node.type === 'listing_result') {
    const checks = (node.checks as Array<{ blocking?: boolean }> | undefined) ?? [];
    if (checks.some(c => c.blocking)) return 'blocked';
  }
  const hasResult =
    (Array.isArray(node.imageUrls) && node.imageUrls.length > 0) ||
    (Array.isArray(node.videoUrls) && node.videoUrls.length > 0) ||
    (Array.isArray(node.spawnedIds) && node.spawnedIds.length > 0);
  return hasResult ? 'success' : 'idle';
}

function lastErrorOf(node: Record<string, unknown>): string | undefined {
  const raw = (node.lastError as string) || (node.lastResult as string) || '';
  if (!raw || !/失败|不可用|超时|未配置|错误/.test(raw)) return undefined;
  return String(raw).slice(0, 200);
}

/** Accepts a null editor: the canvas may not have mounted yet, and an empty
 * context is a truthful description of "nothing to see". */
export function buildCanvasContext(
  editor: Editor | null,
  evidenceSummary?: AgentCanvasContext['evidenceSummary'],
): AgentCanvasContext {
  if (!editor) {
    return {
      selectedNodeIds: [],
      nodes: [],
      connections: [],
      evidenceSummary: evidenceSummary ?? {
        verified: 0,
        needsReview: 0,
        conflicting: 0,
        unsupported: 0,
      },
      policyVersions: {},
    };
  }
  const shapes = editor
    .getCurrentPageShapes()
    .filter((s): s is NodeShape => editor.isShapeOfType(s, 'node'))
    .slice(0, MAX_NODES);

  const nodes: AgentCanvasContext['nodes'] = shapes.map(shape => {
    const raw = shape.props.node as Record<string, unknown>;
    const bounds = editor.getShapePageBounds(shape.id);
    return {
      id: shape.id,
      type: String(raw.type),
      position: { x: Math.round(bounds?.x ?? 0), y: Math.round(bounds?.y ?? 0) },
      editableFields: editableFieldsOf(raw),
      status: statusOf(editor, shape),
      lastError: lastErrorOf(raw),
    };
  });

  const connections: AgentCanvasContext['connections'] = [];
  const seen = new Set<string>();
  for (const shape of shapes) {
    for (const conn of getNodePortConnections(editor, shape)) {
      if (!conn || conn.terminal !== 'start') continue;
      const key = `${shape.id}:${conn.ownPortId}->${conn.connectedShapeId}:${conn.connectedPortId}`;
      if (seen.has(key) || connections.length >= MAX_CONNECTIONS) continue;
      seen.add(key);
      connections.push({
        fromNodeId: shape.id,
        fromPortId: conn.ownPortId,
        toNodeId: conn.connectedShapeId,
        toPortId: conn.connectedPortId,
        dataType: 'text',
      });
    }
  }

  const policyVersions: Record<string, string> = {};
  for (const node of nodes) {
    const version = node.editableFields.policyVersion;
    const platform = node.editableFields.platform;
    if (typeof version === 'string' && version && typeof platform === 'string') {
      policyVersions[platform] = version;
    }
  }

  return {
    selectedNodeIds: editor.getSelectedShapeIds().slice(0, MAX_NODES),
    nodes,
    connections,
    evidenceSummary:
      evidenceSummary ?? { verified: 0, needsReview: 0, conflicting: 0, unsupported: 0 },
    policyVersions,
  };
}

/** Belt-and-braces: no data URL may leave the client inside the context. */
export function containsMediaPayload(context: unknown): boolean {
  return /data:[a-z]+\/[a-z0-9.+-]+;base64,/i.test(JSON.stringify(context ?? {}));
}

/**
 * Canvas node id → a short human name, so plan cards can say "Amazon 白底主图"
 * instead of a shape id. Falls back to the node type's label.
 */
export function nodeDisplayNames(editor: Editor): Map<string, string> {
  const names = new Map<string, string>();
  for (const shape of editor.getCurrentPageShapes()) {
    if (!editor.isShapeOfType(shape, 'node')) continue;
    const node = (shape as NodeShape).props.node as Record<string, unknown>;
    const named = node.name ?? node.productName;
    if (typeof named === 'string' && named.trim()) {
      names.set(shape.id, named.trim().slice(0, 40));
    }
  }
  return names;
}

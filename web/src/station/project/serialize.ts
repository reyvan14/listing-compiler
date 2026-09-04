import { getSnapshot, loadSnapshot, type Editor } from 'tldraw';
import type { NodeShape } from '@/pipeline/nodes/NodeShapeUtil';
import { findSkuShape, type SkuListingNode } from '@/pipeline/nodes/types/skuStation';
import {
  MAX_INLINE_MEDIA_CHARS,
  PROJECT_SCHEMA,
  PROJECT_SCHEMA_VERSION,
  emptyRefs,
  type OmittedMedia,
  type ProjectSnapshot,
  type ServerRefs,
} from './projectSchema';

// Canvas <-> snapshot.
//
// The tldraw store snapshot carries shapes, bindings, page state and camera, so
// a restore reproduces the exact graph rather than re-running the code that
// built it. That distinction is the whole point: re-running generation on
// refresh would mint new nodes, new revisions and new audit events for work the
// operator already did.

export type SerializeOptions = {
  /**
   * Keep large image data URLs in the payload.
   *
   * False for browser-local storage, where a handful of generated images would
   * blow the quota and take the whole snapshot down with them. True for a file
   * export, which has no quota and should be complete.
   */
  inlineMedia: boolean;
  refs?: Partial<ServerRefs>;
  projectName?: string;
};

const MEDIA_FIELDS = ['imageUrl', 'resultUrl', 'posterUrl', 'firstFrameUrl'] as const;

/** Strip oversized data URLs, recording exactly what was dropped and from where. */
function stripMedia(store: unknown, omitted: OmittedMedia[]): unknown {
  const walk = (value: unknown, shapeId: string): unknown => {
    if (Array.isArray(value)) return value.map(v => walk(v, shapeId));
    if (!value || typeof value !== 'object') return value;

    const source = value as Record<string, unknown>;
    const id = typeof source.id === 'string' ? source.id : shapeId;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(source)) {
      const isMediaField = (MEDIA_FIELDS as readonly string[]).includes(key);
      if (
        isMediaField &&
        typeof child === 'string' &&
        child.startsWith('data:') &&
        child.length > MAX_INLINE_MEDIA_CHARS
      ) {
        omitted.push({ shape_id: id, field: key, chars: child.length });
        out[key] = '';
        continue;
      }
      out[key] = walk(child, id);
    }
    return out;
  };
  return walk(store, '');
}

export function serializeProject(editor: Editor, options: SerializeOptions): ProjectSnapshot {
  const raw = getSnapshot(editor.store) as unknown;
  const omitted: OmittedMedia[] = [];
  const store = options.inlineMedia ? raw : stripMedia(raw, omitted);

  const skuShape = findSkuShape(editor);
  const skuNode =
    skuShape && skuShape.props.node.type === 'sku_listing'
      ? (skuShape.props.node as SkuListingNode)
      : null;

  return {
    schema: PROJECT_SCHEMA,
    schema_version: PROJECT_SCHEMA_VERSION,
    saved_at: new Date().toISOString(),
    storage: 'browser-local',
    project: {
      id: options.refs?.product_id ?? '',
      name: options.projectName || skuNode?.productName.trim() || '未命名项目',
      market: 'US',
      locale: 'en-US',
    },
    sku: {
      productName: skuNode?.productName ?? '',
      points: skuNode?.points ?? '',
      platforms: skuNode
        ? (['amazon', 'tiktok', 'shopify'] as const).filter(p => skuNode[p])
        : [],
      assetMode: skuNode?.assetMode ?? 'compliant',
    },
    canvas: { store },
    server_refs: { ...emptyRefs(), ...(options.refs ?? {}) },
    agent_plans: [],
    omitted_media: omitted,
  };
}

/**
 * Replace the canvas with a stored snapshot.
 *
 * `loadSnapshot` swaps the whole store in one operation, so there is no window
 * in which the canvas holds half of each project.
 */
export function restoreProject(editor: Editor, snapshot: ProjectSnapshot): void {
  loadSnapshot(editor.store, snapshot.canvas.store as never);
}

export type SnapshotStats = {
  nodes: number;
  connections: number;
  nodeTypes: Record<string, number>;
  omittedMedia: number;
};

/**
 * What an import would bring in, counted from the payload itself.
 *
 * The preview has to be derived from the file, not from the app's current
 * state, or "you are about to replace 3 nodes with 7" would be a guess.
 */
export function describeSnapshot(snapshot: ProjectSnapshot): SnapshotStats {
  const store = snapshot.canvas?.store as
    | { store?: Record<string, { typeName?: string; type?: string; props?: { node?: { type?: string } } }> }
    | undefined;
  const records = store?.store ?? {};
  const nodeTypes: Record<string, number> = {};
  let nodes = 0;
  let connections = 0;

  for (const record of Object.values(records)) {
    if (record?.typeName !== 'shape') continue;
    if (record.type === 'node') {
      nodes += 1;
      const kind = record.props?.node?.type ?? 'unknown';
      nodeTypes[kind] = (nodeTypes[kind] ?? 0) + 1;
    } else if (record.type === 'connection') {
      connections += 1;
    }
  }

  return {
    nodes,
    connections,
    nodeTypes,
    omittedMedia: snapshot.omitted_media?.length ?? 0,
  };
}

/** Node ids and positions, for asserting a restore changed nothing. */
export function canvasFingerprint(editor: Editor): { id: string; x: number; y: number; type: string }[] {
  return editor
    .getCurrentPageShapes()
    .filter((s): s is NodeShape => editor.isShapeOfType(s, 'node'))
    .map(s => ({
      id: String(s.id),
      x: Math.round(s.x),
      y: Math.round(s.y),
      type: (s as NodeShape).props.node.type,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

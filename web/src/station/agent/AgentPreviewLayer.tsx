import { useValue, type Editor } from 'tldraw';
import type { NodeShape } from '@/pipeline/nodes/NodeShapeUtil';
import { getNodeHeightPx, getNodeWidthPx } from '@/pipeline/nodes/nodeTypes';
import { defaultImageNode, defaultVideoNode } from '@/pipeline/nodes/types/mediaStation';
import { defaultSkuNode } from '@/pipeline/nodes/types/skuStation';
import styles from './agentPlan.module.scss';
import { NODE_LABELS } from './planSummary';
import type { AgentNodeType, AgentPlan } from './types';

// Preview draws where the plan WOULD land. It never creates a shape, because
// creating shapes is applying — and applying needs approval. So this is a
// read-only overlay projected from page coordinates, re-projected whenever the
// camera moves.

const FACTORIES: Record<AgentNodeType, () => unknown> = {
  sku_listing: defaultSkuNode,
  image_generation: defaultImageNode,
  video_generation: defaultVideoNode,
};

/** Last-resort footprint if the layout math is unavailable for a node type. */
const FALLBACK_SIZE = { w: 340, h: 260 };

// Must match apply.ts, or the preview would point somewhere the node will not
// actually land.
const CREATE_ORIGIN = { x: 480, y: 36 };
const LANE_STEP = 360;

/**
 * Footprint of a node that does not exist yet.
 *
 * Reuses the real per-type layout functions against a throwaway shape rather
 * than duplicating their numbers — the node definitions ignore the shape and
 * measure `props.node`.
 */
function plannedSize(editor: Editor, nodeType: AgentNodeType, fields: Record<string, unknown>) {
  try {
    const node = { ...(FACTORIES[nodeType]() as object), ...fields };
    const probe = { id: 'shape:agent-preview', type: 'node', props: { node } } as unknown as NodeShape;
    return { w: getNodeWidthPx(editor, probe), h: getNodeHeightPx(editor, probe) };
  } catch {
    return FALLBACK_SIZE;
  }
}

type Box = { x: number; y: number; w: number; h: number; label: string; update: boolean };

export function AgentPreviewLayer({ editor, plan }: { editor: Editor; plan: AgentPlan }) {
  // Depends on the camera and on the shapes it measures, so it recomputes on
  // pan, zoom and any edit to a referenced node.
  const boxes = useValue<Box[]>(
    'agent preview boxes',
    () => {
      const camera = editor.getCamera();
      const out: Box[] = [];
      let lane = 0;

      for (const op of plan.operations) {
        if (op.type === 'create_node') {
          const size = plannedSize(editor, op.nodeType, op.fields ?? {});
          const page = op.position ?? {
            x: CREATE_ORIGIN.x,
            y: CREATE_ORIGIN.y + lane * LANE_STEP,
          };
          lane += 1;
          const at = editor.pageToViewport(page);
          out.push({
            x: at.x,
            y: at.y,
            w: size.w * camera.z,
            h: size.h * camera.z,
            label: `将新建：${NODE_LABELS[op.nodeType]}`,
            update: false,
          });
          continue;
        }
        if (op.type !== 'update_node') continue;

        const shape = editor.getShape(op.nodeId as never);
        if (!shape || !editor.isShapeOfType(shape, 'node')) continue;
        const bounds = editor.getShapePageBounds(shape.id);
        if (!bounds) continue;
        const at = editor.pageToViewport({ x: bounds.x, y: bounds.y });
        out.push({
          x: at.x,
          y: at.y,
          w: bounds.w * camera.z,
          h: bounds.h * camera.z,
          label: `将修改：${NODE_LABELS[(shape as NodeShape).props.node.type as keyof typeof NODE_LABELS] ?? '节点'}`,
          update: true,
        });
      }
      return out;
    },
    [editor, plan],
  );

  return (
    <div className={styles.previewLayer} aria-hidden="true" data-testid="agent-preview-layer">
      <div className={styles.previewHint}>预览：以下改动尚未应用</div>
      {boxes.map((box, i) => (
        <div
          key={i}
          className={`${styles.previewBox} ${box.update ? styles.previewUpdate : ''}`}
          style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
        >
          <span className={styles.previewTag}>{box.label}</span>
        </div>
      ))}
    </div>
  );
}

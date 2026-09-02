// Bridge between the tldraw canvas and the migration engine.
//
// `collectArtifacts` reads the listing / media nodes into the clean `Artifact`
// model; `applyImpactToCanvas` / `applyArtifactsToCanvas` push migration results
// back onto the matching nodes — and only the matching nodes, so an unaffected
// card is never moved or re-rendered.

import type { Editor } from 'tldraw';
import type { NodeShape } from '@/pipeline/nodes/NodeShapeUtil';
import { updateNode } from '@/pipeline/nodes/types/shared';
import {
  applyResultPatch,
  clearMigrationStatus,
  fillSkuDemo,
  findSkuShape,
  markMigrationStatus,
  selectedPlatforms,
  spawnPlatformResults,
  type SkuListingNode,
} from '@/pipeline/nodes/types/skuStation';
import {
  announceListingSource,
  fetchListingDrafts,
  localSampleDrafts,
  type ListingResultSource,
} from '../listingApi';
import { computeFactRefs, parseSkuFacts } from './skuFacts';
import type { Artifact, ImpactRow, MigrationStatus } from './types';

const STATUS_MAP: Record<string, MigrationStatus> = {
  '': 'current',
  current: 'current',
  stale: 'stale',
  candidate: 'candidate',
  applied: 'applied',
  'rolled-back': 'rolled-back',
  'needs-human-review': 'needs-human-review',
};

export function factsFromCanvas(editor: Editor): Record<string, string> {
  const sku = findSkuShape(editor);
  if (!sku || sku.props.node.type !== 'sku_listing') return {};
  return parseSkuFacts(sku.props.node.productName, sku.props.node.points);
}

export function collectArtifacts(editor: Editor): Artifact[] {
  const facts = factsFromCanvas(editor);
  const out: Artifact[] = [];
  for (const shape of editor.getCurrentPageShapes()) {
    if (!editor.isShapeOfType(shape, 'node')) continue;
    const node = (shape as NodeShape).props.node;

    if (node.type === 'listing_result') {
      if (node.platform === 'ad') continue;
      const meta = node.fieldMeta ?? [];
      out.push({
        artifactId: node.artifactId || node.platform,
        nodeId: shape.id,
        platform: node.platform,
        kind: 'listing',
        revision: 1,
        status: STATUS_MAP[node.migrationStatus] ?? 'current',
        policyVersion: node.policyVersion || '',
        title: node.title,
        titleFactRefs: node.factRefs ?? [],
        fields: node.fields.map((f, i) => ({
          name: meta[i]?.name || `field-${i + 1}`,
          label: f.label,
          value: f.value,
          factRefs: meta[i]?.factRefs ?? [],
        })),
      });
    } else if (node.type === 'image_generation' || node.type === 'video_generation') {
      const prompt = String((node as { prompt?: string }).prompt || '');
      out.push({
        artifactId: shape.id,
        nodeId: shape.id,
        platform:
          node.type === 'video_generation' ? String((node as { platform?: string }).platform || '') : '',
        kind: node.type === 'image_generation' ? 'image' : 'video',
        revision: 1,
        status: 'current',
        policyVersion: '',
        fields: [],
        assetRefs: computeFactRefs(prompt, facts),
      });
    }
  }
  return out;
}

/** Amber `已过期` on every affected listing card; untouched cards stay put. */
export function applyImpactToCanvas(editor: Editor, rows: ImpactRow[]): void {
  const statuses = rows
    .filter(r => r.affected && r.kind === 'listing')
    .map(r => ({
      artifactId: r.artifactId,
      status: 'stale',
      reason: reasonSummary(r),
    }));
  markMigrationStatus(editor, statuses);
}

function reasonSummary(row: ImpactRow): string {
  const parts = row.reasons.map(reason => {
    if (reason.type === 'policy') return `政策变更 · ${reason.fields.join('/')}`;
    if (reason.type === 'sku_fact_conservative') return '缺依赖元数据（保守判定）';
    return `SKU 事实 ${(reason.factIds ?? []).join('、')} · ${reason.fields.join('/')}`;
  });
  return parts.join('；');
}

/** Push applied / rolled-back artifact values + status back onto the cards. */
export function applyArtifactsToCanvas(
  editor: Editor,
  artifacts: Artifact[],
  fallbackStatus: MigrationStatus = 'applied',
): void {
  for (const artifact of artifacts) {
    if (artifact.kind !== 'listing') continue;
    applyResultPatch(editor, artifact.artifactId, {
      title: artifact.title,
      fields: artifact.fields.map(f => ({ label: f.label, value: f.value })),
      policyVersion: artifact.policyVersion,
    });
  }
  markMigrationStatus(
    editor,
    artifacts
      .filter(a => a.kind === 'listing')
      .map(a => ({
        artifactId: a.artifactId,
        status: STATUS_MAP[a.status] ?? fallbackStatus,
        reason:
          (STATUS_MAP[a.status] ?? fallbackStatus) === 'needs-human-review'
            ? '仍有字段需人工复核'
            : '',
      })),
  );
}

export function resetCanvasMigration(editor: Editor): void {
  clearMigrationStatus(editor);
}

/** Ensure the three listing cards exist (demo setup). Returns the data source
 * so the caller can surface the honest "本地示例 / 规则兜底 / 模型生成" label. */
export async function ensureListingCards(
  editor: Editor,
): Promise<ListingResultSource | 'exists'> {
  if (collectArtifacts(editor).some(a => a.kind === 'listing')) return 'exists';
  const sku = findSkuShape(editor);
  if (!sku || sku.props.node.type !== 'sku_listing') return 'exists';
  fillSkuDemo(editor, sku);
  const live = (editor.getShape(sku.id) as NodeShape | undefined) ?? sku;
  const n = live.props.node as SkuListingNode;
  const input = {
    productName: n.productName,
    points: n.points,
    platforms: selectedPlatforms(n),
    assetMode: n.assetMode,
    uploads: n.uploads,
  };
  try {
    const { drafts, source } = await fetchListingDrafts(input, { timeoutMs: 20_000 });
    spawnPlatformResults(editor, live, drafts);
    announceListingSource(source);
    return source;
  } catch {
    const { drafts, source } = localSampleDrafts(input);
    spawnPlatformResults(editor, live, drafts);
    announceListingSource(source);
    return source;
  }
}

/** Scenario 2 driver: rewrite the capacity selling-point line on the SKU node
 * and return { before, after } fact maps. The canvas SKU input visibly changes. */
export function driftCapacity(
  editor: Editor,
  from = '350ml',
  to = '300ml',
): { before: Record<string, string>; after: Record<string, string>; changed: boolean } {
  const sku = findSkuShape(editor);
  const before = factsFromCanvas(editor);
  if (!sku || sku.props.node.type !== 'sku_listing') {
    return { before, after: before, changed: false };
  }
  const points = sku.props.node.points;
  if (!points.includes(from)) return { before, after: before, changed: false };
  const nextPoints = points.split(from).join(to);
  updateNode<SkuListingNode>(editor, sku, node => ({ ...node, points: nextPoints }), false);
  return {
    before,
    after: parseSkuFacts(sku.props.node.productName, nextPoints),
    changed: true,
  };
}

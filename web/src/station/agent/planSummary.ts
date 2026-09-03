import type { AgentNodeType, AgentOperation, AgentPlan } from './types';

// Turns a plan into the plain-language rows the card shows. Kept out of the
// component so the wording is unit-testable without rendering React.

export const NODE_LABELS: Record<AgentNodeType, string> = {
  sku_listing: 'SKU 上新',
  image_generation: '图片生成',
  video_generation: '视频生成',
};

export const FIELD_LABELS: Record<string, string> = {
  productName: '品名',
  points: '卖点',
  amazon: 'Amazon',
  tiktok: 'TikTok Shop',
  shopify: 'Shopify',
  prompt: '提示词',
  aspectRatio: '比例',
  name: '名称',
  count: '张数',
  duration: '时长',
  platform: '平台',
};

export type PlanChangeRow = {
  kind: 'create' | 'update' | 'connect' | 'focus' | 'run';
  label: string;
  detail: string;
};

function fieldSummary(fields: Record<string, unknown>): string {
  const parts = Object.entries(fields).map(([key, value]) => {
    const label = FIELD_LABELS[key] ?? key;
    if (typeof value === 'boolean') return `${label}：${value ? '开' : '关'}`;
    const text = String(value);
    return `${label}：${text.length > 48 ? `${text.slice(0, 48)}…` : text}`;
  });
  return parts.join(' · ');
}

/** Short human name for a node reference, preferring a canvas label. */
export function refLabel(id: string, names: Map<string, string>): string {
  const name = names.get(id);
  if (name) return name;
  if (!id.startsWith('shape:')) return id;
  return `节点 ${id.slice(6, 12)}`;
}

export function planRows(plan: AgentPlan, names: Map<string, string>): PlanChangeRow[] {
  const local = new Map(names);
  for (const op of plan.operations) {
    if (op.type !== 'create_node') continue;
    const named = op.fields?.name;
    local.set(
      op.tempId,
      typeof named === 'string' && named ? named : `新建${NODE_LABELS[op.nodeType]}`,
    );
  }

  const rows: PlanChangeRow[] = [];
  for (const op of plan.operations as AgentOperation[]) {
    switch (op.type) {
      case 'create_node':
        rows.push({
          kind: 'create',
          label: `新建 ${NODE_LABELS[op.nodeType]}`,
          detail: fieldSummary(op.fields ?? {}) || '使用默认字段',
        });
        break;
      case 'update_node':
        rows.push({
          kind: 'update',
          label: `修改 ${refLabel(op.nodeId, local)}`,
          detail: fieldSummary(op.fields ?? {}) || '无字段变更',
        });
        break;
      case 'connect_nodes':
        rows.push({
          kind: 'connect',
          label: '连接',
          detail: `${refLabel(op.from.nodeId, local)} → ${refLabel(op.to.nodeId, local)}`,
        });
        break;
      case 'focus_nodes':
        rows.push({
          kind: 'focus',
          label: '定位',
          detail: op.nodeIds.map(id => refLabel(id, local)).join('、'),
        });
        break;
      case 'run_nodes':
        rows.push({
          kind: 'run',
          label: '运行（需单独确认）',
          detail: op.nodeIds.map(id => refLabel(id, local)).join('、'),
        });
        break;
    }
  }
  return rows;
}

export function planCounts(plan: AgentPlan) {
  const ops = plan.operations ?? [];
  return {
    created: ops.filter(o => o.type === 'create_node').length,
    updated: ops.filter(o => o.type === 'update_node').length,
    connections: ops.filter(o => o.type === 'connect_nodes').length,
    runs: ops.filter(o => o.type === 'run_nodes').length,
  };
}

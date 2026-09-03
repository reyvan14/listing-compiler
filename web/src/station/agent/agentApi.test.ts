import { describe, expect, it } from 'vitest';
import { coercePlan } from './agentApi';
import { containsMediaPayload, describeMedia, editableFieldsOf } from './canvasContext';
import { planCounts, planRows } from './planSummary';
import type { AgentPlan } from './types';

const GOOD = {
  id: 'p',
  title: '创建工作流',
  summary: '新建两个节点',
  estimatedModelCalls: 0,
  warnings: ['一条宣称没有证据'],
  requiresRunConfirmation: false,
  operations: [
    { type: 'create_node', tempId: 'a', nodeType: 'image_generation', fields: { name: '白底主图' } },
    { type: 'connect_nodes', from: { nodeId: 'shape:s', portId: 'o' }, to: { nodeId: 'a', portId: 'i' } },
  ],
};

describe('coercePlan', () => {
  it('accepts a structurally valid plan', () => {
    expect(coercePlan(GOOD)?.title).toBe('创建工作流');
  });

  it('drops a plan carrying an operation type outside the protocol', () => {
    for (const type of ['eval', 'exec', 'http_request', 'publish', 'delete_node']) {
      const rogue = { ...GOOD, operations: [{ type, code: 'rm -rf /' }] };
      expect(coercePlan(rogue), type).toBeNull();
    }
  });

  it('drops a plan carrying a node type outside the protocol', () => {
    const rogue = {
      ...GOOD,
      operations: [{ type: 'create_node', tempId: 'a', nodeType: 'shell', fields: {} }],
    };
    expect(coercePlan(rogue)).toBeNull();
  });

  it('drops malformed, empty and non-object payloads', () => {
    expect(coercePlan(null)).toBeNull();
    expect(coercePlan('{"title":"x"}')).toBeNull();
    expect(coercePlan({ ...GOOD, operations: [] })).toBeNull();
    expect(coercePlan({ ...GOOD, title: 42 })).toBeNull();
  });

  it('defaults run confirmation to required when the field is missing', () => {
    const { requiresRunConfirmation, ...rest } = GOOD;
    void requiresRunConfirmation;
    expect(coercePlan(rest)?.requiresRunConfirmation).toBe(true);
  });

  it('clamps a nonsense model-call estimate rather than trusting it', () => {
    expect(coercePlan({ ...GOOD, estimatedModelCalls: -5 })?.estimatedModelCalls).toBe(0);
    expect(coercePlan({ ...GOOD, estimatedModelCalls: 'many' })?.estimatedModelCalls).toBe(0);
  });
});

describe('canvas context redaction', () => {
  const dataUrl = `data:image/png;base64,${'A'.repeat(400)}`;

  it('describes an image by shape, never by bytes', () => {
    const described = describeMedia([dataUrl]) as {
      count: number;
      items: Array<{ mimeType: string; approxBytes: number | null }>;
    };
    expect(JSON.stringify(described)).not.toContain('AAAA');
    expect(described.count).toBe(1);
    expect(described.items[0].mimeType).toBe('image/png');
    expect(described.items[0].approxBytes).toBeGreaterThan(0);
  });

  it('strips media payloads out of editable fields', () => {
    const fields = editableFieldsOf({
      type: 'image_generation',
      prompt: '白底',
      imageUrls: [dataUrl],
    });
    expect(JSON.stringify(fields)).not.toContain('base64');
  });

  it('detects a media payload that slipped into the context', () => {
    expect(containsMediaPayload({ nodes: [{ f: dataUrl }] })).toBe(true);
    expect(containsMediaPayload({ nodes: [{ f: 'data:image/svg+xml,<svg></svg>' }] })).toBe(true);
    expect(containsMediaPayload({ nodes: [{ f: '白底主图' }] })).toBe(false);
  });
});

describe('plan summary', () => {
  const plan = coercePlan(GOOD) as AgentPlan;

  it('names every operation in plain language', () => {
    const rows = planRows(plan, new Map([['shape:s', 'SKU 上新']]));
    expect(rows[0].label).toContain('新建');
    expect(rows[1].detail).toBe('SKU 上新 → 白底主图');
  });

  it('marks run operations as needing separate confirmation', () => {
    const withRun = { ...plan, operations: [...plan.operations, { type: 'run_nodes' as const, nodeIds: ['a'] }] };
    const rows = planRows(withRun, new Map());
    expect(rows.at(-1)?.label).toContain('需单独确认');
  });

  it('counts what the card promises', () => {
    expect(planCounts(plan)).toEqual({ created: 1, updated: 0, connections: 1, runs: 0 });
  });
});

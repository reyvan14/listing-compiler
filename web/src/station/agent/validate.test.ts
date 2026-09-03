import { beforeEach, describe, expect, it, vi } from 'vitest';

const ports = vi.hoisted(() => ({
  byShape: new Map<string, Record<string, { terminal: string; dataType: string }>>(),
  connections: new Map<string, Array<{ terminal: string; connectedShapeId: string }>>(),
}));

vi.mock('@/pipeline/nodes/nodePorts', () => ({
  getNodePorts: (_editor: unknown, shape: { id?: string } | string) =>
    ports.byShape.get(typeof shape === 'string' ? shape : (shape.id ?? '')) ?? {},
  getNodePortConnections: (_editor: unknown, shape: { id?: string } | string) =>
    ports.connections.get(typeof shape === 'string' ? shape : (shape.id ?? '')) ?? [],
}));

import { stubEditor } from './testEditor';
import { validatePlan } from './validate';
import type { AgentOperation, AgentPlan } from './types';

function plan(operations: AgentOperation[], extra: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: 'p1',
    title: '测试计划',
    summary: '测试',
    estimatedModelCalls: 0,
    warnings: [],
    requiresRunConfirmation: false,
    operations,
    ...extra,
  };
}

const SKU = 'shape:sku';
const IMG = 'shape:img';

beforeEach(() => {
  ports.byShape.clear();
  ports.connections.clear();
  ports.byShape.set(SKU, { output: { terminal: 'start', dataType: 'text' } });
  ports.byShape.set(IMG, {
    prompt: { terminal: 'end', dataType: 'text' },
    image: { terminal: 'start', dataType: 'image' },
  });
});

function editor() {
  return stubEditor([
    { id: SKU, type: 'sku_listing' },
    { id: IMG, type: 'image_generation' },
  ]);
}

describe('validatePlan', () => {
  it('accepts a well-formed plan', () => {
    const result = validatePlan(
      editor(),
      plan([
        { type: 'update_node', nodeId: SKU, nodeType: 'sku_listing', fields: { productName: '折叠杯' } },
        { type: 'create_node', tempId: 'img2', nodeType: 'image_generation', fields: { aspectRatio: '1:1' } },
        { type: 'connect_nodes', from: { nodeId: SKU, portId: 'output' }, to: { nodeId: 'img2', portId: 'prompt' } },
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown node type', () => {
    const result = validatePlan(
      editor(),
      // @ts-expect-error deliberately outside the allow-list
      plan([{ type: 'create_node', tempId: 'x', nodeType: 'shell_command', fields: {} }]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain('shell_command');
  });

  it('rejects an unknown operation type', () => {
    const result = validatePlan(
      editor(),
      // @ts-expect-error deliberately outside the allow-list
      plan([{ type: 'delete_node', nodeIds: [SKU] }]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain('delete_node');
  });

  it('rejects fields outside the writable allow-list', () => {
    for (const field of ['imageUrls', 'isResultNode', '__proto__', 'spawnedNodeIds']) {
      const result = validatePlan(
        editor(),
        plan([
          { type: 'update_node', nodeId: IMG, nodeType: 'image_generation', fields: { [field]: 'x' } },
        ]),
      );
      expect(result.ok, field).toBe(false);
    }
  });

  it('rejects an invalid aspect ratio and an invalid duration', () => {
    const bad = validatePlan(
      editor(),
      plan([
        { type: 'update_node', nodeId: IMG, nodeType: 'image_generation', fields: { aspectRatio: '7:13' } },
      ]),
    );
    expect(bad.ok).toBe(false);

    const badDuration = validatePlan(
      editor(),
      plan([{ type: 'create_node', tempId: 'v', nodeType: 'video_generation', fields: { duration: '90s' } }]),
    );
    expect(badDuration.ok).toBe(false);
  });

  it('bounds prompt and text lengths', () => {
    const result = validatePlan(
      editor(),
      plan([
        {
          type: 'update_node',
          nodeId: IMG,
          nodeType: 'image_generation',
          fields: { prompt: 'a'.repeat(601) },
        },
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain('600');
  });

  it('rejects a reference to a node that does not exist', () => {
    const result = validatePlan(
      editor(),
      plan([
        { type: 'update_node', nodeId: 'shape:ghost', nodeType: 'sku_listing', fields: { productName: 'x' } },
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain('shape:ghost');
  });

  it('rejects a node type that does not match the shape on the canvas', () => {
    const result = validatePlan(
      editor(),
      plan([{ type: 'update_node', nodeId: SKU, nodeType: 'image_generation', fields: { prompt: 'x' } }]),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a port that does not exist', () => {
    const result = validatePlan(
      editor(),
      plan([
        { type: 'connect_nodes', from: { nodeId: SKU, portId: 'nope' }, to: { nodeId: IMG, portId: 'prompt' } },
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain('nope');
  });

  it('rejects connecting incompatible port data types', () => {
    const result = validatePlan(
      editor(),
      plan([
        // image output into a text input
        { type: 'connect_nodes', from: { nodeId: IMG, portId: 'image' }, to: { nodeId: IMG, portId: 'prompt' } },
      ]),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a connection that would create a cycle', () => {
    ports.byShape.set(SKU, {
      output: { terminal: 'start', dataType: 'text' },
      input: { terminal: 'end', dataType: 'text' },
    });
    ports.connections.set(SKU, [{ terminal: 'start', connectedShapeId: IMG }]);
    const result = validatePlan(
      editor(),
      plan([
        { type: 'connect_nodes', from: { nodeId: IMG, portId: 'image' }, to: { nodeId: SKU, portId: 'input' } },
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain('环');
  });

  it('caps operations and created nodes', () => {
    const many: AgentOperation[] = Array.from({ length: 30 }, (_, i) => ({
      type: 'create_node',
      tempId: `n${i}`,
      nodeType: 'image_generation',
      fields: {},
    }));
    const result = validatePlan(editor(), plan(many));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join()).toContain('操作数量超过上限');
      expect(result.errors.join()).toContain('新建节点数量超过上限');
    }
  });

  it('rejects duplicate temporary ids', () => {
    const result = validatePlan(
      editor(),
      plan([
        { type: 'create_node', tempId: 'dup', nodeType: 'image_generation', fields: {} },
        { type: 'create_node', tempId: 'dup', nodeType: 'image_generation', fields: {} },
      ]),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects an empty plan', () => {
    expect(validatePlan(editor(), plan([])).ok).toBe(false);
  });
});

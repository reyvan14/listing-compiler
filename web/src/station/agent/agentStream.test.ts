import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamAgent } from './agentApi';
import type { AgentCanvasContext } from './types';

// These drive the real streaming client against a scripted `fetch`, so the
// chunk boundaries, the fallback rules and the abort path are exercised
// exactly as they run in the browser.

const CONTEXT: AgentCanvasContext = {
  selectedNodeIds: [],
  nodes: [],
  connections: [],
  evidenceSummary: { verified: 0, needsReview: 0, conflicting: 0, unsupported: 0 },
  policyVersions: {},
};

const PLAN = {
  id: 'p',
  title: '创建三平台完整上新工作流',
  summary: 'S',
  estimatedModelCalls: 4,
  warnings: [],
  requiresRunConfirmation: true,
  operations: [
    { type: 'create_node', tempId: 'a', nodeType: 'image_generation', fields: { aspectRatio: '1:1' } },
  ],
};

function frame(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A Response whose body streams `chunks`, optionally pausing between them. */
function sseResponse(chunks: string[], opts: { status?: number; contentType?: string } = {}) {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index++]));
    },
  });
  return new Response(body, {
    status: opts.status ?? 200,
    headers: { 'content-type': opts.contentType ?? 'text/event-stream; charset=utf-8' },
  });
}

function collect() {
  const deltas: string[] = [];
  const stages: string[] = [];
  const plans: unknown[] = [];
  const warnings: string[] = [];
  const errors: unknown[] = [];
  return {
    deltas,
    stages,
    plans,
    warnings,
    errors,
    handlers: {
      onDelta: (t: string) => deltas.push(t),
      onStatus: (s: { stage: string }) => stages.push(s.stage),
      onPlan: (p: unknown) => plans.push(p),
      onWarning: (w: string) => warnings.push(w),
      onError: (e: unknown) => errors.push(e),
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('streamAgent', () => {
  it('delivers text incrementally and in order, then the plan', async () => {
    const sink = collect();
    vi.stubGlobal('fetch', async () =>
      sseResponse([
        frame('meta', { requestId: 'r1' }),
        frame('status', { stage: 'understanding', label: 'a', detail: '', sequence: 1 }),
        // a frame deliberately split across two chunks
        'event: delta\ndata: {"text":"我拟了',
        '一个方案。"}\n\n',
        frame('status', { stage: 'validating', label: 'b', detail: '', sequence: 2 }),
        frame('plan', { plan: PLAN }),
        frame('done', { requestId: 'r1' }),
      ]),
    );

    const result = await streamAgent([], CONTEXT, sink.handlers, new AbortController().signal);

    expect(sink.deltas).toEqual(['我拟了一个方案。']);
    expect(result.reply).toBe('我拟了一个方案。');
    expect(sink.stages).toEqual(['understanding', 'validating']);
    expect(result.plan?.title).toBe('创建三平台完整上新工作流');
    expect(result.meaningful).toBe(true);
    expect(result.unsupported).toBe(false);
  });

  it('appends deltas rather than replacing the text so far', async () => {
    const sink = collect();
    vi.stubGlobal('fetch', async () =>
      sseResponse([frame('delta', { text: '一' }), frame('delta', { text: '二' }), frame('delta', { text: '三' })]),
    );
    const result = await streamAgent([], CONTEXT, sink.handlers, new AbortController().signal);
    expect(sink.deltas).toEqual(['一', '二', '三']);
    expect(result.reply).toBe('一二三');
  });

  it('reports unsupported when the endpoint is missing, so the caller may fall back', async () => {
    for (const status of [404, 405]) {
      vi.stubGlobal('fetch', async () => sseResponse([], { status }));
      const result = await streamAgent([], CONTEXT, {}, new AbortController().signal);
      expect(result.unsupported, `status ${status}`).toBe(true);
      expect(result.meaningful).toBe(false);
    }
  });

  it('reports unsupported when the response is not an event stream', async () => {
    vi.stubGlobal('fetch', async () =>
      sseResponse([JSON.stringify({ reply: 'x' })], { contentType: 'application/json' }),
    );
    const result = await streamAgent([], CONTEXT, {}, new AbortController().signal);
    expect(result.unsupported).toBe(true);
  });

  it('does not mark transport or server failures as safe automatic fallbacks', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('connection reset after request upload');
    });
    await expect(
      streamAgent([], CONTEXT, {}, new AbortController().signal),
    ).rejects.toThrow(/手动重试/);

    vi.stubGlobal('fetch', async () =>
      sseResponse([], { status: 503, contentType: 'application/json' }),
    );
    await expect(
      streamAgent([], CONTEXT, {}, new AbortController().signal),
    ).rejects.toThrow(/503/);
  });

  it('does NOT report unsupported once a meaningful event has arrived', async () => {
    // Falling back here would re-show text and spend a second model call.
    const sink = collect();
    vi.stubGlobal('fetch', async () =>
      sseResponse([
        frame('delta', { text: '已经说了一半' }),
        frame('error', { category: 'network', message: '连接中断', retryable: true }),
      ]),
    );
    const result = await streamAgent([], CONTEXT, sink.handlers, new AbortController().signal);
    expect(result.meaningful).toBe(true);
    expect(result.unsupported).toBe(false);
    expect(sink.errors).toHaveLength(1);
  });

  it('drops a malformed plan payload instead of making it actionable', async () => {
    const sink = collect();
    vi.stubGlobal('fetch', async () =>
      sseResponse([
        // no operations at all — not a usable plan
        frame('plan', { plan: { title: 'x', summary: 'y', operations: [] } }),
        // an operation type outside the protocol
        frame('plan', { plan: { ...PLAN, operations: [{ type: 'exec', cmd: 'rm -rf /' }] } }),
        frame('done', {}),
      ]),
    );
    const result = await streamAgent([], CONTEXT, sink.handlers, new AbortController().signal);
    expect(sink.plans).toHaveLength(0);
    expect(result.plan).toBeNull();
  });

  it('surfaces a plan only from a complete plan event, never from deltas', async () => {
    const sink = collect();
    vi.stubGlobal('fetch', async () =>
      sseResponse([
        frame('delta', { text: '正在规划' }),
        // a partial plan frame that never terminates
        'event: plan\ndata: {"plan":{"title":"半个计划","operations":[',
      ]),
    );
    const result = await streamAgent([], CONTEXT, sink.handlers, new AbortController().signal);
    expect(sink.deltas).toEqual(['正在规划']);
    expect(sink.plans).toHaveLength(0);
    expect(result.plan).toBeNull();
  });

  it('stops reading when the caller aborts', async () => {
    const controller = new AbortController();
    const sink = collect();
    const encoder = new TextEncoder();
    // Bounded on purpose: an unbounded body would hang the test rather than
    // prove anything about cancellation.
    const total = 20;
    let pulled = 0;

    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        pull(ctrl) {
          if (init.signal?.aborted) {
            ctrl.error(new DOMException('aborted', 'AbortError'));
            return;
          }
          if (pulled >= total) {
            ctrl.close();
            return;
          }
          pulled += 1;
          ctrl.enqueue(encoder.encode(frame('delta', { text: `块${pulled}` })));
          if (pulled === 2) controller.abort();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    await expect(
      streamAgent([], CONTEXT, sink.handlers, controller.signal),
    ).rejects.toThrow();

    // It stopped early instead of draining the whole body.
    expect(sink.deltas.length).toBeGreaterThan(0);
    expect(sink.deltas.length).toBeLessThan(total);
  });

  it('refuses to send a context carrying image bytes', async () => {
    const poisoned = {
      ...CONTEXT,
      nodes: [{ id: 'n', type: 'image_generation', position: { x: 0, y: 0 }, editableFields: { imageUrls: ['data:image/png;base64,AAAA'] }, status: 'idle' as const }],
    };
    vi.stubGlobal('fetch', async () => sseResponse([]));
    await expect(
      streamAgent([], poisoned, {}, new AbortController().signal),
    ).rejects.toThrow(/图片数据/);
  });
});

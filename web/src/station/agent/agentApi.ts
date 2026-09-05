import { ApiError, postJson } from '../apiClient';
import {
  AGENT_NODE_TYPES,
  AGENT_OPERATION_TYPES,
  type AgentCanvasContext,
  type AgentPlan,
  type PlanRationale,
} from './types';
import { containsMediaPayload } from './canvasContext';
import { validateActionPlan } from './domainActions';
import { SseParser, eventPayload } from './sse';
import { isTraceStage, type TraceStage } from './trace';

// Wire layer for /api/agent/chat. Its job is to make sure that whatever comes
// back is shaped like a plan before any other module sees it — an unparseable
// or malformed `plan` is dropped, and the reply text is still shown.

export type AgentTurn = { role: 'user' | 'assistant'; content: string };

export type AgentResponse = { reply: string; plan: AgentPlan | null };

/** Structural check. Semantic validation against the canvas is validate.ts. */
export function coercePlan(raw: unknown): AgentPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.title !== 'string' || typeof p.summary !== 'string') return null;
  const rawOps = Array.isArray(p.operations) ? p.operations : [];
  const rawActions = Array.isArray(p.actions) ? p.actions : [];
  // A plan must do something. Canvas operations and domain actions both count.
  if (rawOps.length === 0 && rawActions.length === 0) return null;

  // Actions are re-validated here against the same allow-list the backend
  // enforces. A malformed or unknown action must never render as an applicable
  // card, so the whole plan is refused rather than partially shown.
  const actionCheck = validateActionPlan(
    rawActions.map(a => ({
      action: (a as { action?: unknown })?.action,
      params: (a as { params?: unknown })?.params ?? {},
    })),
  );
  if (!actionCheck.ok) return null;

  for (const op of rawOps) {
    if (!op || typeof op !== 'object') return null;
    const type = (op as { type?: unknown }).type;
    if (typeof type !== 'string' || !(AGENT_OPERATION_TYPES as readonly string[]).includes(type)) {
      return null;
    }
    const nodeType = (op as { nodeType?: unknown }).nodeType;
    if (
      nodeType !== undefined &&
      (typeof nodeType !== 'string' || !(AGENT_NODE_TYPES as readonly string[]).includes(nodeType))
    ) {
      return null;
    }
  }

  return {
    id: typeof p.id === 'string' ? p.id : `plan-${Date.now()}`,
    title: p.title,
    summary: p.summary,
    estimatedModelCalls:
      typeof p.estimatedModelCalls === 'number' && Number.isFinite(p.estimatedModelCalls)
        ? Math.max(0, Math.trunc(p.estimatedModelCalls))
        : 0,
    warnings: Array.isArray(p.warnings) ? p.warnings.filter(w => typeof w === 'string') : [],
    requiresRunConfirmation: p.requiresRunConfirmation !== false,
    operations: rawOps as AgentPlan['operations'],
    actions: actionCheck.actions.map((validated, i) => {
      const declared = (rawActions[i] ?? {}) as Record<string, unknown>;
      return {
        action: validated.spec.action,
        params: validated.params,
        // Presentation comes from the local spec, so a hostile payload cannot
        // relabel a paid action as free.
        label: validated.spec.label,
        summary: validated.spec.summary,
        readOnly: validated.spec.readOnly,
        requiresConfirmation: validated.spec.requiresConfirmation,
        costsMoney: validated.spec.costsMoney,
        confirmPrompt:
          validated.spec.confirmPrompt ||
          (typeof declared.confirmPrompt === 'string' ? declared.confirmPrompt : ''),
      };
    }),
    rationale: coerceRationale(p.rationale),
  };
}

/**
 * The structured "为什么这样规划" block.
 *
 * Every field is a short, typed value the backend derived from the validated
 * plan. There is no free-text field, which is what makes it impossible for
 * model reasoning to arrive here disguised as an explanation.
 */
export function coerceRationale(raw: unknown): PlanRationale | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

  const nodes = Array.isArray(r.nodes)
    ? r.nodes
        .filter((n): n is Record<string, unknown> => !!n && typeof n === 'object')
        .map(n => ({
          ref: String(n.ref ?? ''),
          nodeType: String(n.nodeType ?? ''),
          purpose: String(n.purpose ?? ''),
          aspectRatio: typeof n.aspectRatio === 'string' ? n.aspectRatio : undefined,
          duration: typeof n.duration === 'string' ? n.duration : undefined,
        }))
        .slice(0, 12)
    : [];

  return {
    intent: strings(r.intent).slice(0, 8),
    platforms: strings(r.platforms).slice(0, 6),
    source: r.source === 'model' ? 'model' : 'template',
    nodes,
    nodeCount: count(r.nodeCount),
    updatedNodeCount: count(r.updatedNodeCount),
    connectionCount: count(r.connectionCount),
    warnings: strings(r.warnings).slice(0, 10),
    estimatedModelCalls: count(r.estimatedModelCalls),
    requiresRunConfirmation: r.requiresRunConfirmation === true,
    runTargets: strings(r.runTargets).slice(0, 16),
    publishes: r.publishes === true,
    publishNote: typeof r.publishNote === 'string' ? r.publishNote : '',
  };
}

export async function askAgent(
  messages: AgentTurn[],
  context: AgentCanvasContext,
): Promise<AgentResponse> {
  // Belt and braces: buildCanvasContext already strips media, so a hit here is
  // a bug, not a user problem. Fail closed rather than upload a data URL.
  if (containsMediaPayload(context)) {
    throw new Error('画布上下文里混入了图片数据，已中止发送。');
  }

  const data = await postJson<{ reply?: string; plan?: unknown }>(
    '/api/agent/chat',
    { messages, context },
    { timeoutMs: 45_000 },
  );
  if (!data.reply) throw new Error('empty reply');
  return { reply: data.reply, plan: coercePlan(data.plan) };
}


// --------------------------------------------------------------------------
// Streaming
// --------------------------------------------------------------------------


export type AgentStreamHandlers = {
  onMeta?: (requestId: string) => void;
  onStatus?: (status: {
    stage: TraceStage;
    label: string;
    detail: string;
    sequence: number;
  }) => void;
  onDelta?: (text: string) => void;
  onWarning?: (message: string) => void;
  onPlan?: (plan: AgentPlan) => void;
  onError?: (error: { category: string; message: string; retryable: boolean }) => void;
};

export type AgentStreamResult = {
  /** True once any delta/status/plan/warning arrived. */
  meaningful: boolean;
  /** Set when the endpoint itself is unusable and a fallback is allowed. */
  unsupported: boolean;
  reply: string;
  plan: AgentPlan | null;
};

const STREAM_URL = '/api/agent/chat/stream';

/**
 * Stream one Agent turn.
 *
 * Returns `unsupported: true` only when the endpoint is missing or answers
 * with the wrong content type AND nothing meaningful has been delivered — that
 * is the sole condition under which the caller may retry the older endpoint.
 * Once a single delta, status or plan has arrived, an automatic retry would
 * duplicate visible text and spend a second model call, so it is refused and
 * the user gets an explicit retry action instead.
 */
export async function streamAgent(
  messages: AgentTurn[],
  context: AgentCanvasContext,
  handlers: AgentStreamHandlers,
  signal: AbortSignal,
): Promise<AgentStreamResult> {
  if (containsMediaPayload(context)) {
    throw new Error('画布上下文里混入了图片数据，已中止发送。');
  }

  const result: AgentStreamResult = {
    meaningful: false,
    unsupported: false,
    reply: '',
    plan: null,
  };

  let response: Response;
  try {
    response = await fetch(STREAM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ messages, context }),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    // A transport failure does not prove the server never started the model:
    // fetch cannot tell "connection refused" from "reset after the request was
    // uploaded". So this still does NOT fall back automatically — a second call
    // could duplicate a charged request — and the user gets an explicit retry.
    //
    // It is an ApiError rather than a bare Error so the category and the safe
    // Chinese message survive. Throwing `new Error(...)` here meant the panel
    // rendered "发生未知错误，请稍后重试。" and lost both.
    throw new ApiError('network');
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (response.status === 404 || response.status === 405) {
    result.unsupported = true;
    return result;
  }
  if (!response.ok) {
    throw new Error(`Agent 流式服务返回错误（${response.status}），请手动重试。`);
  }
  if (!response.body || !contentType.includes('text/event-stream')) {
    result.unsupported = true;
    return result;
  }

  const parser = new SseParser();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  const handle = (event: { event: string; data: string }) => {
    const payload = eventPayload(event);
    switch (event.event) {
      case 'meta':
        if (payload && typeof payload.requestId === 'string') handlers.onMeta?.(payload.requestId);
        break;
      case 'status': {
        if (!payload || !isTraceStage(payload.stage)) return;
        result.meaningful = true;
        handlers.onStatus?.({
          stage: payload.stage,
          label: typeof payload.label === 'string' ? payload.label : '',
          detail: typeof payload.detail === 'string' ? payload.detail : '',
          sequence: typeof payload.sequence === 'number' ? payload.sequence : 0,
        });
        break;
      }
      case 'delta': {
        const text = payload && typeof payload.text === 'string' ? payload.text : '';
        if (!text) return;
        result.meaningful = true;
        result.reply += text;
        handlers.onDelta?.(text);
        break;
      }
      case 'warning': {
        const message = payload && typeof payload.message === 'string' ? payload.message : '';
        if (!message) return;
        result.meaningful = true;
        handlers.onWarning?.(message);
        break;
      }
      case 'plan': {
        // Only a complete, coercible plan becomes actionable. A partial or
        // malformed one is dropped rather than rendered with buttons.
        const plan = payload ? coercePlan(payload.plan) : null;
        if (!plan) return;
        result.meaningful = true;
        result.plan = plan;
        handlers.onPlan?.(plan);
        break;
      }
      case 'error': {
        if (!payload) return;
        result.meaningful = true;
        handlers.onError?.({
          category: typeof payload.category === 'string' ? payload.category : 'unknown',
          message:
            typeof payload.message === 'string' ? payload.message : 'Agent 调用失败，请重试。',
          retryable: payload.retryable !== false,
        });
        break;
      }
      // heartbeat / done need no handling beyond keeping the socket alive
      default:
        break;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) handle(event);
    }
    for (const event of parser.flush()) handle(event);
  } finally {
    // Abort or early return must not leave the body half-read.
    reader.cancel().catch(() => {});
  }

  return result;
}

import { postJson } from '../apiClient';
import { AGENT_NODE_TYPES, AGENT_OPERATION_TYPES, type AgentCanvasContext, type AgentPlan } from './types';
import { containsMediaPayload } from './canvasContext';

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
  if (!Array.isArray(p.operations) || p.operations.length === 0) return null;

  for (const op of p.operations) {
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
    operations: p.operations as AgentPlan['operations'],
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

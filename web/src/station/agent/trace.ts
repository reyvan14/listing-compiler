// The user-visible execution trace: 执行过程.
//
// Deliberately NOT the model's reasoning. Every entry here is something the
// product actually did and the user could check — it read the canvas, it
// queried the evidence ledger, it validated a plan against the allow-list.
// The provider's `reasoning_content` is dropped at the backend boundary and
// never reaches this file.

export const TRACE_STAGES = [
  'understanding',
  'reading_canvas',
  'checking_evidence',
  'planning',
  'validating',
  'ready',
  'applying',
  'generating',
  'completed',
  'failed',
  'cancelled',
] as const;

export type TraceStage = (typeof TRACE_STAGES)[number];

export type TraceEntry = {
  stage: TraceStage;
  label: string;
  detail: string;
  sequence: number;
  state: 'active' | 'done' | 'failed';
  /** ms since the turn began, for the optional elapsed-time column. */
  at: number;
};

export const STAGE_LABELS: Record<TraceStage, string> = {
  understanding: '正在理解你的要求',
  reading_canvas: '正在读取当前画布',
  checking_evidence: '正在核对证据账本',
  planning: '正在生成变更计划',
  validating: '正在校验计划',
  ready: '计划已就绪，等待你确认',
  applying: '正在应用到画布',
  generating: '正在生成内容',
  completed: '已完成',
  failed: '未完成',
  cancelled: '已取消',
};

/** Stages that end the trace: nothing after them is still "in progress". */
const TERMINAL: ReadonlySet<TraceStage> = new Set([
  'ready',
  'completed',
  'failed',
  'cancelled',
]);

export function isTraceStage(value: unknown): value is TraceStage {
  return typeof value === 'string' && (TRACE_STAGES as readonly string[]).includes(value);
}

/**
 * Append `entry` to `entries`, settling whatever was active before it.
 *
 * Order is preserved as received. A repeated stage updates in place rather
 * than stacking duplicates, so a `generating` stage that reports 1/5 then 2/5
 * stays one row.
 */
export function advanceTrace(
  entries: TraceEntry[],
  next: {
    stage: TraceStage;
    label?: string;
    detail?: string;
    sequence?: number;
    state?: TraceEntry['state'];
    at?: number;
  },
): TraceEntry[] {
  const state = next.state ?? (TERMINAL.has(next.stage) ? 'done' : 'active');
  const failed = next.stage === 'failed' || next.stage === 'cancelled';
  const settled = entries.map(entry =>
    entry.state === 'active'
      ? { ...entry, state: failed ? ('failed' as const) : ('done' as const) }
      : entry,
  );

  const entry: TraceEntry = {
    stage: next.stage,
    label: next.label || STAGE_LABELS[next.stage],
    detail: next.detail ?? '',
    sequence: next.sequence ?? settled.length + 1,
    state: failed ? 'failed' : state,
    at: next.at ?? 0,
  };

  const existing = settled.findIndex(e => e.stage === next.stage);
  if (existing !== -1) {
    const merged = [...settled];
    merged[existing] = { ...entry, sequence: settled[existing].sequence };
    return merged;
  }
  return [...settled, entry];
}

/** The row shown when the trace is collapsed. */
export function currentEntry(entries: TraceEntry[]): TraceEntry | null {
  if (entries.length === 0) return null;
  return entries.find(e => e.state === 'active') ?? entries[entries.length - 1];
}

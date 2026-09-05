import { ApiError, apiUrl, toSafeMessage } from '../apiClient';
import { evidenceHeaders } from '../evidenceApi';

// Typed Agent domain actions, validated here as well as on the server.
//
// The duplication is deliberate. The backend is the authority — it is the thing
// an attacker actually has to get past — but validating here too means a
// malformed or hostile action never renders as an applicable card, so the
// operator is not asked to approve something that was never legitimate.
//
// The model chooses an action name and typed parameters. It never chooses an
// endpoint, a URL, a method, a path or a command, and there is no field in this
// module through which it could.

export type DomainActionName =
  | 'validate_listing'
  | 'inspect_image'
  | 'open_release_passport'
  | 'build_release_passport'
  | 'export_release_package'
  | 'analyze_policy_impact'
  | 'build_migration_candidate'
  | 'open_evidence_source'
  | 'analyze_feedback'
  | 'create_experiment';

export type ParamKind = 'id' | 'text' | 'idList';

export type ActionSpec = {
  action: DomainActionName;
  label: string;
  summary: string;
  params: Record<string, ParamKind>;
  required: string[];
  readOnly: boolean;
  requiresConfirmation: boolean;
  costsMoney: boolean;
  confirmPrompt: string;
};

/** Mirrors api/agent_actions.py. Publishing is absent, deliberately. */
export const ACTION_SPECS: Record<DomainActionName, ActionSpec> = {
  validate_listing: {
    action: 'validate_listing',
    label: '校验文案',
    summary: '对指定修订运行确定性校验，不改动任何内容。',
    params: { revision_id: 'id' },
    required: ['revision_id'],
    readOnly: true,
    requiresConfirmation: false,
    costsMoney: false,
    confirmPrompt: '',
  },
  inspect_image: {
    action: 'inspect_image',
    label: '检查图片',
    summary: '按像素重新检查已存储的图片资产。',
    params: { asset_id: 'id' },
    required: ['asset_id'],
    readOnly: true,
    requiresConfirmation: false,
    costsMoney: false,
    confirmPrompt: '',
  },
  open_release_passport: {
    action: 'open_release_passport',
    label: '查看发布护照',
    summary: '读取已存在的发布护照，不重新计算，不导出。',
    params: { passport_id: 'id' },
    required: ['passport_id'],
    readOnly: true,
    requiresConfirmation: false,
    costsMoney: false,
    confirmPrompt: '',
  },
  build_release_passport: {
    action: 'build_release_passport',
    label: '生成发布护照',
    summary: '按当前记录重新计算就绪状态并存储护照。',
    params: { sku_id: 'id', platform: 'id' },
    required: ['sku_id', 'platform'],
    readOnly: false,
    requiresConfirmation: false,
    costsMoney: false,
    confirmPrompt: '',
  },
  export_release_package: {
    action: 'export_release_package',
    label: '导出交接包',
    summary: '生成并校验交接包 ZIP。不会向任何平台发布。',
    params: { passport_id: 'id' },
    required: ['passport_id'],
    readOnly: false,
    requiresConfirmation: true,
    costsMoney: false,
    confirmPrompt: '导出交接包会把已批准文案、图片原件与审批记录打包。不会发布到任何平台。确认导出？',
  },
  analyze_policy_impact: {
    action: 'analyze_policy_impact',
    label: '分析政策影响面',
    summary: '计算一次政策变更影响到哪些产物，不改写任何产物。',
    params: { base: 'id', candidate: 'id' },
    required: ['base', 'candidate'],
    readOnly: true,
    requiresConfirmation: false,
    costsMoney: false,
    confirmPrompt: '',
  },
  build_migration_candidate: {
    action: 'build_migration_candidate',
    label: '生成迁移候选补丁',
    summary: '为受影响字段生成候选补丁供人工审阅。当前产物不被改写。',
    params: { platform: 'id', fields: 'idList' },
    required: ['platform'],
    readOnly: false,
    requiresConfirmation: true,
    costsMoney: true,
    confirmPrompt: '生成迁移候选补丁可能调用模型并产生费用。当前已批准内容不会被改写。确认继续？',
  },
  open_evidence_source: {
    action: 'open_evidence_source',
    label: '查看证据文件',
    summary: '读取一份证据文件的元数据与关联事实。',
    params: { source_id: 'id' },
    required: ['source_id'],
    readOnly: true,
    requiresConfirmation: false,
    costsMoney: false,
    confirmPrompt: '',
  },
  analyze_feedback: {
    action: 'analyze_feedback',
    label: '分析投放反馈',
    summary: '对已导入的表现数据做确定性分析，产出候选改进项。',
    params: { import_id: 'id' },
    required: ['import_id'],
    readOnly: true,
    requiresConfirmation: false,
    costsMoney: false,
    confirmPrompt: '',
  },
  create_experiment: {
    action: 'create_experiment',
    label: '创建实验',
    summary: '登记一次 A/B 实验的假设、基线修订与候选修订。',
    params: {
      hypothesis: 'text',
      baseline_revision_id: 'id',
      candidate_revision_id: 'id',
    },
    required: ['hypothesis', 'baseline_revision_id'],
    readOnly: false,
    requiresConfirmation: false,
    costsMoney: false,
    confirmPrompt: '',
  },
};

/** Named so a refusal is explicit rather than implied by absence. */
export const FORBIDDEN_ACTIONS = [
  'publish_listing',
  'submit_to_marketplace',
  'delete_project',
  'run_shell',
  'http_request',
  'read_file',
  'write_file',
];

export const MAX_ACTIONS_PER_PLAN = 8;
const MAX_ID_CHARS = 120;
const MAX_TEXT_CHARS = 500;

/** Same positive allow-list as the backend: if it is not id-shaped, refuse it. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

export type ActionProblem = {
  code:
    | 'unknown_action'
    | 'forbidden_action'
    | 'unknown_param'
    | 'missing_param'
    | 'unsafe_param'
    | 'param_too_long'
    | 'bad_params'
    | 'too_many_actions';
  message: string;
  action?: string;
  param?: string;
};

export type ValidatedAction = {
  spec: ActionSpec;
  params: Record<string, string | string[]>;
};

export type ActionValidation =
  | { ok: true; actions: ValidatedAction[] }
  | { ok: false; problems: ActionProblem[] };

export function validateAction(raw: unknown): { ok: true; value: ValidatedAction } | { ok: false; problem: ActionProblem } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, problem: { code: 'bad_params', message: '操作格式不正确。' } };
  }
  const record = raw as Record<string, unknown>;
  const name = String(record.action ?? '').trim();

  if (FORBIDDEN_ACTIONS.includes(name)) {
    return {
      ok: false,
      problem: { code: 'forbidden_action', message: `操作 ${name} 永远不被允许。`, action: name },
    };
  }
  const spec = ACTION_SPECS[name as DomainActionName];
  if (!spec) {
    return {
      ok: false,
      problem: { code: 'unknown_action', message: `未知操作：${name || '(空)'}`, action: name },
    };
  }

  const supplied = (record.params ?? {}) as Record<string, unknown>;
  if (typeof supplied !== 'object' || Array.isArray(supplied)) {
    return {
      ok: false,
      problem: { code: 'bad_params', message: `${name} 的参数格式不正确。`, action: name },
    };
  }

  for (const key of Object.keys(supplied)) {
    if (!(key in spec.params)) {
      return {
        ok: false,
        problem: { code: 'unknown_param', message: `${name} 不接受参数：${key}`, action: name, param: key },
      };
    }
  }

  const params: Record<string, string | string[]> = {};
  for (const [key, kind] of Object.entries(spec.params)) {
    if (!(key in supplied)) {
      if (spec.required.includes(key)) {
        return {
          ok: false,
          problem: { code: 'missing_param', message: `${name} 缺少必需参数：${key}`, action: name, param: key },
        };
      }
      continue;
    }
    const value = supplied[key];
    if (kind === 'idList') {
      if (!Array.isArray(value) || value.length > 40) {
        return {
          ok: false,
          problem: { code: 'bad_params', message: `${name}.${key} 必须是长度 ≤ 40 的列表。`, action: name, param: key },
        };
      }
      const items = value.map(v => String(v).trim());
      if (items.some(v => !ID_PATTERN.test(v))) {
        return {
          ok: false,
          problem: { code: 'unsafe_param', message: `${name}.${key} 含有非法标识符，已拒绝。`, action: name, param: key },
        };
      }
      params[key] = items;
      continue;
    }
    const text = String(value ?? '').trim();
    if (kind === 'text') {
      if (text.length > MAX_TEXT_CHARS) {
        return {
          ok: false,
          problem: { code: 'param_too_long', message: `${name}.${key} 超出长度上限。`, action: name, param: key },
        };
      }
      params[key] = text;
      continue;
    }
    if (text.length > MAX_ID_CHARS) {
      return {
        ok: false,
        problem: { code: 'param_too_long', message: `${name}.${key} 超出长度上限。`, action: name, param: key },
      };
    }
    if (!ID_PATTERN.test(text)) {
      return {
        ok: false,
        problem: { code: 'unsafe_param', message: `${name}.${key} 不是合法的标识符，已拒绝。`, action: name, param: key },
      };
    }
    params[key] = text;
  }

  return { ok: true, value: { spec, params } };
}

/** Validate a whole plan. One bad action rejects all of them. */
export function validateActionPlan(raw: unknown): ActionValidation {
  if (!Array.isArray(raw)) {
    return { ok: false, problems: [{ code: 'bad_params', message: '操作计划格式不正确。' }] };
  }
  if (raw.length > MAX_ACTIONS_PER_PLAN) {
    return {
      ok: false,
      problems: [
        { code: 'too_many_actions', message: `一次最多 ${MAX_ACTIONS_PER_PLAN} 个操作。` },
      ],
    };
  }
  const actions: ValidatedAction[] = [];
  for (const item of raw) {
    const result = validateAction(item);
    if (!result.ok) return { ok: false, problems: [result.problem] };
    actions.push(result.value);
  }
  return { ok: true, actions };
}

export function needsConfirmation(actions: ValidatedAction[]): ValidatedAction[] {
  return actions.filter(a => a.spec.requiresConfirmation);
}

export function planIsReadOnly(actions: ValidatedAction[]): boolean {
  return actions.every(a => a.spec.readOnly);
}

// --------------------------------------------------------------------------- //
// Client                                                                       //
// --------------------------------------------------------------------------- //

export type ActionRun = {
  action: string;
  params: Record<string, unknown>;
  state: 'ok' | 'rejected' | 'needs_confirmation' | 'failed' | 'unavailable';
  read_only?: boolean;
  confirmed?: boolean;
  result?: Record<string, unknown>;
  error?: string;
  message?: string;
  confirmation_token?: string;
  confirm_prompt?: string;
  costs_money?: boolean;
  started_at?: string;
  at: string;
  idempotency_key?: string;
  replayed: boolean;
};

type Envelope<T> = { code?: number; error?: string; message?: string; data?: T };

export class ActionRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ActionRejected';
    this.code = code;
  }
}

export function actionErrorMessage(err: unknown): string {
  if (err instanceof ActionRejected) return err.message;
  return toSafeMessage(err);
}

async function request<T>(path: string, productId: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...evidenceHeaders(productId),
      },
    });
  } catch {
    throw new ApiError('network');
  }
  let json: Envelope<T> | null = null;
  try {
    json = (await res.json()) as Envelope<T>;
  } catch {
    json = null;
  }
  if (!res.ok) {
    if (json?.error && json?.message) throw new ActionRejected(json.error, json.message);
    throw new ApiError('http', res.status);
  }
  if (!json || json.code !== 0 || json.data === undefined) {
    throw new ApiError('bad-response', res.status);
  }
  return json.data;
}

/**
 * Run one action.
 *
 * `idempotencyKey` is the caller's promise that two calls with the same key are
 * the same intent, which is what lets a retry be safe.
 */
export async function runAction(
  action: string,
  params: Record<string, unknown>,
  idempotencyKey: string,
  confirmationToken = '',
  productId = 'default-product',
): Promise<ActionRun> {
  const data = await request<{ run: ActionRun }>('/api/agent/actions/run', productId, {
    method: 'POST',
    body: JSON.stringify({
      action,
      params,
      idempotency_key: idempotencyKey,
      confirmation_token: confirmationToken,
    }),
  });
  return data.run;
}

export function fetchActionCatalog(
  productId = 'default-product',
  signal?: AbortSignal,
): Promise<{ actions: unknown[]; forbidden: string[]; publishes: boolean }> {
  return request('/api/agent/actions', productId, { signal });
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACTION_SPECS,
  FORBIDDEN_ACTIONS,
  MAX_ACTIONS_PER_PLAN,
  actionErrorMessage,
  needsConfirmation,
  planIsReadOnly,
  runAction,
  validateAction,
  validateActionPlan,
} from './domainActions';

afterEach(() => vi.unstubAllGlobals());

const ok = (params: Record<string, unknown>) => ({ action: 'validate_listing', params });

describe('the allow-list', () => {
  it('offers exactly the ten specified actions and no publishing', () => {
    expect(Object.keys(ACTION_SPECS)).toHaveLength(10);
    expect(Object.keys(ACTION_SPECS)).not.toContain('publish_listing');
    expect(FORBIDDEN_ACTIONS).toContain('publish_listing');
    expect(FORBIDDEN_ACTIONS).toContain('submit_to_marketplace');
  });

  it('exposes no parameter through which a model could name a target', () => {
    for (const spec of Object.values(ACTION_SPECS)) {
      for (const param of Object.keys(spec.params)) {
        expect(['url', 'endpoint', 'method', 'path', 'command', 'cmd', 'shell']).not.toContain(
          param,
        );
      }
    }
  });

  it('marks the consequential actions as needing their own confirmation', () => {
    expect(ACTION_SPECS.export_release_package.requiresConfirmation).toBe(true);
    expect(ACTION_SPECS.build_migration_candidate.requiresConfirmation).toBe(true);
    expect(ACTION_SPECS.build_migration_candidate.costsMoney).toBe(true);
    expect(ACTION_SPECS.validate_listing.requiresConfirmation).toBe(false);
  });

  it('states in the export prompt that nothing is published', () => {
    expect(ACTION_SPECS.export_release_package.confirmPrompt).toContain('不会发布到任何平台');
  });
});

describe('validation refuses', () => {
  it.each(FORBIDDEN_ACTIONS)('the forbidden action %s', name => {
    const result = validateAction({ action: name, params: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.code).toBe('forbidden_action');
  });

  it('an unknown action', () => {
    const result = validateAction({ action: 'make_me_a_sandwich', params: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.code).toBe('unknown_action');
  });

  it('an unknown parameter rather than ignoring it', () => {
    const result = validateAction(ok({ revision_id: 'rev-0001', extra: 'x' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.code).toBe('unknown_param');
  });

  it('a missing required parameter', () => {
    const result = validateAction(ok({}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.code).toBe('missing_param');
  });

  it.each([
    '../../etc/passwd',
    '..\\windows\\system32',
    'http://169.254.169.254/latest',
    'rev-1; rm -rf /',
    'rev-1 | cat /etc/passwd',
    '$(whoami)',
    '`id`',
    'rev 1',
  ])('a parameter shaped like a path or command: %s', value => {
    const result = validateAction(ok({ revision_id: value }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.code).toBe('unsafe_param');
  });

  it('an overlong id', () => {
    const result = validateAction(ok({ revision_id: 'x'.repeat(200) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.code).toBe('param_too_long');
  });

  it('a malformed action object', () => {
    for (const bad of ['validate_listing', 42, null, []]) {
      expect(validateAction(bad).ok).toBe(false);
    }
  });

  it('an id inside a list parameter', () => {
    const result = validateAction({
      action: 'build_migration_candidate',
      params: { platform: 'amazon', fields: ['title', '../../etc/passwd'] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.code).toBe('unsafe_param');
  });
});

describe('validation accepts', () => {
  it('a well-formed action', () => {
    const result = validateAction(ok({ revision_id: 'rev-0001' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.params.revision_id).toBe('rev-0001');
  });

  it('real-world id shapes', () => {
    for (const id of ['rev-0001', 'psp-0001', 'amazon-us-2025.01.21', 'a1b2c3d4e5f6']) {
      expect(validateAction(ok({ revision_id: id })).ok).toBe(true);
    }
  });

  it('prose in a free-text parameter without treating it as an id', () => {
    const result = validateAction({
      action: 'create_experiment',
      params: { hypothesis: 'Shorter titles convert better.', baseline_revision_id: 'rev-0001' },
    });
    expect(result.ok).toBe(true);
  });
});

describe('plans', () => {
  it('are bounded', () => {
    const plan = Array.from({ length: MAX_ACTIONS_PER_PLAN + 1 }, () =>
      ok({ revision_id: 'rev-0001' }),
    );
    const result = validateActionPlan(plan);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0].code).toBe('too_many_actions');
  });

  it('reject entirely when one action is bad', () => {
    const result = validateActionPlan([
      ok({ revision_id: 'rev-0001' }),
      { action: 'run_shell', params: {} },
    ]);
    expect(result.ok).toBe(false);
  });

  it('report which actions still need confirming', () => {
    const result = validateActionPlan([
      ok({ revision_id: 'rev-0001' }),
      { action: 'export_release_package', params: { passport_id: 'psp-0001' } },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(needsConfirmation(result.actions).map(a => a.spec.action)).toEqual([
        'export_release_package',
      ]);
      expect(planIsReadOnly(result.actions)).toBe(false);
    }
  });

  it('recognise a wholly read-only plan', () => {
    const result = validateActionPlan([ok({ revision_id: 'rev-0001' })]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(planIsReadOnly(result.actions)).toBe(true);
  });
});

describe('runAction', () => {
  it('sends the idempotency key and confirmation token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: { run: { action: 'x', state: 'ok', at: '', replayed: false } } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await runAction('validate_listing', { revision_id: 'rev-0001' }, 'key-1', 'tok-1');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.idempotency_key).toBe('key-1');
    expect(body.confirmation_token).toBe('tok-1');
  });

  it('surfaces the backend refusal text rather than a generic error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ code: 1, error: 'forbidden_action', message: '操作永远不被允许。' }),
      }),
    );

    const err = await runAction('run_shell', {}, 'k').catch(e => e);
    expect(actionErrorMessage(err)).toContain('永远不被允许');
  });
});

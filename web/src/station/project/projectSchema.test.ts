import { describe, expect, it } from 'vitest';
import {
  MAX_SNAPSHOT_BYTES,
  PROJECT_SCHEMA,
  PROJECT_SCHEMA_VERSION,
  emptyRefs,
  findCredentialKey,
  validateSnapshot,
} from './projectSchema';

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schema: PROJECT_SCHEMA,
    schema_version: PROJECT_SCHEMA_VERSION,
    saved_at: '2026-09-04T00:00:00.000Z',
    storage: 'browser-local',
    project: { id: 'p', name: 'AeroFold', market: 'US', locale: 'en-US' },
    sku: { productName: 'AeroFold', points: '', platforms: ['amazon'], assetMode: 'compliant' },
    canvas: { store: { store: {}, schema: {} } },
    server_refs: emptyRefs(),
    agent_plans: [],
    omitted_media: [],
    ...overrides,
  };
}

describe('credential detection', () => {
  it('finds a credential-shaped key at any depth', () => {
    expect(findCredentialKey({ a: { b: [{ api_key: 'sk-x' }] } })).toBe('$.a.b[0].api_key');
    expect(findCredentialKey({ nested: { listing_secret: 'x' } })).toBe('$.nested.listing_secret');
    expect(findCredentialKey({ title: 'a cookie recipe' })).toBeNull();
  });

  it('rejects the whole import rather than stripping the field', () => {
    // Silently stripping would teach the sender that exporting secrets is safe.
    const outcome = validateSnapshot(snapshot({ extra: { access_token: 'abc' } }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.problems[0].code).toBe('credential_field');
      expect(outcome.problems[0].detail).toContain('access_token');
    }
  });
});

describe('version handling', () => {
  it('accepts the current version unchanged', () => {
    const outcome = validateSnapshot(snapshot());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.migratedFrom).toBeNull();
  });

  it('refuses a newer version instead of silently dropping what it does not know', () => {
    const outcome = validateSnapshot(snapshot({ schema_version: PROJECT_SCHEMA_VERSION + 5 }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.problems[0].code).toBe('future_version');
      expect(outcome.problems[0].message).toContain('更新的版本');
    }
  });

  it('migrates an unversioned payload rather than rejecting it', () => {
    const legacy = { canvas: { store: { store: {}, schema: {} } } };
    const outcome = validateSnapshot(legacy);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.migratedFrom).toBe(0);
      expect(outcome.snapshot.schema_version).toBe(PROJECT_SCHEMA_VERSION);
      expect(outcome.snapshot.server_refs).toEqual(emptyRefs());
    }
  });

  it('migrates a bare tldraw store snapshot into a project', () => {
    const bare = { store: { 'shape:a': {} }, schema: {} };
    const outcome = validateSnapshot(bare);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.snapshot.canvas.store).toEqual(bare);
      // nothing is invented: the references really are unknown
      expect(outcome.snapshot.server_refs.revision_ids).toEqual([]);
    }
  });

  it('rejects a non-numeric version', () => {
    const outcome = validateSnapshot(snapshot({ schema_version: 'two' }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.problems[0].code).toBe('bad_version');
  });

  it('rejects a versioned payload that is not this schema', () => {
    const outcome = validateSnapshot(snapshot({ schema: 'someone-elses-tool' }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.problems[0].code).toBe('wrong_schema');
  });
});

describe('structural validation', () => {
  it('rejects a payload that is not an object', () => {
    for (const bad of [null, 42, 'text', [1, 2]]) {
      const outcome = validateSnapshot(bad);
      expect(outcome.ok).toBe(false);
    }
  });

  it('rejects an oversized payload before parsing its contents', () => {
    const outcome = validateSnapshot(snapshot(), MAX_SNAPSHOT_BYTES + 1);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.problems[0].code).toBe('too_large');
  });

  it('rejects a snapshot with no canvas', () => {
    const outcome = validateSnapshot(snapshot({ canvas: { store: null } }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.problems.some(p => p.code === 'missing_canvas')).toBe(true);
  });

  it('rejects duplicate entity references', () => {
    const outcome = validateSnapshot(
      snapshot({ server_refs: { ...emptyRefs(), revision_ids: ['rev-1', 'rev-1'] } }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.problems.some(p => p.code === 'duplicate_ids')).toBe(true);
  });

  it('rejects an empty entity reference', () => {
    const outcome = validateSnapshot(
      snapshot({ server_refs: { ...emptyRefs(), asset_ids: ['a1', '  '] } }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.problems.some(p => p.code === 'bad_reference')).toBe(true);
  });
});

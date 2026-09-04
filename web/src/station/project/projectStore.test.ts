import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_SCHEMA, PROJECT_SCHEMA_VERSION, emptyRefs } from './projectSchema';
import {
  STORAGE_KEYS,
  clearProject,
  hasStoredProject,
  loadBackup,
  loadProject,
  saveProject,
} from './projectStore';

function snapshot(name = 'v1') {
  return {
    schema: PROJECT_SCHEMA as typeof PROJECT_SCHEMA,
    schema_version: PROJECT_SCHEMA_VERSION,
    saved_at: '2026-09-04T00:00:00.000Z',
    storage: 'browser-local' as const,
    project: { id: 'p', name, market: 'US', locale: 'en-US' },
    sku: { productName: name, points: '', platforms: ['amazon'], assetMode: 'compliant' },
    canvas: { store: { store: { [`shape:${name}`]: {} }, schema: {} } },
    server_refs: emptyRefs(),
    agent_plans: [],
    omitted_media: [],
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('saving', () => {
  it('stores the project and reports its size', () => {
    const outcome = saveProject(snapshot());
    expect(outcome.ok).toBe(true);
    expect(localStorage.getItem(STORAGE_KEYS.current)).toBeTruthy();
    expect(hasStoredProject()).toBe(true);
  });

  it('promotes the previous good snapshot to the backup slot', () => {
    saveProject(snapshot('first'));
    saveProject(snapshot('second'));

    expect(loadBackup()?.project.name).toBe('first');
    const loaded = loadProject();
    expect(loaded.status).toBe('loaded');
    if (loaded.status === 'loaded') expect(loaded.snapshot.project.name).toBe('second');
  });

  it('leaves the staging key clean after a successful write', () => {
    saveProject(snapshot());
    expect(localStorage.getItem(STORAGE_KEYS.staging)).toBeNull();
  });

  it('reports a quota failure without destroying what was already stored', () => {
    saveProject(snapshot('good'));
    const quota = new DOMException('full', 'QuotaExceededError');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw quota;
    });

    const outcome = saveProject(snapshot('doomed'));

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('quota');
      expect(outcome.message).toContain('导出项目');
    }
    vi.restoreAllMocks();
    const loaded = loadProject();
    expect(loaded.status).toBe('loaded');
    if (loaded.status === 'loaded') expect(loaded.snapshot.project.name).toBe('good');
  });

  it('refuses an oversized snapshot rather than attempting the write', () => {
    const huge = snapshot();
    huge.sku.points = 'x'.repeat(9 * 1024 * 1024);
    const outcome = saveProject(huge);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('too_large');
    expect(localStorage.getItem(STORAGE_KEYS.current)).toBeNull();
  });
});

describe('loading', () => {
  it('reports empty when nothing was ever stored', () => {
    expect(loadProject().status).toBe('empty');
  });

  it('recovers from the backup when the current slot is corrupt', () => {
    saveProject(snapshot('good'));
    saveProject(snapshot('newer'));
    localStorage.setItem(STORAGE_KEYS.current, '{ this is not json');

    const loaded = loadProject();

    expect(loaded.status).toBe('recovered');
    if (loaded.status === 'recovered') {
      expect(loaded.snapshot.project.name).toBe('good');
      expect(loaded.from).toBe('backup');
    }
  });

  it('does not open an older backup over a file from a newer build', () => {
    // Falling back would look like a successful load while silently reverting
    // the user to an older project.
    saveProject(snapshot('older'));
    localStorage.setItem(
      STORAGE_KEYS.current,
      JSON.stringify({ ...snapshot('future'), schema_version: PROJECT_SCHEMA_VERSION + 3 }),
    );

    const loaded = loadProject();

    expect(loaded.status).toBe('unreadable');
    if (loaded.status === 'unreadable') {
      expect(loaded.problems[0].code).toBe('future_version');
    }
  });

  it('reports unreadable when both slots are corrupt, and keeps the bytes', () => {
    localStorage.setItem(STORAGE_KEYS.current, 'nope');
    localStorage.setItem(STORAGE_KEYS.backup, 'also nope');

    expect(loadProject().status).toBe('unreadable');
    // the raw data is still there for a human to rescue
    expect(localStorage.getItem(STORAGE_KEYS.current)).toBe('nope');
  });

  it('loads from the backup when only a backup exists', () => {
    localStorage.setItem(STORAGE_KEYS.backup, JSON.stringify(snapshot('only-backup')));
    const loaded = loadProject();
    expect(loaded.status).toBe('recovered');
  });

  it('rejects a stored project containing a credential rather than loading it', () => {
    localStorage.setItem(
      STORAGE_KEYS.current,
      JSON.stringify({ ...snapshot(), leaked: { api_key: 'sk-x' } }),
    );
    const loaded = loadProject();
    expect(loaded.status).toBe('unreadable');
  });
});

describe('clearing', () => {
  it('removes current, backup and staging together', () => {
    saveProject(snapshot('a'));
    saveProject(snapshot('b'));
    clearProject();

    expect(hasStoredProject()).toBe(false);
    expect(loadProject().status).toBe('empty');
    expect(loadBackup()).toBeNull();
  });
});

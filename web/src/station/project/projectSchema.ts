// The versioned project snapshot: what survives a refresh, and what does not.
//
// Two kinds of state exist in this app, and the split matters.
//
// Server-owned records — listing revisions, validation runs, approvals,
// evidence documents and facts, inspected media, release passports — already
// live in a durable, request-scoped ledger. Copying them into browser storage
// would create a second source of truth that can silently disagree with the
// first. The snapshot therefore stores *references* to them, plus the scope
// that resolves those references, and lets the server stay authoritative.
//
// Canvas state — shapes, bindings, node contents, positions, camera — exists
// only in the editor's memory. That is the part a refresh destroys, so that is
// the part this snapshot actually carries.
//
// Nothing here is a credential store. Imports are rejected outright if they
// contain a credential-shaped field.

export const PROJECT_SCHEMA = 'listing-project';

/** Current snapshot version. Bump only alongside a migration. */
export const PROJECT_SCHEMA_VERSION = 1;

/** Hard ceiling on a stored or imported snapshot. */
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

/** Data URLs longer than this are omitted from browser-local storage. */
export const MAX_INLINE_MEDIA_CHARS = 4096;

export type OmittedMedia = {
  shape_id: string;
  field: string;
  chars: number;
};

export type ServerRefs = {
  workspace_id: string;
  product_id: string;
  revision_ids: string[];
  passport_ids: string[];
  asset_ids: string[];
  evidence_source_ids: string[];
  policy_snapshot_ids: string[];
};

export type ProjectSnapshot = {
  schema: typeof PROJECT_SCHEMA;
  schema_version: number;
  saved_at: string;
  /** Browser-local storage. Stated in the payload, not only in the UI. */
  storage: 'browser-local';
  project: {
    id: string;
    name: string;
    market: string;
    locale: string;
  };
  sku: {
    productName: string;
    points: string;
    platforms: string[];
    assetMode: string;
  };
  canvas: {
    /** A tldraw editor snapshot: shapes, bindings, page state and camera. */
    store: unknown;
  };
  server_refs: ServerRefs;
  /** Agent plans that were actually applied, for auditability. */
  agent_plans: { plan_id: string; title: string; applied_at: string; operations: number }[];
  omitted_media: OmittedMedia[];
};

/** A snapshot that failed validation, with the reason a person can act on. */
export type SnapshotProblem = {
  code:
    | 'not_an_object'
    | 'wrong_schema'
    | 'future_version'
    | 'bad_version'
    | 'too_large'
    | 'missing_canvas'
    | 'credential_field'
    | 'duplicate_ids'
    | 'bad_reference';
  message: string;
  detail?: string;
};

export type ValidationOutcome =
  | { ok: true; snapshot: ProjectSnapshot; migratedFrom: number | null }
  | { ok: false; problems: SnapshotProblem[] };

/**
 * Field names that must never appear in a project file.
 *
 * A project export is something people email each other. Rejecting the whole
 * import is the right response to finding a credential in one: silently
 * stripping it would teach the sender that exporting secrets is safe.
 */
export const FORBIDDEN_KEYS = [
  'api_key',
  'apikey',
  'authorization',
  'auth_token',
  'access_token',
  'secret',
  'password',
  'passwd',
  'cookie',
  'session_id',
  'private_key',
  'ssh_key',
  'id_rsa',
  'env',
  'environ',
];

export function findCredentialKey(value: unknown, path = '$'): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findCredentialKey(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const lowered = key.toLowerCase();
      if (FORBIDDEN_KEYS.some(bad => lowered === bad || lowered.endsWith(`_${bad}`))) {
        return `${path}.${key}`;
      }
      const hit = findCredentialKey(child, `${path}.${key}`);
      if (hit) return hit;
    }
  }
  return null;
}

// --------------------------------------------------------------------------- //
// Migrations                                                                   //
// --------------------------------------------------------------------------- //

export type Migration = {
  /** Version this migration produces. */
  to: number;
  run: (payload: Record<string, unknown>) => Record<string, unknown>;
};

/**
 * Ordered migrations, applied in sequence to reach the current version.
 *
 * Version 0 is not a version this app ever wrote — it is the shape of a payload
 * with no version marker at all, which is what a hand-edited file or a bare
 * tldraw snapshot looks like. Treating that as v0 gives those files a defined
 * path forward instead of a rejection they cannot act on.
 */
export const MIGRATIONS: Migration[] = [
  {
    to: 1,
    run: payload => {
      // A bare tldraw snapshot (no wrapper) becomes a project with an empty
      // reference set. Nothing is invented: the refs are genuinely unknown.
      const looksLikeBareStore =
        payload.store !== undefined || payload.document !== undefined;
      const canvas = looksLikeBareStore
        ? { store: payload }
        : (payload.canvas as { store: unknown } | undefined) ?? { store: null };
      return {
        schema: PROJECT_SCHEMA,
        schema_version: 1,
        saved_at: String(payload.saved_at ?? new Date().toISOString()),
        storage: 'browser-local',
        project: payload.project ?? { id: '', name: '', market: 'US', locale: 'en-US' },
        sku: payload.sku ?? { productName: '', points: '', platforms: [], assetMode: 'compliant' },
        canvas,
        server_refs: payload.server_refs ?? emptyRefs(),
        agent_plans: payload.agent_plans ?? [],
        omitted_media: payload.omitted_media ?? [],
      };
    },
  },
];

export function emptyRefs(): ServerRefs {
  return {
    workspace_id: '',
    product_id: '',
    revision_ids: [],
    passport_ids: [],
    asset_ids: [],
    evidence_source_ids: [],
    policy_snapshot_ids: [],
  };
}

function versionOf(payload: Record<string, unknown>): number {
  const raw = payload.schema_version;
  if (raw === undefined || raw === null) return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : -1;
}

/**
 * Validate, migrate and normalise a candidate snapshot.
 *
 * A payload from a *newer* build is refused rather than guessed at: opening it
 * with today's reader would silently drop whatever the new version added, and
 * the person would not find out until something was missing.
 */
export function validateSnapshot(raw: unknown, bytes?: number): ValidationOutcome {
  const problems: SnapshotProblem[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      problems: [{ code: 'not_an_object', message: '项目文件格式不正确，顶层不是一个对象。' }],
    };
  }
  const payload = raw as Record<string, unknown>;

  if (bytes !== undefined && bytes > MAX_SNAPSHOT_BYTES) {
    return {
      ok: false,
      problems: [
        {
          code: 'too_large',
          message: `项目文件超过 ${Math.round(MAX_SNAPSHOT_BYTES / (1024 * 1024))} MB 上限。`,
        },
      ],
    };
  }

  const credential = findCredentialKey(payload);
  if (credential) {
    return {
      ok: false,
      problems: [
        {
          code: 'credential_field',
          message: '项目文件包含疑似凭证字段，已整体拒绝导入。',
          detail: credential,
        },
      ],
    };
  }

  const version = versionOf(payload);
  if (version < 0) {
    return {
      ok: false,
      problems: [{ code: 'bad_version', message: '项目文件的版本号无法识别。' }],
    };
  }
  if (version > PROJECT_SCHEMA_VERSION) {
    return {
      ok: false,
      problems: [
        {
          code: 'future_version',
          message:
            `这个项目文件来自更新的版本（v${version}，当前支持 v${PROJECT_SCHEMA_VERSION}）。` +
            '请升级后再打开——强行读取会静默丢掉新版本新增的内容。',
        },
      ],
    };
  }
  if (version > 0 && payload.schema !== PROJECT_SCHEMA) {
    return {
      ok: false,
      problems: [{ code: 'wrong_schema', message: '这不是一个上新编译器项目文件。' }],
    };
  }

  let working = payload;
  let migratedFrom: number | null = null;
  for (const migration of MIGRATIONS) {
    if (versionOf(working) < migration.to) {
      migratedFrom = migratedFrom ?? version;
      working = migration.run(working);
    }
  }

  const snapshot = working as unknown as ProjectSnapshot;
  if (!snapshot.canvas || snapshot.canvas.store === null || snapshot.canvas.store === undefined) {
    problems.push({ code: 'missing_canvas', message: '项目文件里没有画布内容。' });
  }

  const refs = snapshot.server_refs ?? emptyRefs();
  for (const [name, list] of Object.entries({
    revision_ids: refs.revision_ids,
    passport_ids: refs.passport_ids,
    asset_ids: refs.asset_ids,
    evidence_source_ids: refs.evidence_source_ids,
  })) {
    const ids = list ?? [];
    if (!Array.isArray(ids)) {
      problems.push({ code: 'bad_reference', message: `引用列表 ${name} 格式不正确。` });
      continue;
    }
    if (new Set(ids).size !== ids.length) {
      problems.push({ code: 'duplicate_ids', message: `引用列表 ${name} 中存在重复 ID。` });
    }
    if (ids.some(id => typeof id !== 'string' || !id.trim())) {
      problems.push({ code: 'bad_reference', message: `引用列表 ${name} 中存在空 ID。` });
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, snapshot, migratedFrom };
}

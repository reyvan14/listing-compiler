import {
  MAX_SNAPSHOT_BYTES,
  validateSnapshot,
  type ProjectSnapshot,
  type SnapshotProblem,
} from './projectSchema';

// Browser-local project storage with a surviving backup.
//
// localStorage has no transactions, so "atomic replacement" here means: write
// the new value under a staging key, promote the previous good value to the
// backup key, then swap the staging key into place. If any step fails, the
// previously good snapshot is still readable — a corrupt write must never be
// able to destroy the last thing that worked.

const CURRENT_KEY = 'listing.project.v1.current';
const BACKUP_KEY = 'listing.project.v1.backup';
const STAGING_KEY = 'listing.project.v1.staging';

export type SaveState = 'idle' | 'saving' | 'saved' | 'failed' | 'recovered';

export type LoadResult =
  | { status: 'empty' }
  | { status: 'loaded'; snapshot: ProjectSnapshot; from: 'current'; migratedFrom: number | null }
  | {
      status: 'recovered';
      snapshot: ProjectSnapshot;
      from: 'backup';
      migratedFrom: number | null;
      problems: SnapshotProblem[];
    }
  | { status: 'unreadable'; problems: SnapshotProblem[] };

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  localStorage.setItem(key, value);
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing useful to do */
  }
}

export type SaveOutcome =
  | { ok: true; bytes: number }
  | { ok: false; reason: 'too_large' | 'quota' | 'unavailable'; message: string };

/** Replace the stored project, keeping the previous good snapshot as a backup. */
export function saveProject(snapshot: ProjectSnapshot): SaveOutcome {
  let serialised: string;
  try {
    serialised = JSON.stringify(snapshot);
  } catch {
    return { ok: false, reason: 'unavailable', message: '项目内容无法序列化，未保存。' };
  }

  if (serialised.length > MAX_SNAPSHOT_BYTES) {
    return {
      ok: false,
      reason: 'too_large',
      message: `项目快照超过 ${Math.round(MAX_SNAPSHOT_BYTES / (1024 * 1024))} MB，未保存到浏览器本地。可改用「导出项目」保存为文件。`,
    };
  }

  try {
    // Stage first: a quota error here leaves current and backup untouched.
    write(STAGING_KEY, serialised);
    const previous = read(CURRENT_KEY);
    if (previous) write(BACKUP_KEY, previous);
    write(CURRENT_KEY, serialised);
    remove(STAGING_KEY);
    return { ok: true, bytes: serialised.length };
  } catch (err) {
    remove(STAGING_KEY);
    const quota =
      err instanceof DOMException &&
      (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED');
    return {
      ok: false,
      reason: quota ? 'quota' : 'unavailable',
      message: quota
        ? '浏览器本地存储空间不足，项目未保存。可改用「导出项目」保存为文件。'
        : '无法写入浏览器本地存储，项目未保存。',
    };
  }
}

function parse(raw: string | null): { value: unknown; bytes: number } | null {
  if (!raw) return null;
  try {
    return { value: JSON.parse(raw), bytes: raw.length };
  } catch {
    return null;
  }
}

/**
 * Load the stored project, falling back to the backup if the current slot is
 * unreadable.
 *
 * A failed load reports *why*, and a recovery says that it recovered. Silently
 * starting from an empty canvas would look identical to having lost the work.
 */
export function loadProject(): LoadResult {
  const currentText = read(CURRENT_KEY);
  const backupText = read(BACKUP_KEY);
  const currentRaw = parse(currentText);
  const backupRaw = parse(backupText);

  if (currentRaw) {
    const outcome = validateSnapshot(currentRaw.value, currentRaw.bytes);
    if (outcome.ok) {
      return {
        status: 'loaded',
        snapshot: outcome.snapshot,
        from: 'current',
        migratedFrom: outcome.migratedFrom,
      };
    }
    // Current is present but unusable. A newer-version file is a "come back
    // with a newer build" situation, not a reason to silently open an older
    // backup over it.
    if (outcome.problems.some(p => p.code === 'future_version')) {
      return { status: 'unreadable', problems: outcome.problems };
    }
    if (backupRaw) {
      const fallback = validateSnapshot(backupRaw.value, backupRaw.bytes);
      if (fallback.ok) {
        return {
          status: 'recovered',
          snapshot: fallback.snapshot,
          from: 'backup',
          migratedFrom: fallback.migratedFrom,
          problems: outcome.problems,
        };
      }
    }
    return { status: 'unreadable', problems: outcome.problems };
  }

  if (backupRaw) {
    const fallback = validateSnapshot(backupRaw.value, backupRaw.bytes);
    if (fallback.ok) {
      return {
        status: 'recovered',
        snapshot: fallback.snapshot,
        from: 'backup',
        migratedFrom: fallback.migratedFrom,
        problems: [],
      };
    }
  }

  // Something is stored but neither slot could be parsed. Reporting "empty"
  // here would be a lie with consequences: the caller would start a blank
  // project and auto-save straight over data a person might still rescue.
  if (currentText !== null || backupText !== null) {
    return {
      status: 'unreadable',
      problems: [
        {
          code: 'not_an_object',
          message: '浏览器本地存档已损坏，无法解析。原始数据仍保留在本地，未被覆盖。',
        },
      ],
    };
  }

  return { status: 'empty' };
}

/** The last known good snapshot, if one is stored separately from current. */
export function loadBackup(): ProjectSnapshot | null {
  const raw = parse(read(BACKUP_KEY));
  if (!raw) return null;
  const outcome = validateSnapshot(raw.value, raw.bytes);
  return outcome.ok ? outcome.snapshot : null;
}

export function hasStoredProject(): boolean {
  return read(CURRENT_KEY) !== null || read(BACKUP_KEY) !== null;
}

/** Forget the browser-local project. The backup goes too — this is "clear". */
export function clearProject(): void {
  remove(CURRENT_KEY);
  remove(BACKUP_KEY);
  remove(STAGING_KEY);
}

/** Test seam: the keys this module owns. */
export const STORAGE_KEYS = {
  current: CURRENT_KEY,
  backup: BACKUP_KEY,
  staging: STAGING_KEY,
};

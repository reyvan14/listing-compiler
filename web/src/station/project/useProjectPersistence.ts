import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from 'tldraw';
import {
  clearProject,
  hasStoredProject,
  loadBackup,
  loadProject,
  saveProject,
  type SaveState,
} from './projectStore';
import type { ProjectSnapshot, SnapshotProblem } from './projectSchema';
import { restoreProject, serializeProject } from './serialize';

// Auto-save, restore, and the honest reporting of both.
//
// The save indicator is not decoration. "Saved" must mean the bytes are in
// storage; "failed" must appear the moment they are not, because a project that
// silently stopped saving looks exactly like one that is saving fine.

const DEBOUNCE_MS = 900;

export type ProjectStatus = {
  state: SaveState;
  message: string;
  savedAt: string;
  bytes: number;
  omittedMedia: number;
  problems: SnapshotProblem[];
};

const IDLE: ProjectStatus = {
  state: 'idle',
  message: '',
  savedAt: '',
  bytes: 0,
  omittedMedia: 0,
  problems: [],
};

export function useProjectPersistence(editor: Editor | null) {
  const [status, setStatus] = useState<ProjectStatus>(IDLE);
  const [enabled, setEnabled] = useState(true);
  const timer = useRef<number | null>(null);
  const restored = useRef(false);

  /** Load a stored project into a freshly mounted editor. Returns true if one was. */
  const restoreInto = useCallback((next: Editor): boolean => {
    if (restored.current) return false;
    restored.current = true;
    const result = loadProject();

    if (result.status === 'empty') return false;

    if (result.status === 'unreadable') {
      setStatus({
        ...IDLE,
        state: 'failed',
        message: '浏览器本地保存的项目无法读取，已从空白画布开始。原有数据未被删除。',
        problems: result.problems,
      });
      // Do not auto-save over data we could not read: that would destroy it.
      setEnabled(false);
      return false;
    }

    try {
      restoreProject(next, result.snapshot);
    } catch {
      setStatus({
        ...IDLE,
        state: 'failed',
        message: '恢复画布时出错，已从空白画布开始。原有数据未被删除。',
      });
      setEnabled(false);
      return false;
    }

    setStatus({
      ...IDLE,
      state: result.status === 'recovered' ? 'recovered' : 'saved',
      savedAt: result.snapshot.saved_at,
      omittedMedia: result.snapshot.omitted_media?.length ?? 0,
      message:
        result.status === 'recovered'
          ? '当前存档损坏，已从上一份可用备份恢复。'
          : result.migratedFrom !== null
            ? `已恢复项目（从 v${result.migratedFrom} 迁移）。`
            : '已恢复上次的项目。',
      problems: result.status === 'recovered' ? result.problems : [],
    });
    return true;
  }, []);

  const saveNow = useCallback((): boolean => {
    if (!editor) return false;
    setStatus(s => ({ ...s, state: 'saving' }));
    const snapshot = serializeProject(editor, { inlineMedia: false });
    const outcome = saveProject(snapshot);
    if (outcome.ok) {
      setStatus({
        state: 'saved',
        message: '',
        savedAt: snapshot.saved_at,
        bytes: outcome.bytes,
        omittedMedia: snapshot.omitted_media.length,
        problems: [],
      });
      return true;
    }
    setStatus(s => ({ ...s, state: 'failed', message: outcome.message }));
    return false;
  }, [editor]);

  // Seed the first save.
  //
  // restoreInto runs inside onMount, before React has the editor and before the
  // store listener below exists — so when there was nothing to restore, the
  // seeded canvas would sit unsaved until the user happened to touch something.
  // A refresh at that point would seed a *different* SKU node id and look like
  // the project had been lost.
  useEffect(() => {
    if (!editor || !enabled) return;
    setStatus(current => {
      if (current.state !== 'idle') return current;
      window.setTimeout(() => saveNow(), 0);
      return current;
    });
  }, [editor, enabled, saveNow]);

  // Auto-save on any store change, debounced.
  useEffect(() => {
    if (!editor || !enabled) return;
    const stop = editor.store.listen(
      () => {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
          timer.current = null;
          saveNow();
        }, DEBOUNCE_MS);
      },
      { scope: 'document' },
    );
    return () => {
      stop();
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [editor, enabled, saveNow]);

  const restoreBackup = useCallback((): boolean => {
    if (!editor) return false;
    const backup = loadBackup();
    if (!backup) {
      setStatus(s => ({ ...s, state: 'failed', message: '没有可用的备份存档。' }));
      return false;
    }
    restoreProject(editor, backup);
    setEnabled(true);
    setStatus({
      ...IDLE,
      state: 'recovered',
      savedAt: backup.saved_at,
      message: '已恢复到上一份可用备份。',
      omittedMedia: backup.omitted_media?.length ?? 0,
    });
    return true;
  }, [editor]);

  const applySnapshot = useCallback(
    (snapshot: ProjectSnapshot) => {
      if (!editor) return;
      restoreProject(editor, snapshot);
      setEnabled(true);
      setStatus({
        ...IDLE,
        state: 'saved',
        savedAt: snapshot.saved_at,
        omittedMedia: snapshot.omitted_media?.length ?? 0,
        message: '已导入项目，替换了当前画布。',
      });
      // Persist immediately so a refresh right after an import keeps it.
      window.setTimeout(() => saveNow(), 0);
    },
    [editor, saveNow],
  );

  const forget = useCallback(() => {
    clearProject();
    setEnabled(true);
    setStatus({ ...IDLE, message: '已清除浏览器本地保存的项目。' });
  }, []);

  return {
    status,
    autoSaveEnabled: enabled,
    hasStored: hasStoredProject(),
    restoreInto,
    saveNow,
    restoreBackup,
    applySnapshot,
    forget,
  };
}

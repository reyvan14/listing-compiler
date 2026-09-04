import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from 'tldraw';
import { resetStationCanvas } from '@/pipeline/nodes/types/skuStation';
import {
  MAX_SNAPSHOT_BYTES,
  validateSnapshot,
  type ProjectSnapshot,
  type SnapshotProblem,
} from './projectSchema';
import { describeSnapshot, serializeProject, type SnapshotStats } from './serialize';
import type { ProjectStatus } from './useProjectPersistence';
import styles from './projectMenu.module.scss';

// Project save state + the actions that manage it.
//
// Everything here is explicitly browser-local and labelled as such. Two actions
// destroy work — importing over the current project, and clearing local storage
// — and neither happens without a preview and a confirmation.

/**
 * Hand a blob to the browser as a download.
 *
 * The object URL is revoked on a later tick, not immediately after the click:
 * revoking synchronously can abort the download before the browser has started
 * reading it, which fails silently and looks like the button doing nothing.
 */
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const STATE_LABEL: Record<ProjectStatus['state'], string> = {
  idle: '未保存',
  saving: '保存中…',
  saved: '已保存',
  failed: '保存失败',
  recovered: '已从备份恢复',
};

const STATE_TONE: Record<ProjectStatus['state'], string> = {
  idle: 'neutral',
  saving: 'neutral',
  saved: 'ok',
  failed: 'danger',
  recovered: 'warn',
};

type Pending = {
  snapshot: ProjectSnapshot;
  stats: SnapshotStats;
  filename: string;
  migratedFrom: number | null;
};

export function ProjectMenu({
  editor,
  status,
  onSaveNow,
  onRestoreBackup,
  onApply,
  onForget,
}: {
  editor: Editor;
  status: ProjectStatus;
  onSaveNow: () => boolean;
  onRestoreBackup: () => boolean;
  onApply: (snapshot: ProjectSnapshot) => void;
  onForget: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [problems, setProblems] = useState<SnapshotProblem[]>([]);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState({ top: 0, right: 0 });

  // The panel is portalled to <body> rather than positioned inside the header.
  // Absolutely positioned inside it, the canvas's own stacking layers painted
  // over the panel: it looked fine but its buttons could not be clicked.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = chipRef.current?.getBoundingClientRect();
      if (rect) setAnchor({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  const exportProject = () => {
    // Export keeps everything: a file has no quota, so omitting media here
    // would lose work for no reason.
    try {
      const snapshot = serializeProject(editor, { inlineMedia: true });
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
      downloadBlob(blob, `${snapshot.project.name || 'listing-project'}.json`);
    } catch {
      setProblems([
        { code: 'not_an_object', message: '导出失败：项目内容无法序列化。' },
      ]);
    }
  };

  const pickFile = async (file: File) => {
    setProblems([]);
    setPending(null);
    if (file.size > MAX_SNAPSHOT_BYTES) {
      setProblems([
        {
          code: 'too_large',
          message: `项目文件超过 ${Math.round(MAX_SNAPSHOT_BYTES / (1024 * 1024))} MB 上限。`,
        },
      ]);
      return;
    }
    let parsed: unknown;
    const text = await file.text();
    try {
      parsed = JSON.parse(text);
    } catch {
      setProblems([{ code: 'not_an_object', message: '项目文件不是有效的 JSON。' }]);
      return;
    }
    const outcome = validateSnapshot(parsed, text.length);
    if (!outcome.ok) {
      setProblems(outcome.problems);
      return;
    }
    setPending({
      snapshot: outcome.snapshot,
      stats: describeSnapshot(outcome.snapshot),
      filename: file.name,
      migratedFrom: outcome.migratedFrom,
    });
  };

  return (
    <div className={styles.wrap} data-testid="project-menu">
      <button
        ref={chipRef}
        type="button"
        className={styles.chip}
        data-tone={STATE_TONE[status.state]}
        data-state={status.state}
        data-testid="project-save-state"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <span className={styles.dot} aria-hidden="true" />
        {STATE_LABEL[status.state]}
        <small>本地</small>
      </button>

      {open &&
        createPortal(
          <>
            <div className={styles.mask} onClick={() => setOpen(false)} aria-hidden="true" />
            <div
              className={styles.panel}
              role="dialog"
              aria-label="项目存档"
              data-testid="project-panel"
              style={{ top: anchor.top, right: anchor.right }}
            >
          <p className={styles.note}>
            项目保存在<strong>这台浏览器的本地存储</strong>里，不上传到服务器，也不含任何密钥。
            换设备或清空浏览器数据会丢失，请用「导出项目」保存为文件。
          </p>

          {status.savedAt && (
            <p className={styles.meta} data-testid="project-saved-at">
              上次保存：{new Date(status.savedAt).toLocaleString()}
              {status.bytes > 0 && ` · ${(status.bytes / 1024).toFixed(0)} KB`}
            </p>
          )}

          {status.message && (
            <p
              className={status.state === 'failed' ? styles.bad : styles.info}
              role={status.state === 'failed' ? 'alert' : 'status'}
              data-testid="project-message"
            >
              {status.message}
            </p>
          )}

          {status.omittedMedia > 0 && (
            <p className={styles.warn} data-testid="project-omitted">
              有 {status.omittedMedia} 张生成图片体积过大，未存入浏览器本地；
              「导出项目」会完整保留它们。
            </p>
          )}

          {status.problems.length > 0 && (
            <ul className={styles.problems} data-testid="project-problems">
              {status.problems.map(p => (
                <li key={p.code + p.message}>{p.message}</li>
              ))}
            </ul>
          )}

          <div className={styles.actions}>
            <button type="button" data-testid="project-save-now" onClick={() => onSaveNow()}>
              立即保存
            </button>
            <button type="button" data-testid="project-export" onClick={exportProject}>
              导出项目
            </button>
            <button
              type="button"
              data-testid="project-import"
              onClick={() => fileRef.current?.click()}
            >
              导入项目
            </button>
            <button
              type="button"
              data-testid="project-restore-backup"
              onClick={() => onRestoreBackup()}
            >
              恢复上一份备份
            </button>
            <button type="button" data-testid="project-new" onClick={() => setConfirmNew(true)}>
              新建项目
            </button>
            <button
              type="button"
              className={styles.danger}
              data-testid="project-clear"
              onClick={() => setConfirmClear(true)}
            >
              清除本地存档
            </button>
          </div>

          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className={styles.file}
            data-testid="project-file"
            onChange={e => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void pickFile(file);
            }}
          />

          {problems.length > 0 && (
            <ul className={styles.problems} role="alert" data-testid="project-import-problems">
              {problems.map(p => (
                <li key={p.code + p.message}>
                  {p.message}
                  {p.detail && <code>{p.detail}</code>}
                </li>
              ))}
            </ul>
          )}

          {pending && (
            <div
              className={styles.confirm}
              role="alertdialog"
              aria-label="确认导入项目"
              data-testid="project-import-preview"
            >
              <b>导入 {pending.filename}？</b>
              <ul className={styles.stats}>
                <li>
                  节点 {pending.stats.nodes} 个 · 连线 {pending.stats.connections} 条
                </li>
                <li>
                  {Object.entries(pending.stats.nodeTypes)
                    .map(([k, v]) => `${k} × ${v}`)
                    .join('、') || '无节点'}
                </li>
                {pending.migratedFrom !== null && (
                  <li>该文件为 v{pending.migratedFrom}，导入时会迁移到当前版本。</li>
                )}
                {pending.stats.omittedMedia > 0 && (
                  <li>其中 {pending.stats.omittedMedia} 张图片在导出时已被省略。</li>
                )}
              </ul>
              <p>
                这会<strong>整个替换</strong>当前画布。本工具<strong>不支持合并两个项目</strong>——
                如果要保留现在的内容，请先「导出项目」。
              </p>
              <div className={styles.confirmBtns}>
                <button
                  type="button"
                  className={styles.primary}
                  data-testid="project-import-confirm"
                  onClick={() => {
                    onApply(pending.snapshot);
                    setPending(null);
                    setOpen(false);
                  }}
                >
                  替换并导入
                </button>
                <button
                  type="button"
                  data-testid="project-import-cancel"
                  onClick={() => setPending(null)}
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {confirmNew && (
            <div className={styles.confirm} role="alertdialog" data-testid="project-new-confirm">
              <b>新建项目？</b>
              <p>当前画布会被清空。建议先「导出项目」。</p>
              <div className={styles.confirmBtns}>
                <button
                  type="button"
                  className={styles.primary}
                  data-testid="project-new-confirm-yes"
                  onClick={() => {
                    resetStationCanvas(editor);
                    setConfirmNew(false);
                    setOpen(false);
                  }}
                >
                  清空并新建
                </button>
                <button type="button" onClick={() => setConfirmNew(false)}>
                  取消
                </button>
              </div>
            </div>
          )}

          {confirmClear && (
            <div className={styles.confirm} role="alertdialog" data-testid="project-clear-confirm">
              <b>清除本地存档？</b>
              <p>
                这会删除浏览器本地保存的项目<strong>与备份</strong>，无法撤销。
                画布上的内容不会被清空，但刷新后就找不回来了。
              </p>
              <div className={styles.confirmBtns}>
                <button
                  type="button"
                  className={styles.danger}
                  data-testid="project-clear-confirm-yes"
                  onClick={() => {
                    onForget();
                    setConfirmClear(false);
                  }}
                >
                  确认清除
                </button>
                <button type="button" onClick={() => setConfirmClear(false)}>
                  取消
                </button>
              </div>
            </div>
          )}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}

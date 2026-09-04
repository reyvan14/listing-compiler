import type { ListingResultNode } from '@/pipeline/nodes/types/skuStation';
import type { DiffRow, DiffStatus, RevisionContent, RevisionField } from './reviewApi';

// Pure helpers for the review tab. No network, no editor, no React — so the
// rules that decide "is this dirty", "what changed" and "may this be approved"
// are testable without mounting anything.

/** The listing copy a canvas result card carries, in revision shape. */
export function nodeToContent(node: ListingResultNode): RevisionContent {
  return {
    title: node.title,
    fields: node.fields.map(f => ({ label: f.label, value: f.value })),
  };
}

/** Normalise the way the backend does, so a round-trip is not seen as an edit. */
export function normaliseContent(content: RevisionContent): RevisionContent {
  return {
    title: (content.title ?? '').replace(/\r\n/g, '\n').trim(),
    fields: (content.fields ?? [])
      .map(f => ({
        label: (f.label ?? '').replace(/\r\n/g, '\n').trim(),
        value: (f.value ?? '').replace(/\r\n/g, '\n').trim(),
      }))
      .filter(f => f.label !== ''),
  };
}

export function sameContent(a: RevisionContent, b: RevisionContent): boolean {
  const x = normaliseContent(a);
  const y = normaliseContent(b);
  if (x.title !== y.title || x.fields.length !== y.fields.length) return false;
  return x.fields.every((f, i) => f.label === y.fields[i].label && f.value === y.fields[i].value);
}

/**
 * Field-level diff for content that is not yet stored.
 *
 * Saved revisions are diffed by the backend, which owns the comparison. This
 * exists only for the unsaved editor buffer, which has no revision id to send,
 * and mirrors the backend's rules so both views classify a change identically.
 */
export function diffContent(base: RevisionContent, target: RevisionContent): DiffRow[] {
  const a = normaliseContent(base);
  const b = normaliseContent(target);
  const rows: DiffRow[] = [];

  const push = (label: string, before: string, after: string, inA: boolean, inB: boolean) => {
    const status: DiffStatus = !inA
      ? 'added'
      : !inB
        ? 'removed'
        : before === after
          ? 'unchanged'
          : 'modified';
    rows.push({ label, before, after, status });
  };

  push('标题', a.title, b.title, true, true);

  const baseFields = new Map(a.fields.map(f => [f.label, f.value]));
  const targetFields = new Map(b.fields.map(f => [f.label, f.value]));
  const order = [...baseFields.keys(), ...[...targetFields.keys()].filter(k => !baseFields.has(k))];
  for (const label of order) {
    push(
      label,
      baseFields.get(label) ?? '',
      targetFields.get(label) ?? '',
      baseFields.has(label),
      targetFields.has(label),
    );
  }
  return rows;
}

export const DIFF_STATUS_LABEL: Record<DiffStatus, string> = {
  unchanged: '未变',
  added: '新增',
  removed: '删除',
  modified: '修改',
};

export function changedRows(rows: DiffRow[]): DiffRow[] {
  return rows.filter(r => r.status !== 'unchanged');
}

/** Field groups the editor renders, reusing the label conventions already in
 * use by the inspector's content tab rather than inventing a second scheme. */
export const BULLET_PREFIX = '五点';
export const SEARCH_LABELS = ['搜索词'];
export const LONG_LABELS = ['长描述', '描述', '详情规划'];

export type FieldGroup = 'bullets' | 'description' | 'keywords' | 'other';

export function groupOf(label: string): FieldGroup {
  if (label.startsWith(BULLET_PREFIX)) return 'bullets';
  if (SEARCH_LABELS.includes(label)) return 'keywords';
  if (LONG_LABELS.includes(label)) return 'description';
  return 'other';
}

export const GROUP_LABEL: Record<FieldGroup, string> = {
  bullets: '卖点',
  description: '描述',
  keywords: '关键词',
  other: '其他字段',
};

export const GROUP_ORDER: FieldGroup[] = ['bullets', 'description', 'keywords', 'other'];

export function groupFields(fields: RevisionField[]): { group: FieldGroup; fields: RevisionField[] }[] {
  return GROUP_ORDER.map(group => ({
    group,
    fields: fields.filter(f => groupOf(f.label) === group),
  })).filter(g => g.fields.length > 0);
}

/** Replace one field's value, keeping order. Unknown labels are ignored. */
export function withFieldValue(
  content: RevisionContent,
  label: string,
  value: string,
): RevisionContent {
  return {
    title: content.title,
    fields: content.fields.map(f => (f.label === label ? { ...f, value } : f)),
  };
}

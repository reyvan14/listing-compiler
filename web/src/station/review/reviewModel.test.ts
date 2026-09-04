import { describe, expect, it } from 'vitest';
import {
  DIFF_STATUS_LABEL,
  GROUP_ORDER,
  changedRows,
  diffContent,
  groupFields,
  groupOf,
  normaliseContent,
  sameContent,
  withFieldValue,
} from './reviewModel';
import { REVISION_STATE_META, type RevisionContent } from './reviewApi';

const base: RevisionContent = {
  title: 'Collapsible Silicone Travel Cup 350ml',
  fields: [
    { label: '五点 1', value: 'folds to 4cm' },
    { label: '五点 2', value: 'food grade silicone' },
    { label: '搜索词', value: 'travel cup' },
  ],
};

describe('content normalisation', () => {
  it('treats a whitespace-only round trip as no edit at all', () => {
    // Otherwise a textarea that appends a newline would look like a real change
    // and invite a pointless revision.
    expect(sameContent(base, { ...base, title: `  ${base.title}\n` })).toBe(true);
    expect(sameContent(base, { ...base, title: `${base.title} 500ml` })).toBe(false);
  });

  it('drops fields that lost their label, matching the backend', () => {
    const cleaned = normaliseContent({
      title: 't',
      fields: [{ label: '  ', value: 'orphan' }, { label: '五点 1', value: 'kept' }],
    });
    expect(cleaned.fields).toEqual([{ label: '五点 1', value: 'kept' }]);
  });

  it('normalises CRLF so a Windows paste is not a diff', () => {
    expect(sameContent(base, { ...base, title: base.title.replace(/ /g, ' ') })).toBe(true);
    const crlf = { title: 'a\r\nb', fields: [] };
    expect(normaliseContent(crlf).title).toBe('a\nb');
  });
});

describe('diffContent', () => {
  it('classifies unchanged, modified, added and removed fields', () => {
    const target: RevisionContent = {
      title: 'Collapsible Silicone Travel Cup 500ml',
      fields: [
        { label: '五点 1', value: 'folds to 4cm' },
        { label: '五点 2', value: 'BPA free silicone' },
        { label: '描述', value: 'new long copy' },
      ],
    };
    const rows = Object.fromEntries(diffContent(base, target).map(r => [r.label, r.status]));

    expect(rows['标题']).toBe('modified');
    expect(rows['五点 1']).toBe('unchanged');
    expect(rows['五点 2']).toBe('modified');
    expect(rows['搜索词']).toBe('removed');
    expect(rows['描述']).toBe('added');
  });

  it('reports no changes for identical content', () => {
    expect(changedRows(diffContent(base, base))).toEqual([]);
  });

  it('always includes the title even when the field lists are empty', () => {
    const rows = diffContent({ title: 'a', fields: [] }, { title: 'b', fields: [] });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('modified');
  });

  it('names every diff status it can produce', () => {
    for (const status of ['unchanged', 'added', 'removed', 'modified'] as const) {
      expect(DIFF_STATUS_LABEL[status]).toBeTruthy();
    }
  });
});

describe('field grouping', () => {
  it('reuses the inspector label conventions rather than a second scheme', () => {
    expect(groupOf('五点 3')).toBe('bullets');
    expect(groupOf('搜索词')).toBe('keywords');
    expect(groupOf('长描述')).toBe('description');
    expect(groupOf('商品视频位')).toBe('other');
  });

  it('keeps groups in a stable order and omits empty ones', () => {
    const groups = groupFields(base.fields);
    expect(groups.map(g => g.group)).toEqual(['bullets', 'keywords']);
    expect(GROUP_ORDER.indexOf('bullets')).toBeLessThan(GROUP_ORDER.indexOf('other'));
  });
});

describe('withFieldValue', () => {
  it('edits one field in place and leaves order untouched', () => {
    const next = withFieldValue(base, '五点 2', 'changed');
    expect(next.fields.map(f => f.label)).toEqual(base.fields.map(f => f.label));
    expect(next.fields[1].value).toBe('changed');
  });

  it('ignores a label that is not present rather than inventing a field', () => {
    expect(withFieldValue(base, 'nope', 'x').fields).toEqual(base.fields);
  });
});

describe('revision state presentation', () => {
  it('shows only approved as a passing tone', () => {
    expect(REVISION_STATE_META.approved.tone).toBe('ok');
    expect(REVISION_STATE_META.needs_changes.tone).toBe('danger');
    // "validated" is not "approved": it must not read as a finished decision.
    expect(REVISION_STATE_META.validated.tone).not.toBe('ok');
  });

  it('gives every lifecycle state a distinct label', () => {
    const labels = Object.values(REVISION_STATE_META).map(m => m.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  STATUS_META,
  applyPortfolio,
  importPortfolio,
  reviewRows,
  safeRows,
  snapshotPortfolio,
  type MatrixRow,
} from './portfolioApi';

function row(over: Partial<MatrixRow> = {}): MatrixRow {
  return {
    sku: 'AERO-350',
    platform: 'amazon',
    field: 'title',
    artifact_id: 'AERO-350::amazon',
    status: 'safe_patch',
    cause: 'policy',
    reason: 'policy tightened',
    previous_value: 'old',
    candidate_value: 'new',
    note: '',
    ...over,
  };
}

function ok(data: unknown) {
  return { ok: true, status: 200, json: async () => ({ code: 0, data }) };
}

afterEach(() => vi.unstubAllGlobals());

describe('row partitioning', () => {
  it('only safe_patch rows are eligible for bulk approval', () => {
    const matrix = [
      row({ status: 'safe_patch' }),
      row({ status: 'review_required', field: 'bullet-4' }),
      row({ status: 'blocked', field: 'bullet-1' }),
      row({ status: 'unaffected', field: '-' }),
    ];
    expect(safeRows(matrix).map(r => r.field)).toEqual(['title']);
    expect(reviewRows(matrix).map(r => r.field)).toEqual(['bullet-4']);
    // blocked and unaffected rows are in neither bucket
    expect([...safeRows(matrix), ...reviewRows(matrix)]).toHaveLength(2);
  });
});

describe('status presentation', () => {
  it('gives every status a distinct label and an honest tone', () => {
    expect(STATUS_META.safe_patch.tone).toBe('ok');
    expect(STATUS_META.review_required.tone).toBe('warn');
    expect(STATUS_META.blocked.tone).toBe('danger');
    expect(STATUS_META.unaffected.tone).toBe('muted');
    const labels = Object.values(STATUS_META).map(m => m.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('snapshotPortfolio', () => {
  it('deep-copies so later mutation cannot corrupt the rollback point', () => {
    const artifacts = { 'AERO-350': [{ title: 'original' }] };
    const snap = snapshotPortfolio(artifacts);
    artifacts['AERO-350'][0].title = 'mutated';
    expect((snap.artifacts as any)['AERO-350'][0].title).toBe('original');
  });
});

describe('importPortfolio', () => {
  it('posts multipart and returns the row-level validation report', async () => {
    const spy = vi.fn().mockResolvedValue(
      ok({
        skus: [{ sku: 'OK-1' }],
        errors: [{ row: 3, sku: '', error: '缺少 sku 列。' }],
        summary: { total_rows: 2, imported: 1, rejected: 1 },
      }),
    );
    vi.stubGlobal('fetch', spy);

    const file = new File(['sku,product_name\n'], 'p.csv', { type: 'text/csv' });
    const res = await importPortfolio(file);

    expect(res.summary.imported).toBe(1);
    expect(res.errors[0].row).toBe(3);
    const [, init] = spy.mock.calls[0];
    expect(init.method).toBe('POST');
    expect((init.body as FormData).get('file')).toBeInstanceOf(File);
  });

  it('surfaces the backend message for an unsupported file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 415,
        json: async () => ({ code: 1, message: '仅支持 CSV 或 XLSX 组合文件。' }),
      }),
    );
    const file = new File(['x'], 'a.txt', { type: 'text/plain' });
    await expect(importPortfolio(file)).rejects.toThrow('仅支持 CSV');
  });
});

describe('applyPortfolio', () => {
  it('sends only the rows it was given, so review rows cannot ride along', async () => {
    const spy = vi.fn().mockResolvedValue(
      ok({ results: {}, applied_skus: ['AERO-350'], needs_review_skus: [], rejected_patches: [] }),
    );
    vi.stubGlobal('fetch', spy);

    const matrix = [row({ status: 'safe_patch' }), row({ status: 'review_required' })];
    await applyPortfolio({ artifacts: {}, approved: safeRows(matrix) });

    const body = JSON.parse(spy.mock.calls[0][1].body);
    expect(body.approved).toHaveLength(1);
    expect(body.approved[0].status).toBe('safe_patch');
  });
});

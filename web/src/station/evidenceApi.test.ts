import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FACT_STATE_META,
  METHOD_META,
  fetchFacts,
  locationLabel,
  runGate,
  uploadEvidence,
  type FactLink,
} from './evidenceApi';

function ok(data: unknown) {
  return { ok: true, status: 200, json: async () => ({ code: 0, data }) };
}

afterEach(() => vi.unstubAllGlobals());

describe('locationLabel', () => {
  const base: FactLink = {
    source_id: 's1',
    page: null,
    sheet: '',
    cell: '',
    excerpt: '',
    method: 'deterministic',
  };

  it('names a PDF page, a spreadsheet cell, and a whole document', () => {
    expect(locationLabel({ ...base, page: 3 })).toBe('第 3 页');
    expect(locationLabel({ ...base, sheet: 'Sheet1', cell: 'row 4' })).toBe('Sheet1 · row 4');
    expect(locationLabel(base)).toBe('整篇文档');
  });
});

describe('extraction method labelling', () => {
  it('keeps deterministic, OCR, model-assisted and manual visually distinct', () => {
    // The gate's honesty depends on these never collapsing into one word.
    const labels = Object.values(METHOD_META);
    expect(new Set(labels).size).toBe(labels.length);
    expect(METHOD_META.deterministic).not.toBe(METHOD_META.model_assisted);
    expect(METHOD_META.manual_review).toContain('人工');
  });
});

describe('fact state presentation', () => {
  it('shows only verified as a passing tone', () => {
    expect(FACT_STATE_META.verified.tone).toBe('ok');
    for (const state of ['unsupported', 'conflicting', 'expired'] as const) {
      expect(FACT_STATE_META[state].tone).toBe('danger');
    }
    expect(FACT_STATE_META.needs_review.tone).toBe('warn');
  });
});

describe('fetchFacts', () => {
  it('unwraps the envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(ok({ facts: [{ fact_id: 'ev-capacity', state: 'verified' }] })),
    );
    const facts = await fetchFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0].fact_id).toBe('ev-capacity');
  });

  it('turns an unreachable backend into a safe ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(fetchFacts()).rejects.toMatchObject({ category: 'network' });
  });
});

describe('uploadEvidence', () => {
  it('posts multipart with the expiry date attached', async () => {
    const spy = vi.fn().mockResolvedValue(ok({ source: { source_id: 'abc' }, facts: [] }));
    vi.stubGlobal('fetch', spy);

    const file = new File(['capacity,350 ml'], 'spec.csv', { type: 'text/csv' });
    const out = await uploadEvidence(file, { expiresOn: '2027-01-01' });

    expect(out.source.source_id).toBe('abc');
    const [, init] = spy.mock.calls[0];
    expect(init.method).toBe('POST');
    const body = init.body as FormData;
    expect(body.get('expires_on')).toBe('2027-01-01');
    expect((body.get('file') as File).name).toBe('spec.csv');
    // multipart must not carry a hand-set Content-Type or the boundary is lost
    expect(init.headers).toBeUndefined();
  });

  it('surfaces the backend rejection message for an unsupported type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 415,
        json: async () => ({
          code: 1,
          error: 'unsupported_type',
          message: '仅支持 PDF、JPG/PNG、TXT/Markdown、CSV 与 XLSX。',
        }),
      }),
    );
    const file = new File(['x'], 'a.exe', { type: 'application/octet-stream' });
    await expect(uploadEvidence(file)).rejects.toThrow('仅支持 PDF');
  });
});

describe('runGate', () => {
  it('returns the per-platform verdict and its claims', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        ok({
          results: [
            {
              platform: 'amazon',
              verdict: 'blocked',
              blocked_fields: ['title'],
              review_fields: [],
              claim_count: 1,
              fields: [
                {
                  field: 'title',
                  verdict: 'blocked',
                  claims: [
                    {
                      fact_key: 'bpa_free',
                      fact_id: 'ev-bpa-free',
                      label: 'BPA-Free',
                      verdict: 'blocked',
                      state: 'unsupported',
                      detail: '缺少任何证据来源。',
                      suggestion: '上传证书或删除该宣称。',
                      supporting_sources: [],
                    },
                  ],
                },
              ],
            },
          ],
          checks: {},
          summary: { blocked: 1, needs_review: 0, ok: 0, claims: 1 },
        }),
      ),
    );

    const res = await runGate([{ id: 'amazon', title: 'Cup BPA-Free', fields: [] }]);
    expect(res.results[0].verdict).toBe('blocked');
    const claim = res.results[0].fields[0].claims[0];
    expect(claim.state).toBe('unsupported');
    expect(claim.supporting_sources).toEqual([]);
    expect(claim.suggestion).toBeTruthy();
  });
});

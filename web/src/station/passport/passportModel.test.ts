import { describe, expect, it } from 'vitest';
import {
  EXPORTABLE,
  HANDOFF_DISCLAIMER,
  canExport,
  coverage,
  formatBytes,
  hasSource,
  mediaProblem,
} from './passportModel';
import { READINESS_META, type Passport, type PassportMedia } from './passportApi';

function passport(overrides: Partial<Passport> = {}): Passport {
  return {
    schema: 'listing-release-passport/v1',
    passport_id: 'psp-0001',
    project_id: '',
    sku_id: 'AERO-350',
    platform: 'amazon',
    locale: { market: 'US', language: 'en-US', currency: 'USD', declared_by: 'operator', verified: false },
    revision_id: 'rev-0001',
    revision_lineage: ['rev-0001'],
    content_hash: 'abc',
    field_hashes: {},
    listing: { title: 't', fields: [] },
    generator: {},
    validation: { validation_id: 'val-0002', blockers: [], warnings: [] },
    evidence_gate: {},
    facts: [],
    evidence_documents: [],
    media: [],
    policy_snapshots: [],
    approvals: [],
    acknowledgements: [],
    audit: [],
    blockers: [],
    warnings: [],
    manual_review: [],
    readiness: 'ready_for_handoff',
    content_readiness: 'ready_for_handoff',
    readiness_reasons: [],
    built_at: '2026-09-04T00:00:00+00:00',
    content_digest: 'd'.repeat(64),
    export: null,
    ...overrides,
  };
}

function media(overrides: Partial<PassportMedia> = {}): PassportMedia {
  return {
    asset_id: 'a1',
    sha256: 'f'.repeat(64),
    origin: 'generated',
    label: '主图',
    format: 'PNG',
    mime_type: 'image/png',
    width: 1600,
    height: 1600,
    size_bytes: 1024,
    policy_snapshot_id: 'amazon-us-2025.01.21',
    summary: {
      counts: { pass: 5, fail: 0, warning: 0, manual_review: 2, unavailable: 0 },
      blocked: false,
      fully_verified: false,
      needs_manual_review: true,
      unavailable: false,
    },
    results: [],
    checksum_verified: true,
    present: true,
    ...overrides,
  };
}

describe('export gating', () => {
  it('refuses to offer an export for a blocked or superseded passport', () => {
    expect(canExport(passport({ readiness: 'blocked' }))).toBe(false);
    expect(canExport(passport({ readiness: 'superseded' }))).toBe(false);
  });

  it('allows export once the blockers are gone, including with open review items', () => {
    // needs_review is exportable on purpose: the operator may hand off with
    // unresolved manual items as long as they are visible and attributed.
    expect(canExport(passport({ readiness: 'needs_review' }))).toBe(true);
    expect(canExport(passport({ readiness: 'ready_for_handoff' }))).toBe(true);
    expect(canExport(passport({ readiness: 'exported' }))).toBe(true);
  });

  it('keeps the exportable set and canExport in agreement', () => {
    for (const state of ['blocked', 'needs_review', 'ready_for_handoff', 'exported', 'superseded'] as const) {
      expect(canExport(passport({ readiness: state }))).toBe(EXPORTABLE.includes(state));
    }
  });
});

describe('coverage', () => {
  it('reports an unchecked area as not covered rather than omitting it', () => {
    // An empty list and an unchecked area must not look the same on screen.
    const rows = coverage(passport());
    const images = rows.find(r => r.label === '图片像素检查')!;
    expect(images.covered).toBe(false);
    expect(images.note).toContain('未覆盖');
  });

  it('never marks subject coverage or overlaid text as covered', () => {
    const rows = coverage(
      passport({ media: [media()], facts: [{ fact_id: 'f', key: 'k', value: 'v', display: 'v', claim_type: 'numeric', state: 'verified', sources: [] }] }),
    );
    const manualOnly = rows.find(r => r.label === '主体占比 / 叠加文字')!;
    expect(manualOnly.covered).toBe(false);
    expect(manualOnly.note).toContain('人工');
  });

  it('says plainly when no claim has evidence behind it', () => {
    const rows = coverage(passport());
    const evidence = rows.find(r => r.label === '证据支撑')!;
    expect(evidence.covered).toBe(false);
    expect(evidence.note).toContain('未被证据支撑');
  });

  it('counts open manual-review items as an uncovered area', () => {
    const rows = coverage(passport({ manual_review: [{ rule_id: 'r', detail: 'd' }] }));
    const manual = rows.find(r => r.label === '人工核验项')!;
    expect(manual.covered).toBe(false);
    expect(manual.note).toContain('责任在操作者');
  });
});

describe('media problems', () => {
  it('names the specific problem rather than a generic failure', () => {
    expect(mediaProblem(media())).toBe('');
    expect(mediaProblem(media({ present: false }))).toBe('文件已丢失');
    expect(mediaProblem(media({ checksum_verified: false }))).toBe('校验和不一致');
    expect(
      mediaProblem(media({ summary: { ...media().summary, blocked: true } })),
    ).toBe('存在阻断项');
  });
});

describe('evidence links', () => {
  it('offers a link only when the underlying record exists', () => {
    const p = passport({
      evidence_documents: [
        {
          source_id: 's1',
          sha256: 'x',
          filename: 'f.pdf',
          label: 'f',
          mime_type: 'application/pdf',
          size_bytes: 1,
          uploaded_at: '',
          expires_on: '',
          cited: true,
        },
      ],
    });
    expect(hasSource(p, 's1')).toBe(true);
    expect(hasSource(p, 'deleted')).toBe(false);
  });
});

describe('disclaimer', () => {
  it('states all three things the operator must not assume', () => {
    const text = HANDOFF_DISCLAIMER.join(' ');
    expect(text).toContain('不会向任何平台发布');
    expect(text).toContain('不代表平台会通过审核');
    expect(text).toContain('由操作者负责确认');
  });

  it('never presents a readiness state as marketplace approval', () => {
    for (const meta of Object.values(READINESS_META)) {
      expect(meta.label).not.toContain('通过审核');
      expect(meta.label).not.toContain('已发布');
    }
    expect(READINESS_META.ready_for_handoff.label).toBe('可交接');
  });
});

describe('byte formatting', () => {
  it('scales sensibly', () => {
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.00 MB');
  });
});

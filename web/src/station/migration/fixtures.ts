// Shared test fixtures for the migration unit tests (not a *.test.ts file).

import type { Artifact, CandidatePatch } from './types';

export function demoArtifacts(): Artifact[] {
  return [
    {
      artifactId: 'amazon',
      nodeId: 'shape:amazon',
      platform: 'amazon',
      kind: 'listing',
      revision: 1,
      status: 'current',
      policyVersion: 'amazon-us-2025.01.21',
      title: 'Collapsible Silicone Travel Cup 350ml, Leak-Proof Lid',
      titleFactRefs: ['name', 'fact-3'],
      fields: [
        { name: 'bullet-1', label: '五点 1', value: 'Folds flat to 4cm.', factRefs: ['fact-1'] },
        { name: 'bullet-2', label: '五点 2', value: 'Rated -40°C to 200°C.', factRefs: ['fact-2'] },
        { name: 'bullet-4', label: '五点 4', value: '350ml / 12oz.', factRefs: ['name', 'fact-3'] },
        { name: 'search-terms', label: '搜索词', value: 'hiking cup 350ml', factRefs: ['fact-3'] },
      ],
    },
    {
      artifactId: 'tiktok',
      nodeId: 'shape:tiktok',
      platform: 'tiktok',
      kind: 'listing',
      revision: 1,
      status: 'current',
      policyVersion: 'tiktok-us-2025.03',
      title: '350ml foldable silicone travel cup',
      titleFactRefs: ['name', 'fact-3'],
      fields: [
        { name: 'description', label: '描述', value: 'Folds to 4cm, 350ml.', factRefs: ['fact-1', 'fact-3'] },
        { name: 'video-slot', label: '商品视频位', value: '1 条货架短视频位。', factRefs: [] },
      ],
    },
    {
      artifactId: 'shopify',
      nodeId: 'shape:shopify',
      platform: 'shopify',
      kind: 'listing',
      revision: 1,
      status: 'current',
      policyVersion: 'shopify-2025.03',
      title: 'Pocket Cup 350',
      titleFactRefs: ['name', 'fact-3'],
      fields: [
        { name: 'long-description', label: '长描述', value: 'Folds to 4cm. 350ml.', factRefs: ['fact-1', 'fact-3'] },
        { name: 'media', label: '媒体', value: '生活图可用。', factRefs: [] },
      ],
    },
  ];
}

export function legacyArtifact(): Artifact {
  return {
    artifactId: 'legacy-amazon',
    platform: 'amazon',
    kind: 'listing',
    revision: 1,
    status: 'current',
    policyVersion: '',
    title: 'Old Cup 350ml',
    // NO titleFactRefs, NO per-field factRefs -> no dependency metadata
    fields: [{ name: 'bullet-1', label: '五点 1', value: 'folds to 4cm', factRefs: undefined as unknown as string[] }],
  };
}

export function capacityPatch(overrides: Partial<CandidatePatch> = {}): CandidatePatch {
  return {
    artifactId: 'amazon',
    platform: 'amazon',
    field: 'title',
    previousValue: 'Collapsible Silicone Travel Cup 350ml, Leak-Proof Lid',
    candidateValue: 'Collapsible Silicone Travel Cup 300ml, Leak-Proof Lid',
    reason: '350→300',
    triggering: { kind: 'sku_fact', factIds: ['fact-3'] },
    factRefs: ['name', 'fact-3'],
    validation: { ok: true, checkable: true, semantic: { ok: true } },
    needsHumanReview: false,
    note: '',
    ...overrides,
  };
}

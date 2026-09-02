import { describe, expect, it } from 'vitest';
import {
  buildDependencyGraph,
  impactSummary,
  propagateStale,
} from './graph';
import { demoArtifacts, legacyArtifact } from './fixtures';

describe('buildDependencyGraph', () => {
  it('indexes every field by the SKU facts it references', () => {
    const graph = buildDependencyGraph(demoArtifacts());
    // fact-3 (capacity) is referenced by many fields across all three platforms
    const fact3 = graph.byFact.get('fact-3') ?? [];
    const owners = new Set(fact3.map(x => x.artifactId));
    expect(owners).toEqual(new Set(['amazon', 'tiktok', 'shopify']));
    expect(fact3).toContainEqual({ artifactId: 'amazon', field: 'title' });
    expect(fact3).toContainEqual({ artifactId: 'amazon', field: 'bullet-4' });

    // the synthetic 'title' field is in the per-artifact map
    const amazon = graph.byArtifact.get('amazon')!;
    expect(amazon.get('title')).toEqual(['name', 'fact-3']);
    expect(amazon.get('bullet-2')).toEqual(['fact-2']);
  });

  it('treats an artifact with no factRefs anywhere as having no metadata', () => {
    const graph = buildDependencyGraph([legacyArtifact()]);
    expect(graph.byFact.size).toBe(0);
  });
});

describe('propagateStale — SKU fact change', () => {
  it('marks only the fields that reference the changed fact', () => {
    const graph = buildDependencyGraph(demoArtifacts());
    const rows = propagateStale(graph, {
      factDelta: { added: [], removed: [], changed: ['fact-3'] },
    });
    const byId = Object.fromEntries(rows.map(r => [r.artifactId, r]));
    expect(byId.amazon.affected).toBe(true);
    expect(byId.amazon.cause).toBe('sku');
    expect(byId.amazon.fieldsToRegenerate).toEqual(
      ['bullet-4', 'search-terms', 'title'].sort(),
    );
    // the temperature bullet is untouched and reusable
    expect(byId.amazon.reusableFields).toContain('bullet-2');
    expect(byId.tiktok.fieldsToRegenerate).toEqual(['description', 'title']);
    expect(byId.shopify.reusableFields).toContain('media');
  });

  it('marks nothing when the changed fact is referenced nowhere', () => {
    const graph = buildDependencyGraph(demoArtifacts());
    const rows = propagateStale(graph, {
      factDelta: { added: [], removed: [], changed: ['fact-5'] },
    });
    expect(rows.every(r => !r.affected)).toBe(true);
  });

  it('falls back conservatively for a legacy artifact without metadata', () => {
    const graph = buildDependencyGraph([legacyArtifact()]);
    const rows = propagateStale(graph, {
      factDelta: { added: [], removed: [], changed: ['fact-3'] },
    });
    expect(rows[0].affected).toBe(true);
    expect(rows[0].hasDependencyMetadata).toBe(false);
    expect(rows[0].reasons[0].type).toBe('sku_fact_conservative');
  });

  it('does not mark image assets whose refs did not change', () => {
    const artifacts = [
      ...demoArtifacts(),
      {
        artifactId: 'amz-img',
        platform: 'amazon',
        kind: 'image' as const,
        revision: 1,
        status: 'current' as const,
        policyVersion: '',
        fields: [],
        assetRefs: ['name'],
      },
    ];
    const rows = propagateStale(buildDependencyGraph(artifacts), {
      factDelta: { added: [], removed: [], changed: ['fact-3'] },
    });
    expect(rows.find(r => r.artifactId === 'amz-img')!.affected).toBe(false);
  });
});

describe('propagateStale — policy change', () => {
  it('an Amazon-only policy change marks Amazon only', () => {
    const graph = buildDependencyGraph(demoArtifacts());
    const rows = propagateStale(graph, {
      policy: {
        platform: 'amazon',
        fields: ['amazon:title'],
        blockingFields: ['amazon:title'],
        baseVersion: 'amazon-us-2025.03',
        candidateVersion: 'amazon-us-2026.03-candidate',
        ruleIds: ['amazon.title.max_length'],
      },
    });
    const affected = rows.filter(r => r.affected).map(r => r.artifactId);
    expect(affected).toEqual(['amazon']);
    const amazon = rows.find(r => r.artifactId === 'amazon')!;
    expect(amazon.cause).toBe('policy');
    expect(amazon.fieldsToRegenerate).toEqual(['title']);
  });

  it('non-blocking policy change flags the field but does not force regeneration', () => {
    const rows = propagateStale(buildDependencyGraph(demoArtifacts()), {
      policy: { platform: 'amazon', fields: ['amazon:title'], blockingFields: [] },
    });
    const amazon = rows.find(r => r.artifactId === 'amazon')!;
    expect(amazon.affected).toBe(true);
    expect(amazon.fieldsToRegenerate).toEqual([]);
    expect(amazon.reasons[0].requiresRegen).toBe(false);
  });

  it('reports "both" when a fact change and a policy change hit the same artifact', () => {
    const rows = propagateStale(buildDependencyGraph(demoArtifacts()), {
      factDelta: { added: [], removed: [], changed: ['fact-3'] },
      policy: { platform: 'amazon', fields: ['amazon:title'], blockingFields: ['amazon:title'] },
    });
    expect(rows.find(r => r.artifactId === 'amazon')!.cause).toBe('both');
    expect(rows.find(r => r.artifactId === 'tiktok')!.cause).toBe('sku');
  });
});

describe('impactSummary', () => {
  it('counts affected / unaffected and splits by cause', () => {
    const rows = propagateStale(buildDependencyGraph(demoArtifacts()), {
      factDelta: { added: [], removed: [], changed: ['fact-3'] },
      policy: { platform: 'amazon', fields: ['amazon:title'], blockingFields: ['amazon:title'] },
    });
    const summary = impactSummary(rows);
    expect(summary.affectedCount).toBe(3);
    expect(summary.unaffectedCount).toBe(0);
    expect(summary.byCause).toEqual({ sku: 2, policy: 0, both: 1 });
  });
});

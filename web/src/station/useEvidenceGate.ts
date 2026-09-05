import { useCallback, useEffect, useState } from 'react';
import type { Editor } from 'tldraw';
import {
  findSkuShape,
  type ListingResultNode,
  type SkuListingNode,
} from '@/pipeline/nodes/types/skuStation';
import { runGate, toSafeMessage, type GateResult } from './evidenceApi';

// Runs the evidence release gate for one platform card.
//
// The gate is a backend round-trip because the fact ledger lives on the server;
// the canvas node carries only the generated copy. Fetching here (rather than
// in each tab) means the Compliance and Evidence tabs agree on one verdict.

export type GateState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  result: GateResult | null;
  error: string;
};

const IDLE: GateState = { status: 'idle', result: null, error: '' };

/** Serialise a result card into the draft shape the gate endpoint expects. */
export function nodeToDraft(node: ListingResultNode): Record<string, unknown> {
  const meta = node.fieldMeta ?? [];
  return {
    id: node.platform,
    title: node.title,
    fields: node.fields.map((f, i) => ({
      field: meta[i]?.name || f.label || `field-${i + 1}`,
      label: f.label,
      value: f.value,
    })),
  };
}

/**
 * The evidence-store partition every listing workflow must agree on.
 *
 * Revisions, fact ledgers and feedback promotions are all scoped by this id on
 * the server. Any panel that reads or writes them has to derive it the same
 * way, or it silently addresses a different, empty store.
 */
export function skuProductId(editor: Editor | null): string {
  const sku = editor ? findSkuShape(editor) : null;
  if (!sku || sku.props.node.type !== 'sku_listing') return 'default-product';
  return `${sku.id}|${(sku.props.node as SkuListingNode).productName.trim().toLowerCase()}`;
}

/** `editor` is passed in rather than pulled from context: the inspector is a
 * viewport-level overlay rendered OUTSIDE the <Tldraw> provider, so useEditor()
 * would throw and take the whole app down with it. */
export function useEvidenceGate(node: ListingResultNode | null, editor: Editor) {
  const [gate, setGate] = useState<GateState>(IDLE);
  const [nonce, setNonce] = useState(0);

  // The SKU selling points are gated alongside the generated copy: a claim the
  // operator typed into the truth source must be answerable even when this
  // platform's draft paraphrases it away.
  const sku = findSkuShape(editor);
  const productId = skuProductId(editor);
  const sourcePoints =
    sku && sku.props.node.type === 'sku_listing'
      ? (sku.props.node as SkuListingNode).points
      : '';

  const platform = node?.platform ?? '';
  // Re-gate when the copy changes, not merely when the object identity does.
  const fingerprint = node
    ? `${node.title}|${node.fields.map(f => `${f.label}:${f.value}`).join('|')}`
    : '';

  useEffect(() => {
    if (!node) {
      setGate(IDLE);
      return;
    }
    const controller = new AbortController();
    setGate(g => ({ ...g, status: 'loading' }));
    runGate([nodeToDraft(node)], controller.signal, sourcePoints, productId)
      .then(res => {
        const result = res.results.find(r => r.platform === platform) ?? res.results[0] ?? null;
        setGate({ status: 'ready', result, error: '' });
      })
      .catch(err => {
        if (controller.signal.aborted) return;
        setGate({ status: 'error', result: null, error: toSafeMessage(err) });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, fingerprint, sourcePoints, productId, nonce]);

  const reload = useCallback(() => setNonce(n => n + 1), []);
  return { gate, reload, productId };
}

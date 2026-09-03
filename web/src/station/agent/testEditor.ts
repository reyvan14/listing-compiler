import type { Editor } from 'tldraw';

// A stand-in for the editor, just rich enough for the validator.
//
// Port lookup and shape creation are exercised for real in the Playwright
// specs against a live tldraw canvas; these unit tests are about the
// validator's own rules — allow-lists, bounds, references, cycles.

export type StubNode = {
  id: string;
  type: string;
  fields?: Record<string, unknown>;
  x?: number;
  y?: number;
};

export function stubEditor(nodes: StubNode[]): Editor {
  const shapes = nodes.map(node => ({
    id: node.id,
    type: 'node',
    x: node.x ?? 0,
    y: node.y ?? 0,
    props: { node: { type: node.type, ...(node.fields ?? {}) } },
  }));
  const byId = new Map(shapes.map(shape => [shape.id, shape]));

  return {
    getShape: (id: string) => byId.get(id),
    isShapeOfType: (shape: { type: string }, type: string) => shape?.type === type,
    getCurrentPageShapes: () => shapes,
    getSelectedShapeIds: () => [],
  } as unknown as Editor;
}

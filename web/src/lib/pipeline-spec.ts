// Inert stand-in for the internal `@yidooo/pipeline-spec` registry, which this
// project does not ship. The semantic pre/post-condition layer that consumes it
// (requiredInputs, ConnectionShapeUtil, NodeDefinition.nodeRole/predecessors) is
// therefore a no-op here. These declarations keep the *type contract* those
// consumers expect; the functions still return "nothing registered".

export type NodeRole = string;

export type NodeInputTier = 'required' | 'recommended' | 'optional';

export type NodeInputSpec = {
  id: string;
  portId: string;
  label: string;
  tier: NodeInputTier;
  /** Empty = accept any source (checked by dataType only). */
  acceptsNodeTypes: string[];
};

export type NodeSpec = {
  label?: string;
  nodeRole?: NodeRole;
  successors?: string[];
  inputs?: NodeInputSpec[];
};

export function getNodeSpec(_type?: string): NodeSpec | undefined {
  return undefined;
}

export function getInputs(_type?: string): readonly NodeInputSpec[] {
  return [];
}

export const PIPELINE_SPEC: Record<string, NodeSpec> = {};

export type NodeRole = string;

export type NodeInputSpec = {
  id: string;
  acceptsNodeTypes?: string[];
};

export function getNodeSpec(_type?: string) {
  return undefined;
}

export function getInputs(_type?: string): readonly NodeInputSpec[] {
  return [];
}

export const PIPELINE_SPEC: Record<string, { successors?: string[]; inputs?: NodeInputSpec[] }> = {};

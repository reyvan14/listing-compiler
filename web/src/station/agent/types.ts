// Wire types for the Agent's structured canvas plans.
//
// A plan is a PROPOSAL. Nothing here is executable: every operation is data
// with an allow-listed `type`, and no field anywhere carries code, a command,
// or a URL for the client to fetch.

export const AGENT_NODE_TYPES = [
  'sku_listing',
  'image_generation',
  'video_generation',
] as const;
export type AgentNodeType = (typeof AGENT_NODE_TYPES)[number];

export const AGENT_OPERATION_TYPES = [
  'create_node',
  'update_node',
  'connect_nodes',
  'focus_nodes',
  'run_nodes',
] as const;
export type AgentOperationType = (typeof AGENT_OPERATION_TYPES)[number];

export type NodeStatus = 'idle' | 'running' | 'success' | 'error' | 'blocked';

export type AgentCanvasContext = {
  selectedNodeIds: string[];
  nodes: Array<{
    id: string;
    type: string;
    position: { x: number; y: number };
    editableFields: Record<string, unknown>;
    status: NodeStatus;
    lastError?: string;
  }>;
  connections: Array<{
    fromNodeId: string;
    fromPortId: string;
    toNodeId: string;
    toPortId: string;
    dataType: string;
  }>;
  evidenceSummary: {
    verified: number;
    needsReview: number;
    conflicting: number;
    unsupported: number;
  };
  policyVersions: Record<string, string>;
};

export type AgentOperation =
  | {
      type: 'create_node';
      tempId: string;
      nodeType: AgentNodeType;
      fields: Record<string, unknown>;
      position?: { x: number; y: number } | null;
    }
  | {
      type: 'update_node';
      nodeId: string;
      nodeType: AgentNodeType;
      fields: Record<string, unknown>;
    }
  | {
      type: 'connect_nodes';
      from: { nodeId: string; portId: string };
      to: { nodeId: string; portId: string };
    }
  | { type: 'focus_nodes'; nodeIds: string[] }
  | { type: 'run_nodes'; nodeIds: string[] };

/**
 * The structured "为什么这样规划" block.
 *
 * Composed entirely of typed, verifiable fields derived from the validated
 * plan. There is deliberately no free-text field: hidden model reasoning has
 * nowhere to live, so the section can never become a chain-of-thought render.
 */
export type PlanRationale = {
  intent: string[];
  platforms: string[];
  /** Which planner produced this: the audited template, or the model. */
  source: 'template' | 'model';
  nodes: Array<{
    ref: string;
    nodeType: string;
    purpose: string;
    aspectRatio?: string;
    duration?: string;
  }>;
  nodeCount: number;
  updatedNodeCount: number;
  connectionCount: number;
  warnings: string[];
  estimatedModelCalls: number;
  requiresRunConfirmation: boolean;
  runTargets: string[];
  publishes: boolean;
  publishNote: string;
};

/**
 * One typed domain action inside a plan.
 *
 * The model supplies only `action` and `params`; every other field is the
 * backend telling the UI what that action means, so a card cannot describe an
 * action as cheaper or safer than the allow-list says it is.
 */
export type AgentPlanAction = {
  action: string;
  params: Record<string, unknown>;
  label: string;
  summary: string;
  readOnly: boolean;
  requiresConfirmation: boolean;
  costsMoney: boolean;
  confirmPrompt: string;
};

export type AgentPlan = {
  id: string;
  title: string;
  summary: string;
  estimatedModelCalls: number;
  warnings: string[];
  requiresRunConfirmation: boolean;
  operations: AgentOperation[];
  actions: AgentPlanAction[];
  rationale?: PlanRationale | null;
};

/** Lifecycle of a plan card. The Agent never claims a state it is not in. */
export type PlanState =
  | 'proposed'
  | 'invalid'
  | 'previewing'
  | 'applying'
  | 'applied'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

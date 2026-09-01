import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Editor, T, useEditor, WeakCache } from 'tldraw';
import {
  NODE_FOOTER_HEIGHT_PX,
  NODE_HEADER_HEIGHT_PX,
  NODE_ROW_BOTTOM_PADDING_PX,
  NODE_ROW_HEADER_GAP_PX,
} from '../constants';
import { PortId, ShapePort } from '../ports/Port';
import { NodeShape } from './NodeShapeUtil';
import {
  ExecutionResult,
  InfoValues,
  NodeDefinition,
  NodeDefinitionConstructor,
} from './types/shared';
import { SkuListingNodeDefinition } from './types/SkuListingNode';
import { ListingResultNodeDefinition } from './types/ListingResultNode';
import { ImageGenerationNodeDefinition } from './types/ImageGenerationNode';
import { VideoGenerationNodeDefinition } from './types/VideoGenerationNode';

export const NodeDefinitions = {
  sku_listing: SkuListingNodeDefinition,
  listing_result: ListingResultNodeDefinition,
  image_generation: ImageGenerationNodeDefinition,
  video_generation: VideoGenerationNodeDefinition,
} satisfies Record<string, NodeDefinitionConstructor<any>>;

export type NodeType = T.TypeOf<typeof NodeType>;
export const NodeType = T.union(
  'type',
  Object.fromEntries(Object.values(NodeDefinitions).map(type => [type.type, type.validator])) as {
    [K in keyof typeof NodeDefinitions as (typeof NodeDefinitions)[K]['type']]: (typeof NodeDefinitions)[K]['validator'];
  },
);

const nodeDefinitions = new WeakCache<
  Editor,
  { [K in keyof typeof NodeDefinitions]: InstanceType<(typeof NodeDefinitions)[K]> }
>();

const nodeQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      refetchInterval: false,
      gcTime: 0,
      refetchOnMount: true,
      retry: false,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
});

export function getNodeDefinitions(editor: Editor) {
  return nodeDefinitions.get(editor, () => {
    return Object.fromEntries(
      Object.values(NodeDefinitions).map(value => [value.type, new value(editor)]),
    ) as any;
  });
}

export function getNodeDefinition(
  editor: Editor,
  node: NodeType | NodeType['type'],
): NodeDefinition<NodeType> {
  return getNodeDefinitions(editor)[
    typeof node === 'string' ? node : node.type
  ] as NodeDefinition<NodeType>;
}

export function getNodeWidthPx(editor: Editor, shape: NodeShape): number {
  return getNodeDefinition(editor, shape.props.node).getWidthPx(shape, shape.props.node);
}

export function getNodeBodyHeightPx(editor: Editor, shape: NodeShape): number {
  return getNodeDefinition(editor, shape.props.node).getBodyHeightPx(shape, shape.props.node);
}

export function getNodeHeightPx(editor: Editor, shape: NodeShape): number {
  const def = getNodeDefinition(editor, shape.props.node);
  return (
    (def.showHeading ? NODE_HEADER_HEIGHT_PX + NODE_ROW_HEADER_GAP_PX : 0) +
    getNodeBodyHeightPx(editor, shape) +
    NODE_ROW_BOTTOM_PADDING_PX +
    (def.showFooter ? NODE_FOOTER_HEIGHT_PX : 0)
  );
}

export function getNodeTypePorts(editor: Editor, shape: NodeShape): Record<string, ShapePort> {
  return getNodeDefinition(editor, shape.props.node).getPorts(shape, shape.props.node);
}

export async function executeNode(
  editor: Editor,
  shape: NodeShape,
  inputs: Record<string, string | number | null | (string | number | null)[]>,
): Promise<ExecutionResult> {
  return await getNodeDefinition(editor, shape.props.node).execute(shape, shape.props.node, inputs);
}

export function getNodeOutputInfo(
  editor: Editor,
  shape: NodeShape,
  inputs: InfoValues,
): InfoValues {
  return getNodeDefinition(editor, shape.props.node).getOutputInfo(shape, shape.props.node, inputs);
}

export function onNodePortConnect(editor: Editor, shape: NodeShape, port: PortId) {
  getNodeDefinition(editor, shape.props.node).onPortConnect?.(shape, shape.props.node, port);
}

export function onNodePortDisconnect(editor: Editor, shape: NodeShape, port: PortId) {
  getNodeDefinition(editor, shape.props.node).onPortDisconnect?.(shape, shape.props.node, port);
}

export function NodeBody({ shape }: { shape: NodeShape }) {
  const editor = useEditor();
  const node = shape.props.node;
  const { Component } = getNodeDefinition(editor, node);
  return (
    <QueryClientProvider client={nodeQueryClient}>
      <Component shape={shape} node={node} />
    </QueryClientProvider>
  );
}

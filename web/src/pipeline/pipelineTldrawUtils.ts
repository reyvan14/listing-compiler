import { ConnectionBindingUtil } from './connection/ConnectionBindingUtil';
import { ConnectionShapeUtil } from './connection/ConnectionShapeUtil';
import { NodeShapeUtil } from './nodes/NodeShapeUtil';

/**
 * Custom tldraw shape/binding utils for the pipeline's node & connection shapes.
 *
 * Shared single source of truth: the main editor (App) AND the chat-history
 * preview (TldrawViewer) must register the same utils — otherwise any tldraw
 * instance rendering a snapshot that contains "node"/"connection" shapes throws
 * "No shape util found for type ...".
 */
export const pipelineShapeUtils = [NodeShapeUtil, ConnectionShapeUtil];
export const pipelineBindingUtils = [ConnectionBindingUtil];

import { TLShapeId, VecModel } from 'tldraw';
import { NodeType } from '../nodes/nodeTypes';
import { EditorAtom } from '../utils';

export interface OnCanvasNodePickerState {
  connectionShapeId: TLShapeId;
  location: 'start' | 'end' | 'middle';
  onPick: (nodeType: NodeType, position: VecModel) => void;
  onClose: () => void;
}

export const onCanvasNodePickerState = new EditorAtom<OnCanvasNodePickerState | null>(
  'on canvas node picker',
  () => null,
);

export function OnCanvasNodePicker() {
  return null;
}

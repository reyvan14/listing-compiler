import type { Editor } from 'tldraw'
import { EditorAtom } from '../../utils'

// Which video node has the storyboard workflow open.
//
// Editor-scoped state, not shape props, for the same reason the listing
// inspector works this way: opening a panel must not touch the canvas. No node
// resizes, nothing restacks, and the camera does not move, so a storyboard can
// be edited without the graph drifting underneath it.

export type StoryboardPanelState = {
  /** Shape id of the video node whose storyboard is open, or null when closed. */
  shapeId: string | null
  /** SKU the storyboard belongs to, resolved when the panel is opened. */
  skuId: string
  platform: string
}

export const storyboardPanelState = new EditorAtom<StoryboardPanelState>(
  'storyboard panel',
  () => ({ shapeId: null, skuId: '', platform: 'tiktok' }),
)

export function openStoryboardPanel(
  editor: Editor,
  shapeId: string,
  skuId: string,
  platform: string,
) {
  storyboardPanelState.set(editor, { shapeId, skuId, platform })
}

export function closeStoryboardPanel(editor: Editor) {
  storyboardPanelState.set(editor, { shapeId: null, skuId: '', platform: 'tiktok' })
}

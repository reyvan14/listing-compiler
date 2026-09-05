import type { Editor } from 'tldraw'
import { EditorAtom } from '../../utils'

// Which listing platform the viewport-level detail inspector is showing.
//
// Deliberately NOT persisted on the shape: opening the inspector must not touch
// the canvas at all — no node resize, no restack, no camera move. Keeping the
// state in an editor-scoped atom means the shape records are untouched, so
// geometry and connections cannot drift when a user reads the detail.

export type InspectorState = {
  /** Platform id of the open card, or null when the inspector is closed. */
  platform: string | null
  /** Shape that opened it, so focus can return there on close. */
  originShapeId: string | null
  /** Open the review tab on this exact revision, when something linked to it. */
  focusRevisionId: string | null
}

export const listingInspectorState = new EditorAtom<InspectorState>(
  'listing inspector',
  () => ({ platform: null, originShapeId: null, focusRevisionId: null }),
)

export function openListingInspector(
  editor: Editor,
  platform: string,
  originShapeId?: string,
) {
  listingInspectorState.set(editor, {
    platform,
    originShapeId: originShapeId ?? null,
    focusRevisionId: null,
  })
}

/**
 * Open the inspector's review tab on one specific revision.
 *
 * Used when something elsewhere — a feedback candidate, an Agent result —
 * created a revision and needs to hand the reviewer straight to it rather than
 * to whatever the canvas happens to show.
 */
export function openRevisionForReview(
  editor: Editor,
  platform: string,
  revisionId: string,
) {
  listingInspectorState.set(editor, {
    platform,
    originShapeId: null,
    focusRevisionId: revisionId,
  })
}

export function closeListingInspector(editor: Editor) {
  listingInspectorState.set(editor, {
    platform: null,
    originShapeId: null,
    focusRevisionId: null,
  })
}

/** Switch platform tabs without closing or changing the origin shape. */
export function selectInspectorPlatform(editor: Editor, platform: string) {
  listingInspectorState.update(editor, s => ({ ...s, platform, focusRevisionId: null }))
}

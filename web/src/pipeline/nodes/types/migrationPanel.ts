import type { Editor } from 'tldraw'
import { EditorAtom } from '../../utils'

// Which stored migration candidate the migration panel should open on.
//
// Editor-scoped rather than shape-scoped for the same reason as the listing
// inspector: an Agent action asking to show a candidate must not add, resize or
// restack anything on the canvas, and must not move the camera.

export type MigrationFocus = {
  /** Candidate id to open the panel on, or null for the normal panel. */
  candidateId: string | null
  /** Bumped on every request so re-opening the same candidate still fires. */
  nonce: number
}

export const migrationFocusState = new EditorAtom<MigrationFocus>(
  'migration focus',
  () => ({ candidateId: null, nonce: 0 }),
)

export function openMigrationCandidate(editor: Editor, candidateId: string) {
  migrationFocusState.update(editor, s => ({
    candidateId,
    nonce: s.nonce + 1,
  }))
}

export function clearMigrationFocus(editor: Editor) {
  migrationFocusState.update(editor, s => ({ candidateId: null, nonce: s.nonce }))
}

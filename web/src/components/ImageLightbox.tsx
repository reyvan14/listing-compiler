import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './imageLightbox.css'

// Shared original-image viewer.
//
// Rendered through a portal onto document.body so it escapes every ancestor
// stacking context — the listing-details inspector sits at z-index 2147483646,
// and a lightbox nested inside it could never paint above it otherwise.
//
// Every pointer handler stops propagation: this thing opens over an interactive
// tldraw canvas, where a stray click selects or drags a node and a stray wheel
// event zooms the board.

export type ImageLightboxProps = {
  /** The ORIGINAL image source — never a thumbnail or a re-encoded copy. */
  src: string
  /** Accessible name for the dialog, e.g. "Amazon 白底主图 1:1". */
  label: string
  alt?: string
  onClose: () => void
  /** Focused on close when it is still in the document. */
  returnFocusTo?: HTMLElement | null
}

export function ImageLightbox({
  src,
  label,
  alt,
  onClose,
  returnFocusTo,
}: ImageLightboxProps) {
  const [failed, setFailed] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  // Escape closes the lightbox and nothing else.
  //
  // Listening on `window` in the CAPTURE phase is deliberate. The listing
  // inspector also listens on `document` in capture, and it mounts first — for
  // two capture listeners on the same target the earlier registration wins, so
  // a document-level listener here would let the inspector close first.
  // Capture descends window → document, so this always runs before the
  // inspector's handler, and stopPropagation keeps the key from reaching it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  // Lock background scrolling, restoring whatever the page had before.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  // Move focus in on open, hand it back on close.
  //
  // preventScroll on BOTH calls matters: focus() scrolls its target into view by
  // default, and the trigger lives inside the scrollable details modal — so
  // restoring focus was silently shifting that modal's scroll position.
  useEffect(() => {
    const previouslyFocused = (returnFocusTo ?? document.activeElement) as HTMLElement | null
    closeRef.current?.focus({ preventScroll: true })
    return () => {
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus({ preventScroll: true })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep Tab inside the dialog while it is open.
  const onKeyDownTrap = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== 'Tab' || !dialogRef.current) return
    const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled])',
    )
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }, [])

  /** Swallow a pointer event so it never reaches the canvas or the modal. */
  const swallow = (event: React.SyntheticEvent) => event.stopPropagation()

  return createPortal(
    <div
      ref={dialogRef}
      className="ImageLightbox"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      data-testid="image-lightbox"
      onKeyDown={onKeyDownTrap}
      // The backdrop closes; pointer events never bubble to the canvas below.
      onPointerDown={swallow}
      onPointerUp={swallow}
      onWheel={swallow}
      onDoubleClick={swallow}
      onClick={event => {
        event.stopPropagation()
        onClose()
      }}
    >
      <button
        ref={closeRef}
        type="button"
        className="ImageLightbox-close"
        aria-label="关闭原图预览"
        data-testid="lightbox-close"
        onPointerDown={swallow}
        onClick={event => {
          event.stopPropagation()
          onClose()
        }}
      >
        <CloseIcon />
      </button>

      {failed ? (
        <div className="ImageLightbox-error" role="alert" data-testid="lightbox-error">
          <b>原图加载失败</b>
          <span>无法读取该图片的原始文件，请确认来源仍然可用。</span>
        </div>
      ) : (
        <img
          className="ImageLightbox-media"
          src={src}
          alt={alt ?? label}
          data-testid="lightbox-image"
          // Clicking the image itself must NOT close the lightbox.
          onClick={swallow}
          onPointerDown={swallow}
          onDoubleClick={swallow}
          onError={() => setFailed(true)}
        />
      )}
    </div>,
    document.body,
  )
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M4.5 4.5L13.5 13.5M13.5 4.5L4.5 13.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Magnifier used by every "查看原图" affordance, so they stay identical. */
export function ZoomIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="4.75" stroke="currentColor" strokeWidth="1.3" />
      <path d="M11.5 11.5L15 15" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M6.25 8H9.75M8 6.25V9.75" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

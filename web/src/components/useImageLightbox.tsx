import { useCallback, useRef, useState } from 'react'
import { ImageLightbox, ZoomIcon } from './ImageLightbox'

// One hook + one trigger button, so every "查看原图" affordance in the app
// behaves identically and no call site re-implements the event plumbing.

export function useImageLightbox() {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLElement | null>(null)

  const openLightbox = useCallback((trigger?: HTMLElement | null) => {
    triggerRef.current = trigger ?? null
    setOpen(true)
  }, [])

  const close = useCallback(() => setOpen(false), [])

  const render = useCallback(
    (src: string, label: string, alt?: string) =>
      open && src ? (
        <ImageLightbox
          src={src}
          label={label}
          alt={alt}
          onClose={close}
          returnFocusTo={triggerRef.current}
        />
      ) : null,
    [open, close],
  )

  return { open, openLightbox, close, render }
}

/**
 * The floating "查看原图" control shown on hover in an image's bottom-right.
 *
 * Every pointer event is stopped here: these sit on top of tldraw shapes, where
 * a click that reaches the canvas selects or drags the node.
 */
export function ViewOriginalButton({
  onOpen,
  compact = false,
}: {
  onOpen: (trigger: HTMLElement) => void
  /** Icon only, for images too small for the label. Keeps the tooltip. */
  compact?: boolean
}) {
  const swallow = (event: React.SyntheticEvent) => event.stopPropagation()
  return (
    <button
      type="button"
      className="ImageZoomBtn"
      title="查看原图"
      aria-label="查看原图"
      data-testid="view-original"
      onPointerDown={swallow}
      onDoubleClick={swallow}
      onClick={event => {
        event.stopPropagation()
        event.preventDefault()
        onOpen(event.currentTarget)
      }}
    >
      <ZoomIcon />
      {!compact && <span>查看原图</span>}
    </button>
  )
}

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * A selection highlight that travels.
 *
 * Every list in this app marks its current item by turning a background on in
 * one row and off in another, which reads as two unrelated events. Here there
 * is one pill per list and it moves: pick the second database and the
 * highlight slides down to meet it, growing or shrinking to fit on the way.
 * The eye follows it, which is the whole point — in a keyboard-driven app the
 * user is often moving the selection faster than they can re-read the list.
 *
 * Usage is two attributes at the call site:
 *
 *   <Highlight className="overflow-y-auto">
 *     {items.map((i) => (
 *       <button className="relative …" data-highlight={i === active || undefined}>
 *     ))}
 *   </Highlight>
 *
 * `data-highlight` on the active item (and nowhere else) is what is followed;
 * `relative` on every item is what keeps the text painting above the pill,
 * since an absolutely positioned sibling would otherwise cover it.
 *
 * This is not in `src/ui` on purpose. That layer exists to quarantine vendor
 * APIs — see ui/README.md — and there is no vendor here to hide.
 */
interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface HighlightProps {
  children: React.ReactNode
  /** Applied to the wrapper, which is made `relative` regardless. */
  className?: string
  /** Colour and shape of the pill. Defaults to the accent wash. */
  pillClassName?: string
}

export function Highlight({
  children,
  className = '',
  pillClassName = 'rounded-xl bg-[var(--color-accent-dim)]/60 shadow-xs',
}: HighlightProps) {
  const host = useRef<HTMLDivElement>(null)
  const [rect, setRect] = useState<Rect | null>(null)
  const [moving, setMoving] = useState(false)

  const measure = useCallback(() => {
    const el = host.current
    const target = el?.querySelector<HTMLElement>('[data-highlight]')
    if (!el || !target) {
      setRect(null)
      return
    }
    const a = target.getBoundingClientRect()
    const b = el.getBoundingClientRect()
    // Content coordinates, not viewport ones: the pill is a child of the
    // wrapper, so it has to be positioned in the same space the wrapper
    // scrolls. Adding scrollTop covers the case where the wrapper *is* the
    // scroll container; where the scroller is an ancestor it is zero and the
    // rect difference already accounts for the offset.
    const next = {
      x: a.left - b.left + el.scrollLeft,
      y: a.top - b.top + el.scrollTop,
      w: a.width,
      h: a.height,
    }
    setRect((prev) => (prev && same(prev, next) ? prev : next))
  }, [])

  // Deliberately no dependency array. What the pill should sit on can change
  // for reasons this component cannot see — a filtered list, a renamed row, a
  // font-size change — so it re-measures after every render and the identity
  // check above stops that from looping.
  useLayoutEffect(measure)

  // Dragging the sidebar resizes the rows without re-rendering this.
  useEffect(() => {
    const el = host.current
    if (!el) return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    // A scroller inside the wrapper moves the target without a render.
    el.addEventListener('scroll', measure, { capture: true, passive: true })
    return () => {
      observer.disconnect()
      el.removeEventListener('scroll', measure, { capture: true })
    }
  }, [measure])

  // Movement is enabled one frame after the pill first has somewhere to be.
  useEffect(() => {
    if (!rect) {
      setMoving(false)
      return
    }
    if (moving) return
    const id = requestAnimationFrame(() => setMoving(true))
    return () => cancelAnimationFrame(id)
  }, [rect, moving])

  return (
    <div ref={host} className={`relative ${className}`}>
      <div
        aria-hidden
        className={`highlight-pill ${moving ? 'highlight-pill-moves' : ''} ${pillClassName}`}
        style={
          rect
            ? {
                opacity: 1,
                width: rect.w,
                height: rect.h,
                transform: `translate3d(${rect.x}px, ${rect.y}px, 0)`,
              }
            : { opacity: 0 }
        }
      />
      {children}
    </div>
  )
}

function same(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

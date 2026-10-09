import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * A selection highlight that travels, and a quieter one for the pointer.
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
 *       <button className="relative …" data-item data-highlight={i === active || undefined}>
 *     ))}
 *   </Highlight>
 *
 * `data-highlight` on the active item (and nowhere else) is what the selection
 * pill sits on. It moves only when that does — never with the pointer, since
 * a pill chasing the mouse and springing back draws the eye for nothing.
 *
 * Items marked `data-item` get a second, dimmer hover pill. It slides out from
 * the selection to the item under the pointer, follows it between items, and
 * fades where it is when the pointer leaves. Coming back mid-fade picks it up
 * from there; coming back after starts again from the selection.
 *
 * `relative` on every item is what keeps the text painting above the pills,
 * since an absolutely positioned sibling would otherwise cover it.
 *
 * One host can span several lists — the whole sidebar is one — so the pill
 * glides between them instead of one fading out as another fades in. A
 * scroller inside it is marked `data-highlight-clip` to trim the pill to it.
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
  /** Colour and shape of the selection pill. Defaults to the accent wash. */
  pillClassName?: string
  /** Colour and shape of the hover pill. Defaults to a fainter accent wash. */
  hoverClassName?: string
}

export function Highlight({
  children,
  className = '',
  pillClassName = 'rounded-xl bg-[var(--color-accent-dim)]/60 shadow-xs',
  hoverClassName = 'rounded-xl bg-[var(--color-accent-dim)]/25',
}: HighlightProps) {
  const host = useRef<HTMLDivElement>(null)
  const hoverPill = useRef<HTMLDivElement>(null)
  const [rect, setRect] = useState<Rect | null>(null)
  const [moving, setMoving] = useState(false)
  const hovered = useRef<HTMLElement | null>(null)

  const selected = useCallback(() => {
    const el = host.current
    // With several marked, the last is the most specific: a keyboard row in a
    // nested list outranks the tab it sits in.
    return [...(el?.querySelectorAll<HTMLElement>('[data-highlight]') ?? [])]
      .filter((t) => ownedBy(el, t))
      .at(-1)
  }, [])

  const measure = useCallback(() => {
    const el = host.current
    const target = selected()
    const next = el && target ? rectIn(el, target) : null
    setRect((prev) => (prev && next && same(prev, next) ? prev : next))
  }, [selected])

  // The hover pill is driven by the DOM, not state: it moves on every pointer
  // crossing, and a re-render of the whole list each time would be waste.
  const hover = useCallback(
    (item: HTMLElement | null, glide = true) => {
      const el = host.current
      const pill = hoverPill.current
      if (!el || !pill) return
      hovered.current = item
      if (!item?.isConnected) {
        hovered.current = null
        pill.style.opacity = '0'
        return
      }
      const to = rectIn(el, item)
      // Fully faded: start again from the selection, so it slides out of it.
      if (getComputedStyle(pill).opacity === '0') {
        const from = selected()
        place(pill, from ? rectIn(el, from) : to, false)
        void pill.offsetWidth
      }
      place(pill, to, glide)
      pill.style.opacity = '1'
    },
    [selected],
  )

  // Deliberately no dependency array. What the pill should sit on can change
  // for reasons this component cannot see — a filtered list, a renamed row, a
  // font-size change — so it re-measures after every render and the identity
  // check above stops that from looping.
  useLayoutEffect(measure)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const remeasure = () => {
      measure()
      // A virtualised list recycles rows, so a hovered one may have gone.
      if (hovered.current) hover(hovered.current, false)
    }
    // Dragging the sidebar resizes the rows without re-rendering this.
    const resized = new ResizeObserver(remeasure)
    resized.observe(el)
    // A nested list moving its marker re-renders itself, not this.
    const marked = new MutationObserver(remeasure)
    marked.observe(el, { subtree: true, childList: true, attributeFilter: ['data-highlight'] })
    // A scroller inside moves the target without a render. The pills follow
    // at once rather than springing after it, which would read as lag.
    const scrolled = () => {
      setMoving(false)
      remeasure()
    }
    el.addEventListener('scroll', scrolled, { capture: true, passive: true })
    return () => {
      resized.disconnect()
      marked.disconnect()
      el.removeEventListener('scroll', scrolled, { capture: true })
    }
  }, [measure, hover])

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
    <div
      ref={host}
      data-highlight-host
      className={`relative ${className}`}
      onPointerOver={(e) => {
        const item = (e.target as Element).closest<HTMLElement>('[data-item]')
        if (!item || item === hovered.current || !ownedBy(host.current, item)) return
        hover(item)
      }}
      onPointerLeave={() => hover(null)}
    >
      <div
        aria-hidden
        ref={hoverPill}
        className={`highlight-pill highlight-pill-moves ${hoverClassName}`}
        style={{ opacity: 0 }}
      />
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

/** Where `target` sits in `host`'s content box, trimmed to its scroller. */
function rectIn(host: HTMLElement, target: HTMLElement): Rect {
  const b = host.getBoundingClientRect()
  let { top, bottom } = target.getBoundingClientRect()
  const { left, width } = target.getBoundingClientRect()
  // Trimmed to the scroller it sits in, so a half-scrolled row's pill does
  // not paint over whatever is above or below that scroller.
  const clip = target.closest('[data-highlight-clip]')
  if (clip && host.contains(clip)) {
    const c = clip.getBoundingClientRect()
    top = Math.max(top, c.top)
    bottom = Math.max(top, Math.min(bottom, c.bottom))
  }
  // Content coordinates, not viewport ones: the pill is a child of the
  // wrapper, so it has to be positioned in the same space the wrapper
  // scrolls. Adding scrollTop covers the case where the wrapper *is* the
  // scroll container; where the scroller is an ancestor it is zero and the
  // rect difference already accounts for the offset.
  return {
    x: left - b.left + host.scrollLeft,
    y: top - b.top + host.scrollTop,
    w: width,
    h: bottom - top,
  }
}

/** Moves a pill by hand; `glide` false lands it at once, opacity untouched. */
function place(pill: HTMLElement, r: Rect, glide: boolean) {
  pill.classList.toggle('highlight-pill-moves', glide)
  pill.style.width = `${r.w}px`
  pill.style.height = `${r.h}px`
  pill.style.transform = `translate3d(${r.x}px, ${r.y}px, 0)`
}

/** Nested lists have their own pill; an item belongs to the nearest host above it. */
function ownedBy(host: HTMLElement | null, item: Element): boolean {
  return item.parentElement?.closest('[data-highlight-host]') === host
}

function same(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

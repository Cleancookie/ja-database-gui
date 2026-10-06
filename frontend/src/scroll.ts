/**
 * Keeping the focused cell on screen.
 *
 * Both grids scroll one element with sticky chrome pinned over its near edges:
 * the column header along the top, and — transposed — the column-name strip
 * down the left. A virtualiser's own `scrollToIndex` knows nothing about that
 * chrome, so its idea of "just in view" left the cell under the header, at
 * times with a pixel of it showing. The arithmetic lives here instead, one rule
 * per axis, so both orientations share it and it can be tested without a DOM.
 */

/** One axis of the scroll element, in content coordinates. */
export interface Viewport {
  /** Current scroll offset — `scrollTop` or `scrollLeft`. */
  offset: number
  /** Visible length: `clientHeight` or `clientWidth`. */
  length: number
  /** Sticky chrome pinned at the near edge, which covers content behind it. */
  sticky: number
}

/** Where something sits on one axis, in content coordinates. */
export interface Span {
  start: number
  size: number
}

/**
 * The scroll offset that shows as much of `span` as the axis can.
 *
 * A span that fits is brought wholly inside the uncovered area — both of its
 * edges, which across the two axes is every corner of the cell. A span too big
 * to fit cannot be shown whole, so the near edge wins: a long value read from
 * its start is worth more than the same value read from the middle.
 */
export function offsetToShow(v: Viewport, span: Span): number {
  let offset = v.offset
  // Far edge first and near edge second, so that on an oversized span the near
  // edge overrides and what shows begins at the start of the cell.
  const end = span.start + span.size
  if (end > offset + v.length) offset = end - v.length
  if (span.start < offset + v.sticky) offset = span.start - v.sticky
  return Math.max(0, offset)
}

/** Where the `index`th of a run of equally sized items sits. */
export function uniformSpan(index: number, size: number, before = 0): Span {
  return { start: before + index * size, size }
}

/** Where the `index`th item sits in a run of measured widths. */
export function measuredSpan(index: number, sizes: number[], before = 0): Span {
  let start = before
  for (let i = 0; i < index; i++) start += sizes[i] ?? 0
  return { start, size: sizes[index] ?? 0 }
}

/**
 * Whether a correction is short enough to animate.
 *
 * Arrow keys move by one cell and gain from being followed by the eye. A jump
 * of thousands of rows does not: animating it is a wait, and the virtualiser
 * would render every window on the way. Two viewports is roughly the point
 * where a scroll stops reading as movement and starts reading as a delay.
 */
export function worthAnimating(delta: number, length: number): boolean {
  return Math.abs(delta) <= length * 2
}

/** Whether the user has asked for less movement. */
export function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/** A correction to make, on both axes, with why it is being made. */
export interface Correction {
  dy: number
  dx: number
  height: number
  width: number
  /** The move came from a held key rather than a deliberate press. */
  repeat: boolean
}

/**
 * Whether a correction should glide rather than land at once.
 *
 * Held keys are the reason this is more than `worthAnimating` on each axis.
 * Autorepeat arrives every 30ms or so and a smooth scroll takes ten times
 * that, so every repeat cancels the animation before it has covered a row and
 * restarts the easing from a standstill: the selection runs off down the result
 * while the viewport crawls after it. A repeat therefore lands immediately, and
 * only a single press glides. Reduced motion is passed in rather than read here
 * so the rule stays a function of its arguments.
 */
export function smoothly(c: Correction, reduced: boolean): boolean {
  if (c.repeat || reduced) return false
  return worthAnimating(c.dy, c.height) && worthAnimating(c.dx, c.width)
}

/**
 * Scroll an element to an offset, animating the move when that helps.
 *
 * The one impure function here, and the only place the rules above are applied:
 * a short deliberate hop glides, while a long jump, a held key and a
 * reduced-motion preference all land immediately. Doing nothing when already
 * there matters — an unconditional `scrollTo` during a smooth animation
 * cancels it.
 */
export function scrollTo(el: HTMLElement, top: number, left: number, repeat = false): void {
  const dy = top - el.scrollTop
  const dx = left - el.scrollLeft
  if (dy === 0 && dx === 0) return
  const smooth = smoothly(
    { dy, dx, height: el.clientHeight, width: el.clientWidth, repeat },
    reducedMotion(),
  )
  el.scrollTo({ top, left, behavior: smooth ? 'smooth' : 'auto' })
}

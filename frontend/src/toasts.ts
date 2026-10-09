import type { Toast } from './store'

/** How long an info toast stays, counted afresh each time the stack collapses. */
export const TOAST_MS = 4000

/** Cards visible behind the front one while the stack is collapsed. */
export const PEEK_LAYERS = 2
/** How far each card behind the front one sticks out above it, in px. */
export const PEEK_PX = 10
export const GAP_PX = 8

/**
 * A repeat of a toast already on screen bumps its count instead of stacking a
 * copy — a failing loop otherwise buries everything under identical cards.
 * The repeat moves to the front and restarts its timer (`at` changes).
 */
export function addToast(list: Toast[], t: Toast): Toast[] {
  const same = t.action
    ? undefined
    : list.find((o) => !o.action && o.kind === t.kind && o.message === t.message)
  if (!same) return [...list, t]
  return [...list.filter((o) => o !== same), { ...same, count: same.count + 1, at: t.at }]
}

/**
 * Where each card sits, measured up from the bottom of the stack. `heights` is
 * newest first. Collapsed, cards behind the front peek out by a few pixels and
 * take the front card's height so they line up; expanded, they sit in a column.
 */
export function stackLayout(heights: number[], expanded: boolean) {
  const front = heights[0] ?? 0
  let y = 0
  const cards = heights.map((h, i) => {
    const card = expanded
      ? { y, scale: 1, height: h, visible: true }
      : {
          y: i * PEEK_PX,
          scale: 1 - i * 0.05,
          height: i === 0 ? h : front,
          visible: i <= PEEK_LAYERS,
        }
    y += h + GAP_PX
    return card
  })
  const total = expanded
    ? Math.max(0, y - GAP_PX)
    : front + Math.min(heights.length - 1, PEEK_LAYERS) * PEEK_PX
  return { cards, total }
}

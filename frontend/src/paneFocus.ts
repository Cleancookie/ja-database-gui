import { listMove } from './listNav'
import type { useStore } from './store'

type Store = ReturnType<typeof useStore.getState>

export type Pane = 'main' | 'left' | 'tray'

/**
 * The attribute a pane's root carries (`data-pane="left"`), and the one its
 * focus home carries — the control whose keys the pane is driven by: the
 * picker list, the table search, the tray's header row.
 */
export const PANE_ATTR = 'data-pane'
export const FOCUS_HOME_ATTR = 'data-focus-home'

function home(pane: Pane): HTMLElement | null {
  const root = document.querySelector<HTMLElement>(`[${PANE_ATTR}="${pane}"]`)
  if (!root) return null
  return root.querySelector<HTMLElement>(`[${FOCUS_HOME_ATTR}]`) ?? root
}

/**
 * Focuses the pane's home. A pane sliding open stays hidden for part of the
 * slide and refuses focus until then, so this keeps trying for about half a
 * second.
 */
export function focusPane(pane: Pane) {
  let tries = 0
  const attempt = () => {
    const el = home(pane)
    el?.focus()
    if (el && document.activeElement !== el && ++tries < 30) requestAnimationFrame(attempt)
  }
  requestAnimationFrame(attempt)
}

/** Shows or hides a pane, taking focus into one that opens and back to the page from one that closes. */
export async function setPane(s: Store, pane: Exclude<Pane, 'main'>, open: boolean) {
  if (pane === 'left') await s.setTabStrip(open)
  else s.setTrayOpen(open)
  focusPane(open ? pane : 'main')
}

/**
 * Focus that has fallen to the page — a click on empty background — leaves
 * the list keys with nowhere to go. Those keys, Enter and typing are handed
 * to the main pane's home instead. A printable key is not re-sent: focusing
 * during keydown already lets its character land in a field, and a re-sent
 * event would not type.
 */
export function recoverFocus(e: KeyboardEvent): boolean {
  const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey
  if (!printable && e.key !== 'Enter' && !listMove(e)) return false
  const at = document.activeElement
  if (at && at !== document.body && !at.hasAttribute(PANE_ATTR)) return false
  const el = home('main')
  // A bare pane root is no home: the grid, say, already reads keys from window.
  if (!el || el === at || el.hasAttribute(PANE_ATTR)) return false
  el.focus()
  if (!printable) {
    e.preventDefault()
    el.dispatchEvent(new KeyboardEvent('keydown', e))
  }
  return true
}

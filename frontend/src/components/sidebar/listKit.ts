import { useEffect, useRef, useState } from 'react'
import { listMove, moveIndex } from '../../listNav'

export const INPUT =
  'w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-elevated)] px-2 py-1 outline-none placeholder:text-[var(--color-faint)]'
export const PILL = 'rounded-lg bg-[var(--color-accent-dim)]/55'
export const ICON_BUTTON =
  'relative shrink-0 rounded-full px-2 leading-6 text-[var(--color-faint)] opacity-40 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-[var(--color-elevated)] hover:text-[var(--color-text)]'

/**
 * A highlight moved by the list keys (`listNav.ts`), with Enter taking the
 * highlighted row. A focused button is left to activate itself — it is what
 * the user is looking at.
 */
export function useListKeys(count: number, onEnter: (index: number) => void) {
  const [selected, setSelected] = useState(0)
  const onKeyDown = (e: React.KeyboardEvent) => {
    const move = listMove(e)
    if (move) {
      e.preventDefault()
      setSelected((i) => moveIndex(move, i, count))
      return
    }
    if (e.key !== 'Enter' || (e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    if (selected < count) onEnter(selected)
  }
  return { selected, setSelected, onKeyDown }
}

/**
 * Focuses `el` each time `active` turns true, a frame later so a step that is
 * still opening has put it on screen.
 */
export function useFocusWhen(active: boolean, el: () => HTMLElement | null) {
  const target = useRef(el)
  target.current = el
  useEffect(() => {
    if (!active) return
    const id = requestAnimationFrame(() => target.current()?.focus())
    return () => cancelAnimationFrame(id)
  }, [active])
}

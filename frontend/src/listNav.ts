/**
 * The one set of keys that move a highlight through a list, shared by the
 * command palette and the connection picker so a movement works the same in
 * both. Pure so the mapping is tested without a DOM.
 */

export type ListMove = 'next' | 'prev' | 'first' | 'last'

/**
 * Arrows, Home and End, plus Ctrl+J / Ctrl+K — the same pair the grid moves
 * on. `emacs` adds Ctrl+N / Ctrl+P; the picker leaves it off because Ctrl+P
 * there opens the palette.
 */
export function listMove(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  emacs = false,
): ListMove | null {
  if (e.altKey) return null
  if (!e.ctrlKey) {
    if (e.shiftKey) return null
    switch (e.key) {
      case 'ArrowDown':
        return 'next'
      case 'ArrowUp':
        return 'prev'
      case 'Home':
        return 'first'
      case 'End':
        return 'last'
    }
    return null
  }
  if (e.shiftKey) return null
  switch (e.key.toLowerCase()) {
    case 'j':
      return 'next'
    case 'k':
      return 'prev'
    case 'n':
      return emacs ? 'next' : null
    case 'p':
      return emacs ? 'prev' : null
  }
  return null
}

/** Where the highlight lands after `move`, clamped to the list. */
export function moveIndex(move: ListMove, index: number, count: number): number {
  if (count <= 0) return 0
  switch (move) {
    case 'next':
      return Math.min(index + 1, count - 1)
    case 'prev':
      return Math.max(index - 1, 0)
    case 'first':
      return 0
    case 'last':
      return count - 1
  }
}

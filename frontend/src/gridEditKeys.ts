import type { State } from './store'

/**
 * The grid's editing keys, kept out of DataGrid's already long key handler.
 * True when the key was one of them and has been dealt with.
 *
 * Only reached for the browse grid; an ad-hoc result has no table behind it.
 */
export function handleEditKey(e: KeyboardEvent, s: State): boolean {
  const mod = e.ctrlKey || e.metaKey

  if (e.key === 'F2' && !mod && !e.shiftKey) {
    e.preventDefault()
    void s.startEdit()
    return true
  }
  // Ctrl+Backspace rather than Delete: Delete is easy to hit and a NULL is not
  // the same as clearing a value, so it takes a deliberate chord.
  if (e.key === 'Backspace' && mod) {
    e.preventDefault()
    s.setSelectionNull()
    return true
  }
  // Claimed only while there is something to undo, so Ctrl+Z stays whatever it
  // was everywhere else.
  if (e.key.toLowerCase() === 'z' && mod && !e.shiftKey && s.staged.past.length > 0) {
    e.preventDefault()
    s.undoEdit()
    return true
  }
  return false
}

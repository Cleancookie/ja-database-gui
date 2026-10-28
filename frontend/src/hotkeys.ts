import type { Settings } from './types'

export interface HotkeyAction {
  id: string
  label: string
  defaults: string[]
}

/** The rebindable shortcuts. Everything else is fixed and listed in ShortcutsDialog. */
export const HOTKEY_ACTIONS: HotkeyAction[] = [
  { id: 'palette.go', label: 'Go to… palette', defaults: ['Ctrl+P'] },
  { id: 'palette.do', label: 'Command palette', defaults: ['Ctrl+Shift+P'] },
  { id: 'pane.left', label: 'Toggle left pane', defaults: ['Ctrl+B', 'Ctrl+ArrowLeft'] },
  { id: 'pane.right', label: 'Toggle right pane', defaults: ['Ctrl+ArrowRight', 'Ctrl+Space'] },
  { id: 'pane.tray', label: 'Toggle activity tray', defaults: ['Ctrl+`', 'Ctrl+ArrowDown'] },
  { id: 'tab.new', label: 'New tab', defaults: ['Ctrl+T'] },
  { id: 'tab.close', label: 'Close tab', defaults: ['Ctrl+W'] },
]

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta'])

/** "Ctrl+Shift+P" for a keydown, or null for a bare modifier press. Meta counts as Ctrl. */
export function chord(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null
  const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

export function bindingsFor(overrides: Settings['hotkeys'], id: string): string[] {
  const own = overrides?.[id]
  if (own) return [own]
  return HOTKEY_ACTIONS.find((a) => a.id === id)?.defaults ?? []
}

/** Arrow chords mean "move by word" in a field, so they never fire while typing. */
export function firesWhileTyping(combo: string): boolean {
  return !combo.split('+').at(-1)!.startsWith('Arrow')
}

/** The action a keydown triggers, or null. */
export function actionFor(
  overrides: Settings['hotkeys'],
  e: KeyboardEvent,
  typing: boolean,
): string | null {
  const c = chord(e)
  if (!c) return null
  for (const a of HOTKEY_ACTIONS) {
    if (bindingsFor(overrides, a.id).includes(c) && (!typing || firesWhileTyping(c))) return a.id
  }
  return null
}

/** Another action already bound to `combo`, for the conflict warning. */
export function conflict(overrides: Settings['hotkeys'], id: string, combo: string) {
  return HOTKEY_ACTIONS.find((a) => a.id !== id && bindingsFor(overrides, a.id).includes(combo))
}

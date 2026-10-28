import type { Command } from './commands'
import type { Settings } from './types'

type Overrides = Settings['hotkeys']

/**
 * Commands whose keys the editor or grid handle themselves, so they cannot be
 * rebound here. They are listed read-only and still count towards conflicts.
 * Reload stays fixed on purpose: it is the way out when the UI wedges.
 */
const FIXED = new Set([
  'sql:run',
  'sql:format',
  'sql:prev-run',
  'sql:next-run',
  'grid:copy',
  'grid:transpose',
  'app:reload',
])

export const isFixed = (id: string) => FIXED.has(id) || id.startsWith('edit:')

/** Ids the window handler runs before it checks for an open palette or dialog. */
export const WORKS_OVER_MODALS = new Set(['palette:go', 'palette:do', 'app:settings', 'sql:cancel'])

const GLYPHS: Record<string, string> = {
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
  '↑': 'ArrowUp',
  '↓': 'ArrowDown',
}
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta'])
const MOD_ORDER = ['Ctrl', 'Alt', 'Shift']

function keyName(key: string): string {
  if (key === ' ') return 'Space'
  if (key === '+') return 'Plus'
  return key.length === 1 ? key.toUpperCase() : key
}

/** "Ctrl+Shift+P" for a keydown, or null for a bare modifier press. Meta counts as Ctrl. */
export function chord(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null
  const mods = []
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  return [...mods, keyName(e.key)].join('+')
}

/** A command's `shortcut` text as chords: "Ctrl+B / Ctrl+←" is two. */
export function parseShortcut(text?: string): string[] {
  if (!text) return []
  return text
    .split(' / ')
    .map((part) => {
      const pieces = part.trim().split('+')
      const key = pieces.pop()!
      const mods = MOD_ORDER.filter((m) => pieces.includes(m))
      return [...mods, keyName(GLYPHS[key] ?? key)].join('+')
    })
    .filter(Boolean)
}

/** What `cmd` is bound to now: the user's list if they made one, else its defaults. */
export function bindingsOf(cmd: Command, overrides: Overrides): string[] {
  const own = overrides?.[cmd.id]
  return own && !isFixed(cmd.id) ? own : parseShortcut(cmd.shortcut)
}

/** Arrow chords mean "move by word" in a field; Alt+arrows only stay out of the SQL editor. */
export function firesWhileTyping(c: string, target: HTMLElement | null): boolean {
  if (!c.split('+').at(-1)!.startsWith('Arrow')) return true
  return c.startsWith('Alt+') && !target?.isContentEditable
}

/** The rebindable command bound to `c`, if any. */
export function commandFor(cmds: Command[], overrides: Overrides, c: string): Command | null {
  return cmds.find((cmd) => !isFixed(cmd.id) && bindingsOf(cmd, overrides).includes(c)) ?? null
}

/** Other commands already using `c`, fixed ones included. */
export function conflictsFor(
  cmds: Command[],
  overrides: Overrides,
  id: string,
  c: string,
): Command[] {
  return cmds.filter((cmd) => cmd.id !== id && bindingsOf(cmd, overrides).includes(c))
}

/** "Ctrl+ArrowLeft" as "Ctrl+←". */
export function display(c: string): string {
  const glyph = Object.entries(GLYPHS).find(([, name]) => c.endsWith(`+${name}`))
  return glyph ? c.slice(0, -glyph[1].length) + glyph[0] : c.replace(/\+Plus$/, '++')
}

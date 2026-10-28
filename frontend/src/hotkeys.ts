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

/** One step of a binding as a combo: "Shift+Alt+F" is "Alt+Shift+F". */
function normaliseStep(step: string): string {
  const pieces = step.trim().split('+')
  const key = pieces.pop()!
  const mods = MOD_ORDER.filter((m) => pieces.includes(m))
  return [...mods, keyName(GLYPHS[key] ?? key)].join('+')
}

/**
 * A command's `shortcut` text as bindings. " / " separates alternatives and a
 * space separates the steps of a chord: "Ctrl+K Ctrl+S / Ctrl+B" is two.
 */
export function parseShortcut(text?: string): string[] {
  if (!text) return []
  return text
    .split(' / ')
    .map((part) => part.trim().split(/\s+/).map(normaliseStep).join(' '))
    .filter(Boolean)
}

export const stepsOf = (binding: string) => binding.split(' ')

/** What `cmd` is bound to now: the user's list if they made one, else its defaults. */
export function bindingsOf(cmd: Command, overrides: Overrides): string[] {
  const own = overrides?.[cmd.id]
  return own && !isFixed(cmd.id) ? own : parseShortcut(cmd.shortcut)
}

/** Arrow combos mean "move by word" in a field; Alt+arrows only stay out of the SQL editor. */
export function firesWhileTyping(c: string, target: HTMLElement | null): boolean {
  if (!c.split('+').at(-1)!.startsWith('Arrow')) return true
  return c.startsWith('Alt+') && !target?.isContentEditable
}

const startsWith = (steps: string[], prefix: string[]) => prefix.every((p, i) => steps[i] === p)

export type Advance =
  | { type: 'run'; cmd: Command }
  | { type: 'wait'; pending: string[] }
  | { type: 'abort' }
  | { type: 'none' }

/**
 * What a keypress does given the steps already pressed. An exact match runs at
 * once, even when a longer chord shares its start — the page flags that as a
 * conflict. A key that continues no chord abandons the pending one and is tried
 * afresh, so a mistyped second key never leaves the first one stuck.
 */
export function advance(
  cmds: Command[],
  overrides: Overrides,
  pending: string[],
  c: string,
): Advance {
  const seq = [...pending, c]
  let exact: Command | null = null
  let longer = false
  for (const cmd of cmds) {
    if (isFixed(cmd.id)) continue
    for (const b of bindingsOf(cmd, overrides)) {
      const steps = stepsOf(b)
      if (!startsWith(steps, seq)) continue
      if (steps.length === seq.length) exact ??= cmd
      else longer = true
    }
  }
  if (exact) return { type: 'run', cmd: exact }
  if (longer) return { type: 'wait', pending: seq }
  if (pending.length === 0) return { type: 'none' }
  const fresh = advance(cmds, overrides, [], c)
  return fresh.type === 'none' ? { type: 'abort' } : fresh
}

const overlaps = (a: string, b: string) => {
  const x = stepsOf(a)
  const y = stepsOf(b)
  return startsWith(x, y) || startsWith(y, x)
}

/** Other commands whose bindings equal `binding` or share its start, fixed ones included. */
export function conflictsFor(
  cmds: Command[],
  overrides: Overrides,
  id: string,
  binding: string,
): Command[] {
  return cmds.filter(
    (cmd) => cmd.id !== id && bindingsOf(cmd, overrides).some((b) => overlaps(b, binding)),
  )
}

/** Every binding that equals or shadows another command's. */
export function clashingBindings(cmds: Command[], overrides: Overrides): Set<string> {
  const all = cmds.flatMap((cmd) => bindingsOf(cmd, overrides).map((b) => ({ id: cmd.id, b })))
  const out = new Set<string>()
  for (const x of all) for (const y of all) if (x.id !== y.id && overlaps(x.b, y.b)) out.add(x.b)
  return out
}

const displayStep = (c: string) => {
  const glyph = Object.entries(GLYPHS).find(([, name]) => c.endsWith(`+${name}`) || c === name)
  if (glyph) return c.slice(0, c.length - glyph[1].length) + glyph[0]
  return c.replace(/\+Plus$/, '++')
}

/** "Ctrl+K Ctrl+ArrowLeft" as "Ctrl+K Ctrl+←". */
export const display = (binding: string) => stepsOf(binding).map(displayStep).join(' ')

/** One step split into its held modifiers and the key struck. */
export function parseStep(step: string): { mods: Set<string>; key: string } {
  const pieces = step.split('+')
  const key = pieces.pop()!
  return { mods: new Set(pieces), key }
}

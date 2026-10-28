import { describe, expect, it } from 'vitest'
import type { Command } from './commands'
import {
  chord,
  commandFor,
  conflictsFor,
  display,
  firesWhileTyping,
  parseShortcut,
} from './hotkeys'

const ev = (init: Partial<KeyboardEvent>) => init as KeyboardEvent
const cmd = (id: string, shortcut?: string): Command => ({
  id,
  title: id,
  group: 'App',
  shortcut,
  candidate: { name: id },
  run: () => {},
})

describe('hotkeys', () => {
  it('names chords', () => {
    expect(chord(ev({ key: 'p', ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+P')
    expect(chord(ev({ key: ' ', ctrlKey: true }))).toBe('Ctrl+Space')
    expect(chord(ev({ key: 'Control', ctrlKey: true }))).toBeNull()
  })

  it('parses shortcut text, reordering modifiers and glyphs', () => {
    expect(parseShortcut('Ctrl+B / Ctrl+←')).toEqual(['Ctrl+B', 'Ctrl+ArrowLeft'])
    expect(parseShortcut('Shift+Alt+F')).toEqual(['Alt+Shift+F'])
    expect(parseShortcut('Ctrl+= / Ctrl+Shift+Plus')).toEqual(['Ctrl+=', 'Ctrl+Shift+Plus'])
    expect(parseShortcut(undefined)).toEqual([])
  })

  it('an override replaces the defaults, [] clears them', () => {
    const cmds = [cmd('a', 'Ctrl+A'), cmd('b', 'Ctrl+B')]
    expect(commandFor(cmds, { a: ['Ctrl+J'] }, 'Ctrl+A')).toBeNull()
    expect(commandFor(cmds, { a: ['Ctrl+J'] }, 'Ctrl+J')?.id).toBe('a')
    expect(commandFor(cmds, { b: [] }, 'Ctrl+B')).toBeNull()
  })

  it('fixed commands ignore overrides and still conflict', () => {
    const cmds = [cmd('sql:run', 'Ctrl+Enter'), cmd('x')]
    expect(commandFor(cmds, { 'sql:run': ['Ctrl+J'] }, 'Ctrl+J')).toBeNull()
    expect(conflictsFor(cmds, {}, 'x', 'Ctrl+Enter').map((c) => c.id)).toEqual(['sql:run'])
  })

  it('arrows stay out of fields', () => {
    expect(firesWhileTyping('Ctrl+ArrowRight', null)).toBe(false)
    expect(firesWhileTyping('Ctrl+Space', null)).toBe(true)
    expect(firesWhileTyping('Alt+ArrowLeft', null)).toBe(true)
  })

  it('shows arrows as glyphs', () => {
    expect(display('Ctrl+ArrowLeft')).toBe('Ctrl+←')
    expect(display('Ctrl+Shift+Plus')).toBe('Ctrl+Shift++')
  })
})

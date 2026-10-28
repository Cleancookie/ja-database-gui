import { describe, expect, it } from 'vitest'
import type { Command } from './commands'
import {
  advance,
  chord,
  clashingBindings,
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
    expect(advance(cmds, { a: ['Ctrl+J'] }, [], 'Ctrl+A').type).toBe('none')
    expect(advance(cmds, { a: ['Ctrl+J'] }, [], 'Ctrl+J')).toMatchObject({ type: 'run' })
    expect(advance(cmds, { b: [] }, [], 'Ctrl+B').type).toBe('none')
  })

  it('fixed commands ignore overrides and still conflict', () => {
    const cmds = [cmd('sql:run', 'Ctrl+Enter'), cmd('x')]
    expect(advance(cmds, { 'sql:run': ['Ctrl+J'] }, [], 'Ctrl+J').type).toBe('none')
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

  describe('chords', () => {
    const cmds = [cmd('a', 'Ctrl+K Ctrl+S'), cmd('b', 'Ctrl+K Ctrl+T'), cmd('c', 'Ctrl+J')]

    it('parses a space as the next step', () => {
      expect(parseShortcut('Ctrl+K Ctrl+S / Ctrl+B')).toEqual(['Ctrl+K Ctrl+S', 'Ctrl+B'])
      expect(display('Ctrl+K Ctrl+ArrowLeft')).toBe('Ctrl+K Ctrl+←')
    })

    it('waits on a shared first step, then runs on the second', () => {
      expect(advance(cmds, {}, [], 'Ctrl+K')).toEqual({ type: 'wait', pending: ['Ctrl+K'] })
      const r = advance(cmds, {}, ['Ctrl+K'], 'Ctrl+T')
      expect(r.type === 'run' && r.cmd.id).toBe('b')
    })

    it('a key that continues nothing abandons the chord and is tried afresh', () => {
      expect(advance(cmds, {}, ['Ctrl+K'], 'Ctrl+J')).toMatchObject({ type: 'run' })
      expect(advance(cmds, {}, ['Ctrl+K'], 'Ctrl+Q').type).toBe('abort')
    })

    it('flags a binding that shadows or equals another', () => {
      const shadow = [cmd('a', 'Ctrl+K Ctrl+S'), cmd('b', 'Ctrl+K'), cmd('c', 'Ctrl+J')]
      expect([...clashingBindings(shadow, {})].sort()).toEqual(['Ctrl+K', 'Ctrl+K Ctrl+S'])
      expect(conflictsFor(shadow, {}, 'c', 'Ctrl+K').map((x) => x.id)).toEqual(['a', 'b'])
    })
  })
})

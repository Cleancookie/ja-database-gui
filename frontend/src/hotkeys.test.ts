import { describe, expect, it } from 'vitest'
import { actionFor, chord, conflict } from './hotkeys'

const ev = (init: Partial<KeyboardEvent>) => init as KeyboardEvent

describe('hotkeys', () => {
  it('names chords', () => {
    expect(chord(ev({ key: 'p', ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+P')
    expect(chord(ev({ key: ' ', ctrlKey: true }))).toBe('Ctrl+Space')
    expect(chord(ev({ key: 'Control', ctrlKey: true }))).toBeNull()
  })
  it('fires Ctrl+Space while typing but not Ctrl+Arrow', () => {
    expect(actionFor(undefined, ev({ key: ' ', ctrlKey: true }), true)).toBe('pane.right')
    expect(actionFor(undefined, ev({ key: 'ArrowRight', ctrlKey: true }), true)).toBeNull()
    expect(actionFor(undefined, ev({ key: 'ArrowRight', ctrlKey: true }), false)).toBe('pane.right')
  })
  it('an override replaces the defaults', () => {
    const o = { 'pane.right': 'Ctrl+J' }
    expect(actionFor(o, ev({ key: ' ', ctrlKey: true }), false)).toBeNull()
    expect(actionFor(o, ev({ key: 'j', ctrlKey: true }), false)).toBe('pane.right')
  })
  it('reports a conflict', () => {
    expect(conflict(undefined, 'tab.new', 'Ctrl+W')?.id).toBe('tab.close')
    expect(conflict(undefined, 'tab.new', 'Ctrl+Q')).toBeUndefined()
  })
})

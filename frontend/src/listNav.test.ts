import { describe, expect, it } from 'vitest'
import { listMove, moveIndex } from './listNav'

const key = (k: string, mods: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}) => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
})

describe('listMove', () => {
  it('maps arrows, Home and End', () => {
    expect(listMove(key('ArrowDown'))).toBe('next')
    expect(listMove(key('ArrowUp'))).toBe('prev')
    expect(listMove(key('Home'))).toBe('first')
    expect(listMove(key('End'))).toBe('last')
  })

  it('maps Ctrl+J / Ctrl+K in either case', () => {
    expect(listMove(key('j', { ctrlKey: true }))).toBe('next')
    expect(listMove(key('K', { ctrlKey: true }))).toBe('prev')
  })

  it('leaves bare letters alone so typing still works', () => {
    expect(listMove(key('j'))).toBeNull()
    expect(listMove(key('k'))).toBeNull()
  })

  it('gives Ctrl+N / Ctrl+P only to callers that ask, and never Ctrl+Shift+P', () => {
    expect(listMove(key('n', { ctrlKey: true }))).toBeNull()
    expect(listMove(key('p', { ctrlKey: true }))).toBeNull()
    expect(listMove(key('n', { ctrlKey: true }), true)).toBe('next')
    expect(listMove(key('p', { ctrlKey: true }), true)).toBe('prev')
    expect(listMove(key('p', { ctrlKey: true, shiftKey: true }), true)).toBeNull()
  })

  it('ignores Alt, which is history navigation', () => {
    expect(listMove(key('ArrowUp', { altKey: true }))).toBeNull()
  })
})

describe('moveIndex', () => {
  it('clamps at both ends', () => {
    expect(moveIndex('next', 2, 3)).toBe(2)
    expect(moveIndex('prev', 0, 3)).toBe(0)
    expect(moveIndex('first', 2, 3)).toBe(0)
    expect(moveIndex('last', 0, 3)).toBe(2)
  })

  it('stays at 0 for an empty list', () => {
    expect(moveIndex('last', 0, 0)).toBe(0)
  })
})

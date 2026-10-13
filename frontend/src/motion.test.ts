import { afterEach, describe, expect, it, vi } from 'vitest'
import { motionScale } from './motion'

describe('motionScale', () => {
  afterEach(() => vi.unstubAllGlobals())
  const prefersReduced = (matches: boolean) =>
    vi.stubGlobal('window', { matchMedia: () => ({ matches }) })

  it('follows the OS when unset', () => {
    prefersReduced(true)
    expect(motionScale(null)).toBe(0)
    prefersReduced(false)
    expect(motionScale(null)).toBe(1)
  })

  it('lets a chosen scale override reduced motion', () => {
    prefersReduced(true)
    expect(motionScale(0.5)).toBe(0.5)
  })
})

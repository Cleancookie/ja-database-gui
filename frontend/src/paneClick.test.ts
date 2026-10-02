import { describe, expect, it } from 'vitest'
import { onScrollbar } from './paneClick'

const el = { clientWidth: 400, clientHeight: 150 }
const origin = { left: 10, top: 20 }

describe('onScrollbar', () => {
  it('is false inside the content box', () => {
    expect(onScrollbar(el, origin, 100, 100)).toBe(false)
  })
  it('is true past the right edge of the content box', () => {
    expect(onScrollbar(el, origin, 10 + 400, 100)).toBe(true)
  })
  it('is true below the content box', () => {
    expect(onScrollbar(el, origin, 100, 20 + 150)).toBe(true)
  })
})

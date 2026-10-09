import { describe, expect, it } from 'vitest'
import type { Toast } from './store'
import { GAP_PX, PEEK_PX, addToast, stackLayout } from './toasts'

function toast(over: Partial<Toast> = {}): Toast {
  return { id: 1, kind: 'error', message: 'boom', count: 1, at: 0, autoDismiss: false, ...over }
}

describe('addToast', () => {
  it('folds a repeat into the one on screen and moves it to the front', () => {
    const list = [toast(), toast({ id: 2, message: 'other' })]
    const out = addToast(list, toast({ id: 3, at: 9 }))
    expect(out.map((t) => [t.id, t.count, t.at])).toEqual([
      [2, 1, 0],
      [1, 2, 9],
    ])
  })

  it('keeps a different kind of the same message separate', () => {
    expect(addToast([toast()], toast({ id: 2, kind: 'info' }))).toHaveLength(2)
  })

  it('never folds toasts with an action — each button acts on its own thing', () => {
    const action = { label: 'Reopen', run: () => {} }
    expect(addToast([toast({ action })], toast({ id: 2, action }))).toHaveLength(2)
  })
})

describe('stackLayout', () => {
  it('collapsed, peeks the cards behind at the front card height', () => {
    const { cards, total } = stackLayout([40, 80, 60, 50], false)
    expect(cards.map((c) => [c.y, c.height, c.visible])).toEqual([
      [0, 40, true],
      [PEEK_PX, 40, true],
      [2 * PEEK_PX, 40, true],
      [3 * PEEK_PX, 40, false],
    ])
    expect(total).toBe(40 + 2 * PEEK_PX)
  })

  it('expanded, stacks every card at its own height', () => {
    const { cards, total } = stackLayout([40, 80], true)
    expect(cards.map((c) => [c.y, c.height])).toEqual([
      [0, 40],
      [40 + GAP_PX, 80],
    ])
    expect(total).toBe(120 + GAP_PX)
  })
})

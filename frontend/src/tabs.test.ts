import { describe, expect, it, vi } from 'vitest'
import { blankFields, newTab, tabTitle, visit } from './tabs'

const ref = (name: string) => ({ database: 'db', schema: '', name })

describe('tabTitle', () => {
  const base = { view: 'data' as const, activeRef: null, activeDatabase: '' }
  it('names the table on screen', () => {
    expect(tabTitle({ ...base, activeRef: ref('users') })).toBe('users')
  })
  it('calls an unpointed tab New tab', () => {
    expect(tabTitle(base)).toBe('New tab')
  })
  it('names the SQL editor after its database', () => {
    expect(tabTitle({ ...base, view: 'sql', activeDatabase: 'shop' })).toBe('SQL · shop')
    expect(tabTitle({ ...base, view: 'sql' })).toBe('SQL')
  })
})

describe('visit', () => {
  const entry = (name: string) => ({ connectionId: 'c', ref: ref(name) })
  it('appends and moves to the new entry', () => {
    let t = newTab(1, null)
    t = visit(t, entry('a'))
    t = visit(t, entry('b'))
    expect(t.history.map((h) => h.ref.name)).toEqual(['a', 'b'])
    expect(t.at).toBe(1)
  })
  it('drops forward entries after going back', () => {
    let t = newTab(1, null)
    for (const n of ['a', 'b', 'c']) t = visit(t, entry(n))
    t = { ...t, at: 0 }
    t = visit(t, entry('d'))
    expect(t.history.map((h) => h.ref.name)).toEqual(['a', 'd'])
    expect(t.at).toBe(1)
  })
  it('ignores reopening the table already shown', () => {
    let t = visit(newTab(1, null), entry('a'))
    const again = visit(t, entry('a'))
    expect(again).toBe(t)
  })
  it('caps the history', () => {
    let t = newTab(1, null)
    for (let i = 0; i < 80; i++) t = visit(t, entry(`t${i}`))
    expect(t.history.length).toBe(50)
    expect(t.history[49].ref.name).toBe('t79')
    expect(t.at).toBe(49)
  })
})

describe('blankFields', () => {
  it('carries the paging defaults and nothing else', () => {
    const f = blankFields(250, false)
    expect(f.pageSize).toBe(250)
    expect(f.paginationEnabled).toBe(false)
    expect(f.activeRef).toBeNull()
    expect(f.activeConnectionId).toBeNull()
    expect(f.view).toBe('data')
  })
})

describe('store tabs', () => {
  it('stashes and restores a tab’s fields on switch', async () => {
    vi.resetModules()
    vi.doMock('./api', () => ({ api: new Proxy({}, { get: () => async () => ({}) }), transportName: 'test' }))
    const { useStore } = await import('./store')
    const s = () => useStore.getState()

    useStore.setState({ activeRef: ref('users'), filter: 'id > 3', page: 4 })
    s().newTab()
    expect(s().tabs).toHaveLength(2)
    expect(s().activeRef).toBeNull()
    expect(s().filter).toBe('')

    const first = s().tabs[0].id
    s().switchTab(first)
    expect(s().activeRef?.name).toBe('users')
    expect(s().filter).toBe('id > 3')
    expect(s().page).toBe(4)
  })

  it('closes the active tab onto its neighbour, and the last onto a blank one', async () => {
    vi.resetModules()
    vi.doMock('./api', () => ({ api: new Proxy({}, { get: () => async () => ({}) }), transportName: 'test' }))
    const { useStore } = await import('./store')
    const s = () => useStore.getState()

    useStore.setState({ activeRef: ref('a') })
    s().newTab()
    useStore.setState({ activeRef: ref('b') })
    s().closeTab()
    expect(s().tabs).toHaveLength(1)
    expect(s().activeRef?.name).toBe('a')

    s().closeTab()
    expect(s().tabs).toHaveLength(1)
    expect(s().activeRef).toBeNull()
  })
})

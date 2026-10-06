import { describe, expect, it, vi } from 'vitest'
import {
  blankFields,
  closeOpen,
  FRESH_CONTROLS,
  neighbourOf,
  openTableKeys,
  recordPage,
  samePage,
  TAB_FIELDS,
  tabHistory,
  tabTitle,
  upsertOpen,
  type Page,
  type TabFields,
} from './tabs'
import { refKey } from './recency'

const ref = (name: string) => ({ database: 'db', schema: '', name })

describe('tabTitle', () => {
  const server = { serverHostsDatabases: true } as TabFields['capabilities']
  const file = { serverHostsDatabases: false } as TabFields['capabilities']
  it('names the connection and database', () => {
    expect(tabTitle({ activeConnectionId: 'c', activeDatabase: 'shop', capabilities: server }, 'Prod')).toBe('Prod / shop')
  })
  it('names a file connection alone', () => {
    expect(tabTitle({ activeConnectionId: 'c', activeDatabase: 'main', capabilities: file }, 'Sample')).toBe('Sample')
  })
  it('names a connection with no database chosen yet alone', () => {
    expect(tabTitle({ activeConnectionId: 'c', activeDatabase: '', capabilities: server }, 'Prod')).toBe('Prod')
  })
  it('calls an unpointed tab New tab', () => {
    expect(tabTitle({ activeConnectionId: null, activeDatabase: '', capabilities: null }, undefined)).toBe('New tab')
  })
})

describe('recordPage', () => {
  const page = (tabId: number, kind: Page['kind'], name?: string): Page => ({
    tabId,
    kind,
    connectionId: name ? 'c' : null,
    ref: name ? ref(name) : null,
    controls: null,
  })

  it('writes the page left and the page reached', () => {
    const r = recordPage([], -1, page(1, 'picker'), page(1, 'table', 'a'))
    expect(r.nav.map((p) => p.kind)).toEqual(['picker', 'table'])
    expect(r.at).toBe(1)
  })
  it('drops what was ahead after going back', () => {
    let r = recordPage([], -1, page(1, 'picker'), page(1, 'table', 'a'))
    r = recordPage(r.nav, r.at, page(1, 'table', 'a'), page(1, 'table', 'b'))
    r = { nav: r.nav, at: 1 }
    r = recordPage(r.nav, r.at, page(1, 'table', 'a'), page(1, 'sql'))
    expect(r.nav.map((p) => p.kind)).toEqual(['picker', 'table', 'sql'])
  })
  it('refreshes the page being left so it keeps its filter', () => {
    const left = { ...page(1, 'table', 'a'), controls: { filter: 'id > 3', orderBy: [], sortChosen: false, page: 2 } }
    const r = recordPage([page(1, 'table', 'a')], 0, left, page(1, 'sql'))
    expect(r.nav[0].controls?.filter).toBe('id > 3')
  })
  it('caps the record', () => {
    let r = { nav: [] as Page[], at: -1 }
    for (let i = 0; i < 150; i++) r = recordPage(r.nav, r.at, page(1, 'table', `t${i}`), page(1, 'table', `t${i + 1}`))
    expect(r.nav.length).toBe(100)
    expect(r.at).toBe(99)
  })
})

describe('samePage', () => {
  it('ignores how a table is filtered', () => {
    const a: Page = { tabId: 1, kind: 'table', connectionId: 'c', ref: ref('a'), controls: { filter: 'x', orderBy: [], sortChosen: false, page: 1 } }
    expect(samePage(a, { ...a, controls: null })).toBe(true)
  })
  it('tells tabs apart', () => {
    const a: Page = { tabId: 1, kind: 'picker', connectionId: null, ref: null, controls: null }
    expect(samePage(a, { ...a, tabId: 2 })).toBe(false)
  })
})

describe('open tables', () => {
  const open = (...names: string[]) => names.map((n) => ({ ref: ref(n), controls: FRESH_CONTROLS }))
  const names = (l: { ref: { name: string } }[]) => l.map((t) => t.ref.name)
  const filtered = { ...FRESH_CONTROLS, filter: 'id > 3' }

  it('appends a new table and updates one already open in place', () => {
    expect(names(upsertOpen(open('a'), ref('b'), FRESH_CONTROLS))).toEqual(['a', 'b'])
    const l = upsertOpen(open('a', 'b'), ref('a'), filtered)
    expect(names(l)).toEqual(['a', 'b'])
    expect(l[0].controls.filter).toBe('id > 3')
  })
  it('closes by ref', () => {
    expect(names(closeOpen(open('a', 'b', 'c'), ref('b')))).toEqual(['a', 'c'])
  })
  it('picks the next table along, else the previous, else none', () => {
    expect(neighbourOf(open('a', 'b', 'c'), ref('b'))?.ref.name).toBe('c')
    expect(neighbourOf(open('a', 'b', 'c'), ref('c'))?.ref.name).toBe('b')
    expect(neighbourOf(open('a'), ref('a'))).toBeNull()
    expect(neighbourOf(open('a'), ref('x'))).toBeNull()
  })
  it('keys open tables the way the recent list does', () => {
    expect(openTableKeys(open('a')).has(refKey('db', '', 'a'))).toBe(true)
  })
})

describe('blankFields', () => {
  it('names exactly the per-tab fields', () => {
    expect(Object.keys(blankFields(100, true)).sort()).toEqual([...TAB_FIELDS].sort())
  })

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

  it('reopens closed tabs newest first, and ignores empty ones', async () => {
    vi.resetModules()
    vi.doMock('./api', () => ({ api: new Proxy({}, { get: () => async () => ({}) }), transportName: 'test' }))
    const { useStore } = await import('./store')
    const s = () => useStore.getState()

    const opened = (name: string) => ({ activeRef: ref(name), openTables: [{ ref: ref(name), controls: FRESH_CONTROLS }] })
    useStore.setState(opened('a'))
    s().newTab()
    useStore.setState(opened('b'))
    s().newTab()
    s().closeTab()
    s().closeTab()
    s().closeTab()
    expect(s().activeRef).toBeNull()

    s().reopenTab()
    expect(s().activeRef?.name).toBe('a')
    s().reopenTab()
    expect(s().activeRef?.name).toBe('b')
    expect(s().tabs).toHaveLength(3)
    s().reopenTab()
    expect(s().tabs).toHaveLength(3)
  })
})

describe('store routes', () => {
  async function fresh() {
    vi.resetModules()
    vi.doMock('./api', () => ({ api: new Proxy({}, { get: () => async () => ({}) }), transportName: 'test' }))
    const { useStore } = await import('./store')
    useStore.setState({ activeConnectionId: 'c', activeDatabase: 'db' })
    return useStore
  }
  const table = (name: string) => ({ schema: '', name, type: 'table' as const })

  it('goes back from a table to the picker, and forward again', async () => {
    const useStore = await fresh()
    await useStore.getState().openObject(table('users'))
    expect(useStore.getState().activeRef?.name).toBe('users')

    await useStore.getState().stepHistory(-1)
    expect(useStore.getState().activeRef).toBeNull()
    expect(useStore.getState().view).toBe('data')

    await useStore.getState().stepHistory(1)
    expect(useStore.getState().activeRef?.name).toBe('users')
  })

  it('records a tab switch, so back returns to the other tab', async () => {
    const useStore = await fresh()
    await useStore.getState().openObject(table('users'))
    const first = useStore.getState().activeTabId
    useStore.getState().newTab()
    expect(useStore.getState().activeTabId).not.toBe(first)

    await useStore.getState().stepHistory(-1)
    expect(useStore.getState().activeTabId).toBe(first)
    expect(useStore.getState().activeRef?.name).toBe('users')
  })

  it('records the SQL editor as a page', async () => {
    const useStore = await fresh()
    await useStore.getState().openObject(table('users'))
    useStore.getState().setView('sql')
    await useStore.getState().stepHistory(-1)
    expect(useStore.getState().view).toBe('data')
    expect(useStore.getState().activeRef?.name).toBe('users')
  })

  it('skips pages of a closed tab', async () => {
    const useStore = await fresh()
    await useStore.getState().openObject(table('users'))
    const first = useStore.getState().activeTabId
    useStore.getState().newTab()
    const second = useStore.getState().activeTabId
    useStore.getState().switchTab(first)
    useStore.getState().closeTab(second)
    const before = useStore.getState().navAt
    await useStore.getState().stepHistory(-1)
    expect(useStore.getState().tabs.some((t) => t.id === useStore.getState().activeTabId)).toBe(true)
    expect(useStore.getState().navAt).toBeLessThan(before)
  })
})

describe('tabHistory', () => {
  const page = (tabId: number, kind: Page['kind'], name?: string): Page => ({
    tabId,
    kind,
    connectionId: name ? 'c' : null,
    ref: name ? ref(name) : null,
    controls: null,
  })
  const names = (nav: Page[], at: number, tabId: number) =>
    tabHistory(nav, at, tabId).map((v) => v.page.ref?.name ?? v.page.kind)

  it('lists earlier pages newest first, without the current one or the picker', () => {
    const nav = [page(1, 'picker'), page(1, 'table', 'a'), page(1, 'table', 'b'), page(1, 'sql')]
    expect(names(nav, 3, 1)).toEqual(['b', 'a'])
  })
  it('keeps to its own tab', () => {
    const nav = [page(1, 'table', 'a'), page(2, 'table', 'x'), page(1, 'table', 'b'), page(2, 'table', 'y')]
    expect(names(nav, 3, 1)).toEqual(['a'])
    expect(names(nav, 3, 2)).toEqual(['x'])
  })
  it('names each place once, at its latest visit', () => {
    const nav = [page(1, 'table', 'a'), page(1, 'table', 'b'), page(1, 'table', 'a'), page(1, 'sql')]
    const h = tabHistory(nav, 3, 1)
    expect(h.map((v) => [v.page.ref?.name, v.at])).toEqual([['a', 2], ['b', 1]])
  })
  it('ignores what is ahead after going back', () => {
    const nav = [page(1, 'table', 'a'), page(1, 'table', 'b'), page(1, 'table', 'c')]
    expect(names(nav, 1, 1)).toEqual(['a'])
  })
})

import { describe, expect, it, vi } from 'vitest'
import { EMPTY_EDITS, EMPTY_STAGED, tableKey } from './edits'

async function fresh() {
  vi.resetModules()
  vi.doMock('./api', () => ({ api: new Proxy({}, { get: () => async () => ({}) }), transportName: 'test' }))
  const { useStore } = await import('./store')
  useStore.setState({ activeConnectionId: 'c', activeDatabase: 'db', objects: [] })
  return useStore
}
const table = (name: string) => ({ schema: '', name, type: 'table' as const })
const ref = (name: string) => ({ database: 'db', schema: '', name })

describe('open tables', () => {
  it('lists each table opened in the tab once', async () => {
    const useStore = await fresh()
    const s = () => useStore.getState()
    await s().openObject(table('a'))
    await s().openObject(table('b'))
    await s().openObject(table('a'))
    expect(s().openTables.map((t) => t.ref.name)).toEqual(['a', 'b'])
  })

  it('brings back a table’s filter, sort and page when it is returned to', async () => {
    const useStore = await fresh()
    const s = () => useStore.getState()
    await s().openObject(table('a'))
    useStore.setState({ filter: 'id > 3', page: 2, orderBy: [{ column: 'id', desc: true }], sortChosen: true })
    await s().openObject(table('b'))
    expect(s().filter).toBe('')
    await s().openObject(table('a'))
    expect(s().filter).toBe('id > 3')
    expect(s().page).toBe(2)
    expect(s().orderBy).toEqual([{ column: 'id', desc: true }])
    expect(s().sortChosen).toBe(true)
  })

  it('closes onto the next table, then the previous, then nothing', async () => {
    const useStore = await fresh()
    const s = () => useStore.getState()
    for (const n of ['a', 'b', 'c']) await s().openObject(table(n))
    await s().openObject(table('b'))
    await s().closeOpenTable()
    expect(s().activeRef?.name).toBe('c')
    await s().closeOpenTable()
    expect(s().activeRef?.name).toBe('a')
    await s().closeOpenTable()
    expect(s().activeRef).toBeNull()
    expect(s().openTables).toEqual([])
  })

  it('closes a table that is not on screen without leaving the one that is', async () => {
    const useStore = await fresh()
    const s = () => useStore.getState()
    await s().openObject(table('a'))
    await s().openObject(table('b'))
    await s().closeOpenTable(ref('a'))
    expect(s().activeRef?.name).toBe('b')
    expect(s().openTables.map((t) => t.ref.name)).toEqual(['b'])
  })

  it('asks before closing a table with staged edits, and drops only its edits', async () => {
    const useStore = await fresh()
    const s = () => useStore.getState()
    await s().openObject(table('a'))
    const key = tableKey('c', ref('a'))
    const other = tableKey('c', ref('z'))
    const edits = { ...EMPTY_EDITS, inserts: [{ id: 1, set: {} }], nextInsertId: 2 }
    const { withStaged } = await import('./storeEdits')
    useStore.setState(
      withStaged(s(), {
        ...EMPTY_STAGED,
        tables: { [key]: { ref: ref('a'), edits }, [other]: { ref: ref('z'), edits } },
        order: [key, other],
        scope: { connectionId: 'c', database: 'db' },
      }),
    )

    await s().closeOpenTable()
    const d = s().dialog
    expect(d.kind).toBe('confirmDiscard')
    expect(s().activeRef?.name).toBe('a')
    if (d.kind !== 'confirmDiscard') return
    expect(d.count).toBe(1)
    await d.proceed()
    expect(s().activeRef).toBeNull()
    expect(s().dirtyTables.has(key)).toBe(false)
    expect(s().dirtyTables.has(other)).toBe(true)
  })

  it('keeps each tab’s open tables to itself', async () => {
    const useStore = await fresh()
    const s = () => useStore.getState()
    await s().openObject(table('a'))
    const first = s().activeTabId
    s().newTab()
    useStore.setState({ activeConnectionId: 'c', activeDatabase: 'db' })
    await s().openObject(table('x'))
    s().switchTab(first)
    expect(s().openTables.map((t) => t.ref.name)).toEqual(['a'])
  })

  it('reopens a closed tab with its open tables', async () => {
    const useStore = await fresh()
    const s = () => useStore.getState()
    await s().openObject(table('a'))
    await s().openObject(table('b'))
    s().closeTab()
    expect(s().openTables).toEqual([])
    s().reopenTab()
    expect(s().openTables.map((t) => t.ref.name)).toEqual(['a', 'b'])
    expect(s().activeRef?.name).toBe('b')
  })

  it('reopens a table that was closed when going back to it', async () => {
    const useStore = await fresh()
    const s = () => useStore.getState()
    await s().openObject(table('a'))
    await s().openObject(table('b'))
    await s().closeOpenTable(ref('a'))
    await s().stepHistory(-1)
    expect(s().activeRef?.name).toBe('a')
    expect(s().openTables.map((t) => t.ref.name)).toEqual(['b', 'a'])
  })

  it('forgets a dropped table in every tab', async () => {
    const useStore = await fresh()
    const s = () => useStore.getState()
    await s().openObject(table('a'))
    await s().openObject(table('b'))
    const first = s().activeTabId
    s().newTab()
    useStore.setState({ activeConnectionId: 'c', activeDatabase: 'db' })
    await s().openObject(table('a'))
    await s().runDrop(ref('a'), 'table')
    expect(s().activeRef).toBeNull()
    expect(s().openTables).toEqual([])
    const saved = s().tabs.find((t) => t.id === first)?.saved
    expect(saved?.openTables.map((t) => t.ref.name)).toEqual(['b'])
  })

  it('forgets the open tables of a disconnected connection', async () => {
    const useStore = await fresh()
    const s = () => useStore.getState()
    await s().openObject(table('a'))
    await s().disconnect('c')
    expect(s().openTables).toEqual([])
  })
})

describe('openWorkspace', () => {
  async function server() {
    vi.resetModules()
    const api = {
      connect: async (_id: string, _pw: string | null, database: string) => ({
        capabilities: { serverHostsDatabases: true },
        databases: [{ name: 'one' }, { name: 'two' }],
        defaultDatabase: database || 'one',
      }),
      listObjects: async () => [],
    }
    vi.doMock('./api', () => ({
      api: new Proxy(api, { get: (t, k) => (t as Record<string | symbol, unknown>)[k] ?? (async () => ({})) }),
      errorMessage: String,
      transportName: 'test',
    }))
    const { useStore } = await import('./store')
    useStore.setState({ connections: [{ id: 'c', name: 'C', kind: 'postgres' }] })
    return useStore
  }

  it('uses the current tab while it has no database', async () => {
    const useStore = await server()
    const s = () => useStore.getState()
    await s().openWorkspace('c')
    expect(s().tabs).toHaveLength(1)
    expect(s().activeConnectionId).toBe('c')
    expect(s().activeDatabase).toBe('')
    await s().openWorkspace('c', 'two')
    expect(s().tabs).toHaveLength(1)
    expect(s().activeDatabase).toBe('two')
  })

  it('opens a new tab for another database once the tab has one', async () => {
    const useStore = await server()
    const s = () => useStore.getState()
    await s().openWorkspace('c', 'one')
    const first = s().activeTabId
    await s().openWorkspace('c', 'one')
    expect(s().tabs).toHaveLength(1)
    await s().openWorkspace('c', 'two')
    expect(s().tabs).toHaveLength(2)
    expect(s().activeTabId).not.toBe(first)
    expect(s().activeDatabase).toBe('two')
    expect(s().tabs.find((t) => t.id === first)?.saved?.activeDatabase).toBe('one')
  })
})

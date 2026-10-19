import { describe, expect, it, vi } from 'vitest'
import { EMPTY_EDITS, EMPTY_STAGED, tableKey } from './edits'

async function fresh() {
  vi.resetModules()
  vi.doMock('./api', () => ({
    api: new Proxy({}, { get: () => async () => ({}) }),
    transportName: 'test',
  }))
  const { useStore } = await import('./store')
  useStore.setState({ activeConnectionId: 'c', activeDatabase: 'db', objects: [] })
  return useStore
}
const table = (name: string) => ({ schema: '', name, type: 'table' as const })
const ref = (name: string) => ({ database: 'db', schema: '', name })

describe('table tabs', () => {
  it('opens a table in the empty tab it is opened from', async () => {
    const useStore = await fresh()
    const s = () => useStore.getState()
    await s().openObject(table('a'))
    expect(s().tabs).toHaveLength(1)
    expect(s().activeRef?.name).toBe('a')
  })

  it('opens another table in a new tab on the same database', async () => {
    const useStore = await fresh()
    const s = () => useStore.getState()
    await s().openObject(table('a'))
    const first = s().activeTabId
    await s().openObject(table('b'))
    expect(s().tabs).toHaveLength(2)
    expect(s().activeTabId).not.toBe(first)
    expect(s().activeRef?.name).toBe('b')
    expect(s().activeDatabase).toBe('db')
    expect(s().tabs.find((t) => t.id === first)?.saved?.activeRef?.name).toBe('a')
  })

  it('switches to the tab a table is already open in', async () => {
    const useStore = await fresh()
    const s = () => useStore.getState()
    await s().openObject(table('a'))
    const first = s().activeTabId
    await s().openObject(table('b'))
    await s().openObject(table('a'))
    expect(s().tabs).toHaveLength(2)
    expect(s().activeTabId).toBe(first)
  })

  it('brings back a table’s filter, sort and page when it is returned to', async () => {
    const useStore = await fresh()
    const s = () => useStore.getState()
    await s().openObject(table('a'))
    useStore.setState({
      filter: 'id > 3',
      page: 2,
      orderBy: [{ column: 'id', desc: true }],
      sortChosen: true,
    })
    await s().openObject(table('b'))
    expect(s().filter).toBe('')
    await s().openObject(table('a'))
    expect(s().filter).toBe('id > 3')
    expect(s().page).toBe(2)
    expect(s().orderBy).toEqual([{ column: 'id', desc: true }])
    expect(s().sortChosen).toBe(true)
  })

  it('opens the SQL editor in an empty tab, else in a new tab on the same database', async () => {
    const useStore = await fresh()
    const s = () => useStore.getState()
    s().openSql()
    expect(s().tabs).toHaveLength(1)
    expect(s().view).toBe('sql')
    s().openSql()
    expect(s().tabs).toHaveLength(1)
    await s().openObject(table('a'))
    expect(s().tabs).toHaveLength(2)
    s().openSql()
    expect(s().tabs).toHaveLength(3)
    expect(s().view).toBe('sql')
    expect(s().activeRef).toBeNull()
    expect(s().activeDatabase).toBe('db')
  })

  it('opens the details of a table in that table’s tab', async () => {
    const useStore = await fresh()
    const s = () => useStore.getState()
    await s().openObject(table('a'))
    const first = s().activeTabId
    await s().openObject(table('b'))
    await s().openDetails(ref('a'))
    expect(s().activeTabId).toBe(first)
    expect(s().view).toBe('details')
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

  it('reopens a closed tab with its table', async () => {
    const useStore = await fresh()
    const s = () => useStore.getState()
    await s().openObject(table('a'))
    await s().openObject(table('b'))
    s().closeTab()
    expect(s().activeRef?.name).toBe('a')
    s().reopenTab()
    expect(s().activeRef?.name).toBe('b')
  })

  it('forgets a dropped table in every tab', async () => {
    const useStore = await fresh()
    const s = () => useStore.getState()
    await s().openObject(table('a'))
    const first = s().activeTabId
    await s().openObject(table('b'))
    await s().runDrop(ref('a'), 'table')
    expect(s().activeRef?.name).toBe('b')
    expect(s().tabs.find((t) => t.id === first)?.saved?.activeRef).toBeNull()
    s().switchTab(first)
    await s().runDrop(ref('a'), 'table')
    expect(s().activeRef).toBeNull()
  })

  it('forgets the table of a disconnected connection', async () => {
    const useStore = await fresh()
    const s = () => useStore.getState()
    await s().openObject(table('a'))
    await s().disconnect('c')
    expect(s().activeRef).toBeNull()
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
      api: new Proxy(api, {
        get: (t, k) => (t as Record<string | symbol, unknown>)[k] ?? (async () => ({})),
      }),
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

  it('shows the view it is asked for in the new tab', async () => {
    const useStore = await server()
    const s = () => useStore.getState()
    await s().openWorkspace('c', 'one')
    await s().openWorkspace('c', 'two', 'sql')
    expect(s().view).toBe('sql')
    await s().openWorkspace('c', 'one')
    expect(s().view).toBe('data')
  })
})

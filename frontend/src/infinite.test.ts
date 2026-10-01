import { describe, expect, it, vi } from 'vitest'

describe('infinite scroll', () => {
  // A table of 250 rows, served the way the API serves it: the requested page,
  // plus whether any more follow.
  const TOTAL = 250
  async function fresh(infiniteScroll: boolean, keyset = true) {
    vi.resetModules()
    const calls: { page: number; pageSize: number; after?: unknown }[] = []
    vi.doMock('./api', () => ({
      transportName: 'test',
      api: new Proxy(
        {
          readRows: async (req: {
            pagination: { page: number; pageSize: number }
            after?: { values: number[] }
          }) => {
            const { page, pageSize } = req.pagination
            calls.push({ page, pageSize, ...(req.after ? { after: req.after } : {}) })
            // By position the next page starts after the last id seen; by offset
            // it is counted from the top. Ids here are the row numbers.
            const from = req.after ? req.after.values[0] + 1 : (page - 1) * pageSize
            const rows = Array.from({ length: Math.max(0, Math.min(pageSize, TOTAL - from)) }, (_, i) => [
              { v: String(from + i) },
            ])
            return {
              result: { columns: [{ name: 'id' }], rows, truncated: false, textCap: 0, truncatedCells: [], elapsedMs: 1, query: '' },
              columns: [],
              editKey: ['id'],
              readOnlyReason: '',
              hasMore: from + pageSize < TOTAL,
              next:
                keyset && from + pageSize < TOTAL
                  ? { columns: ['id'], values: [from + pageSize - 1] }
                  : null,
            }
          },
        },
        { get: (t, k) => (k in t ? (t as never)[k] : async () => ({})) },
      ),
    }))
    const { useStore } = await import('./store')
    useStore.setState({
      activeConnectionId: 'c',
      activeDatabase: 'db',
      pageSize: 100,
      settings: { ...useStore.getState().settings, infiniteScroll, rowCap: 100000, autoCount: false },
    })
    return { useStore, calls }
  }
  const table = { schema: '', name: 'big', type: 'table' as const }

  it('appends the next page and keeps the rows already loaded', async () => {
    const { useStore, calls } = await fresh(true)
    await useStore.getState().openObject(table)
    expect(useStore.getState().result?.rows).toHaveLength(100)
    expect(useStore.getState().hasMore).toBe(true)

    await useStore.getState().loadMore()
    expect(useStore.getState().result?.rows).toHaveLength(200)
    expect(useStore.getState().page).toBe(2)
    // Asked for by position: the rows after the last one, not "page 2".
    expect(calls.at(-1)).toEqual({ page: 1, pageSize: 100, after: { columns: ['id'], values: [99] } })

    await useStore.getState().loadMore()
    expect(useStore.getState().result?.rows).toHaveLength(250)
    expect(useStore.getState().hasMore).toBe(false)

    await useStore.getState().loadMore()
    expect(calls).toHaveLength(3)
  })

  it('falls back to counting pages when the sort cannot be read by position', async () => {
    const { useStore, calls } = await fresh(true, false)
    await useStore.getState().openObject(table)
    expect(useStore.getState().nextCursor).toBeNull()
    await useStore.getState().loadMore()
    expect(calls.at(-1)).toEqual({ page: 2, pageSize: 100 })
    expect(useStore.getState().result?.rows).toHaveLength(200)
  })

  it('starts the cursor over with a new sort', async () => {
    const { useStore, calls } = await fresh(true)
    await useStore.getState().openObject(table)
    await useStore.getState().loadMore()
    await useStore.getState().toggleSort('id')
    expect(calls.at(-1)).not.toHaveProperty('after')
  })

  it('keeps the loaded pages on a refresh by asking for them all at once', async () => {
    const { useStore, calls } = await fresh(true)
    await useStore.getState().openObject(table)
    await useStore.getState().loadMore()
    await useStore.getState().reload()
    expect(calls.at(-1)).toEqual({ page: 1, pageSize: 200 })
    expect(useStore.getState().result?.rows).toHaveLength(200)
  })

  it('starts over from the first page when the sort changes', async () => {
    const { useStore, calls } = await fresh(true)
    await useStore.getState().openObject(table)
    await useStore.getState().loadMore()
    await useStore.getState().toggleSort('id')
    expect(calls.at(-1)).toEqual({ page: 1, pageSize: 100 })
    expect(useStore.getState().result?.rows).toHaveLength(100)
  })

  it('does nothing when switched off, and setPage still pages', async () => {
    const { useStore, calls } = await fresh(false)
    await useStore.getState().openObject(table)
    await useStore.getState().loadMore()
    expect(calls).toHaveLength(1)
    await useStore.getState().setPage(2)
    expect(useStore.getState().result?.rows).toHaveLength(100)
    expect(calls.at(-1)).toEqual({ page: 2, pageSize: 100 })
  })

  it('does not turn pages by hand', async () => {
    const { useStore, calls } = await fresh(true)
    await useStore.getState().openObject(table)
    await useStore.getState().setPage(2)
    expect(calls).toHaveLength(1)
  })
})

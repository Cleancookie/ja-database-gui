import { describe, expect, it, vi } from 'vitest'

describe('count rows on demand', () => {
  async function fresh() {
    vi.resetModules()
    const counted: string[] = []
    vi.doMock('./api', () => ({
      transportName: 'test',
      api: new Proxy(
        {
          readRows: async () => ({
            result: {
              columns: [{ name: 'id' }],
              rows: [[{ v: '1' }]],
              truncated: false,
              textCap: 0,
              truncatedCells: [],
              elapsedMs: 1,
              query: '',
            },
            columns: [],
            editKey: ['id'],
            readOnlyReason: '',
            hasMore: true,
            next: null,
          }),
          countRows: async (req: { filter: string }) => {
            counted.push(req.filter)
            return 42
          },
        },
        { get: (t, k) => (k in t ? (t as never)[k] : async () => ({})) },
      ),
    }))
    const { useStore } = await import('./store')
    useStore.setState({
      activeConnectionId: 'c',
      activeDatabase: 'db',
      settings: { ...useStore.getState().settings, autoCount: false },
    })
    return { useStore, counted }
  }
  const table = { schema: '', name: 't', type: 'table' as const }

  it('counts only when asked and keeps the total across pages', async () => {
    const { useStore, counted } = await fresh()
    await useStore.getState().openObject(table)
    expect(counted).toEqual([])
    expect(useStore.getState().totalCount).toBeNull()

    await useStore.getState().countRows()
    expect(counted).toEqual([''])
    expect(useStore.getState().totalCount).toBe(42)

    await useStore.getState().setPage(2)
    expect(useStore.getState().totalCount).toBe(42)
  })

  it('drops the total when the filter changes', async () => {
    const { useStore } = await fresh()
    await useStore.getState().openObject(table)
    await useStore.getState().countRows()
    await useStore.getState().applyFilter('id > 1')
    expect(useStore.getState().totalCount).toBeNull()
  })
})

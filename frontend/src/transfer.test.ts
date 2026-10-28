import { describe, expect, it } from 'vitest'
import { buildTransfer, newConnections, parseTransfer } from './transfer'
import type { Connection, Settings } from './types'

const settings = {
  theme: 'dark',
  fontSizePx: 16,
  autoCount: true,
  hotkeys: { 'tab:new': ['Ctrl+J'] },
} as unknown as Settings
const conn = (name: string): Connection =>
  ({ id: 'x1', name, kind: 'postgres', host: 'h', createdAt: 't' }) as Connection

describe('transfer', () => {
  it('exports only the chosen sections, without ids or timestamps', () => {
    const t = buildTransfer(['settings', 'connections'], settings, [conn('a')])
    expect(t.settings).not.toHaveProperty('hotkeys')
    expect(t.hotkeys).toBeUndefined()
    expect(t.connections?.[0]).toEqual({ name: 'a', kind: 'postgres', host: 'h' })
  })

  it('round-trips', () => {
    const text = JSON.stringify(
      buildTransfer(['settings', 'hotkeys', 'connections'], settings, [conn('a')]),
    )
    const back = parseTransfer(text, settings)
    expect(back.settings).toEqual({ theme: 'dark', fontSizePx: 16, autoCount: true })
    expect(back.hotkeys).toEqual({ 'tab:new': ['Ctrl+J'] })
    expect(back.connections?.[0]).toMatchObject({ id: '', name: 'a' })
  })

  it('drops unknown keys and wrong types, and rejects other files', () => {
    const text = JSON.stringify({
      app: 'ja-db',
      settings: { fontSizePx: 'big', evil: 1, theme: 'x' },
    })
    expect(parseTransfer(text, settings).settings).toEqual({ theme: 'x' })
    expect(() => parseTransfer('{}', settings)).toThrow('Not a ja-db export')
    expect(() => parseTransfer('nope', settings)).toThrow('Not a JSON file')
  })

  it('skips connections already present', () => {
    expect(newConnections([conn('a'), conn('b')], [conn('a')]).map((c) => c.name)).toEqual(['b'])
  })
})

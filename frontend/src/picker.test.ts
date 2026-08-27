import { describe, expect, it } from 'vitest'
import { pickerModel, type PickerState } from './picker'

const base: PickerState = {
  connections: [
    { id: 'a', name: 'local mysql' },
    { id: 'b', name: 'prod' },
  ],
  activeConnectionId: null,
  capabilities: null,
  databases: [],
  activeDatabase: '',
}

const server = { serverHostsDatabases: true }
const file = { serverHostsDatabases: false }

describe('pickerModel, with no connection open', () => {
  // The whole point of the change: land in the editor cold and the header
  // still tells you what to do, instead of hiding itself.
  it('offers the connections', () => {
    const m = pickerModel(base)
    expect(m.kind).toBe('connections')
    expect(m.options).toEqual([
      { value: 'a', label: 'local mysql' },
      { value: 'b', label: 'prod' },
    ])
    expect(m.value).toBe('')
  })

  it('says it is not connected', () => {
    expect(pickerModel(base).placeholder).toBe('Not connected')
  })

  it('asks for a connection when none is saved', () => {
    const m = pickerModel({ ...base, connections: [] })
    expect(m.options).toEqual([])
    expect(m.placeholder).toBe('No connections')
  })
})

describe('pickerModel, connected to a server', () => {
  const connected: PickerState = {
    ...base,
    activeConnectionId: 'a',
    capabilities: server,
    databases: ['app', 'app_test'],
    activeDatabase: 'app',
  }

  it('offers the databases with the active one selected', () => {
    const m = pickerModel(connected)
    expect(m.kind).toBe('databases')
    expect(m.options).toEqual([
      { value: 'app', label: 'app' },
      { value: 'app_test', label: 'app_test' },
    ])
    expect(m.value).toBe('app')
  })

  // connect() auto-picks one, so this is the unusual case — a server that
  // reported no databases at all.
  it('prompts when nothing is selected', () => {
    const m = pickerModel({ ...connected, activeDatabase: '' })
    expect(m.value).toBe('')
    expect(m.placeholder).toBe('Choose a database')
  })
})

describe('pickerModel, connected to a file', () => {
  // SQLite has no databases — serverHostsDatabases is how the rest of the app
  // decides this too, and a dropdown of nothing would be a lie.
  it('names the connection instead of offering a dropdown', () => {
    const m = pickerModel({ ...base, activeConnectionId: 'b', capabilities: file })
    expect(m.kind).toBe('static')
    expect(m.options).toEqual([])
    expect(m.placeholder).toBe('prod')
  })
})

describe('pickerModel, mid-connect', () => {
  // capabilities arrive with the connect response, so there is a moment with
  // an id and no answer about dialects yet.
  it('says so rather than guessing', () => {
    const m = pickerModel({ ...base, activeConnectionId: 'a' })
    expect(m.kind).toBe('static')
    expect(m.placeholder).toBe('Connecting…')
  })
})

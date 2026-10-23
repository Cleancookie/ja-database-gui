import { describe, expect, it } from 'vitest'
import { pickerModel, type PickerState } from './picker'

const base: PickerState = {
  activeConnectionId: null,
  capabilities: null,
  databases: [],
  activeDatabase: '',
}

const server = { serverHostsDatabases: true }
const file = { serverHostsDatabases: false }

describe('pickerModel, with no connection open', () => {
  // The server dropdown beside it is the whole choice.
  it('shows nothing', () => {
    expect(pickerModel(base).kind).toBe('none')
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
  // decides this too, and a dropdown of nothing would be a lie. The server
  // dropdown already names the file.
  it('shows nothing beside the server', () => {
    const m = pickerModel({ ...base, activeConnectionId: 'b', capabilities: file })
    expect(m.kind).toBe('none')
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

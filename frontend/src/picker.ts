/**
 * What the SQL editor's header picker should show.
 *
 * The header used to render a read-only chip, and only when a database was
 * already chosen — so arriving in the editor with nothing connected gave you
 * no database, no dropdown and no hint that the sidebar was where to go. The
 * picker is always present instead, and adapts: databases when there are
 * databases to choose, connections when there is not yet a connection.
 *
 * Pure so the dialect rules are tested without a DOM; `components/
 * DatabasePicker.tsx` is only the `<select>` around it.
 */

/** The slice of the store the picker depends on — narrow on purpose. */
export interface PickerState {
  connections: { id: string; name: string }[]
  activeConnectionId: string | null
  capabilities: { serverHostsDatabases: boolean } | null
  databases: string[]
  activeDatabase: string
}

export interface PickerOption {
  value: string
  label: string
}

export interface PickerModel {
  /**
   * What choosing an option means: `connections` connects, `databases`
   * switches database, `static` is not a dropdown at all.
   */
  kind: 'connections' | 'databases' | 'static'
  options: PickerOption[]
  /** '' when nothing is chosen, which is when the placeholder shows. */
  value: string
  /** The empty-selection label — and the whole label when kind is `static`. */
  placeholder: string
}

export function pickerModel(s: PickerState): PickerModel {
  if (!s.activeConnectionId) {
    return {
      kind: 'connections',
      options: s.connections.map((c) => ({ value: c.id, label: c.name })),
      value: '',
      placeholder: s.connections.length === 0 ? 'No connections' : 'Not connected',
    }
  }

  // capabilities arrive with the connect response, so there is a window with an
  // id and nothing yet known about the dialect. Saying so beats offering an
  // empty list of databases that is about to be filled.
  if (!s.capabilities) {
    return { kind: 'static', options: [], value: '', placeholder: 'Connecting…' }
  }

  // SQLite: one file, no databases. The same flag gates the sidebar's database
  // section and the database entries in the palette.
  if (!s.capabilities.serverHostsDatabases) {
    const name = s.connections.find((c) => c.id === s.activeConnectionId)?.name ?? ''
    return { kind: 'static', options: [], value: '', placeholder: name }
  }

  return {
    kind: 'databases',
    options: s.databases.map((d) => ({ value: d, label: d })),
    value: s.activeDatabase,
    placeholder: 'Choose a database',
  }
}

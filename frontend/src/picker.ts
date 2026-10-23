/**
 * What the SQL editor's header picker should show.
 *
 * The header used to render a read-only chip, and only when a database was
 * already chosen — so arriving in the editor with nothing connected gave you
 * no database, no dropdown and no hint that the sidebar was where to go. The
 * server dropdown is always present instead; this models the control beside
 * it: databases when the server has them to choose, nothing otherwise.
 *
 * Pure so the dialect rules are tested without a DOM; `components/
 * DatabasePicker.tsx` is only the `<select>` around it.
 */

/** The slice of the store the picker depends on — narrow on purpose. */
export interface PickerState {
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
   * `databases` switches database, `static` is a label, `none` shows nothing
   * beside the server dropdown.
   */
  kind: 'databases' | 'static' | 'none'
  options: PickerOption[]
  /** '' when nothing is chosen, which is when the placeholder shows. */
  value: string
  /** The empty-selection label — and the whole label when kind is `static`. */
  placeholder: string
}

const NONE: PickerModel = { kind: 'none', options: [], value: '', placeholder: '' }

export function pickerModel(s: PickerState): PickerModel {
  if (!s.activeConnectionId) return NONE

  // capabilities arrive with the connect response, so there is a window with an
  // id and nothing yet known about the dialect. Saying so beats offering an
  // empty list of databases that is about to be filled.
  if (!s.capabilities) {
    return { kind: 'static', options: [], value: '', placeholder: 'Connecting…' }
  }

  // SQLite: one file, no databases; the server dropdown already names it. The
  // same flag gates the sidebar's database section and the palette's entries.
  if (!s.capabilities.serverHostsDatabases) return NONE

  return {
    kind: 'databases',
    options: s.databases.map((d) => ({ value: d, label: d })),
    value: s.activeDatabase,
    placeholder: 'Choose a database',
  }
}

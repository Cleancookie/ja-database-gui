import { useStore } from '../../store'
import { pickerClass } from '../DatabasePicker'

/**
 * Where TABLES is: the connection, and on a server its database. Choosing one
 * only changes what is listed; no tab moves or opens.
 */
export function BrowsePicker() {
  const connections = useStore((s) => s.connections)
  const connectionId = useStore((s) => s.browseConnectionId)
  const capabilities = useStore((s) => s.browseCapabilities)
  const databases = useStore((s) => s.browseDatabases)
  const database = useStore((s) => s.browseDatabase)
  const browse = useStore((s) => s.browse)

  if (!connectionId) return null
  const name = connections.find((c) => c.id === connectionId)?.name
  const hosts = !!capabilities?.serverHostsDatabases

  return (
    <>
      <span className="min-w-0 truncate text-[var(--color-faint)]">
        {name}
        {hosts && ' /'}
      </span>
      {hosts && (
        <select
          id="sidebar-database-picker"
          aria-label="Database to list"
          title="Which database's tables are listed"
          value={database}
          onChange={(e) => {
            if (e.target.value) void browse(connectionId, e.target.value)
          }}
          className={pickerClass(database === '')}
        >
          {database === '' && <option value="">Choose a database</option>}
          {databases.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      )}
    </>
  )
}

import { useStore } from '../../store'
import { pickerClass } from '../DatabasePicker'

/**
 * Where TABLES is: a server, and on one that hosts several its database.
 * Choosing either only changes what is listed; no tab moves or opens.
 */
export function BrowsePicker() {
  const connections = useStore((s) => s.connections)
  const connectionId = useStore((s) => s.browseConnectionId)
  const capabilities = useStore((s) => s.browseCapabilities)
  const databases = useStore((s) => s.browseDatabases)
  const database = useStore((s) => s.browseDatabase)
  const browse = useStore((s) => s.browse)

  if (connections.length === 0) return null
  const colour = connections.find((c) => c.id === connectionId)?.colour

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <span
        aria-hidden
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ background: colour || 'var(--color-border-strong)' }}
      />
      <select
        id="sidebar-server-picker"
        aria-label="Server to list"
        title="Whose tables are listed"
        value={connectionId ?? ''}
        onChange={(e) => {
          if (e.target.value) void browse(e.target.value)
        }}
        className={`min-w-0 flex-1 ${pickerClass(!connectionId)}`}
      >
        {!connectionId && <option value="">Choose a server</option>}
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      {connectionId && capabilities?.serverHostsDatabases && (
        <select
          id="sidebar-database-picker"
          aria-label="Database to list"
          title="Which database's tables are listed"
          value={database}
          onChange={(e) => {
            if (e.target.value) void browse(connectionId, e.target.value)
          }}
          className={`min-w-0 flex-1 ${pickerClass(database === '')}`}
        >
          {database === '' && <option value="">Choose a database</option>}
          {databases.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

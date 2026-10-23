import { DATABASE_PICKER_ID, SERVER_PICKER_ID } from '../commands'
import { useStore, type View } from '../store'
import { pickerModel } from '../picker'

/** A header `<select>`, warning-coloured while nothing is chosen. */
export function pickerClass(unchosen: boolean): string {
  return `max-w-[14rem] rounded-lg border border-[var(--color-border)] bg-[var(--color-elevated)] px-1.5 py-0.5 font-[var(--font-mono)] shadow-xs outline-none ${
    unchosen ? 'text-[var(--color-warn)]' : 'text-[var(--color-muted)]'
  }`
}

/**
 * Which server and database the statement runs against, and a way to change
 * either. Mirrors the sidebar's BrowsePicker, except a choice here opens the
 * editor on it rather than only changing what TABLES lists.
 *
 * Native `<select>`s, deliberately: `ui/README.md` keeps `<select>` out of the
 * adapter layer because the element is already keyboard-accessible, and these
 * are on the path to running a query, so they should behave exactly as the
 * platform's do.
 *
 * The database-side decisions are in `picker.ts`; this only renders them.
 */
export function DatabasePicker({
  view,
}: {
  /** What a tab opened on another database shows. */
  view?: View
}) {
  const connections = useStore((s) => s.connections)
  const activeConnectionId = useStore((s) => s.activeConnectionId)
  const capabilities = useStore((s) => s.capabilities)
  const databases = useStore((s) => s.databases)
  const activeDatabase = useStore((s) => s.activeDatabase)
  const openWorkspace = useStore((s) => s.openWorkspace)
  const setDialog = useStore((s) => s.setDialog)

  // With nothing saved there is nothing to pick, so the control becomes the
  // one action that helps.
  if (connections.length === 0) {
    return (
      <button
        onClick={() => setDialog({ kind: 'connection', connection: null })}
        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-elevated)] px-2 py-0.5 text-[var(--color-muted)] shadow-xs hover:border-[var(--color-accent)]"
      >
        New connection…
      </button>
    )
  }

  const model = pickerModel({ activeConnectionId, capabilities, databases, activeDatabase })
  const onDatabases = model.kind === 'databases'

  return (
    <>
      <select
        id={SERVER_PICKER_ID}
        aria-label="Server"
        title="Statements run on this server"
        value={activeConnectionId ?? ''}
        onChange={(e) => {
          const v = e.target.value
          if (v && v !== activeConnectionId) void openWorkspace(v, '', view)
        }}
        className={pickerClass(!activeConnectionId)}
      >
        {!activeConnectionId && <option value="">Not connected</option>}
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      {model.kind === 'static' && (
        <span className="max-w-[12rem] truncate rounded-lg bg-[var(--color-elevated)] px-1.5 py-0.5 font-[var(--font-mono)] text-[var(--color-muted)]">
          {model.placeholder}
        </span>
      )}
      {onDatabases && activeConnectionId && (
        <select
          id={DATABASE_PICKER_ID}
          aria-label="Database"
          title="Statements run against this database"
          value={model.value}
          onChange={(e) => {
            const v = e.target.value
            if (v) void openWorkspace(activeConnectionId, v, view)
          }}
          className={pickerClass(model.value === '')}
        >
          {/* Only while nothing is chosen: once it is, an empty entry is a way to
              select nothing, which no statement can run against. */}
          {model.value === '' && <option value="">{model.placeholder}</option>}
          {model.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </>
  )
}

import { DATABASE_PICKER_ID } from '../commands'
import { useStore, type View } from '../store'
import { pickerModel } from '../picker'

/** A header `<select>`, warning-coloured while nothing is chosen. */
export function pickerClass(unchosen: boolean): string {
  return `max-w-[14rem] rounded-lg border border-[var(--color-border)] bg-[var(--color-elevated)] px-1.5 py-0.5 font-[var(--font-mono)] shadow-xs outline-none ${
    unchosen ? 'text-[var(--color-warn)]' : 'text-[var(--color-muted)]'
  }`
}

/**
 * Which database the statement runs against, and a way to change it.
 *
 * A native `<select>`, deliberately: `ui/README.md` keeps `<select>` out of the
 * adapter layer because the element is already keyboard-accessible, and this
 * one is on the path to running a query, so it should behave exactly as the
 * platform's does.
 *
 * All the decisions are in `picker.ts`; this only renders them.
 */
export function DatabasePicker({
  id = DATABASE_PICKER_ID,
  view,
}: {
  id?: string
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

  const model = pickerModel({
    connections,
    activeConnectionId,
    capabilities,
    databases,
    activeDatabase,
  })

  // Connected to a file — there is nothing to choose. The connection name
  // still shows, because "what am I about to run this against" is the question
  // the header is answering either way.
  if (model.kind === 'static') {
    return (
      <span
        title="Statements run against this connection"
        className="max-w-[12rem] truncate rounded-lg bg-[var(--color-elevated)] px-1.5 py-0.5 font-[var(--font-mono)] text-[var(--color-muted)]"
      >
        {model.placeholder}
      </span>
    )
  }

  // With nothing saved there is nothing to pick, so the control becomes the
  // one action that helps.
  if (model.kind === 'connections' && model.options.length === 0) {
    return (
      <button
        id={id}
        onClick={() => setDialog({ kind: 'connection', connection: null })}
        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-elevated)] px-2 py-0.5 text-[var(--color-muted)] shadow-xs hover:border-[var(--color-accent)]"
      >
        New connection…
      </button>
    )
  }

  const onDatabases = model.kind === 'databases'

  return (
    <select
      id={id}
      aria-label={onDatabases ? 'Database' : 'Connection'}
      title={
        onDatabases
          ? 'Statements run against this database'
          : 'Connect — the database is then chosen for you'
      }
      value={model.value}
      onChange={(e) => {
        const v = e.target.value
        if (v === '') return
        void (onDatabases && activeConnectionId
          ? openWorkspace(activeConnectionId, v, view)
          : openWorkspace(v, '', view))
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
  )
}

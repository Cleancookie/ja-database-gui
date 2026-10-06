import { useEffect, useMemo, useState } from 'react'
import { api, errorMessage } from '../api'
import { useActiveKind, useHasSchemas, useStore } from '../store'
import { dialogButton, FormDialog } from '../ui'
import type { NewColumn } from '../types'

/**
 * The new-table dialog.
 *
 * The type field is free text with the dialect's usual spellings offered as
 * suggestions, rather than a closed list. Types are where the four dialects
 * disagree most and the disagreement does not stop at names — `numeric(10,2)`,
 * `nvarchar(max)`, `bigint AUTO_INCREMENT` — so a fixed list would be a
 * permanent source of "the type I want is not in the dropdown". The Go side
 * treats the value as a raw fragment on the same terms as the row filter.
 *
 * The statement is rendered by the driver, not assembled here: quoting and the
 * one dialect that cannot use a database-qualified CREATE are its business, and
 * a preview built by different code from the one that runs would be a lie.
 */
export function NewTableDialog({ schema }: { schema: string }) {
  const setDialog = useStore((s) => s.setDialog)
  const createTable = useStore((s) => s.createTable)
  const connectionId = useStore((s) => s.activeConnectionId)
  const database = useStore((s) => s.activeDatabase)
  const objects = useStore((s) => s.objects)
  const drivers = useStore((s) => s.drivers)
  const kind = useActiveKind()
  const hasSchemas = useHasSchemas()

  const [name, setName] = useState('')
  const [target, setTarget] = useState(schema)
  const [columns, setColumns] = useState<NewColumn[]>(() => [blankColumn(), blankColumn()])
  const [preview, setPreview] = useState('')
  const [previewError, setPreviewError] = useState('')
  const [creating, setCreating] = useState(false)

  const types = (kind && drivers?.[kind]?.commonTypes) || []

  // The schemas already in use, so the common case is a pick rather than a
  // spelling. Still an editable field: a brand-new schema has no objects in it
  // and so would never appear in this list.
  const schemas = useMemo(
    () => Array.from(new Set(objects.map((o) => o.schema).filter(Boolean))).sort(),
    [objects],
  )

  const spec = useMemo(
    () => ({
      ref: { database, schema: hasSchemas ? target.trim() : '', name: name.trim() },
      columns: columns.filter((c) => c.name.trim() !== '' || c.type.trim() !== ''),
    }),
    [database, hasSchemas, target, name, columns],
  )

  const complete =
    spec.ref.name !== '' &&
    spec.columns.length > 0 &&
    spec.columns.every((c) => c.name.trim() !== '' && c.type.trim() !== '')

  // Asking the driver on every edit rather than debouncing: the call runs no
  // SQL and does not even need the connection to be open, so it costs less than
  // the timer would.
  useEffect(() => {
    if (!connectionId || !complete) {
      setPreview('')
      setPreviewError('')
      return
    }
    let live = true
    void api
      .previewCreateTable({ connectionId, spec })
      .then((sql) => {
        if (live) {
          setPreview(sql)
          setPreviewError('')
        }
      })
      .catch((e) => {
        if (live) {
          setPreview('')
          setPreviewError(errorMessage(e))
        }
      })
    return () => {
      live = false
    }
  }, [connectionId, complete, spec])

  const patchColumn = (i: number, p: Partial<NewColumn>) =>
    setColumns((cs) => cs.map((c, j) => (i === j ? { ...c, ...p } : c)))

  const close = () => setDialog({ kind: 'none' })

  return (
    <FormDialog
      open
      onClose={close}
      title="New table"
      description="Name the table and its columns, then create it"
      widthClass="w-[min(52rem,94vw)]"
      onSubmit={() => {
        if (!complete || creating) return
        setCreating(true)
        void createTable(spec).finally(() => setCreating(false))
      }}
      footer={
        <>
          <span className="text-[var(--color-faint)]">{database}</span>
          <button type="button" onClick={close} className={`ml-auto ${dialogButton.ghost}`}>
            Cancel
          </button>
          <button type="submit" disabled={!complete || creating} className={dialogButton.primary}>
            {creating ? 'Creating…' : 'Create table'}
          </button>
        </>
      }
    >
      <div className="flex gap-3 p-4 pb-2">
        {hasSchemas && (
          <Field label="Schema" className="w-48">
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              list="new-table-schemas"
              placeholder="public"
              spellCheck={false}
              className={`w-full ${inputClass}`}
            />
            <datalist id="new-table-schemas">
              {schemas.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </Field>
        )}
        <Field label="Table name" className="flex-1">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="orders"
            spellCheck={false}
            className={`w-full ${inputClass}`}
          />
        </Field>
      </div>

      <div className="px-4 pb-2">
        <div className="mb-1 flex gap-2 font-semibold tracking-wider text-[var(--color-faint)] uppercase">
          <span className="flex-1">Column</span>
          <span className="flex-1">Type</span>
          <span className="w-32">Default</span>
          <span className="w-12 text-center">Null</span>
          <span className="w-12 text-center">PK</span>
          <span className="w-7" />
        </div>

        {columns.map((c, i) => (
          <div key={i} className="mb-1 flex items-center gap-2">
            <input
              value={c.name}
              onChange={(e) => patchColumn(i, { name: e.target.value })}
              aria-label={`Column ${i + 1} name`}
              spellCheck={false}
              className={`flex-1 ${inputClass}`}
            />
            <input
              value={c.type}
              onChange={(e) => patchColumn(i, { type: e.target.value })}
              list="new-table-types"
              aria-label={`Column ${i + 1} type`}
              spellCheck={false}
              className={`flex-1 ${inputClass} font-[var(--font-mono)]`}
            />
            <input
              value={c.default}
              onChange={(e) => patchColumn(i, { default: e.target.value })}
              aria-label={`Column ${i + 1} default`}
              placeholder="none"
              spellCheck={false}
              className={`w-32 ${inputClass} font-[var(--font-mono)]`}
            />
            <span className="flex w-12 justify-center">
              <input
                type="checkbox"
                // A primary key column is NOT NULL on every engine, so the box
                // is shown as off and locked rather than silently ignored.
                checked={c.nullable && !c.primaryKey}
                disabled={c.primaryKey}
                onChange={(e) => patchColumn(i, { nullable: e.target.checked })}
                aria-label={`Column ${i + 1} nullable`}
              />
            </span>
            <span className="flex w-12 justify-center">
              <input
                type="checkbox"
                checked={c.primaryKey}
                onChange={(e) => patchColumn(i, { primaryKey: e.target.checked })}
                aria-label={`Column ${i + 1} primary key`}
              />
            </span>
            <button
              type="button"
              onClick={() =>
                setColumns((cs) => (cs.length > 1 ? cs.filter((_, j) => j !== i) : cs))
              }
              disabled={columns.length === 1}
              title="Remove this column"
              aria-label={`Remove column ${i + 1}`}
              className="w-7 rounded-lg py-1 text-[var(--color-muted)] disabled:opacity-30 enabled:hover:bg-[var(--color-elevated)] enabled:hover:text-[var(--color-danger)]"
            >
              ✕
            </button>
          </div>
        ))}

        <datalist id="new-table-types">
          {types.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>

        <button
          type="button"
          onClick={() => setColumns((cs) => [...cs, blankColumn()])}
          className="mt-1 rounded-lg px-1.5 py-1 text-[var(--color-muted)] hover:bg-[var(--color-elevated)] hover:text-[var(--color-text)]"
        >
          + Add column
        </button>
      </div>

      {/* Always visible once the definition is complete: this is the statement
          that will run, and it is the only place the quoting and the dialect's
          own wording can be checked before it does. */}
      <div className="px-4 pb-4">
        {previewError ? (
          <p className="rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-dim)] px-3 py-2 font-[var(--font-mono)] break-words text-[var(--color-danger)]">
            {previewError}
          </p>
        ) : (
          <pre className="max-h-40 overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 font-[var(--font-mono)] whitespace-pre text-[var(--color-muted)]">
            {preview || 'Name the table and fill in a column to see the statement.'}
          </pre>
        )}
      </div>
    </FormDialog>
  )
}

/** Nullable by default: NOT NULL with no default rejects the first insert. */
function blankColumn(): NewColumn {
  return { name: '', type: '', nullable: true, primaryKey: false, default: '' }
}

const inputClass =
  'rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-panel)] px-2 py-1.5 outline-none placeholder:text-[var(--color-faint)]'

function Field({
  label,
  className = '',
  children,
}: {
  label: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block font-semibold tracking-wider text-[var(--color-faint)] uppercase">
        {label}
      </span>
      {children}
    </label>
  )
}

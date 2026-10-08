import { useEffect, useMemo, useRef, useState } from 'react'
import { api, errorMessage } from '../api'
import { applyJsonEdits, formatBytes, formatJson, parseJson } from '../json'
import { useStore, type CellTarget } from '../store'
import { rowKeyOf } from '../edits'
import { cellEditBlock, currentInput } from '../storeEdits'
import type { JSONEdit } from '../types'
import { Dialog, dialogButton } from '../ui'
import { JsonView, type JsonEditing } from './JsonView'

/**
 * One cell, full size.
 *
 * This is the other half of the text cap: values are cut on the way out of the
 * database so browsing stays fast, and this dialog is where the whole thing can
 * still be had. A cut value is fetched in full as soon as the dialog opens —
 * opening it *is* the demand, and asking the user to press a second button to
 * see the data they just asked for is a button too many.
 *
 * JSON gets a tree; everything else gets its text. The tab is chosen for you
 * and then left alone, so a column of JSON documents does not need re-picking
 * on every cell.
 */
export function CellDialog({ cell }: { cell: CellTarget }) {
  const setDialog = useStore((s) => s.setDialog)
  const connectionId = useStore((s) => s.activeConnectionId)
  const activeRef = useStore((s) => s.activeRef)
  const filter = useStore((s) => s.filter)
  const orderBy = useStore((s) => s.orderBy)
  const sortChosen = useStore((s) => s.sortChosen)

  const [full, setFull] = useState<string | null>(null)
  const [bytes, setBytes] = useState<number | null>(null)
  const [clipped, setClipped] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // null means "whatever suits this value"; a click pins the choice.
  const [pinnedTab, setPinnedTab] = useState<'text' | 'json' | null>(null)

  const fetchable = cell.truncated && cell.rowOffset !== null && !!connectionId && !!activeRef

  useEffect(() => {
    const rowOffset = cell.rowOffset
    if (!fetchable || !connectionId || !activeRef || rowOffset === null) return
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const res = await api.readCell({
          connectionId,
          ref: activeRef,
          column: cell.column,
          // The filter and sort must be the ones the page was read with, or
          // the row offset addresses a different row.
          filter,
          orderBy,
          applyDefaultSort: !sortChosen,
          rowOffset,
          ...(cell.key ? { key: cell.key } : {}),
        })
        if (cancelled) return
        setFull(res.value ?? '')
        setBytes(res.bytes)
        setClipped(res.truncated)
      } catch (e) {
        if (!cancelled) setError(errorMessage(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // Keyed on the cell alone on purpose: the filter and sort cannot change
    // while a modal is open, so re-running this when they are re-read from the
    // store would only refetch the same value.
  }, [cell, fetchable, connectionId, activeRef, filter, orderBy, sortChosen])

  const loaded = full ?? (cell.value === null ? '' : String(cell.value))
  // Whole once fetched, or when it was never cut. Only a whole value is edited.
  const whole = !cell.truncated || full !== null
  const at = cell.at
  // Edits go to the row the dialog was opened on, so a page re-read under it
  // that moved the row ends editing rather than redirecting it.
  const sameRow = useStore(
    (s) =>
      !!at &&
      !!s.result &&
      at.col < s.result.columns.length &&
      JSON.stringify(rowKeyOf(s.result, at.row, s.editKey)) === JSON.stringify(cell.key),
  )
  const input = useStore((s) =>
    at && sameRow && s.result ? currentInput(s, at.row, at.col).input : undefined,
  )
  // The staged result, not the loaded one: the tree is where path edits are
  // made, and it has to show them.
  const staged = useMemo(() => {
    if (!input) return null
    if (input.kind === 'value') return input.value ?? ''
    if (input.kind !== 'json' || !whole) return null
    const r = applyJsonEdits(loaded, input.edits ?? [])
    return r.ok ? r.text : null
  }, [input, loaded, whole])
  const text = staged ?? loaded
  const isNull =
    input?.kind === 'null' ||
    input?.kind === 'default' ||
    (!input && cell.value === null && full === null)
  const parsed = useMemo(() => parseJson(text), [text])
  const tab = pinnedTab ?? (parsed.ok ? 'json' : 'text')

  const block = useStore((s) =>
    at && sameRow ? cellEditBlock(s, at.row, at.col) : 'not a row of the table on screen',
  )
  const mssql = useStore(
    (s) => s.connections.find((c) => c.id === s.activeConnectionId)?.kind === 'mssql',
  )
  const stageJsonEdit = useStore((s) => s.stageJsonEdit)
  const stageCellText = useStore((s) => s.stageCellText)
  const editing = useMemo<JsonEditing | undefined>(() => {
    if (!at || block || !whole || isNull) return undefined
    return {
      mssql,
      jsonEdits: input?.kind === 'json' ? (input.edits ?? []) : [],
      apply(edit: JSONEdit) {
        // Tried on the text on screen first, so a bad edit is refused with a
        // reason before anything is staged.
        const r = applyJsonEdits(text, [edit])
        if (!r.ok) return r.reason
        // A change to the root is the whole document: there is no path for the
        // server to apply, so it is staged as the new value outright.
        return edit.path.length === 0
          ? stageCellText(at.row, at.col, r.text)
          : stageJsonEdit(at.row, at.col, edit)
      },
    }
  }, [at, block, whole, isNull, mssql, input, text, stageJsonEdit, stageCellText])

  // Escape belongs to an open tree editor before it belongs to the dialog.
  const escape = useRef<(() => boolean) | null>(null)
  const close = () => {
    if (escape.current?.()) return
    setDialog({ kind: 'none' })
  }

  return (
    <Dialog
      open
      onClose={close}
      widthClass="w-[min(60rem,94vw)]"
      description={`Full value of the ${cell.column} column`}
      title={
        <span className="flex items-baseline gap-2">
          <span className="font-[var(--font-mono)]">{cell.column}</span>
          <span className="font-normal text-[var(--color-faint)]">{cell.dbType}</span>
          {/* The size the database reported once it has been fetched;
              until then, the size of what is on screen. */}
          <span className="font-normal text-[var(--color-muted)]">
            {formatBytes(bytes ?? text.length)}
          </span>
        </span>
      }
      footer={
        <>
          <button
            type="button"
            onClick={() =>
              // Copy what is on screen: the tree's re-indented form from the
              // JSON tab, the raw value from the text tab.
              void navigator.clipboard?.writeText(
                tab === 'json' && parsed.ok ? formatJson(parsed.value) : text,
              )
            }
            className={dialogButton.secondary}
          >
            Copy
          </button>
          <button onClick={close} className={`ml-auto ${dialogButton.ghost}`}>
            Close
          </button>
        </>
      }
    >
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <Tab label="Text" active={tab === 'text'} onClick={() => setPinnedTab('text')} />
        <Tab
          label="JSON"
          active={tab === 'json'}
          disabled={!parsed.ok}
          title={parsed.ok ? undefined : `Not shown as JSON: ${parsed.reason}`}
          onClick={() => setPinnedTab('json')}
        />
        <span className="ml-auto text-[var(--color-faint)]">
          {input && <span className="mr-2 text-[var(--color-warn)]">staged edit shown</span>}
          {loading
            ? 'fetching the full value…'
            : error
              ? // A failed fetch must not hide the prefix that is already
                // on screen, so it is reported beside it rather than replacing it.
                `could not fetch in full: ${error}`
              : cell.truncated && full === null
                ? `truncated — showing the first ${text.length} characters`
                : clipped
                  ? 'clipped at 8 MB'
                  : ''}
        </span>
      </div>

      {/* A fixed viewport with its own scrolling: a megabyte of text must not
          stretch the dialog past the screen. */}
      <div className="max-h-[65vh] min-h-[8rem] overflow-auto">
        {isNull ? (
          <p className="p-4 text-[var(--color-faint)] italic">
            {input?.kind === 'default' ? 'DEFAULT' : 'NULL'}
          </p>
        ) : tab === 'json' && parsed.ok ? (
          <JsonView value={parsed.value} text={text} editing={editing} escape={escape} />
        ) : (
          // Deliberately larger than the grid's 0.75rem. The grid is dense
          // because it shows hundreds of rows at once; this dialog shows one
          // value the user has stopped to read. Still in rem, so the root-size
          // knob in Settings scales it with everything else.
          <pre className="p-3 font-[var(--font-mono)] leading-relaxed break-all whitespace-pre-wrap">
            {text}
          </pre>
        )}
        {!isNull && text === '' && (
          <p className="px-3 pb-3 text-[var(--color-faint)] italic">empty string</p>
        )}
      </div>

      {cell.truncated && cell.rowOffset === null && (
        // Ad-hoc SQL results have no table to go back to, so there is nothing
        // to re-read. Saying so beats a button that cannot work.
        <p className="border-t border-[var(--color-border)] px-4 py-2 text-[var(--color-muted)]">
          This value was cut to keep the result small. Re-run the statement with the cap turned off
          in Settings to see it whole.
        </p>
      )}
    </Dialog>
  )
}

function Tab({
  label,
  active,
  disabled,
  title,
  onClick,
}: {
  label: string
  active: boolean
  disabled?: boolean
  title?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-lg px-2 py-0.5 ${
        active
          ? 'bg-[var(--color-accent-dim)] text-[var(--color-text)]'
          : 'text-[var(--color-muted)] disabled:opacity-40 enabled:hover:bg-[var(--color-elevated)]'
      }`}
    >
      {label}
    </button>
  )
}

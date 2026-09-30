import { useCallback, useEffect, useRef, useState } from 'react'
import { jsonStatus, reformatJson, stageBlock, wantsJsonTools, type JsonStatus } from '../bigEdit'
import { formatBytes } from '../json'
import { useStore } from '../store'
import type { Editing } from '../storeEdits'
import { CodeEditor, Dialog, dialogButton, type CodeEditorHandle } from '../ui'

/**
 * Mounts the large editor while a cell is being edited in it. Its own component
 * so `App` does not subscribe to `editing`: the field changes when an edit
 * starts, finishes or finishes loading, and nothing above the dialog cares.
 */
export function LargeEditorHost() {
  const editing = useStore((s) => (s.editing?.mode === 'large' ? s.editing : null))
  return editing ? <CellEditDialog editing={editing} /> : null
}

interface Meta {
  chars: number
  changed: boolean
  json: JsonStatus | null
}

/**
 * The editor for a value too big for a cell: near-full-window, line-numbered,
 * wrapped, with JSON highlighting and a validity readout where it applies.
 *
 * It starts from the whole value — a capped cell is fetched first and this shows
 * a loading state meanwhile, never the capped text. The document lives in
 * CodeMirror and is read once, on Stage; React is told only a debounced summary
 * (length, changed, valid), so typing in several megabytes costs no more than
 * typing in a few lines.
 *
 * A json/jsonb column refuses to stage invalid JSON — the database would refuse
 * it anyway — but a text column holding JSON is only told, never stopped.
 */
function CellEditDialog({ editing }: { editing: Editing }) {
  const commitEdit = useStore((s) => s.commitEdit)
  const cancelEdit = useStore((s) => s.cancelEdit)
  const handle = useRef<CodeEditorHandle>(null)
  const jsonTools = wantsJsonTools(editing.text, editing.dataType)
  const [meta, setMeta] = useState<Meta>({
    chars: editing.text.length,
    changed: false,
    json: jsonTools ? jsonStatus(editing.text) : null,
  })
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const refresh = useCallback(() => {
    const text = handle.current?.getValue() ?? ''
    setMeta({
      chars: text.length,
      changed: text !== editing.text,
      json: jsonTools ? jsonStatus(text) : null,
    })
    setError(null)
  }, [editing.text, jsonTools])

  // A capped cell opens empty and gets its text when the fetch lands; the
  // summary has to follow, since the editor itself only reports typing.
  useEffect(() => {
    if (editing.loading) return
    setMeta({
      chars: editing.text.length,
      changed: false,
      json: jsonTools ? jsonStatus(editing.text) : null,
    })
  }, [editing.loading, editing.text, jsonTools])

  // Radix focuses the first control in the dialog once it opens, which is a
  // toolbar button; the point of opening it is to type.
  useEffect(() => {
    if (!editing.loading) setTimeout(() => handle.current?.focus(), 0)
  }, [editing.loading])

  const stage = () => {
    if (editing.loading) return
    const text = handle.current?.getValue() ?? ''
    if (text === editing.text) return cancelEdit()
    const block = stageBlock(text, editing.dataType)
    if (block) return setError(block)
    commitEdit(text)
  }

  const requestClose = () => {
    const text = handle.current?.getValue() ?? editing.text
    if (text === editing.text || confirming) return cancelEdit()
    setConfirming(true)
  }

  const reformat = (indent: number | null) => {
    const text = handle.current?.getValue() ?? ''
    if (jsonStatus(text).state !== 'valid') return
    handle.current?.setValue(reformatJson(text, indent))
    refresh()
  }

  const revert = () => {
    handle.current?.setValue(editing.original)
    refresh()
  }

  const valid = meta.json?.state === 'valid'

  return (
    <Dialog
      open
      onClose={requestClose}
      widthClass="w-[min(90rem,96vw)]"
      description={`Edit the ${editing.column} column`}
      title={
        <span className="flex items-baseline gap-2">
          <span className="font-[var(--font-mono)]">{editing.column}</span>
          <span className="font-normal text-[var(--color-faint)]">{editing.dataType.trim()}</span>
        </span>
      }
      footer={
        <>
          <span className="text-[var(--color-muted)]">
            {editing.loading
              ? 'fetching the full value…'
              : `${meta.chars.toLocaleString()} chars · ${formatBytes(meta.chars)}`}
          </span>
          <span
            className={
              meta.changed ? 'font-semibold text-[var(--color-warn)]' : 'text-[var(--color-faint)]'
            }
          >
            {meta.changed ? 'changed' : 'unchanged'}
          </span>
          <button
            type="button"
            onClick={revert}
            disabled={editing.loading || !meta.changed}
            className={`ml-auto ${dialogButton.ghost}`}
          >
            Revert to original
          </button>
          <button type="button" onClick={requestClose} className={dialogButton.ghost}>
            Cancel
          </button>
          <button
            type="button"
            onClick={stage}
            disabled={editing.loading || !meta.changed}
            className={dialogButton.primary}
          >
            Stage{' '}
            <span className="font-[var(--font-mono)] text-[0.75em] opacity-80">Ctrl+Enter</span>
          </button>
        </>
      }
    >
      <div className="flex min-h-9 items-center gap-2 border-b border-[var(--color-border)] px-4 py-1.5">
        {jsonTools && (
          <>
            <span
              className={
                valid
                  ? 'text-[var(--color-success)]'
                  : meta.json?.state === 'invalid'
                    ? 'text-[var(--color-danger)]'
                    : 'text-[var(--color-faint)]'
              }
              aria-live="polite"
            >
              {meta.json?.state === 'valid'
                ? 'valid JSON'
                : meta.json?.state === 'invalid'
                  ? `invalid: ${meta.json.message}`
                  : 'empty'}
            </span>
            <button
              type="button"
              onClick={() => reformat(2)}
              disabled={!valid}
              className={toolButton}
            >
              Format
            </button>
            <button
              type="button"
              onClick={() => reformat(null)}
              disabled={!valid}
              className={toolButton}
            >
              Minify
            </button>
          </>
        )}
        {editing.original === '' && !editing.loading && (
          <span className="ml-auto text-[var(--color-faint)]">was NULL or empty</span>
        )}
      </div>

      {error && (
        <p
          role="alert"
          className="border-b border-[var(--color-danger)] bg-[var(--color-danger-dim)] px-4 py-2 text-[var(--color-danger)]"
        >
          {error}
        </p>
      )}
      {confirming && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-[var(--color-warn)] bg-[var(--color-warn-dim)] px-4 py-2"
        >
          <span className="text-[var(--color-warn)]">Discard your changes to this value?</span>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className={`ml-auto ${dialogButton.secondary}`}
          >
            Keep editing
          </button>
          <button type="button" onClick={cancelEdit} className={dialogButton.dangerFilled}>
            Discard
          </button>
        </div>
      )}

      {editing.loading ? (
        <p className="flex h-[58vh] items-center justify-center text-[var(--color-muted)]">
          Fetching the full value…
        </p>
      ) : (
        <CodeEditor
          initialValue={editing.text}
          language={jsonTools ? 'json' : 'text'}
          onDocChange={refresh}
          onSubmit={stage}
          ariaLabel={`Edit ${editing.column}`}
          className="h-[58vh] text-[0.875rem]"
          handleRef={handle}
        />
      )}
    </Dialog>
  )
}

const toolButton =
  'rounded-lg border border-[var(--color-border-strong)] px-2 py-0.5 font-semibold disabled:opacity-40 enabled:hover:border-[var(--color-accent)]'

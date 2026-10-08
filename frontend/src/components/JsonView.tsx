import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { reformatJson } from '../bigEdit'
import { registerJsonTreeCommands, type Command } from '../commands'
import {
  formatJson,
  jsonPathOf,
  jsonSourceAt,
  jsonValueText,
  summarise,
  type JsonKind,
} from '../json'
import { editMarks, initialOpen, treeKey, treeRows, type TreeRow } from '../jsonTree'
import { useStore } from '../store'
import type { JSONEdit } from '../types'
import { ContextMenu, type MenuItem } from '../ui'
import { editCellClass } from '../useGridEdits'
import { Highlight } from './Highlight'

/**
 * A collapsible JSON tree, and where a value inside a document is edited.
 *
 * Hand-rolled rather than pulled in: a viewer library is tens of kilobytes with
 * its own theming to fight. It also stays outside `src/ui/` on purpose — that
 * layer exists to quarantine *vendor* APIs, and there is no vendor here.
 *
 * Rendered as a flat list of visible rows (see jsonTree.ts) with one focused
 * row, so the keyboard can walk it: arrows, Home/End, Left/Right to close and
 * open, and the menu key for the same menu a right-click gives. The tree holds
 * focus itself and points at the row with `aria-activedescendant`, so no row
 * needs to be a tab stop.
 *
 * With `editing`, the same rows take edits: each one is staged as a path edit
 * through `editing.apply` and nothing is written until the change set is
 * accepted. Keys, as in the grid where one exists: F2 or Enter edits a value,
 * Shift+F2 edits it as JSON, R renames a key, Insert or A adds a key or element,
 * Delete removes one, Ctrl+Z undoes the last staged edit.
 */

export interface JsonEditing {
  /** Stages one edit. Returns why it could not be, or null. */
  apply: (edit: JSONEdit) => string | null
  /** SQL Server cannot remove an array element by path. */
  mssql: boolean
  /** Path edits already staged on this cell, to mark the nodes they touch. */
  jsonEdits: readonly JSONEdit[]
}

/** An inline editor open on one row. */
type Draft =
  | { mode: 'value'; row: TreeRow; text: string; json: boolean; multiline: boolean; error?: string }
  | { mode: 'key'; row: TreeRow; text: string; error?: string }
  | { mode: 'add'; row: TreeRow; key: string | null; text: string; error?: string }
  | { mode: 'append'; row: TreeRow; text: string; error?: string }

interface TreeAction {
  id: string
  label: string
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  separatorBefore?: boolean
  run: () => void
}

const MSSQL_ARRAY_REMOVE =
  'SQL Server cannot remove an array element by path — edit the whole value with F2 in the grid'

export function JsonView({
  value,
  text,
  editing,
  escape,
}: {
  value: unknown
  /** The document as text, so editors open on its exact characters. */
  text: string
  editing?: JsonEditing
  /** Set while an editor is open, to cancel it: Escape is the dialog's otherwise. */
  escape?: React.MutableRefObject<(() => boolean) | null>
}) {
  const copyText = useStore((s) => s.copyText)
  const [open, setOpen] = useState(() => initialOpen(value))
  const rows = useMemo(() => treeRows(value, open), [value, open])
  // Focus is held by path, so it stays on the same node across an edit; the
  // index is the fallback when that node has gone.
  const [focusPath, setFocusPath] = useState(rows[0].path)
  const lastIndex = useRef(0)
  const found = rows.findIndex((r) => r.path === focusPath)
  const index = found >= 0 ? found : Math.min(lastIndex.current, rows.length - 1)
  lastIndex.current = index
  const focused = rows[index]

  // One menu root for the whole tree, with the clicked row in state — the same
  // arrangement the grid uses, and for the same reason: a Radix root per node
  // would be hundreds of them in a document of any size.
  const [target, setTarget] = useState<TreeRow | null>(null)
  // The value is replaced under us when the dialog finishes fetching a cut
  // cell in full, or an edit is staged, and a target left pointing into the
  // old document would act on data that is no longer on screen.
  useEffect(() => setTarget(null), [value])
  const hit = target ?? focused

  const [draft, setDraft] = useState<Draft | null>(null)
  // Read by the tree's focus handler, which must see an editor close at once —
  // before the render that removes it — or it hands focus straight back to it.
  const draftOpen = useRef(false)
  draftOpen.current = draft !== null
  useEffect(() => {
    if (!editing) setDraft(null)
  }, [editing])

  const treeRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const rowId = (i: number) => `${id}-row-${i}`
  const focusedId = rowId(index)

  // The tree takes focus when it appears, so the keys work at once rather than
  // after a click. Before the dialog's own first-field focus, which leaves
  // focus alone when it is already inside.
  useEffect(() => treeRef.current?.focus({ preventScroll: true }), [])

  useEffect(() => {
    document.getElementById(focusedId)?.scrollIntoView({ block: 'nearest' })
  }, [focusedId])

  const marks = useMemo(() => editMarks(editing?.jsonEdits ?? []), [editing?.jsonEdits])

  const toggle = (path: string, to: boolean) =>
    setOpen((prev) => {
      if (prev.has(path) === to) return prev
      const next = new Set(prev)
      if (to) next.add(path)
      else next.delete(path)
      return next
    })

  const refocus = () => treeRef.current?.focus({ preventScroll: true })

  const focusRow = (row: TreeRow) => {
    setFocusPath(row.path)
    refocus()
  }

  const closeDraft = () => {
    draftOpen.current = false
    setDraft(null)
    refocus()
  }

  useEffect(() => {
    if (!escape) return
    escape.current = draft
      ? () => {
          closeDraft()
          return true
        }
      : null
    return () => {
      escape.current = null
    }
  })

  const pushToast = useStore((s) => s.pushToast)
  const undoEdit = useStore((s) => s.undoEdit)

  /** Stages an edit; on success closes the editor and moves focus to `then`. */
  const submit = (edit: JSONEdit, then?: string) => {
    if (!editing) return
    const why = editing.apply(edit)
    if (why) {
      if (draft) setDraft({ ...draft, error: why })
      else pushToast('error', `Not staged: ${why}`)
      return
    }
    if (then) setFocusPath(then)
    closeDraft()
  }

  // ---- What can be done to a row --------------------------------------------

  /** The container an add acts on: the row itself, or the one it sits in. */
  const holderOf = (row: TreeRow) => (row.container ? row : rows[row.parent])

  function startValue(row: TreeRow, asJson: boolean) {
    const raw = jsonSourceAt(text, row.segs) ?? formatJson(row.value)
    if (row.kind === 'string' && !asJson) {
      const s = row.value as string
      setDraft({ mode: 'value', row, text: s, json: false, multiline: s.includes('\n') })
    } else if (row.container) {
      setDraft({ mode: 'value', row, text: reformatJson(raw, 2), json: true, multiline: true })
    } else {
      setDraft({ mode: 'value', row, text: raw, json: true, multiline: false })
    }
  }

  function startAdd(row: TreeRow) {
    const holder = holderOf(row)
    if (!holder) return
    toggle(holder.path, true)
    setFocusPath(holder.path)
    setDraft(
      holder.kind === 'array'
        ? { mode: 'append', row: holder, text: '""' }
        : { mode: 'add', row: holder, key: null, text: '' },
    )
  }

  function remove(row: TreeRow) {
    if (editing?.mssql && row.inArray) return pushToast('info', MSSQL_ARRAY_REMOVE)
    submit({ op: 'remove', path: row.segs })
  }

  function actionsFor(row: TreeRow): TreeAction[] {
    const valueText = jsonValueText(row.value)
    const json = formatJson(row.value)
    const copy: TreeAction[] = [
      {
        id: 'copy-key',
        label: 'Copy key',
        // The root is the document itself and has no key. Left visible but
        // disabled so the menu keeps its shape from node to node.
        disabled: row.name === null,
        run: () => void copyText(row.name ?? ''),
      },
      { id: 'copy-path', label: 'Copy key path', run: () => void copyText(row.path) },
      {
        id: 'copy-value',
        label: 'Copy value',
        separatorBefore: true,
        run: () => void copyText(valueText),
      },
      {
        id: 'copy-json',
        label: 'Copy value as JSON',
        // Identical for numbers, booleans, null and containers; the two differ
        // only for a string, where this one keeps the quotes and the escapes.
        disabled: json === valueText,
        run: () => void copyText(json),
      },
    ]
    if (!editing) return copy

    const root = row.parent < 0
    const holder = holderOf(row)
    const inObject = !root && !row.inArray
    const blockedRemove = editing.mssql && row.inArray
    return [
      ...copy,
      {
        id: 'edit',
        label: 'Edit value',
        shortcut: 'F2',
        separatorBefore: true,
        // The whole document is the large editor's job: F2 on the grid cell.
        disabled: root,
        run: () => startValue(row, false),
      },
      {
        id: 'edit-json',
        label: 'Edit as JSON',
        shortcut: 'Shift+F2',
        // Only a string edits differently as JSON: it is how one becomes a
        // number, an object or null.
        disabled: root || row.kind !== 'string',
        run: () => startValue(row, true),
      },
      {
        id: 'rename',
        label: 'Rename key',
        shortcut: 'R',
        disabled: !inObject,
        run: () => setDraft({ mode: 'key', row, text: row.name ?? '' }),
      },
      {
        id: 'add',
        label: holder?.kind === 'array' ? 'Append element' : 'Add key',
        shortcut: 'Insert',
        disabled: !holder,
        run: () => startAdd(row),
      },
      {
        id: 'remove',
        label: blockedRemove
          ? 'Delete element (not on SQL Server — F2 the cell)'
          : row.inArray
            ? 'Delete element'
            : 'Delete key',
        shortcut: 'Delete',
        danger: true,
        disabled: root || blockedRemove,
        run: () => remove(row),
      },
    ]
  }

  const items: MenuItem[] = actionsFor(hit).map(({ run, ...a }) => ({ ...a, onSelect: run }))

  // The same actions in the palette, for the focused node.
  const paletteSource = useRef<() => Command[]>(() => [])
  paletteSource.current = () =>
    actionsFor(focused)
      .filter((a) => !a.disabled)
      .map((a) => ({
        id: `json:${a.id}`,
        title: a.label,
        subtitle: focused.path,
        group: 'JSON',
        shortcut: a.shortcut,
        candidate: { name: a.label, keywords: 'json tree node key value document path' },
        run: a.run,
      }))
  useEffect(() => {
    registerJsonTreeCommands(() => paletteSource.current())
    return () => registerJsonTreeCommands(null)
  }, [])

  /** Raises a contextmenu at the focused row, which is how Radix opens. */
  const openMenu = () => {
    const el = document.getElementById(focusedId)
    if (!el) return
    setTarget(focused)
    const box = el.getBoundingClientRect()
    el.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        clientX: Math.round(box.left + 24),
        clientY: Math.round(box.bottom),
      }),
    )
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Keys typed into an open editor are the editor's.
    if (e.target !== e.currentTarget) return
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault()
      openMenu()
      return
    }
    if (e.key === 'Enter' && focused.container) {
      e.preventDefault()
      toggle(focused.path, !focused.open)
      return
    }
    if (editing && editKey(e, focused)) {
      e.preventDefault()
      return
    }
    const step = treeKey(e.nativeEvent, rows, index)
    if (!step) return
    e.preventDefault()
    if ('focus' in step) setFocusPath(rows[step.focus].path)
    else toggle('open' in step ? step.open : step.close, 'open' in step)
  }

  /** The editing keys. True when the key was one of them. */
  function editKey(e: React.KeyboardEvent, row: TreeRow): boolean {
    const mod = e.ctrlKey || e.metaKey
    const root = row.parent < 0
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') {
      undoEdit()
      return true
    }
    if (mod || e.altKey) return false
    if ((e.key === 'F2' && !root) || (e.key === 'Enter' && !e.shiftKey && !root)) {
      startValue(row, e.key === 'F2' && e.shiftKey)
      return true
    }
    if (e.shiftKey) return false
    if (e.key === 'r' || e.key === 'R') {
      if (!root && !row.inArray) setDraft({ mode: 'key', row, text: row.name ?? '' })
      return true
    }
    if (e.key === 'Insert' || e.key === 'a') {
      startAdd(row)
      return true
    }
    if (e.key === 'Delete' && !root) {
      remove(row)
      return true
    }
    return false
  }

  // ---- Committing an editor -------------------------------------------------

  function commit(d: Draft, typed: string) {
    const json = (t: string) => {
      try {
        JSON.parse(t)
        return null
      } catch (err) {
        return `Not valid JSON: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    const fail = (error: string) => setDraft({ ...d, text: typed, error })
    const segs = d.row.segs
    const parentSegs = segs.slice(0, -1)

    switch (d.mode) {
      case 'value': {
        if (d.json) {
          const bad = json(typed)
          if (bad) return fail(bad)
        }
        const v = d.json ? fitTo(text, typed) : JSON.stringify(typed)
        return submit({ op: 'set', path: segs, value: v }, d.row.path)
      }
      case 'key': {
        if (typed === d.row.name) return closeDraft()
        const to = jsonPathOf([...parentSegs, typed])
        if (d.row.open) toggle(to, true)
        return submit({ op: 'rename', path: segs, newKey: typed }, to)
      }
      case 'add': {
        if (d.key === null) {
          const holder = d.row.value as Record<string, unknown>
          if (Object.prototype.hasOwnProperty.call(holder, typed)) {
            return fail(`${jsonPathOf([...segs, typed])} already exists`)
          }
          return setDraft({ mode: 'add', row: d.row, key: typed, text: '""' })
        }
        const bad = json(typed)
        if (bad) return fail(bad)
        return submit(
          { op: 'set', path: [...segs, d.key], value: fitTo(text, typed) },
          jsonPathOf([...segs, d.key]),
        )
      }
      case 'append': {
        const bad = json(typed)
        if (bad) return fail(bad)
        const n = (d.row.value as unknown[]).length
        return submit(
          { op: 'append', path: segs, value: fitTo(text, typed) },
          jsonPathOf([...segs, n]),
        )
      }
    }
  }

  const editorFor = (d: Draft) => (
    <InlineEditor
      key={`${d.mode}:${d.row.path}:${d.mode === 'add' ? d.key : ''}`}
      initial={d.text}
      multiline={d.mode === 'value' && d.multiline}
      label={draftLabel(d)}
      error={d.error}
      onCommit={(t) => commit(d, t)}
      onCancel={closeDraft}
    />
  )

  return (
    <ContextMenu items={items} heading={hit.path}>
      {/* Matches the cell dialog's text tab rather than the grid: both are for
          reading one value, not for scanning many. */}
      <div
        ref={treeRef}
        role="tree"
        aria-label="JSON document"
        tabIndex={0}
        aria-activedescendant={focusedId}
        onKeyDown={onKeyDown}
        // Focus handed back to the tree — by a closing palette, say — goes on
        // to an open editor, which is where the user was.
        onFocus={(e) => {
          if (e.target === e.currentTarget && draftOpen.current) {
            e.currentTarget.querySelector<HTMLElement>('[data-tree-editor]')?.focus()
          }
        }}
        className="p-3 font-[var(--font-mono)] leading-relaxed outline-none"
      >
        <Highlight pillClassName="rounded-lg bg-[var(--color-accent-dim)]/60">
          {rows.map((row, i) => (
            <RowView
              key={row.path}
              id={rowId(i)}
              row={row}
              focused={i === index}
              mark={marks.get(row.path)}
              keyEditor={
                draft?.mode === 'key' && draft.row.path === row.path ? editorFor(draft) : null
              }
              valueEditor={
                draft?.mode === 'value' && draft.row.path === row.path ? editorFor(draft) : null
              }
              childEditor={
                (draft?.mode === 'add' || draft?.mode === 'append') &&
                draft.row.path === row.path ? (
                  <>
                    {/* The key chosen in the first step, beside its value. */}
                    {draft.mode === 'add' && <Key name={draft.key} />}
                    {editorFor(draft)}
                  </>
                ) : null
              }
              onClick={() => {
                focusRow(row)
                if (row.container) toggle(row.path, !row.open)
              }}
              onEditKey={
                editing && row.parent >= 0 && !row.inArray
                  ? () => setDraft({ mode: 'key', row, text: row.name ?? '' })
                  : undefined
              }
              onEditValue={editing && row.parent >= 0 ? () => startValue(row, false) : undefined}
              onContextMenu={() => {
                setTarget(row)
                setFocusPath(row.path)
              }}
            />
          ))}
        </Highlight>
      </div>
    </ContextMenu>
  )
}

/**
 * A value typed for a single-line document is minified to match it; one
 * typed for a pretty-printed document is left as typed.
 */
function fitTo(doc: string, value: string): string {
  return doc.includes('\n') ? value : reformatJson(value, null)
}

function draftLabel(d: Draft): string {
  switch (d.mode) {
    case 'value':
      return d.json ? 'New value, as JSON' : 'New text'
    case 'key':
      return 'New key name'
    case 'add':
      return d.key === null ? 'Key to add' : `Value of ${d.key}, as JSON`
    case 'append':
      return 'Element to append, as JSON'
  }
}

function RowView({
  id,
  row,
  focused,
  mark,
  keyEditor,
  valueEditor,
  childEditor,
  onClick,
  onEditKey,
  onEditValue,
  onContextMenu,
}: {
  id: string
  row: TreeRow
  focused: boolean
  mark: 'self' | 'inside' | undefined
  keyEditor: React.ReactNode
  valueEditor: React.ReactNode
  childEditor: React.ReactNode
  onClick: () => void
  onEditKey?: () => void
  onEditValue?: () => void
  onContextMenu: () => void
}) {
  const fromEditor = (e: React.MouseEvent) =>
    !!(e.target as HTMLElement).closest('[data-tree-editor]')
  const guides = (depth: number) =>
    // One rule per level down the left edge: what makes the nesting readable
    // once a document is more than two deep.
    Array.from({ length: depth }, (_, d) => (
      <span
        key={d}
        aria-hidden
        className="w-3 shrink-0 self-stretch border-r border-[var(--color-border)]"
      />
    ))
  return (
    <>
      <div
        id={id}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-expanded={row.container ? row.open : undefined}
        aria-selected={focused}
        data-item
        data-highlight={focused || undefined}
        onClick={(e) => !fromEditor(e) && onClick()}
        onContextMenu={onContextMenu}
        className={`relative flex items-baseline gap-2 rounded-lg px-1 ${
          mark === 'self' ? editCellClass('dirty', false) : ''
        }`}
      >
        {guides(row.depth)}
        <span aria-hidden className="w-3 shrink-0 text-[var(--color-faint)]">
          {row.container ? (row.open ? '▾' : '▸') : ''}
        </span>
        {keyEditor ?? (
          <Key
            name={row.name}
            onDoubleClick={
              onEditKey &&
              ((e) => {
                e.stopPropagation()
                onEditKey()
              })
            }
          />
        )}
        {valueEditor ?? (
          <span
            className="min-w-0"
            onDoubleClick={(e) => {
              if (!onEditValue || fromEditor(e)) return
              e.stopPropagation()
              onEditValue()
            }}
          >
            {row.container ? (
              <span className="text-[var(--color-faint)]">{summarise(row.value)}</span>
            ) : (
              <Scalar kind={row.kind} value={row.value} />
            )}
          </span>
        )}
        {mark === 'inside' && (
          <span
            className="text-[var(--color-warn)]"
            title="Something inside has a staged edit"
            aria-label="has staged edits inside"
          >
            •
          </span>
        )}
      </div>
      {childEditor && (
        <div className="relative flex items-baseline gap-2 px-1">
          {guides(row.depth + 1)}
          <span aria-hidden className="w-3 shrink-0" />
          {childEditor}
        </div>
      )}
    </>
  )
}

/**
 * A one-line field, or a small multi-line one for a container. Enter stages
 * (Ctrl+Enter when Enter is a newline), Escape cancels.
 */
function InlineEditor({
  initial,
  multiline,
  label,
  error,
  onCommit,
  onCancel,
}: {
  initial: string
  multiline: boolean
  label: string
  error?: string
  onCommit: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(initial)
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    } else if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      onCommit(text)
    }
  }
  const field =
    'w-full rounded-md border border-[var(--color-accent)] bg-[var(--color-bg)] px-1.5 font-[var(--font-mono)] outline-none'
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      {multiline ? (
        <textarea
          data-tree-editor
          autoFocus
          aria-label={label}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={Math.min(16, Math.max(3, text.split('\n').length))}
          spellCheck={false}
          className={`${field} resize-y py-1`}
        />
      ) : (
        <input
          data-tree-editor
          autoFocus
          aria-label={label}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={(e) => {
            // The caret inside an empty string's quotes, ready to type.
            if (e.target.value === '""') e.target.setSelectionRange(1, 1)
          }}
          spellCheck={false}
          className={field}
        />
      )}
      <span className={error ? 'text-[var(--color-danger)]' : 'text-[var(--color-faint)]'}>
        {error ?? `${label} — ${multiline ? 'Ctrl+Enter' : 'Enter'} to stage, Esc to cancel`}
      </span>
    </span>
  )
}

/** The root has no key; every other node is labelled with its key or index. */
function Key({
  name,
  onDoubleClick,
}: {
  name: string | null
  onDoubleClick?: (e: React.MouseEvent) => void
}) {
  if (name === null) return null
  return (
    <span className="shrink-0 text-[var(--color-accent)]" onDoubleClick={onDoubleClick}>
      {name}:
    </span>
  )
}

function Scalar({ kind, value }: { kind: JsonKind; value: unknown }) {
  if (kind === 'null') {
    // Same treatment as a NULL cell in the grid, for the same reason: it must
    // never be mistaken for the string "null".
    return <span className="text-[var(--color-faint)] italic">null</span>
  }
  if (kind === 'string') {
    return (
      <span className="break-all whitespace-pre-wrap text-[var(--color-success)]">
        {value as string}
      </span>
    )
  }
  return <span className="text-[var(--color-warn)]">{String(value)}</span>
}

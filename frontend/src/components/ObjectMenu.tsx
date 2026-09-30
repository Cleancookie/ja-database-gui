import { useCallback, useRef, useState } from 'react'
import { refLabel, useStore } from '../store'
import { ContextMenu, Dialog, dialogButton, type MenuItem } from '../ui'
import { qualifiedName } from '../commands'
import type { ObjectRef, ObjectType, SchemaObject } from '../types'

/**
 * The right-click items for a sidebar table or view.
 *
 * Every item here is a store action that the command palette also exposes —
 * this menu is a second route to them, not a second implementation. Whether a
 * destructive item confirms first, and what gets refreshed afterwards, lives in
 * the action; see the `truncateTable` / `dropObject` block in store.ts.
 *
 * Read with getState rather than subscribed to: the builder runs while the menu
 * is being rendered, so state is already current, and a subscription here would
 * re-render the menu wrapper for changes it does not show.
 */
export function objectMenuItems(object: SchemaObject): MenuItem[] {
  const s = useStore.getState()
  const ref = {
    database: s.activeDatabase,
    schema: object.schema,
    name: object.name,
  }

  const items: MenuItem[] = [
    { label: 'Open rows', onSelect: () => void s.openObject(object) },
    { label: 'Show details', onSelect: () => void s.openDetails(ref) },
    {
      label: 'New table…',
      separatorBefore: true,
      // Defaulted to this object's schema, which is nearly always where a table
      // being added alongside it belongs.
      onSelect: () => s.newTable(object.schema),
    },
  ]

  if (object.type === 'table') {
    items.push({
      label: s.capabilities?.truncateIsDelete ? 'Empty table (DELETE)' : 'Empty table (TRUNCATE)',
      separatorBefore: true,
      danger: true,
      onSelect: () => void s.truncateTable(ref),
    })
  }
  items.push({
    label: object.type === 'view' ? 'Drop view…' : 'Drop table…',
    separatorBefore: object.type !== 'table',
    danger: true,
    onSelect: () => void s.dropObject(ref, object.type),
  })
  return items
}

/** What a sidebar row carries so the list's one menu can tell which object was hit. */
export function objectKey(o: SchemaObject): string {
  return `${o.type}:${qualifiedName(o)}`
}

/**
 * The sidebar object list's one right-click menu.
 *
 * A Radix menu root per row registers document-level key and pointer listeners
 * of its own, so keystroke cost anywhere in the app — typing in the WHERE box
 * included — grew with the number of tables. One root around the list, told
 * which row was hit via `data-object` (see `objectKey`), costs the same at any
 * size. The grid does the same for its cells.
 *
 * State lives here, not in Sidebar, so choosing a row does not re-render the
 * list: `children` keeps its identity across this component's own renders.
 *
 * Only tables and views have anything to describe. A right-click anywhere else
 * in the list is stopped before it reaches Radix, which leaves the platform's
 * own behaviour untouched. The menu key on a focused row raises a native
 * contextmenu event at that row, so it lands in the same handler.
 */
export function ObjectListMenu({ children }: { children: React.ReactNode }) {
  const [object, setObject] = useState<SchemaObject | null>(null)
  const row = useRef<HTMLElement | null>(null)

  const onContextMenuCapture = useCallback((e: React.MouseEvent) => {
    const el = (e.target as Element).closest<HTMLElement>('[data-object]')
    const key = el?.dataset.object
    const hit = key ? useStore.getState().objects.find((o) => objectKey(o) === key) : undefined
    if (hit && (hit.type === 'table' || hit.type === 'view')) {
      row.current = el
      setObject(hit)
      return
    }
    e.stopPropagation()
  }, [])

  // The trigger is the wrapper, which cannot take focus, so Radix would drop it
  // on the body. Put it back on the row that was hit — unless an item opened a
  // dialog, which owns focus now.
  const onCloseAutoFocus = useCallback((e: Event) => {
    e.preventDefault()
    if (!document.querySelector('[role="dialog"]')) row.current?.focus()
  }, [])

  return (
    <ContextMenu
      items={object ? objectMenuItems(object) : []}
      heading={object ? qualifiedName(object) : undefined}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <div onContextMenuCapture={onContextMenuCapture}>{children}</div>
    </ContextMenu>
  )
}

/**
 * Confirmation for emptying a table.
 *
 * The wording names the statement rather than describing it, because the two are
 * not interchangeable: TRUNCATE does not fire row triggers and on most engines
 * cannot be rolled back, while the DELETE that SQLite gets instead does both.
 */
export function ConfirmTruncateDialog({ target }: { target: ObjectRef }) {
  const setDialog = useStore((s) => s.setDialog)
  const runTruncate = useStore((s) => s.runTruncate)
  const isDelete = useStore((s) => s.capabilities?.truncateIsDelete ?? false)
  const close = () => setDialog({ kind: 'none' })

  return (
    <Dialog
      open
      onClose={close}
      title={`Empty ${refLabel(target)}?`}
      widthClass="w-[min(28rem,92vw)]"
      footer={
        <>
          <button onClick={close} className={`ml-auto ${dialogButton.ghost}`}>
            Cancel
          </button>
          <button onClick={() => void runTruncate(target)} className={dialogButton.dangerFilled}>
            Empty it
          </button>
        </>
      }
    >
      <p className="px-4 py-4 leading-relaxed text-[var(--color-muted)]">
        {isDelete ? (
          <>
            Every row is deleted. SQLite has no <code>TRUNCATE</code>, so this runs{' '}
            <code>DELETE FROM</code> — triggers fire, and it is undone by rolling back the
            transaction it runs in. This one is not in a transaction.
          </>
        ) : (
          <>
            Every row is deleted by <code>TRUNCATE TABLE</code>. The table and its columns stay.
            There is no undo.
          </>
        )}
      </p>
    </Dialog>
  )
}

/** Confirmation for dropping a table or view. */
export function ConfirmDropDialog({ target, type }: { target: ObjectRef; type: ObjectType }) {
  const setDialog = useStore((s) => s.setDialog)
  const runDrop = useStore((s) => s.runDrop)
  const close = () => setDialog({ kind: 'none' })

  return (
    <Dialog
      open
      onClose={close}
      title={`Drop ${type} ${refLabel(target)}?`}
      widthClass="w-[min(28rem,92vw)]"
      footer={
        <>
          <button onClick={close} className={`ml-auto ${dialogButton.ghost}`}>
            Cancel
          </button>
          <button onClick={() => void runDrop(target, type)} className={dialogButton.dangerFilled}>
            Drop it
          </button>
        </>
      }
    >
      <p className="px-4 py-4 leading-relaxed text-[var(--color-muted)]">
        {type === 'view'
          ? 'The view definition is removed. The tables it reads from are not touched.'
          : 'The table, its rows, its indexes and its triggers are all removed. There is no undo.'}
      </p>
    </Dialog>
  )
}

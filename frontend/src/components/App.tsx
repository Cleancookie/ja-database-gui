import { useCallback, useEffect } from 'react'
import { buildActionCommands, type Command } from '../commands'
import { isTypingTarget } from '../dom'
import {
  advance,
  chord,
  display,
  firesWhileTyping,
  WORKS_OVER_MODALS,
  type Advance,
} from '../hotkeys'
import { activeSqlResult, isBound, isInfinite, useStore } from '../store'
import { ActivityPage } from './ActivityPage'
import { TableDetailsPage } from './TableDetailsPage'
import { ActivityTray, ConfirmCancelDialog } from './ActivityTray'
import { CellDialog } from './CellDialog'
import { LargeEditorHost } from './CellEditDialog'
import { useCellMenu } from './CellMenu'
import { CommandPalette } from './CommandPalette'
import { ConfirmDiscardDialog } from './ConfirmDiscardDialog'
import { ConfirmDeleteDialog } from './ConnectionMenu'
import { ConfirmCloseDialog } from './ConfirmCloseDialog'
import { ConfirmResetSampleDialog } from './ConfirmResetSampleDialog'
import { ConnectionDialog } from './ConnectionDialog'
import { DataGrid } from './DataGrid'
import { EmptyPanel } from './EmptyPanel'
import { FilterBar } from './FilterBar'
import { NewTableDialog } from './NewTableDialog'
import { ConfirmDropDialog, ConfirmTruncateDialog } from './ObjectMenu'
import { Paginator } from './Paginator'
import { ReviewChangesDialog } from './ReviewChangesDialog'
import { RowPane } from './RowPane'
import { SettingsDialog } from './SettingsDialog'
import { PasswordDialog } from './PasswordDialog'
import { HotkeysPage } from './HotkeysPage'
import { TransferDialog } from './TransferDialog'
import { ShortcutsDialog } from './ShortcutsDialog'
import { SqlEditor } from './SqlEditor'
import { TabStrip } from './TabStrip'
import { StorageNotice } from './StorageNotice'
import { WorkspacePicker } from './WorkspacePicker'
import { Toasts } from './Toasts'
import { recoverFocus } from '../paneFocus'

export function App() {
  const init = useStore((s) => s.init)
  const tabStripHidden = useStore((s) => s.settings.tabStripHidden)
  const rowPaneOpen = useStore((s) => s.settings.rowPaneOpen)
  const dialog = useStore((s) => s.dialog)
  const view = useStore((s) => s.view)
  const bound = useStore(isBound)
  const activeRef = useStore((s) => s.activeRef)
  const result = useStore((s) => s.result)
  const columns = useStore((s) => s.columns)
  const orderBy = useStore((s) => s.orderBy)
  const busy = useStore((s) => s.busy)
  const page = useStore((s) => s.page)
  const pageSize = useStore((s) => s.pageSize)
  const paginationEnabled = useStore((s) => s.paginationEnabled)
  const sortBy = useStore((s) => s.sortBy)
  const clearSort = useStore((s) => s.clearSort)
  const loadMore = useStore((s) => s.loadMore)
  const infinite = useStore(isInfinite)
  const openCell = useStore((s) => s.openCell)
  const cellMenu = useCellMenu('browse')
  // Stable, so the memoised grid is not re-rendered by an inline arrow every
  // time something else in the shell changes — `busy` toggling on each query
  // is enough on its own.
  const onSort = useCallback(
    (column: string, desc: boolean | null) =>
      void (desc === null ? clearSort() : sortBy(column, desc)),
    [sortBy, clearSort],
  )
  const onOpenCell = useCallback(
    (row: number, col: number) => openCell('browse', row, col),
    [openCell],
  )

  useEffect(() => {
    void init()
  }, [init])

  useGlobalHotkeys()

  return (
    <div className="flex h-full flex-col">
      <StorageNotice className="m-2 mb-0" />

      <div className="flex min-h-0 flex-1 gap-2 p-2">
        <TabStrip open={!tabStripHidden} />

        <main
          data-pane="main"
          tabIndex={-1}
          className="island flex min-w-0 flex-1 flex-col outline-none"
        >
          {view === 'hotkeys' ? (
            <HotkeysPage />
          ) : view === 'activity' ? (
            <ActivityPage />
          ) : view === 'details' ? (
            <TableDetailsPage />
          ) : view === 'sql' ? (
            <SqlEditor />
          ) : activeRef ? (
            <>
              <FilterBar />
              <div className="min-h-0 flex-1">
                {result ? (
                  <DataGrid
                    result={result}
                    source="browse"
                    columns={columns}
                    orderBy={orderBy}
                    onSort={onSort}
                    rowOffset={paginationEnabled && !infinite ? (page - 1) * pageSize : 0}
                    onEndReached={infinite ? loadMore : undefined}
                    onOpenCell={onOpenCell}
                    cellMenu={cellMenu}
                  />
                ) : (
                  <Placeholder text={busy ? 'Loading…' : 'No rows'} />
                )}
              </div>
              <Paginator />
            </>
          ) : bound ? (
            <EmptyPanel />
          ) : (
            <WorkspacePicker />
          )}
        </main>

        <RowPane open={rowPaneOpen} />
      </div>

      {/* Below every view, including the activity page: what is running is
          worth knowing wherever the user happens to be. */}
      <ActivityTray />

      <CommandPalette />
      {dialog.kind === 'connection' && <ConnectionDialog existing={dialog.connection} />}
      {dialog.kind === 'password' && (
        <PasswordDialog
          connection={dialog.connection}
          database={dialog.database}
          error={dialog.error}
          browse={dialog.browse}
        />
      )}
      {dialog.kind === 'shortcuts' && <ShortcutsDialog />}
      {dialog.kind === 'transfer' && <TransferDialog mode={dialog.mode} />}
      {dialog.kind === 'settings' && <SettingsDialog />}
      {dialog.kind === 'cell' && <CellDialog cell={dialog.cell} />}
      {dialog.kind === 'confirmDelete' && (
        <ConfirmDeleteDialog name={dialog.connection.name} id={dialog.connection.id} />
      )}
      {dialog.kind === 'confirmResetSample' && <ConfirmResetSampleDialog />}
      {dialog.kind === 'confirmClose' && <ConfirmCloseDialog />}
      {dialog.kind === 'confirmTruncate' && <ConfirmTruncateDialog target={dialog.ref} />}
      {dialog.kind === 'confirmDrop' && (
        <ConfirmDropDialog target={dialog.ref} type={dialog.type} />
      )}
      {dialog.kind === 'newTable' && <NewTableDialog schema={dialog.schema} />}
      {dialog.kind === 'reviewChanges' && <ReviewChangesDialog />}
      {dialog.kind === 'confirmDiscard' && (
        <ConfirmDiscardDialog count={dialog.count} proceed={dialog.proceed} />
      )}
      {dialog.kind === 'confirmCancel' && (
        <ConfirmCancelDialog queryId={dialog.queryId} sql={dialog.sql} />
      )}
      <LargeEditorHost />
      <Toasts />
      <PendingChord />
    </div>
  )
}

/** The first steps of a chord, so a half-typed one is never a mystery. */
function PendingChord() {
  const pending = useStore((s) => s.pendingChord)
  if (pending.length === 0) return null
  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-elevated)] px-3 py-1.5 font-[var(--font-mono)] text-[var(--color-accent)] shadow-lg"
    >
      {pending.map(display).join(' ')} …
    </div>
  )
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center text-[var(--color-faint)]">{text}</div>
  )
}

/** How long the first step of a chord waits for the next. */
const CHORD_TIMEOUT_MS = 2000

/**
 * Global keyboard shortcuts.
 *
 * Handlers check whether focus is in a text field before claiming a key, so
 * typing a filter never triggers navigation. The palette keys are the
 * exception — they open from anywhere, including the filter box and the SQL
 * editor, which is the point of a palette-first app with no menu bar.
 */
function useGlobalHotkeys() {
  useEffect(() => {
    let pending: string[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState()
      const mod = e.ctrlKey || e.metaKey
      const target = e.target as HTMLElement | null
      const typing = isTypingTarget(target)

      // Rebindable commands. Ctrl+P, Ctrl+Shift+P, Ctrl+, and Ctrl+. are claimed
      // before the typing and modal guards so they work from the filter box,
      // the SQL editor and over a dialog. Ctrl+P *inside* an open palette
      // belongs to it (move-up), so "Go to" only fires when none is open.
      let cmds: Command[] | undefined
      let result: Advance | undefined
      const resolve = (): Advance => {
        if (result) return result
        const c = chord(e)
        const first = pending.length === 0
        if (
          !c ||
          (first && !(mod || e.altKey)) ||
          (first && typing && !firesWhileTyping(c, target))
        ) {
          return (result = { type: 'none' })
        }
        cmds ??= buildActionCommands(s)
        return (result = advance(cmds, s.settings.hotkeys, pending, c))
      }
      const setPending = (next: string[]) => {
        pending = next
        clearTimeout(timer)
        if (next.length > 0) timer = setTimeout(() => setPending([]), CHORD_TIMEOUT_MS)
        useStore.setState({ pendingChord: next })
      }
      const dispatch = (overModals: boolean) => {
        const r = resolve()
        if (r.type === 'abort') {
          e.preventDefault()
          setPending([])
          return true
        }
        if (r.type === 'wait') {
          if (overModals) return false
          e.preventDefault()
          setPending(r.pending)
          return true
        }
        if (r.type !== 'run' || WORKS_OVER_MODALS.has(r.cmd.id) !== overModals) return false
        setPending([])
        if (r.cmd.id === 'palette:go' && s.palette !== null) return false
        // Claimed even when the command does not apply right now: Ctrl+R would
        // otherwise reload the webview and Ctrl+W close it.
        e.preventDefault()
        if (r.cmd.when !== false) void r.cmd.run()
        return true
      }
      if (dispatch(true)) return

      // Escape here only closes the palette, which is hand-rolled. Dialogs and
      // menus dismiss themselves through the ui layer — unmounting them from
      // out here would pre-empt the close sequence that restores focus to
      // whatever opened them.
      if (e.key === 'Escape') {
        if (s.palette !== null) {
          s.setPalette(null)
          return
        }
        // The details page is a read-only detour from the rows, so Escape backs
        // out of it the way it closes anything else opened on top.
        if (s.view === 'details' || s.view === 'hotkeys') s.setView('data')
        return
      }

      // Everything below would otherwise steal keys from the palette or a
      // dialog while the user is typing in it.
      if (s.palette !== null || s.dialog.kind !== 'none') {
        if (pending.length > 0) setPending([])
        return
      }

      if (recoverFocus(e)) return

      if (dispatch(false)) return

      // Ctrl+S is Accept changes: it opens the review and runs nothing. Claimed
      // from any view while something is staged — edits outlive the table they
      // were made in — and over a grid otherwise, so the browser's own save-page
      // never appears there; with nothing staged it says so.
      if (
        mod &&
        !e.shiftKey &&
        e.key.toLowerCase() === 's' &&
        (s.stagedSummary.total > 0 || (s.view === 'data' && s.activeRef))
      ) {
        e.preventDefault()
        void s.reviewChanges()
        return
      }

      // Alt+[ and Alt+] step through the SQL editor's kept runs. Claimed inside
      // the editor too: CodeMirror leaves both unbound. e.code, not e.key, since
      // some layouts type a character on Alt+bracket.
      if (
        s.view === 'sql' &&
        e.altKey &&
        !mod &&
        !e.shiftKey &&
        (e.code === 'BracketLeft' || e.code === 'BracketRight')
      ) {
        e.preventDefault()
        s.stepSqlRun(e.code === 'BracketLeft' ? -1 : 1)
        return
      }

      // Tab flips the grid's axes. Claimed only when a grid is actually on
      // screen and the caret is not in a field, so Tab keeps meaning "next
      // control" everywhere else — and Shift+Tab is left alone entirely, so
      // there is always a way to traverse focus backwards out of the grid.
      if (!typing && !mod && !e.shiftKey && e.key === 'Tab' && gridOnScreen(s)) {
        e.preventDefault()
        s.toggleTransposed()
        return
      }
    }

    // The side buttons of a mouse: 3 is back, 4 is forward. The webview would
    // treat them as history navigation, of which this app has none, so every
    // event of the press is claimed in the capture phase. They walk the
    // active tab's own history; with Shift they move between tabs.
    const onMouse = (e: MouseEvent | PointerEvent) => {
      if (e.button !== 3 && e.button !== 4) return
      e.preventDefault()
      // The side buttons arrive as pointerdown / pointerup / auxclick and never
      // as mousedown / mouseup, so the pointer event is the one acted on; the
      // others are only silenced so the webview does not navigate.
      if (e.type !== 'pointerup') return
      const s = useStore.getState()
      if (s.palette !== null || s.dialog.kind !== 'none') return
      const delta = e.button === 3 ? -1 : 1
      if (e.shiftKey) s.cycleTab(delta)
      else void s.stepHistory(delta)
    }

    window.addEventListener('keydown', onKey)
    for (const type of ['mousedown', 'mouseup', 'auxclick', 'pointerdown', 'pointerup'] as const) {
      window.addEventListener(type, onMouse, true)
    }
    return () => {
      window.removeEventListener('keydown', onKey)
      for (const type of [
        'mousedown',
        'mouseup',
        'auxclick',
        'pointerdown',
        'pointerup',
      ] as const) {
        window.removeEventListener(type, onMouse, true)
      }
    }
  }, [])
}

/** Whether a result grid is the thing the user is looking at. */
function gridOnScreen(s: ReturnType<typeof useStore.getState>): boolean {
  if (s.view === 'data') return s.result !== null && s.activeRef !== null
  if (s.view === 'sql') return activeSqlResult(s) !== null
  return false
}

import { useCallback, useEffect } from 'react'
import { focusFilter, focusTableSearch } from '../commands'
import { isTypingTarget } from '../dom'
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
import { ConfirmResetSampleDialog } from './ConfirmResetSampleDialog'
import { ConnectionDialog } from './ConnectionDialog'
import { DataGrid } from './DataGrid'
import { EmptyPanel } from './EmptyPanel'
import { FilterBar } from './FilterBar'
import { NewTableDialog } from './NewTableDialog'
import { ConfirmDropDialog, ConfirmTruncateDialog } from './ObjectMenu'
import { Paginator } from './Paginator'
import { ReviewChangesDialog } from './ReviewChangesDialog'
import { SettingsDialog } from './SettingsDialog'
import { PasswordDialog } from './PasswordDialog'
import { ShortcutsDialog } from './ShortcutsDialog'
import { SqlEditor } from './SqlEditor'
import { TabStrip } from './TabStrip'
import { StorageNotice } from './StorageNotice'
import { WorkspacePicker } from './WorkspacePicker'
import { Toasts } from './Toasts'

export function App() {
  const init = useStore((s) => s.init)
  const tabStripHidden = useStore((s) => s.settings.tabStripHidden)
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
  const toggleSort = useStore((s) => s.toggleSort)
  const loadMore = useStore((s) => s.loadMore)
  const infinite = useStore(isInfinite)
  const openCell = useStore((s) => s.openCell)
  const cellMenu = useCellMenu('browse')
  // Stable, so the memoised grid is not re-rendered by an inline arrow every
  // time something else in the shell changes — `busy` toggling on each query
  // is enough on its own.
  const onSort = useCallback((column: string) => void toggleSort(column), [toggleSort])
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

        <main className="island flex min-w-0 flex-1 flex-col">
          {view === 'activity' ? (
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
        />
      )}
      {dialog.kind === 'shortcuts' && <ShortcutsDialog />}
      {dialog.kind === 'settings' && <SettingsDialog />}
      {dialog.kind === 'cell' && <CellDialog cell={dialog.cell} />}
      {dialog.kind === 'confirmDelete' && (
        <ConfirmDeleteDialog name={dialog.connection.name} id={dialog.connection.id} />
      )}
      {dialog.kind === 'confirmResetSample' && <ConfirmResetSampleDialog />}
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
    </div>
  )
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center text-[var(--color-faint)]">{text}</div>
  )
}

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
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState()
      const mod = e.ctrlKey || e.metaKey
      const target = e.target as HTMLElement | null
      const typing = isTypingTarget(target)

      // The two palettes. Ctrl+P goes somewhere, Ctrl+Shift+P does something —
      // the same split as an editor's quick-open versus command palette.
      // preventDefault matters on Ctrl+P: the webview would otherwise print.
      //
      // Handled before the typing guard so a palette is reachable from the
      // filter box and the SQL editor, which is most of where the caret is.
      // Ctrl+P *inside* an open palette belongs to it (move-up), so the switch
      // only fires when none is open.
      if (mod && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        s.setPalette(s.palette === 'do' ? null : 'do')
        return
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'p' && s.palette === null) {
        e.preventDefault()
        s.setPalette('go')
        return
      }

      // Ctrl+K used to open the "go" palette as well, and Ctrl+J the tray. Both
      // letters now belong to the grid's vim movement — Ctrl+H/J/K/L — because
      // hjkl is only worth having if all four are the same modifier. The
      // palettes keep Ctrl+P and Ctrl+Shift+P, which were always the primary
      // pair; the tray moved to Ctrl+` , as a bottom panel is in an editor.

      // Ctrl+, is conventional for preferences and is worth honouring even
      // from inside a dialog, so it is handled before the modal guard.
      if (mod && e.key === ',') {
        e.preventDefault()
        s.setDialog({ kind: 'settings' })
        return
      }

      // Ctrl+. stops the editor's running statement. Claimed before the typing
      // guard so it works with the caret in the editor, which is where it is
      // needed. No CodeMirror binding uses it, and Escape cannot be the key: it
      // already closes popups and the palette.
      if (mod && !e.shiftKey && e.key === '.') {
        e.preventDefault()
        if (s.sqlRun) void s.cancelSql()
        return
      }

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
        if (s.view === 'details') s.setView('data')
        return
      }

      // Everything below would otherwise steal keys from the palette or a
      // dialog while the user is typing in it.
      if (s.palette !== null || s.dialog.kind !== 'none') return

      // Ctrl+= is the unshifted half of Ctrl++, so both keys zoom in. preventDefault
      // stops the webview applying its own page zoom on top.
      if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        void s.adjustFontSize(1)
        return
      }
      if (mod && (e.key === '-' || e.key === '_')) {
        e.preventDefault()
        void s.adjustFontSize(-1)
        return
      }
      if (mod && e.key === '0') {
        e.preventDefault()
        void s.resetFontSize()
        return
      }

      if (mod && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        void s.setTabStrip(s.settings.tabStripHidden)
        return
      }

      // Tabs. Ctrl+Tab and Ctrl+PageUp/PageDown cycle as in a browser; Ctrl+T and
      // Ctrl+W open and close. The Tab key itself still means "transpose" below,
      // which is why that rule insists on no modifier.
      if (mod && (e.key === 'Tab' || e.key === 'PageDown' || e.key === 'PageUp')) {
        e.preventDefault()
        s.cycleTab(e.key === 'PageUp' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1)
        return
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault()
        s.newTab()
        return
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault()
        s.reopenTab()
        return
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'w') {
        e.preventDefault()
        s.closeTab()
        return
      }

      if (mod && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        s.setView(s.view === 'activity' ? 'data' : 'activity')
        return
      }

      // Ctrl+` for the bottom tray, as in every editor with a bottom panel.
      if (mod && e.key === '`') {
        e.preventDefault()
        s.setTrayOpen(!s.trayOpen)
        return
      }

      // Ctrl+L, as for a browser's location bar: works from inside a field too.
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        void focusTableSearch(s)
        return
      }

      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        if (s.view !== 'data') s.setView('data')
        // The bar only exists once a table is open; focusing after the render
        // that mounts it is what makes Ctrl+F work on the first press.
        requestAnimationFrame(focusFilter)
        return
      }

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

      if (mod && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        s.setView(s.view === 'sql' ? 'data' : 'sql')
        return
      }

      if (mod && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        void s.reload()
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

      // The tab's open tables: Alt+W closes the one on screen, Alt+PageUp /
      // PageDown move between them. e.code, since some layouts type a
      // character on Alt+W.
      if (e.altKey && !mod && !e.shiftKey && e.code === 'KeyW') {
        e.preventDefault()
        void s.closeOpenTable()
        return
      }
      if (e.altKey && !mod && !e.shiftKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
        e.preventDefault()
        void s.cycleOpenTable(e.key === 'PageUp' ? -1 : 1)
        return
      }

      // Alt+arrows are the browser's back and forward, and the keyboard twin of
      // the mouse buttons. Left alone inside the SQL editor, which uses them to
      // move by syntax; a plain <input> has no use for them.
      if (
        !target?.isContentEditable &&
        e.altKey &&
        !mod &&
        !e.shiftKey &&
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
      ) {
        e.preventDefault()
        void s.stepHistory(e.key === 'ArrowLeft' ? -1 : 1)
        return
      }

      // Ctrl+arrow toggles the pane on that edge. Skipped while typing, where
      // Ctrl+Left/Right mean "move by word". There is no top or right pane, so
      // those arrows are free.
      if (!typing && mod && !e.shiftKey && !e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault()
        void s.setTabStrip(s.settings.tabStripHidden)
        return
      }
      if (!typing && mod && !e.shiftKey && !e.altKey && e.key === 'ArrowDown') {
        e.preventDefault()
        s.setTrayOpen(!s.trayOpen)
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

import { useStore } from '../store'
import { Dialog, dialogButton } from '../ui'

const SHORTCUTS: [string, string][] = [
  ['Ctrl+P', 'Go to a connection, database or table'],
  ['Ctrl+Shift+P', 'Run a command — settings, editor, activity'],
  ['Ctrl+,', 'Settings'],
  ['Ctrl+F  /  /', 'Focus the WHERE filter'],
  ['Enter', 'Apply the filter'],
  ['Ctrl+E', 'Toggle the SQL editor'],
  ['Ctrl+Enter', 'Run the query, or only the selected text (in the editor)'],
  ['Ctrl+R', 'Refresh the current rows'],
  ['Ctrl+Shift+R', 'Reload the app — the escape hatch if the UI wedges'],
  ['Ctrl+←  /  Ctrl+→', 'Previous / next page'],
  ['Ctrl+`', 'Toggle the activity tray (query log)'],
  ['Ctrl+Shift+A', 'Open connections'],
  ['Tab', 'Transpose the grid — column names down the side, one record per column'],
  ['Right-click  /  Menu', 'Cell actions in the grid, connection actions in the sidebar'],
  ['Click  /  Shift+click', 'Select a cell, then extend the range to another'],
  ['Ctrl+H J K L', 'Move a cell — hjkl, as the arrows do; add Shift to extend'],
  ['Shift+arrows  /  Ctrl+A', 'Extend the range by cell / select the whole result'],
  ['Ctrl+C', 'Copy — a cell as-is, one column as an IN list, wider as CSV'],
  ['Enter', 'Open the selected cell (JSON viewer, full value) — also on right-click'],
  ['Double-click', 'Select the text inside a cell, as anywhere else'],
  ['F2', 'Edit the selected cell — Enter stages it, Esc cancels, nothing is written yet'],
  ['Shift+F2', 'Edit the cell in the large editor — long, multi-line and JSON values open there on F2'],
  ['Ctrl+Backspace', 'Stage NULL over the selected cells'],
  ['Ctrl+Z', 'Undo the last staged edit'],
  ['Ctrl+S', 'Accept changes — lists every statement across every table; Run writes them, Esc cancels'],
  ['Drag a column edge', 'Resize it · double-click the edge to fit its contents'],
  ['Double-click the gutter edge', 'Fit every column to its contents at once'],
  ['↑ ↓  /  Ctrl+P N J K', 'Move through the palette'],
  ['Esc', 'Close, or revert an unapplied filter'],
]

export function ShortcutsDialog() {
  const setDialog = useStore((s) => s.setDialog)
  const close = () => setDialog({ kind: 'none' })

  return (
    <Dialog
      open
      onClose={close}
      title="Keyboard shortcuts"
      widthClass="w-[min(28rem,92vw)]"
      footer={
        <button onClick={close} className={`ml-auto ${dialogButton.secondary}`}>
          Close
        </button>
      }
    >
      <dl className="p-4">
        {SHORTCUTS.map(([key, what]) => (
          <div key={key} className="flex items-baseline gap-4 py-1">
            <dt className="w-44 shrink-0 font-[var(--font-mono)] text-[var(--color-accent)]">
              {key}
            </dt>
            <dd className="text-[var(--color-muted)]">{what}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  )
}

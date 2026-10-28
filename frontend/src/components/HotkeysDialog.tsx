import { useState } from 'react'
import { useStore } from '../store'
import { chord, conflict, bindingsFor, HOTKEY_ACTIONS } from '../hotkeys'
import { Dialog, dialogButton } from '../ui'

/**
 * Rebind the pane, palette and tab keys. Changes save as they are made: a
 * remap you must remember to confirm is one you lose when the dialog closes.
 */
export function HotkeysDialog() {
  const settings = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)
  const setDialog = useStore((s) => s.setDialog)
  const [recording, setRecording] = useState<string | null>(null)
  const [warning, setWarning] = useState('')

  const overrides = settings.hotkeys ?? {}
  const save = (next: Record<string, string>) => void saveSettings({ ...settings, hotkeys: next })

  const reset = (id: string) => {
    const { [id]: _, ...rest } = overrides
    save(rest)
    setWarning('')
  }

  const onKeyDown = (id: string, e: React.KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') return setRecording(null)
    const c = chord(e.nativeEvent)
    if (!c) return
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      setWarning('Include Ctrl or Alt so the key still works while typing.')
      return
    }
    const clash = conflict(overrides, id, c)
    if (clash) {
      setWarning(`${c} is already ${clash.label}. Rebind that one first.`)
      return
    }
    setWarning('')
    setRecording(null)
    save({ ...overrides, [id]: c })
  }

  return (
    <Dialog
      open
      onClose={() => setDialog({ kind: 'none' })}
      title="Hotkeys"
      widthClass="w-[min(34rem,94vw)]"
      footer={
        <>
          <button
            onClick={() => {
              save({})
              setWarning('')
            }}
            className={dialogButton.ghost}
          >
            Reset all
          </button>
          <button
            onClick={() => setDialog({ kind: 'settings' })}
            className={`ml-auto ${dialogButton.ghost}`}
          >
            Back to settings
          </button>
          <button onClick={() => setDialog({ kind: 'none' })} className={dialogButton.secondary}>
            Close
          </button>
        </>
      }
    >
      <div className="p-4">
        <ul className="flex flex-col gap-1">
          {HOTKEY_ACTIONS.map((a) => (
            <li key={a.id} className="flex items-center gap-3 py-1">
              <span className="min-w-0 flex-1">{a.label}</span>
              <button
                type="button"
                autoFocus={recording === a.id}
                onClick={() => {
                  setRecording(a.id)
                  setWarning('')
                }}
                onKeyDown={recording === a.id ? (e) => onKeyDown(a.id, e) : undefined}
                onBlur={() => recording === a.id && setRecording(null)}
                className="min-w-40 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-panel)] px-2 py-1 text-left font-[var(--font-mono)] text-[var(--color-accent)]"
              >
                {recording === a.id ? 'Press keys…' : bindingsFor(overrides, a.id).join('  /  ')}
              </button>
              <button
                type="button"
                disabled={!overrides[a.id]}
                onClick={() => reset(a.id)}
                className="text-[var(--color-muted)] disabled:opacity-30"
              >
                Reset
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-3 min-h-5 text-[var(--color-faint)]" role="status">
          {warning || 'Click a key, then press the new combination. Esc cancels.'}
        </p>
      </div>
    </Dialog>
  )
}

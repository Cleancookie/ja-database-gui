// Warns before the window or tab closes with staged edits that were never applied.
// Wails: Go holds the window open (OnBeforeClose) and asks the UI, which shows
// ConfirmCloseDialog. Browser: the native beforeunload prompt does the asking.

import { api, transportName } from './api'
import { useStore } from './store'
import { hasUnsavedChanges } from './unsaved'

export function installUnsavedGuard(): void {
  let dirty = hasUnsavedChanges(useStore.getState())
  const report = () => {
    if (transportName === 'wails') void api.setUnsavedChanges(dirty).catch(() => {})
  }
  useStore.subscribe((s) => {
    const now = hasUnsavedChanges(s)
    if (now === dirty) return
    dirty = now
    report()
  })
  window.runtime?.EventsOn('close-requested', () =>
    useStore.getState().setDialog({ kind: 'confirmClose' }),
  )
  window.addEventListener('beforeunload', (e) => {
    if (transportName === 'wails' || !dirty) return
    e.preventDefault()
    e.returnValue = ''
  })
}

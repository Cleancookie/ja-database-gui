// Warns before the window or tab closes with staged edits that were never applied.
// Wails: Go owns the dialog (OnBeforeClose), so the UI only reports whether
// anything is staged. Browser: the native beforeunload prompt does the asking.

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
  window.addEventListener('beforeunload', (e) => {
    if (transportName === 'wails' || !dirty) return
    e.preventDefault()
    e.returnValue = ''
  })
}

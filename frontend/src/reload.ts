/**
 * Reloading the whole app.
 *
 * The escape hatch for a hard crash: whatever state the UI has got itself
 * into, Ctrl+Shift+R starts the webview over. Connections live in the Go
 * process, so a reload costs the view and not the session.
 *
 * Why not in `useGlobalHotkeys` with every other shortcut: that hook lives
 * inside `App`, and `App` unmounting is precisely the crash this key is for.
 * Its effect cleanup removes the listener on the way down, so the one moment
 * you need the key is the one moment it would be gone. Registered from
 * main.tsx at module scope instead, outside React's lifecycle entirely.
 */

/**
 * Ctrl+Shift+R — or Cmd+Shift+R.
 *
 * Shift is what separates it from plain Ctrl+R, which already means "refresh
 * the current rows".
 */
export function isAppReloadKey(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'r'
}

/** Binds the key for the life of the document. Never unbound. */
export function installAppReload() {
  window.addEventListener('keydown', (e) => {
    if (!isAppReloadKey(e)) return
    e.preventDefault()
    window.location.reload()
  })
}

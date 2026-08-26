/**
 * Whether a key event came from somewhere the user is typing.
 *
 * Window-level hotkeys need this: a cell stays selected while a filter is being
 * typed, so without it Enter would both apply the filter *and* open the cell
 * viewer, and Ctrl+C would copy the grid instead of the selection in the box.
 *
 * `contentEditable` is the case that matters and the one that was missed. The
 * filter box used to be an `<input>`, so an `instanceof HTMLInputElement` check
 * covered it; it is now a CodeMirror editor, whose editable surface is a
 * contenteditable div. Any check that enumerates element *types* will keep
 * going stale as surfaces change, so this asks the question the callers
 * actually mean: is focus somewhere that consumes typing?
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return true
  }
  // isContentEditable is true on descendants of a contenteditable host too, so
  // this covers a nested span inside the editor as well as its content element.
  return target.isContentEditable
}

/**
 * Hands the user a text file. An object URL and a synthetic click on an
 * `<a download>` is the platform's own save path — it works in the browser dev
 * server and in the WebView2/WebKit shells Wails puts around the same bundle,
 * so no Go-side file dialog has to exist for it.
 */
export function downloadText(filename: string, text: string, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

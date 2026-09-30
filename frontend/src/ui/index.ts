/**
 * The app's component API.
 *
 * Import from here, never from a vendor package directly — see ./README.md
 * for why that boundary matters.
 */
export { Dialog, FormDialog, dialogButton } from './Dialog'
export type { DialogProps } from './Dialog'
export { ContextMenu } from './Menu'
export type { ContextMenuProps, MenuItem } from './Menu'
// Deliberately the lazy wrapper, not ./Editor itself — importing the real one
// here would pull CodeMirror into the startup bundle and undo the split.
export { Editor } from './LazyEditor'
export type { EditorProps, EditorHandle, EditorCompletion } from './Editor'
// Lazy for the same reason: see ./README.md.
export { CodeEditor } from './LazyCodeEditor'
export type { CodeEditorProps, CodeEditorHandle } from './CodeEditor'

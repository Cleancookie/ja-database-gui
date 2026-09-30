import { lazy, Suspense } from 'react'
import type { CodeEditorProps } from './CodeEditor'

/**
 * The large-text editor, loaded on demand for the same reason as `LazyEditor`:
 * CodeMirror is the biggest thing in the bundle and this surface opens only
 * when someone edits a long value. The fallback reserves the editor's box.
 */
const Impl = lazy(() => import('./CodeEditor').then((m) => ({ default: m.CodeEditor })))

export function CodeEditor(props: CodeEditorProps) {
  return (
    <Suspense fallback={<div className={props.className} aria-busy="true" />}>
      <Impl {...props} />
    </Suspense>
  )
}

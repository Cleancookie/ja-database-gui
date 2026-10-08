import { useEffect, useImperativeHandle, useRef } from 'react'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { json } from '@codemirror/lang-json'
import { HighlightStyle, codeFolding, foldGutter, foldKeymap, syntaxHighlighting } from '@codemirror/language'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { tags } from '@lezer/highlight'

/**
 * A large-text editor: line numbers, wrapping, JSON highlighting and folding.
 *
 * The other CodeMirror in `Editor.tsx` is a SQL editor with completion and a
 * controlled value, which is the wrong shape for editing a document of several
 * megabytes: a controlled value means the whole text is copied into React on
 * every keystroke. Here the document lives in CodeMirror's state and is read
 * once, when the user stages it, through `getValue`. The only per-keystroke
 * work the app sees is `onDocChange`, debounced, which carries no text.
 *
 * CodeMirror stays behind `src/ui/`, and this file is lazy-loaded with the
 * rest of it — see `LazyCodeEditor.tsx`.
 */

export interface CodeEditorHandle {
  getValue: () => string
  setValue: (text: string) => void
  focus: () => void
}

export interface CodeEditorProps {
  /** The text it opens with. Later changes go through `setValue`. */
  initialValue: string
  language: 'json' | 'text'
  /** The document changed; ask `getValue` for what it is now. Debounced. */
  onDocChange?: () => void
  /** Ctrl/Cmd+Enter. */
  onSubmit?: () => void
  ariaLabel?: string
  className?: string
  handleRef: React.Ref<CodeEditorHandle>
}

const DEBOUNCE_MS = 150

const highlight = HighlightStyle.define([
  { tag: tags.propertyName, color: 'var(--color-accent)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--color-success)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--color-warn)' },
  { tag: [tags.punctuation, tags.separator, tags.bracket], color: 'var(--color-muted)' },
])

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--color-text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)', lineHeight: '1.5' },
  '.cm-content': { caretColor: 'var(--color-accent)' },
  '.cm-gutters': {
    backgroundColor: 'var(--color-panel)',
    color: 'var(--color-faint)',
    border: 'none',
    borderRight: '1px solid var(--color-border)',
  },
  '.cm-foldGutter span': { cursor: 'pointer', padding: '0 0.25rem' },
  '.cm-foldGutter span:hover': { color: 'var(--color-accent)' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--color-panel)',
    color: 'var(--color-muted)',
    border: '1px solid var(--color-border)',
    padding: '0 0.25rem',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--color-accent-dim)',
  },
})

const languageFor = (l: CodeEditorProps['language']): Extension => (l === 'json' ? json() : [])

export function CodeEditor({
  initialValue,
  language,
  onDocChange,
  onSubmit,
  ariaLabel,
  className = '',
  handleRef,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const lang = useRef(new Compartment())
  const live = useRef({ onDocChange, onSubmit })
  live.current = { onDocChange, onSubmit }

  useImperativeHandle(handleRef, () => ({
    getValue: () => view.current?.state.doc.toString() ?? '',
    setValue: (text) => {
      const v = view.current
      if (!v) return
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } })
    },
    focus: () => view.current?.focus(),
  }))

  useEffect(() => {
    if (!host.current) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          lineNumbers(),
          codeFolding(),
          foldGutter(),
          history(),
          syntaxHighlighting(highlight),
          theme,
          lang.current.of(languageFor(language)),
          EditorView.lineWrapping,
          // Claimed before the defaults. Escape is left alone on purpose: it
          // reaches the dialog, which decides whether edits need confirming.
          keymap.of([
            {
              key: 'Mod-Enter',
              run: () => {
                live.current.onSubmit?.()
                return true
              },
            },
          ]),
          keymap.of([...foldKeymap, ...historyKeymap, ...defaultKeymap]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return
            clearTimeout(timer)
            timer = setTimeout(() => live.current.onDocChange?.(), DEBOUNCE_MS)
          }),
        ],
      }),
    })
    view.current = v
    if (ariaLabel) v.contentDOM.setAttribute('aria-label', ariaLabel)
    v.contentDOM.setAttribute('spellcheck', 'false')
    v.focus()
    return () => {
      clearTimeout(timer)
      v.destroy()
      view.current = null
    }
    // The document is not a prop after mount; rebuilding for it would lose the
    // caret and the undo history on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    view.current?.dispatch({ effects: lang.current.reconfigure(languageFor(language)) })
  }, [language])

  return <div ref={host} className={className} />
}

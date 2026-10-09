import { useEffect, useImperativeHandle, useRef } from 'react'
import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionKeymap,
  completionStatus,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { sql, MySQL, PostgreSQL, MSSQL, SQLite, type SQLDialect } from '@codemirror/lang-sql'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view'
import { selectionToRun } from '../sqlRun'

/**
 * A SQL text editor.
 *
 * CodeMirror 6 sits behind this file and must not appear anywhere else in the
 * app — see ./README.md. It was chosen over Monaco because it is modular
 * enough to pay for only what is used here, needs no web worker (the Wails
 * build serves embedded assets, where a worker is awkward), and ships real SQL
 * dialects. What it buys beyond a textarea is the completion popup with its
 * own keyboard handling and collision-aware positioning, dialect-aware
 * tokenising for highlighting, and the room to add error squiggles later
 * without another dependency decision.
 *
 * The API here is narrow on purpose: a value, a change callback, and the two
 * keys this app binds. No CodeMirror type is exported.
 */

/** What the app hands over for completion — no editor types involved. */
export interface EditorCompletion {
  /** Every candidate that could be offered, ranked by `boost`. */
  options: { label: string; boost: number; kind: string; detail?: string }[]
  /**
   * The token under the caret, or null to suppress the popup entirely (inside
   * a string literal, for instance). Given the whole text and the caret.
   */
  tokenAt: (text: string, caret: number) => { from: number; word: string } | null
}

export interface EditorHandle {
  focus: () => void
  /** Focuses with the caret after the last character, scrolled into view. */
  focusEnd: () => void
  /** Selects everything, matching what focusing an input used to do. */
  focusAndSelectAll: () => void
  blur: () => void
  /**
   * The text Run should send when something is selected, else null. Read from
   * the view at call time so the selection never has to live in React state.
   */
  selectedSql: () => string | null
  /**
   * Replaces the selection (or the whole document when nothing is selected)
   * with `fn`'s result, as one transaction so a single undo reverts it. Does
   * nothing if the document changed while `fn` was pending. A rejection from
   * `fn` leaves the text untouched and propagates.
   */
  transformText: (fn: (text: string) => Promise<string>) => Promise<void>
}

export interface EditorProps {
  value: string
  onChange: (value: string) => void
  /**
   * Enter in a single-line editor, Ctrl/Cmd+Enter in a multi-line one. Not
   * called while the completion popup is open — there, the key belongs to the
   * popup, which is the behaviour people expect from every other editor.
   */
  onSubmit?: () => void
  /** Escape, only when the popup is closed. */
  onCancel?: () => void
  /** Shift+Alt+F. */
  onFormat?: () => void
  /**
   * Fires only when "is there a runnable selection" flips, not per keystroke
   * or caret move. Lets a button label follow the selection cheaply.
   */
  onHasSelectionChange?: (has: boolean) => void
  /**
   * Single-line mode: newlines are rejected, so the editor behaves like an
   * input. Used by the filter box, whose value is one SQL fragment.
   */
  singleLine?: boolean
  placeholder?: string
  dialect?: 'mysql' | 'postgres' | 'mssql' | 'sqlite' | null
  completion?: EditorCompletion
  autoFocus?: boolean
  ariaLabel?: string
  /** Applied to the editor's own scroll element. */
  className?: string
  id?: string
  handleRef?: React.Ref<EditorHandle>
}

const DIALECTS: Record<string, SQLDialect> = {
  mysql: MySQL,
  postgres: PostgreSQL,
  mssql: MSSQL,
  sqlite: SQLite,
}

/**
 * The app's own palette, mapped onto syntax tags.
 *
 * CodeMirror ships no theme, which is the same reason Radix was chosen for the
 * component layer: the styling stays ours. These are the tokens from
 * index.css, so the editor cannot drift from the rest of the app.
 */
const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--color-accent)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--color-success)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--color-warn)' },
  { tag: tags.comment, color: 'var(--color-faint)', fontStyle: 'italic' },
  { tag: [tags.operator, tags.punctuation], color: 'var(--color-muted)' },
  { tag: tags.typeName, color: 'var(--color-muted)' },
])

/**
 * Theme for the editor's own chrome. `!important` is avoided; these selectors
 * are all CodeMirror's, so specificity is not being fought over.
 */
const theme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--color-text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': {
    fontFamily: 'var(--font-mono)',
    caretColor: 'var(--color-accent)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-accent)' },
  '.cm-placeholder': { color: 'var(--color-faint)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--color-accent-dim)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--color-elevated)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-xl)',
    padding: '0.25rem',
    boxShadow: 'var(--shadow-lg)',
    overflow: 'hidden',
    // The tray sits at the bottom of the window; a popup that renders under
    // it would be unreadable in exactly the case it is needed.
    zIndex: '60',
  },
  '.cm-tooltip-autocomplete ul li': {
    fontFamily: 'var(--font-mono)',
    padding: '3px 8px',
    borderRadius: 'var(--radius-md)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--color-accent-dim)',
    color: 'var(--color-text)',
  },
  '.cm-completionDetail': {
    color: 'var(--color-faint)',
    fontStyle: 'normal',
    marginLeft: '0.75rem',
  },
  '.cm-completionIcon': { display: 'none' },
})

export function Editor({
  value,
  onChange,
  onSubmit,
  onCancel,
  onFormat,
  onHasSelectionChange,
  singleLine = false,
  placeholder,
  dialect,
  completion,
  autoFocus,
  ariaLabel,
  className = '',
  id,
  handleRef,
}: EditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)

  // Callbacks and candidates are read through a ref so that changing them —
  // which happens on every keystroke, since onChange closes over fresh state —
  // does not tear down and rebuild the editor.
  const live = useRef({ onChange, onSubmit, onCancel, onFormat, onHasSelectionChange, completion })
  live.current = { onChange, onSubmit, onCancel, onFormat, onHasSelectionChange, completion }
  const hadSelection = useRef(false)

  const language = useRef(new Compartment())

  useImperativeHandle(handleRef, () => ({
    focus: () => view.current?.focus(),
    focusEnd: () => {
      const v = view.current
      if (!v) return
      v.focus()
      v.dispatch({ selection: { anchor: v.state.doc.length }, scrollIntoView: true })
    },
    focusAndSelectAll: () => {
      const v = view.current
      if (!v) return
      v.focus()
      v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } })
    },
    blur: () => view.current?.contentDOM.blur(),
    selectedSql: () => {
      const v = view.current
      if (!v) return null
      const { ranges, mainIndex } = v.state.selection
      return selectionToRun(v.state.doc.toString(), ranges, mainIndex)
    },
    transformText: async (fn) => {
      const v = view.current
      if (!v) return
      const before = v.state.doc
      const { from, to } = v.state.selection.main
      const whole = from === to
      const [a, b] = whole ? [0, before.length] : [from, to]
      const next = await fn(before.sliceString(a, b))
      if (view.current !== v || v.state.doc !== before || next === before.sliceString(a, b)) return
      v.dispatch({
        changes: { from: a, to: b, insert: next },
        selection: whole
          ? { anchor: Math.min(from, a + next.length) }
          : { anchor: a, head: a + next.length },
        userEvent: 'input.format',
        scrollIntoView: true,
      })
    },
  }))

  useEffect(() => {
    if (!host.current) return

    const submitKey = singleLine ? 'Enter' : 'Mod-Enter'
    const extensions: Extension[] = [
      history(),
      syntaxHighlighting(highlight),
      theme,
      language.current.of(sqlExtension(dialect)),
      EditorView.lineWrapping,
      // Ordered before the default keymaps so these keys are claimed first,
      // but each handler declines when the popup owns the key.
      keymap.of([
        {
          key: submitKey,
          run: (v) => {
            if (completionStatus(v.state) === 'active') return false
            live.current.onSubmit?.()
            return true
          },
        },
        {
          key: 'Escape',
          run: (v) => {
            if (completionStatus(v.state) !== null) {
              closeCompletion(v)
              return true
            }
            if (!live.current.onCancel) return false
            live.current.onCancel()
            return true
          },
        },
        {
          key: 'Shift-Alt-f',
          run: () => {
            if (!live.current.onFormat) return false
            live.current.onFormat()
            return true
          },
        },
        // Tab accepts a completion when one is selected; otherwise it indents,
        // which is what the textarea this replaced already did.
        { key: 'Tab', run: acceptCompletion },
      ]),
      keymap.of([...completionKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
      autocompletion({
        override: [(ctx) => complete(ctx, live.current.completion)],
        icons: false,
        // Nothing here is destructive, and a filter fragment is short: showing
        // the list without a keypress is help rather than noise.
        activateOnTyping: true,
        closeOnBlur: true,
      }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) live.current.onChange(u.state.doc.toString())
        if (u.selectionSet || u.docChanged) {
          const { ranges, mainIndex } = u.state.selection
          const main = ranges[mainIndex]
          // Cheap test first: a caret, which is nearly every update, needs no
          // slice of the document.
          const has =
            main.from !== main.to &&
            selectionToRun(u.state.doc.toString(), ranges, mainIndex) !== null
          if (has !== hadSelection.current) {
            hadSelection.current = has
            live.current.onHasSelectionChange?.(has)
          }
        }
      }),
      EditorState.transactionFilter.of((tr) =>
        // Single-line mode is enforced on the transaction rather than by
        // stripping newlines afterwards, so a pasted multi-line value can
        // never briefly exist as a multi-line document.
        singleLine && tr.newDoc.lines > 1 ? [] : tr,
      ),
    ]
    if (placeholder) extensions.push(cmPlaceholder(placeholder))

    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: value, extensions }),
    })
    view.current = v

    const content = v.contentDOM
    if (ariaLabel) content.setAttribute('aria-label', ariaLabel)
    content.setAttribute('spellcheck', 'false')
    if (autoFocus) v.focus()

    return () => {
      v.destroy()
      view.current = null
    }
    // Rebuilt only for structural props. `value` is deliberately excluded —
    // it is synced by the effect below, and rebuilding per keystroke would
    // lose the caret, the undo history and any open popup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [singleLine, placeholder, ariaLabel, autoFocus])

  // The dialect can change without a remount, when the user switches
  // connection with the editor open.
  useEffect(() => {
    view.current?.dispatch({
      effects: language.current.reconfigure(sqlExtension(dialect)),
    })
  }, [dialect])

  // A controlled value that the app may replace from outside — Escape
  // reverting the filter, or a table change clearing it. Guarded so the
  // editor's own edits do not round-trip and reset the caret.
  useEffect(() => {
    const v = view.current
    if (!v) return
    const current = v.state.doc.toString()
    if (current === value) return
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: value },
      selection: { anchor: Math.min(value.length, v.state.selection.main.anchor) },
    })
  }, [value])

  return <div ref={host} id={id} className={className} />
}

function sqlExtension(dialect: EditorProps['dialect']): Extension {
  const d = dialect ? DIALECTS[dialect] : undefined
  // Without a connection there is no dialect to be right about; the generic
  // grammar still highlights and still tokenises for completion.
  return sql(d ? { dialect: d } : undefined)
}

/**
 * Bridges the app's candidate list into CodeMirror's completion protocol.
 *
 * The app decides the token boundary (a dot is part of a qualified name, and a
 * caret inside a string literal suppresses the popup); CodeMirror does the
 * filtering and ranking from there, using `boost` for the ordering the app
 * asked for.
 */
function complete(ctx: CompletionContext, completion?: EditorCompletion): CompletionResult | null {
  if (!completion || completion.options.length === 0) return null

  const text = ctx.state.doc.toString()
  const token = completion.tokenAt(text, ctx.pos)
  if (!token) return null
  // An explicit request (Ctrl+Space) should always offer something; typing
  // should not pop up a list of everything on the first character.
  if (!ctx.explicit && token.word.length === 0) return null

  return {
    from: token.from,
    options: completion.options.map((o) => ({
      label: o.label,
      detail: o.detail,
      type: o.kind,
      boost: o.boost,
    })),
    validFor: /^[\w$.]*$/,
  }
}

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildActionCommands, buildNavigationCommands, type Command } from '../commands'
import { matchPositions, rankCandidates, type Scored } from '../fuzzy'
import { listMove, moveIndex } from '../listNav'
import { useStore } from '../store'
import { Layer } from '../ui'
import { Highlight } from './Highlight'

/**
 * How many rows are ever put in the DOM. The list is not virtualised, and
 * nobody scrolls a fuzzy-matched list past its first screen — past this the
 * answer is a better query, not more rows.
 */
const MAX_ROWS = 200

/**
 * The palettes. Rebuilt from live state each time one opens, so what is offered
 * always reflects what is actually possible right now.
 *
 * There are two, and which one is open is the only difference between them:
 * 'go' (Ctrl+P) lists places — tables, databases, connections; 'do'
 * (Ctrl+Shift+P) lists actions. One combined list meant seventeen tables and
 * twenty commands competing for the same two keystrokes, and neither winning.
 */
export function CommandPalette() {
  const mode = useStore((s) => s.palette)
  const setPalette = useStore((s) => s.setPalette)
  const open = mode !== null
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // Snapshotting on open avoids rebuilding the (potentially large) command
  // list on every keystroke, and stops the list shifting under the cursor if
  // a background refresh lands mid-typing.
  const commands = useMemo(() => {
    if (mode === null) return []
    const s = useStore.getState()
    return mode === 'go' ? buildNavigationCommands(s) : buildActionCommands(s)
  }, [mode])

  // Cut to what is rendered *before* grouping. A database with thousands of
  // tables ranks thousands of candidates, and grouping them all — building a
  // map of arrays and flattening it — to then show two hundred was most of the
  // work done on each keystroke.
  const results = useMemo(
    () => groupContiguously(rankCandidates(query, commands, (c) => c.candidate).slice(0, MAX_ROWS)),
    [query, commands],
  )

  // Reset on a mode change as well as on opening: switching palettes with a
  // query already typed should not carry it across, since the two lists have
  // nothing in common.
  useEffect(() => {
    if (mode !== null) {
      setQuery('')
      setSelected(0)
    }
  }, [mode])

  useEffect(() => {
    setSelected(0)
  }, [query])

  // Keep the highlighted row in view when navigating with the keyboard.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${selected}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  // Stable, so the memoised rows below are not all rebuilt to move a highlight
  // by one. Declared before the early return: hooks cannot be conditional.
  const run = useCallback(
    (cmd: Command | undefined) => {
      if (!cmd) return
      setPalette(null)
      void cmd.run()
    },
    [setPalette],
  )

  if (!open) return null

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Switch palettes without closing. Ctrl+P alone cannot do this: listMove
    // takes it as move-up, and taking it back would cost more than the
    // symmetry is worth.
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'p') {
      e.preventDefault()
      setPalette(mode === 'go' ? 'do' : 'go')
      return
    }
    const move = listMove(e, true)
    if (move) {
      e.preventDefault()
      setSelected((i) => moveIndex(move, i, results.length))
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setPalette(null)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(results[selected]?.item)
    }
  }

  return (
    // A layer of its own, so the palette works over an open dialog — the JSON
    // tree's actions are offered from inside the cell viewer.
    <Layer label={mode === 'go' ? 'Go to' : 'Run a command'} onClose={() => setPalette(null)}>
      <div
        className="chrome animate-fade-in fixed inset-0 z-50 flex items-start justify-center bg-[var(--color-scrim)] pt-[12vh] backdrop-blur-[3px]"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) setPalette(null)
        }}
      >
        <div className="animate-pop-in w-[min(680px,92vw)] overflow-hidden rounded-3xl border border-[var(--color-border)] bg-[var(--color-elevated)] shadow-2xl">
          <div className="flex items-center gap-2.5 border-b border-[var(--color-border)] px-5">
            {/* Which palette this is, stated rather than implied: the two look
              otherwise identical, and typing into the wrong one is the obvious
              way to be confused by a split palette. */}
            <span className="shrink-0 rounded-full bg-[var(--color-accent-dim)]/50 px-2.5 py-0.5 font-bold tracking-wide text-[var(--color-accent)]">
              {mode === 'go' ? 'Go to' : 'Run'}
            </span>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                mode === 'go' ? 'Table, database or connection…' : 'Settings, editor, activity…'
              }
              spellCheck={false}
              aria-label={mode === 'go' ? 'Go to' : 'Command'}
              className="min-w-0 flex-1 bg-transparent py-3.5 outline-none placeholder:text-[var(--color-faint)] focus-visible:shadow-none focus-visible:outline-none"
            />
            <kbd className="shrink-0 rounded-lg border border-[var(--color-border-strong)] px-1.5 py-0.5 font-[var(--font-mono)] text-[var(--color-faint)]">
              Ctrl+Shift+P
            </kbd>
          </div>

          <div ref={listRef} className="max-h-[52vh] overflow-y-auto">
            <Highlight className="p-2">
              {results.length === 0 && (
                <div className="px-4 py-6 text-center text-[var(--color-faint)]">
                  {mode === 'go'
                    ? 'Nothing to go to — connect first, or try Ctrl+Shift+P'
                    : 'No matching commands'}
                </div>
              )}
              {results.map(({ item }, i) => (
                <Row
                  key={item.id}
                  item={item}
                  query={query}
                  index={i}
                  selected={i === selected}
                  heading={i > 0 && results[i - 1].item.group === item.group ? null : item.group}
                  onRun={run}
                />
              ))}
            </Highlight>
          </div>
        </div>
      </div>
    </Layer>
  )
}

/**
 * One result row.
 *
 * Memoised, and every prop it takes is stable while the query is: moving the
 * selection with the arrow keys then re-renders the row being left and the row
 * being entered, not all two hundred. The highlight positions are worked out in
 * here rather than passed in — ranking deliberately does not produce them, and
 * a fresh array as a prop would defeat the memo anyway.
 *
 * Hover uses `mouseenter`, not `mousemove`. With `mousemove` every pixel of
 * pointer movement across the list set the selection again, so the whole list
 * re-rendered at the pointer's sample rate.
 */
const Row = memo(function Row({
  item,
  query,
  index,
  selected,
  heading,
  onRun,
}: {
  item: Command
  query: string
  index: number
  selected: boolean
  /** The group name, when this row is the first of its group. */
  heading: string | null
  onRun: (cmd: Command) => void
}) {
  return (
    <div>
      {heading && (
        <div className="px-3 pt-3 pb-1 font-bold tracking-wider text-[var(--color-faint)] uppercase">
          {heading}
        </div>
      )}
      <button
        data-index={index}
        data-item
        onClick={() => onRun(item)}
        data-highlight={selected || undefined}
        className="relative flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate">
            <Highlighted
              text={item.title}
              positions={alignToTitle(item, matchPositions(query, item.candidate))}
            />
          </span>
          {item.subtitle && (
            <span className="block truncate text-[var(--color-muted)]">{item.subtitle}</span>
          )}
        </span>
        {item.shortcut && (
          <kbd className="shrink-0 rounded-lg border border-[var(--color-border-strong)] px-1.5 py-0.5 font-[var(--font-mono)] text-[var(--color-muted)]">
            {item.shortcut}
          </kbd>
        )}
      </button>
    </div>
  )
})

/**
 * Keeps each group's entries together while preserving relevance order.
 *
 * Ranking alone interleaves groups, and the list renders a heading whenever
 * the group changes — so a plain sorted list produced a dozen repeated
 * headings for seventeen results, which read as no filtering at all.
 *
 * Groups are ordered by their best-scoring member, so the most relevant group
 * still leads, and entries stay in rank order within it.
 */
function groupContiguously<T extends { group: string }>(results: Scored<T>[]): Scored<T>[] {
  const groups = new Map<string, Scored<T>[]>()
  for (const r of results) {
    const list = groups.get(r.item.group)
    if (list) list.push(r)
    else groups.set(r.item.group, [r])
  }
  // Map preserves insertion order, and `results` is already sorted, so the
  // first time a group appears is its best hit.
  return [...groups.values()].flat()
}

/**
 * Shifts match positions from the candidate name onto the displayed title.
 *
 * Positions index `candidate.name` — the bare table name, or a command's core
 * label — while the row renders `title`, which is usually longer: "auth.user"
 * against "user", or "Connect to prod" against "prod". Applied unshifted they
 * highlight the wrong characters entirely.
 *
 * Titles are built by prefixing the name, so a suffix match gives the offset.
 * When the two are unrelated the match came from a schema or hidden keyword
 * and there is nothing honest to highlight.
 */
function alignToTitle(item: Command, positions: number[]): number[] {
  if (positions.length === 0) return positions
  const { title, candidate } = item
  if (!title.endsWith(candidate.name)) return []
  const offset = title.length - candidate.name.length
  return offset === 0 ? positions : positions.map((p) => p + offset)
}

/**
 * Highlights the matched characters.
 */
function Highlighted({ text, positions }: { text: string; positions: number[] }) {
  if (positions.length === 0) return <>{text}</>
  const set = new Set(positions)
  const out: React.ReactNode[] = []
  let run = ''
  let runMatched = set.has(0)

  const flush = (key: number) => {
    if (!run) return
    out.push(
      runMatched ? (
        <span key={key} className="font-semibold text-[var(--color-accent)]">
          {run}
        </span>
      ) : (
        <span key={key}>{run}</span>
      ),
    )
    run = ''
  }

  for (let i = 0; i < text.length; i++) {
    const matched = set.has(i)
    if (matched !== runMatched) {
      flush(i)
      runMatched = matched
    }
    run += text[i]
  }
  flush(text.length)
  return <>{out}</>
}

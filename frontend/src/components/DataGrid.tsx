import { useVirtualizer } from '@tanstack/react-virtual'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { isTypingTarget } from '../dom'
import { inRect, rectOf, type CellPos, type Rect } from '../selection'
import { measuredSpan, offsetToShow, scrollTo, uniformSpan } from '../scroll'
import { useStore, type ResultSource } from '../store'
import { ContextMenu, type MenuItem } from '../ui'
import type { Cell, Column, ResultColumn, ResultSet, Sort } from '../types'

const WIDTH_SAMPLE_ROWS = 120

/**
 * Grid metrics derived from the root font size, so the Settings slider
 * rescales rows, gutters and column widths together. Hardcoded pixels here
 * would leave larger text clipped inside unchanged row heights.
 */
function metrics(rootPx: number) {
  // The grid renders at the root size like everything else, so a character is
  // measured against that and not against a per-component size. See index.css.
  const cellPx = rootPx
  return {
    rowHeight: Math.round(rootPx * 1.625),
    headerHeight: Math.round(rootPx * 1.875),
    gutter: Math.round(rootPx * 3.5),
    // Slightly wider than the true advance of the mono faces we target.
    // Erring high costs a little horizontal space; erring low truncates
    // values, which is the one thing a data grid must not do casually.
    charPx: cellPx * 0.64,
    minCol: Math.round(rootPx * 5.25),
    maxCol: Math.round(rootPx * 28.75),
    padPx: Math.round(rootPx * 1.6),
  }
}

interface Props {
  result: ResultSet
  /** Which result this is, so the selection in the store knows whose it is. */
  source: ResultSource
  /** Introspected column metadata; absent when running ad-hoc SQL. */
  columns?: Column[]
  orderBy?: Sort[]
  onSort?: (column: string) => void
  /** Row offset of the first row, so numbering continues across pages. */
  rowOffset?: number
  /**
   * Opens one cell in the viewer: Enter, or the right-click menu. Deliberately
   * not a double-click — that is how you select the text inside a cell, and a
   * viewer popping open instead is the thing that annoyed us most about it.
   */
  onOpenCell?: (rowIndex: number, colIndex: number) => void
  /**
   * Right-click actions for one cell. A builder rather than a list because the
   * menu wraps the whole row area — one Radix root, not one per cell — and is
   * asked for the items of whichever cell was clicked.
   */
  cellMenu?: (rowIndex: number, colIndex: number) => MenuItem[]
}

/**
 * Virtualised result grid. Only the visible cells are in the DOM — both axes,
 * since a hundred-column result is as ordinary as a 100k-row one and the
 * product of the two is what a render costs.
 *
 * Cells are selectable as a range: click one, shift-click another, or hold shift
 * with the arrow keys. What Ctrl+C then produces is decided by the shape of the
 * range and by nothing else — see frontend/src/selection.ts.
 */
export const DataGrid = memo(function DataGrid({
  result,
  source,
  columns,
  orderBy,
  onSort,
  rowOffset = 0,
  onOpenCell,
  cellMenu,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // The focused cell's own element, so the keyboard menu key can open the
  // context menu where the cell is rather than at the pointer's last position.
  const selectedRef = useRef<HTMLDivElement | null>(null)
  // Whether the move that set the current focus came from a held key. Read by
  // the scroll effects below, which must not animate a repeat — autorepeat is
  // an order of magnitude faster than a smooth scroll and would cancel it on
  // every step. See frontend/src/scroll.ts.
  const repeatRef = useRef(false)
  const rootPx = useStore((s) => s.settings.fontSizePx)
  const transposed = useStore((s) => s.transposed)
  const gm = useMemo(() => metrics(rootPx), [rootPx])

  // Only this grid's own selection: the other result keeps its own, so
  // switching between the browser and the editor does not lose either.
  const selection = useStore((s) => (s.selection?.source === source ? s.selection : null))
  const copyText = useStore((s) => s.copyText)
  // Which header was right-clicked. One menu wraps the whole header strip — a
  // Radix root per column would be one per column on a 200-column table — so
  // it has to be told which column the event came from, the same arrangement
  // the row area uses with the focused cell.
  const [headerCol, setHeaderCol] = useState<number | null>(null)
  const selectCell = useStore((s) => s.selectCell)
  const extendSelection = useStore((s) => s.extendSelection)
  const clearSelection = useStore((s) => s.clearSelection)
  const focus = selection?.focus ?? null
  const rect = useMemo(() => (selection ? rectOf(selection) : null), [selection])

  /** A click (or a shift-click, which extends instead of starting over). */
  const pick = (row: number, col: number, extend: boolean) => {
    repeatRef.current = false
    if (extend) extendSelection(source, { row, col })
    else selectCell(source, { row, col })
  }

  const meta = useMemo(() => {
    const byName = new Map((columns ?? []).map((c) => [c.name, c]))
    return result.columns.map((rc) => ({
      ...rc,
      column: byName.get(rc.name),
      numeric: isNumericType(rc.dbType, byName.get(rc.name)?.dataType),
    }))
  }, [result.columns, columns])

  // A set keyed on "row:col" — the API sends only the cells that were cut, and
  // a lookup per rendered cell has to be O(1) or scrolling pays for it.
  const cutCells = useMemo(
    () => new Set((result.truncatedCells ?? []).map((c) => `${c.row}:${c.col}`)),
    [result.truncatedCells],
  )

  // Every width either orientation needs, from one pass over the sample.
  //
  // Measured from a sample rather than the whole result: scanning 100k rows to
  // size columns would cost more than rendering them. It lives here, above the
  // orientation switch, so pressing Tab does not re-scan — the transposed grid
  // used to measure its own two widths on mount, which meant every flip paid
  // for a fresh pass over the sample.
  const sizing = useMemo(() => {
    const sample = result.rows.slice(0, WIDTH_SAMPLE_ROWS)
    const px = (chars: number, min: number) =>
      Math.round(Math.min(gm.maxCol, Math.max(min, chars * gm.charPx + gm.padPx)))
    // The longest value anywhere, and the longest column name: the transposed
    // grid gives every record one uniform width and holds the names in its own
    // left column, so those are the two numbers it needs.
    let widestValue = 0
    let widestName = 0
    const columns = meta.map((m, i) => {
      const pk = m.column?.primaryKey
      let longest = m.name.length + (pk ? 2 : 0)
      // Three, not two: the badge sits next to the name in the label column
      // rather than sharing a truncating header with it.
      const nameChars = m.name.length + (pk ? 3 : 0)
      if (nameChars > widestName) widestName = nameChars
      for (const row of sample) {
        const len = displayValue(row[i]).length
        if (len > longest) longest = len
        if (len > widestValue) widestValue = len
      }
      return px(longest, gm.minCol)
    })
    return { columns, label: px(widestName, gm.gutter), cell: px(widestValue, gm.minCol) }
  }, [meta, result.rows, gm])
  const widths = sizing.columns

  const totalWidth = widths.reduce((a, b) => a + b, 0) + gm.gutter

  const virtualizer = useVirtualizer({
    count: result.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => gm.rowHeight,
    overscan: 12,
    // The rows start below the sticky header, not at the top of the scroll
    // element. Without this the virtualiser's coordinates are a header out and
    // its window drifts off the visible rows.
    scrollMargin: gm.headerHeight,
  })

  // Columns are virtualised as well as rows. A wide result is as ordinary as a
  // long one — a hundred-column table put every column of every visible row in
  // the DOM, thousands of cells, and then paid for all of them on each render:
  // the first draw stalled for seconds and a single arrow key took most of one.
  // Widths are already measured per column, so they are the estimate and no
  // cell has to be remeasured. The columns start right of the record-number
  // gutter, hence the margin, which also makes an item's `start` the same
  // content coordinate measuredSpan gives the scroll effect below.
  const colV = useVirtualizer({
    horizontal: true,
    count: meta.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => widths[i] ?? gm.minCol,
    overscan: 4,
    scrollMargin: gm.gutter,
  })

  // Row height and column widths both change with the font size and with the
  // result, so both virtualisers have to remeasure or the old geometry sticks.
  useEffect(() => {
    virtualizer.measure()
    colV.measure()
  }, [gm.rowHeight, widths, virtualizer, colV])

  // A new result set should start at the top, not wherever the last one was,
  // and a selection into rows that are no longer there means nothing.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
    clearSelection()
  }, [result, clearSelection])

  // Keeps the focused cell on screen when it moved by keyboard, whole rather
  // than merely touching the edge. Both axes are worked out from the geometry
  // rather than left to scrollToIndex or scrollIntoView: neither knows the
  // sticky header covers the top of the viewport, so both would happily stop
  // with the cell behind it. See frontend/src/scroll.ts.
  useEffect(() => {
    const el = scrollRef.current
    if (!focus || transposed || !el) return
    scrollTo(
      el,
      offsetToShow(
        { offset: el.scrollTop, length: el.clientHeight, sticky: gm.headerHeight },
        uniformSpan(focus.row, gm.rowHeight, gm.headerHeight),
      ),
      // The row-number gutter scrolls with the rows in this orientation, so
      // nothing covers the near edge horizontally.
      offsetToShow(
        { offset: el.scrollLeft, length: el.clientWidth, sticky: 0 },
        measuredSpan(focus.col, widths, gm.gutter),
      ),
      repeatRef.current,
    )
  }, [focus, transposed, gm, widths])

  // Ctrl+C copies the selection, Enter opens the focused cell, and the arrows
  // move — with shift held, they extend the range instead. Copying what you are
  // looking at is the single most common thing done with a result grid; opening
  // a cell is how a capped value, or a JSON document, is read at all.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState()
      const sel = s.selection?.source === source ? s.selection : null
      // A cell stays selected while the user types in the filter box, where
      // Enter means "apply" and Ctrl+C means "copy what I selected in here".
      const target = e.target as HTMLElement | null
      if (isTypingTarget(target)) return
      // While the cell menu or a dialog is open the keys belong to it: Enter
      // there means "activate the highlighted item", and handling it here as
      // well would run the menu's action and open the viewer on top of it.
      if (target?.closest('[role="menu"],[role="dialog"]')) return
      const mod = e.ctrlKey || e.metaKey

      // Select-all is worth having on a grid whose whole result is often what
      // you want, and there is no competing meaning outside a text field. Shift
      // must be excluded: Ctrl+Shift+A opens the connections page.
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        s.selectAll(source)
        return
      }

      if (!sel) return
      const cur = sel.focus

      // Arrow movement, mapped through the orientation: down is the next row
      // when rows run across, and the next column when they run down. Ctrl+hjkl
      // is the same movement — the app is keyboard-first, and a hand that never
      // leaves the home row is the whole argument for it. Select-all keeps
      // Ctrl+A above, so only these four letters are claimed.
      // Ctrl+arrow stays pagination, which is why the modifier picks the map
      // rather than being tolerated by both.
      const step = mod ? VIM[e.key.toLowerCase()] : ARROWS[e.key]
      if (step) {
        const d = transposed ? { row: step.col, col: step.row } : step
        const pos = {
          row: clamp(cur.row + d.row, 0, result.rows.length - 1),
          col: clamp(cur.col + d.col, 0, result.columns.length - 1),
        }
        e.preventDefault()
        repeatRef.current = e.repeat
        if (e.shiftKey) s.extendSelection(source, pos)
        else s.selectCell(source, pos)
        return
      }

      if (e.key === 'Enter' && !mod && onOpenCell) {
        e.preventDefault()
        onOpenCell(cur.row, cur.col)
        return
      }
      // The platform menu key, and its laptop-keyboard equivalent. Radix opens
      // the menu from a contextmenu event, so the cheapest way to honour the
      // key is to raise one at the focused cell — which also puts the menu
      // where the cell is rather than wherever the pointer was left.
      if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && cellMenu) {
        const el = selectedRef.current
        if (!el) return
        e.preventDefault()
        const box = el.getBoundingClientRect()
        el.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            clientX: Math.round(box.left + 8),
            clientY: Math.round(box.bottom),
          }),
        )
        return
      }
      if (!mod || e.key !== 'c') return
      if (window.getSelection()?.toString()) return // let a text selection win
      e.preventDefault()
      void s.copySelection()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [source, transposed, result, onOpenCell, cellMenu])

  if (result.columns.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--color-faint)]">
        {result.rowsAffected != null
          ? `${result.rowsAffected} row(s) affected`
          : 'Statement completed with no result set'}
      </div>
    )
  }

  const sort = orderBy?.[0]
  // The visible columns, shared by the header strip and every rendered row so
  // that a name and the values under it can never come from different windows.
  const cols = colV.getVirtualItems()

  // Built for the selected cell, which right-clicking has just set through
  // mousedown. Whether there is a menu at all is decided by the prop and never
  // by the selection: mounting the trigger conditionally would rebuild the row
  // area on the first right-click, taking the element the event came from with
  // it. The placeholder is all but unreachable for the same reason.
  //
  // Memoised because building it reads the result — including a scan for
  // whether this cell was truncated — and nothing about a repaint of the grid
  // changes the answer. Only a move of the focus does.
  const menuItems = useMemo<MenuItem[] | null>(() => {
    if (!cellMenu) return null
    if (!focus) return [{ label: 'No cell selected', onSelect: () => {}, disabled: true }]
    return cellMenu(focus.row, focus.col)
  }, [cellMenu, focus, result])
  const menuHeading = focus ? meta[focus.col]?.name : undefined

  // Transposing swaps the axes only: the selection, the keyboard, the menu and
  // the cut-cell markers above all address the *source* row and column, so they
  // are unchanged by which way round the data is drawn.
  if (transposed) {
    return (
      <RecordsGrid
        result={result}
        meta={meta}
        cutCells={cutCells}
        gm={gm}
        rowOffset={rowOffset}
        focus={focus}
        rect={rect}
        labelWidth={sizing.label}
        cellWidth={sizing.cell}
        pick={pick}
        selectedRef={selectedRef}
        repeatRef={repeatRef}
        menuItems={menuItems}
        menuHeading={menuHeading}
      />
    )
  }

  const headerName = headerCol === null ? undefined : meta[headerCol]?.name
  const headerItems: MenuItem[] = [
    {
      label: 'Copy column name',
      disabled: !headerName,
      onSelect: () => headerName && void copyText(headerName),
    },
    {
      label: 'Copy all column names',
      onSelect: () => void copyText(meta.map((m) => m.name).join(', ')),
    },
  ]

  return (
    <div ref={scrollRef} className="h-full overflow-auto font-[var(--font-mono)]">
      <div style={{ width: totalWidth, minWidth: '100%' }}>
        {/* One menu for the whole strip; each button says which column it is.
            The buttons are never `disabled`, even with no sort to offer: a
            disabled control dispatches no events, and the right-click would
            never reach the menu. */}
        <ContextMenu items={headerItems} heading={headerName}>
          <div
            className="chrome sticky top-0 z-10 border-b border-[var(--color-border-strong)] bg-[var(--color-panel)] font-bold"
            style={{ height: gm.headerHeight, width: totalWidth }}
          >
            <div
              className="absolute top-0 left-0 border-r border-[var(--color-border)]"
              style={{ width: gm.gutter, height: gm.headerHeight }}
              aria-hidden
            />
            {cols.map((c) => {
              const i = c.index
              const m = meta[i]
              const active = sort?.column === m.name
              return (
                <button
                  key={`${m.name}-${i}`}
                  type="button"
                  onClick={() => onSort?.(m.name)}
                  onContextMenu={() => setHeaderCol(i)}
                  title={`${m.name}${m.column ? ` · ${m.column.dataType}` : ''}${
                    m.column?.primaryKey ? ' · primary key' : ''
                  }`}
                  className={`absolute top-0 flex items-center gap-1 border-r border-[var(--color-border)] px-2 text-left ${
                    onSort ? 'hover:bg-[var(--color-accent-dim)]/40' : 'cursor-default'
                  }`}
                  style={{ left: c.start, width: c.size, height: gm.headerHeight }}
                >
                  {m.column?.primaryKey && (
                    // A text badge rather than a key glyph: symbol fonts vary
                    // wildly across the platforms this ships to, and a tofu box
                    // next to a column name reads as corruption.
                    <span
                      className="shrink-0 rounded-full bg-[var(--color-warn-dim)] px-1.5 font-semibold text-[var(--color-warn)]"
                      title="primary key"
                    >
                      PK
                    </span>
                  )}
                  <span
                    className={`truncate ${active ? 'text-[var(--color-accent)]' : 'text-[var(--color-text)]'}`}
                  >
                    {m.name}
                  </span>
                  {active && (
                    <span className="ml-auto shrink-0 text-[var(--color-accent)]">
                      {sort.desc ? '▾' : '▴'}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </ContextMenu>

        {/* The menu wraps the row area only: the header has its own meaning
            for a click, and a cell menu over it would act on a cell that is
            nowhere near the pointer. */}
        <CellContextMenu items={menuItems} heading={menuHeading}>
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const row = result.rows[v.index]
              return (
                <div
                  key={v.key}
                  className={`absolute ${
                    v.index % 2 === 1 ? 'bg-[var(--color-row-alt)]' : ''
                  } hover:bg-[var(--color-accent-dim)]/25`}
                  style={{
                    top: v.start - gm.headerHeight,
                    height: v.size,
                    left: 0,
                    right: 0,
                    minWidth: totalWidth,
                  }}
                >
                  <div
                    className="chrome absolute top-0 left-0 flex items-center justify-end border-r border-[var(--color-border)] pr-2 text-[var(--color-faint)] select-none"
                    style={{ width: gm.gutter, height: v.size }}
                  >
                    {rowOffset + v.index + 1}
                  </div>
                  {cols.map((c) => {
                    const ci = c.index
                    const m = meta[ci]
                    const isFocus = focus?.row === v.index && focus.col === ci
                    const inRange = rect ? inRect(rect, v.index, ci) : false
                    const value = row[ci]
                    const cut = cutCells.has(`${v.index}:${ci}`)
                    return (
                      <div
                        key={ci}
                        ref={isFocus ? selectedRef : undefined}
                        onMouseDown={(e) => pick(v.index, ci, e.shiftKey)}
                        // mousedown already fires for the right button, but a
                        // ctrl-click on macOS arrives as a contextmenu without
                        // one. The menu must always act on the cell that was
                        // actually clicked, never on a stale selection.
                        onContextMenu={() => pick(v.index, ci, false)}
                        className={`absolute top-0 truncate border-r border-[var(--color-border)] px-2 ${
                          m.numeric ? 'text-right' : ''
                        } ${cellSelectionClass(isFocus, inRange)}`}
                        style={{
                          left: c.start,
                          width: c.size,
                          height: v.size,
                          lineHeight: `${gm.rowHeight}px`,
                        }}
                        title={cellTitle(value, cut, result.textCap)}
                      >
                        <CellBody value={value} cut={cut} />
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </CellContextMenu>
      </div>
    </div>
  )
})

/** Arrow keys as a step in display coordinates. */
const ARROWS: Record<string, { row: number; col: number }> = {
  ArrowUp: { row: -1, col: 0 },
  ArrowDown: { row: 1, col: 0 },
  ArrowLeft: { row: 0, col: -1 },
  ArrowRight: { row: 0, col: 1 },
}

/** The same steps on hjkl, taken with the modifier held. */
const VIM: Record<string, { row: number; col: number }> = {
  k: ARROWS.ArrowUp,
  j: ARROWS.ArrowDown,
  h: ARROWS.ArrowLeft,
  l: ARROWS.ArrowRight,
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/**
 * How a cell shows that it is selected.
 *
 * The focus cell keeps the ring it always had, and the rest of the range is a
 * flatter wash: one cell has to stay identifiable as the one the keyboard and
 * the menu are pointing at, or extending a range becomes guesswork.
 */
function cellSelectionClass(isFocus: boolean, inRange: boolean): string {
  if (isFocus) {
    return 'bg-[var(--color-accent-dim)]/60 ring-1 ring-[var(--color-accent)] ring-inset'
  }
  return inRange ? 'bg-[var(--color-accent-dim)]/30' : ''
}

/** One source column, with its introspected metadata where there is any. */
interface ColMeta extends ResultColumn {
  column?: Column
  numeric: boolean
}

type Metrics = ReturnType<typeof metrics>

interface RecordsProps {
  result: ResultSet
  meta: ColMeta[]
  cutCells: Set<string>
  gm: Metrics
  rowOffset: number
  focus: CellPos | null
  rect: Rect | null
  /** Width of the sticky column-name strip, measured by the parent. */
  labelWidth: number
  /** The one uniform width every record column gets, likewise. */
  cellWidth: number
  pick: (row: number, col: number, extend: boolean) => void
  selectedRef: React.MutableRefObject<HTMLDivElement | null>
  repeatRef: React.MutableRefObject<boolean>
  menuItems: MenuItem[] | null
  menuHeading?: string
}

/**
 * The transposed grid: column names down the left, one record per column.
 *
 * This is the shape for reading one wide row — forty columns of a customer are
 * a column you can scan, not a horizontal scroll. It is a *view* of the same
 * result: no query is re-run, and a cell here is the same cell as in the row
 * orientation, so copy, open, and the right-click menu all behave identically.
 *
 * Both axes are virtualised, because both can be long: a result is transposed
 * without first being narrowed, and 5k records across is as ordinary here as
 * 5k rows down is in the other orientation. Records are given one uniform
 * width, sampled across the whole grid rather than per record — a matrix whose
 * columns are all different widths is much harder to read down.
 */
function RecordsGrid({
  result,
  meta,
  cutCells,
  gm,
  rowOffset,
  focus,
  rect,
  labelWidth,
  cellWidth,
  pick,
  selectedRef,
  repeatRef,
  menuItems,
  menuHeading,
}: RecordsProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Both axes start inside the sticky chrome — the rows below the record
  // numbers, the records right of the column names — and both virtualisers are
  // told so, or their windows sit a header and a label column off the content
  // they are meant to cover.
  const rowV = useVirtualizer({
    count: meta.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => gm.rowHeight,
    overscan: 12,
    scrollMargin: gm.headerHeight,
  })

  const colV = useVirtualizer({
    horizontal: true,
    count: result.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => cellWidth,
    overscan: 4,
    scrollMargin: labelWidth,
  })

  // Both measurements are derived from the font size and the values, so a
  // Settings change or a new result has to remeasure or the old geometry sticks.
  useEffect(() => {
    rowV.measure()
    colV.measure()
  }, [gm.rowHeight, cellWidth, rowV, colV])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, left: 0 })
  }, [result])

  // Where the focus went, on both axes at once: the row is a source column, the
  // column is a source row. One scroll of the shared element rather than two
  // scrollToIndex calls — those fought each other, and neither allowed for the
  // record-number header or the sticky column-name strip, which is how a cell
  // could end up "in view" with a pixel of it showing. Both edges of the cell
  // on both axes is all four of its corners.
  useEffect(() => {
    const el = scrollRef.current
    if (!focus || !el) return
    scrollTo(
      el,
      offsetToShow(
        { offset: el.scrollTop, length: el.clientHeight, sticky: gm.headerHeight },
        uniformSpan(focus.col, gm.rowHeight, gm.headerHeight),
      ),
      offsetToShow(
        { offset: el.scrollLeft, length: el.clientWidth, sticky: labelWidth },
        uniformSpan(focus.row, cellWidth, labelWidth),
      ),
      repeatRef.current,
    )
  }, [focus, gm, labelWidth, cellWidth, repeatRef])

  const cols = colV.getVirtualItems()
  const totalWidth = labelWidth + colV.getTotalSize()

  return (
    <div ref={scrollRef} className="h-full overflow-auto font-[var(--font-mono)]">
      <div style={{ width: totalWidth, minWidth: '100%' }}>
        {/* The record numbers. Sticky on both axes, so the number of the record
            you are reading stays put whichever way you scroll. */}
        <div
          className="chrome sticky top-0 z-20 flex border-b border-[var(--color-border-strong)] bg-[var(--color-panel)]"
          style={{ height: gm.headerHeight, width: totalWidth }}
        >
          <div
            className="sticky left-0 z-10 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-panel)] px-2 text-[var(--color-faint)]"
            style={{ width: labelWidth, lineHeight: `${gm.headerHeight}px` }}
          >
            column
          </div>
          <div className="relative" style={{ width: colV.getTotalSize() }}>
            {cols.map((c) => (
              <div
                key={c.key}
                className="absolute top-0 truncate border-r border-[var(--color-border)] px-2 text-right text-[var(--color-faint)]"
                style={{
                  left: c.start - labelWidth,
                  width: c.size,
                  height: gm.headerHeight,
                  lineHeight: `${gm.headerHeight}px`,
                }}
              >
                {rowOffset + c.index + 1}
              </div>
            ))}
          </div>
        </div>

        <CellContextMenu items={menuItems} heading={menuHeading}>
          <div style={{ height: rowV.getTotalSize(), position: 'relative' }}>
            {rowV.getVirtualItems().map((v) => {
              const m = meta[v.index]
              return (
                <div
                  key={v.key}
                  className={`absolute flex ${v.index % 2 === 1 ? 'bg-[var(--color-row-alt)]' : ''}`}
                  style={{
                    top: v.start - gm.headerHeight,
                    height: v.size,
                    left: 0,
                    width: totalWidth,
                  }}
                >
                  {/* The name of the column this record's value belongs to.
                      Sticky left for the same reason the header is sticky top:
                      scrolled away, a value is unlabelled. */}
                  <div
                    className="chrome sticky left-0 z-10 flex shrink-0 items-center gap-1 truncate border-r border-[var(--color-border)] bg-[var(--color-panel)] px-2 select-none"
                    style={{ width: labelWidth }}
                    title={`${m.name}${m.column ? ` · ${m.column.dataType}` : ''}${
                      m.column?.primaryKey ? ' · primary key' : ''
                    }`}
                  >
                    {m.column?.primaryKey && (
                      <span
                        className="shrink-0 rounded-full bg-[var(--color-warn-dim)] px-1.5 font-semibold text-[var(--color-warn)]"
                        title="primary key"
                      >
                        PK
                      </span>
                    )}
                    <span className="truncate">{m.name}</span>
                  </div>
                  <div className="relative" style={{ width: colV.getTotalSize() }}>
                    {cols.map((c) => {
                      const value = result.rows[c.index]?.[v.index]
                      if (value === undefined) return null
                      const isFocus = focus?.row === c.index && focus.col === v.index
                      const inRange = rect ? inRect(rect, c.index, v.index) : false
                      const cut = cutCells.has(`${c.index}:${v.index}`)
                      return (
                        <div
                          key={c.key}
                          ref={isFocus ? selectedRef : undefined}
                          onMouseDown={(e) => pick(c.index, v.index, e.shiftKey)}
                          onContextMenu={() => pick(c.index, v.index, false)}
                          className={`absolute top-0 truncate border-r border-b border-[var(--color-border)] px-2 hover:bg-[var(--color-accent-dim)]/25 ${
                            m.numeric ? 'text-right' : ''
                          } ${cellSelectionClass(isFocus, inRange)}`}
                          style={{
                            left: c.start - labelWidth,
                            width: c.size,
                            height: v.size,
                            lineHeight: `${gm.rowHeight}px`,
                          }}
                          title={cellTitle(value, cut, result.textCap)}
                        >
                          <CellBody value={value} cut={cut} />
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </CellContextMenu>
      </div>
    </div>
  )
}

/**
 * The row area's right-click menu, or the row area unchanged when the grid was
 * given no menu to show. Keeping the decision here means the trigger wraps
 * exactly the same element either way, so nothing about the grid's layout
 * depends on whether a menu was supplied.
 */
function CellContextMenu({
  items,
  heading,
  children,
}: {
  items: MenuItem[] | null
  heading?: string
  children: React.ReactNode
}) {
  if (!items) return children
  return (
    <ContextMenu items={items} heading={heading}>
      {children}
    </ContextMenu>
  )
}

/**
 * One cell's contents, in either orientation.
 *
 * NULL and '' must never look the same — telling them apart is half of why
 * people open a GUI at all. Truncation is shown in the cell rather than only in
 * the tooltip: a value that was cut but looks whole is worse than no value. The
 * CUT badge is pinned right and the text truncates before it, or the marker
 * would be the first thing scrolled out of sight, since capped values always
 * overflow.
 */
function CellBody({ value, cut }: { value: Cell; cut: boolean }) {
  if (value === null) return <span className="text-[var(--color-faint)] italic">NULL</span>
  if (value === '') return <span className="text-[var(--color-faint)] italic">empty</span>
  if (typeof value === 'boolean')
    return <span className="text-[var(--color-warn)]">{String(value)}</span>
  if (cut) {
    return (
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate">{String(value)}</span>
        <span className="shrink-0 rounded-full bg-[var(--color-warn-dim)] px-1.5 font-semibold text-[var(--color-warn)]">
          CUT
        </span>
      </span>
    )
  }
  return <>{String(value)}</>
}

/** The tooltip for one cell, shared by both orientations. */
function cellTitle(value: Cell, cut: boolean, textCap: number): string {
  if (value === null) return 'NULL'
  if (cut) return `${String(value)}\n\n(cut to ${textCap} characters — Enter for the whole value)`
  return String(value)
}

function displayValue(v: Cell): string {
  if (v === null) return 'NULL'
  return String(v)
}

/** Right-aligning numbers makes magnitude comparable down a column. */
function isNumericType(dbType: string, dataType?: string): boolean {
  const t = `${dbType} ${dataType ?? ''}`.toUpperCase()
  return /INT|DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL|MONEY|SERIAL/.test(t) && !/INTERVAL|POINT/.test(t)
}

import { useEffect, useState } from 'react'
import { formatCount } from '../commands'
import { parsePageSize } from '../pageSize'
import { isInfinite, PAGE_SIZES, useStore } from '../store'

/**
 * Pagination controls: page size, page number, or switched off entirely.
 *
 * With pagination off the app fetches every matching row up to the 100k cap in
 * internal/driver/scan.go, and the grid virtualises them.
 */
export function Paginator() {
  const enabled = useStore((s) => s.paginationEnabled)
  const page = useStore((s) => s.page)
  const pageSize = useStore((s) => s.pageSize)
  const hasMore = useStore((s) => s.hasMore)
  const totalCount = useStore((s) => s.totalCount)
  const result = useStore((s) => s.result)
  const busy = useStore((s) => s.busy)
  const setPage = useStore((s) => s.setPage)
  const setPageSize = useStore((s) => s.setPageSize)
  const setPaginationEnabled = useStore((s) => s.setPaginationEnabled)
  const countRows = useStore((s) => s.countRows)
  const autoCount = useStore((s) => s.settings.autoCount)
  const [counting, setCounting] = useState(false)
  const rowCap = useStore((s) => s.settings.rowCap)
  const infinite = useStore(isInfinite)

  const [pageDraft, setPageDraft] = useState(String(page))
  useEffect(() => setPageDraft(String(page)), [page])

  // The size dropdown is presets plus a "Custom…" escape hatch for a one-off
  // number the user already knows (a gnarly 5-row table, say). Landing on a
  // pageSize that isn't a preset — because the last thing typed here was
  // custom — should also land in custom mode, so the control reflects reality
  // on mount rather than silently snapping back to the nearest preset.
  const isPreset = (n: number) => (PAGE_SIZES as readonly number[]).includes(n)
  const [customMode, setCustomMode] = useState(!isPreset(pageSize))
  const [customDraft, setCustomDraft] = useState(String(pageSize))
  useEffect(() => {
    setCustomMode(!isPreset(pageSize))
    setCustomDraft(String(pageSize))
  }, [pageSize])

  const commitCustomSize = () => {
    const n = parsePageSize(customDraft, rowCap)
    // Bad input is non-destructive: fall back to whatever page size is
    // already in effect rather than sending a garbage or huge request.
    if (n == null) {
      setCustomDraft(String(pageSize))
      return
    }
    setCustomDraft(String(n))
    if (n !== pageSize) void setPageSize(n)
  }

  const rowCount = result?.rows.length ?? 0
  // With infinite scroll the rows on screen are the first through the last
  // loaded, not one page of them.
  const firstRow = enabled && !infinite ? (page - 1) * pageSize + 1 : 1
  const lastRow = enabled && !infinite ? firstRow + rowCount - 1 : rowCount
  const lastPage =
    totalCount != null && enabled && !infinite
      ? Math.max(1, Math.ceil(totalCount / pageSize))
      : null

  const commitPage = () => {
    const n = Number.parseInt(pageDraft, 10)
    if (Number.isFinite(n) && n >= 1) void setPage(n)
    else setPageDraft(String(page))
  }

  return (
    <div className="chrome flex items-center gap-3 border-t border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2">
      <label className="flex items-center gap-1.5 text-[var(--color-muted)]">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => void setPaginationEnabled(e.target.checked)}
        />
        Paginate
      </label>

      {enabled ? (
        <>
          <label className="flex items-center gap-1.5 text-[var(--color-muted)]">
            Per page
            <select
              value={customMode ? 'custom' : pageSize}
              onChange={(e) => {
                if (e.target.value === 'custom') setCustomMode(true)
                else void setPageSize(Number(e.target.value))
              }}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-elevated)] px-2 py-0.5 shadow-xs outline-none"
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
              <option value="custom">Custom…</option>
            </select>
            {customMode && (
              <input
                value={customDraft}
                onChange={(e) => setCustomDraft(e.target.value)}
                onBlur={commitCustomSize}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitCustomSize()
                    e.currentTarget.blur()
                  }
                }}
                // Picking "Custom…" from the select should not require a
                // separate Tab press to reach the box — this is a
                // keyboard-driven app.
                autoFocus
                aria-label="Custom page size"
                title={`Up to ${rowCap.toLocaleString()}`}
                className="w-14 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-elevated)] px-1 py-0.5 text-center outline-none"
              />
            )}
          </label>

          {infinite ? (
            <span className="text-[var(--color-faint)]">
              {busy && rowCount > 0
                ? 'Loading more…'
                : hasMore
                  ? 'Scroll for more'
                  : 'End of results'}
            </span>
          ) : (
            <div className="flex items-center gap-1">
              <button
                onClick={() => void setPage(1)}
                disabled={page <= 1 || busy}
                title="First page"
                className="rounded-full px-2 py-0.5 disabled:opacity-30 enabled:hover:bg-[var(--color-accent-dim)]/50 enabled:hover:text-[var(--color-accent)]"
              >
                «
              </button>
              <button
                onClick={() => void setPage(page - 1)}
                disabled={page <= 1 || busy}
                title="Previous page"
                className="rounded-full px-2 py-0.5 disabled:opacity-30 enabled:hover:bg-[var(--color-accent-dim)]/50 enabled:hover:text-[var(--color-accent)]"
              >
                ‹
              </button>
              <input
                value={pageDraft}
                onChange={(e) => setPageDraft(e.target.value)}
                onBlur={commitPage}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitPage()
                    e.currentTarget.blur()
                  }
                }}
                aria-label="Page number"
                className="w-12 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-elevated)] px-1 py-0.5 text-center outline-none"
              />
              {lastPage != null && <span className="text-[var(--color-faint)]">of {lastPage}</span>}
              <button
                onClick={() => void setPage(page + 1)}
                disabled={!hasMore || busy}
                title="Next page"
                className="rounded-full px-2 py-0.5 disabled:opacity-30 enabled:hover:bg-[var(--color-accent-dim)]/50 enabled:hover:text-[var(--color-accent)]"
              >
                ›
              </button>
            </div>
          )}
        </>
      ) : (
        <span className="rounded-full bg-[var(--color-warn-dim)] px-2.5 py-0.5 font-semibold text-[var(--color-warn)]">
          Pagination off — loading every matching row
        </span>
      )}

      <div className="ml-auto flex items-center gap-3 text-[var(--color-faint)]">
        {rowCount > 0 && (
          <span>
            {enabled ? `${formatCount(firstRow)}–${formatCount(lastRow)}` : formatCount(rowCount)}
            {totalCount != null && ` of ${formatCount(totalCount)}`}
          </span>
        )}
        {result && !autoCount && totalCount == null && (
          <button
            onClick={() => {
              setCounting(true)
              void countRows().finally(() => setCounting(false))
            }}
            disabled={counting}
            title="Run COUNT(*) for this table and filter"
            className="rounded-full px-2 py-0.5 disabled:opacity-50 enabled:hover:bg-[var(--color-accent-dim)]/50 enabled:hover:text-[var(--color-accent)]"
          >
            {counting ? 'Counting…' : 'Count'}
          </button>
        )}
        {result?.truncated && (
          <span className="text-[var(--color-warn)]" title="The 100k row safety cap was reached">
            capped at 100k
          </span>
        )}
        {result && <span>{result.elapsedMs}ms</span>}
      </div>
    </div>
  )
}

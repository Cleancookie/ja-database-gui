import { useEffect, useMemo, useRef, useState } from 'react'
import { rankCandidates } from '../../fuzzy'
import { useStore } from '../../store'
import { Highlight } from '../Highlight'
import { INPUT, PILL, useFocusWhen, useListKeys } from './listKit'

/** The databases on the tab's server, with a filter once there are more than a few. */
export function DatabaseList({
  active = false,
  onPicked,
  className = '',
}: {
  active?: boolean
  onPicked?: () => void
  className?: string
}) {
  const databases = useStore((s) => s.databases)
  const activeDatabase = useStore((s) => s.activeDatabase)
  const selectDatabase = useStore((s) => s.selectDatabase)

  const [query, setQuery] = useState('')
  const visible = useMemo(
    () => (query ? rankCandidates(query, databases, (d) => ({ name: d })).map((r) => r.item) : databases),
    [databases, query],
  )

  const pick = (d: string) => {
    void selectDatabase(d)
    onPicked?.()
  }

  const root = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const { selected, setSelected, onKeyDown } = useListKeys(visible.length, (i) => pick(visible[i]))
  useEffect(() => {
    if (active) setSelected(Math.max(0, databases.indexOf(activeDatabase)))
    // Only on activation: a refresh of the list must not yank the highlight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
  useFocusWhen(active, () => field.current ?? root.current)
  useEffect(() => {
    root.current?.querySelector('[data-highlight]')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  return (
    <div ref={root} tabIndex={-1} onKeyDown={onKeyDown} className="outline-none focus-visible:outline-none">
      {databases.length > 8 && (
        <div className="px-3 py-1">
          <input
            ref={field}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelected(0)
            }}
            placeholder="Filter databases…  (Enter picks the highlighted one)"
            spellCheck={false}
            aria-label="Filter databases"
            className={INPUT}
          />
        </div>
      )}
      <Highlight className={`overflow-y-auto px-1.5 pb-1.5 ${className}`} pillClassName={PILL}>
        {visible.map((d, i) => (
          <button
            key={d}
            onClick={() => pick(d)}
            title={d}
            data-highlight={i === selected || undefined}
            className={`relative flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left ${
              d === activeDatabase ? 'font-bold' : 'hover:bg-[var(--color-panel)]'
            }`}
          >
            <span className="shrink-0 text-[var(--color-faint)]">▪</span>
            <span className="min-w-0 flex-1 truncate">{d}</span>
          </button>
        ))}
      </Highlight>
    </div>
  )
}

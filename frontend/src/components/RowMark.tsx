import type { RowMark as Mark } from '../useGridEdits'

const STYLE: Record<NonNullable<Mark>, { colour: string; title: string }> = {
  update: { colour: 'bg-[var(--color-accent)]', title: 'Edited, not saved' },
  delete: { colour: 'bg-[var(--color-danger)]', title: 'Staged for deletion' },
  insert: { colour: 'bg-[var(--color-success)]', title: 'New row, not saved' },
}

/**
 * The dot in a row's number gutter when something is staged on that row: accent
 * for an edit, red for a delete, green for a new row. Absolutely placed, so it
 * never moves the number beside it.
 */
export function RowMark({ mark }: { mark: Mark }) {
  if (!mark) return null
  const s = STYLE[mark]
  return (
    <span
      title={s.title}
      className={`absolute top-1/2 left-1.5 h-2 w-2 -translate-y-1/2 rounded-full ${s.colour}`}
    />
  )
}

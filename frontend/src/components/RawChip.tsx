/**
 * Toggles a cell edit between text and a raw SQL expression such as NOW().
 * Mouse-down is swallowed so clicking it does not blur, and so stage, the
 * inline editor it sits in.
 */
export function RawChip({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={
        on
          ? 'Raw SQL: sent unquoted, e.g. NOW(). Click to send as text'
          : 'Send as raw SQL, unquoted — for NOW(), CURRENT_TIMESTAMP, UUID()'
      }
      onMouseDown={(e) => e.preventDefault()}
      onClick={onToggle}
      className={`shrink-0 rounded-full border px-1.5 font-[var(--font-mono)] text-[0.6875rem] leading-4 font-semibold ${
        on
          ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-bg)]'
          : 'border-[var(--color-border-strong)] text-[var(--color-faint)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)]'
      }`}
    >
      raw
    </button>
  )
}

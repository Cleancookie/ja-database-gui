import { useStore } from '../store'
import { storageWarning } from '../secrets'

/**
 * Says how passwords are being kept, whenever that is not the OS keyring.
 * Never dismissible: a plaintext password store is not something to hide after
 * one click.
 */
export function StorageNotice({ className = '' }: { className?: string }) {
  const warning = storageWarning(useStore((s) => s.secretBackend))
  if (!warning) return null
  const danger = warning.level === 'error'
  return (
    <div
      role="alert"
      className={`rounded-lg border px-3 py-2 leading-relaxed ${
        danger
          ? 'border-[var(--color-danger)] bg-[var(--color-danger-dim)] text-[var(--color-danger)]'
          : 'border-[var(--color-warn)] bg-[var(--color-warn-dim)] text-[var(--color-text)]'
      } ${className}`}
    >
      <strong className="block">{warning.headline}</strong>
      {warning.detail}
    </div>
  )
}

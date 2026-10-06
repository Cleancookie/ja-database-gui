import { useState } from 'react'
import { useStore } from '../store'
import { dialogButton, FormDialog } from '../ui'
import type { Connection } from '../types'

/**
 * The prompt for a connection saved with "Ask for the password every time".
 *
 * The password lives in this component's state until submit and is handed
 * straight to `connect`; the store never holds it.
 */
export function PasswordDialog({
  connection,
  database,
  error,
}: {
  connection: Connection
  database: string
  error?: string
}) {
  const setDialog = useStore((s) => s.setDialog)
  const connect = useStore((s) => s.connect)
  const [password, setPassword] = useState('')

  const close = () => setDialog({ kind: 'none' })

  return (
    <FormDialog
      open
      onClose={close}
      title={`Password for ${connection.name}`}
      widthClass="w-[min(26rem,92vw)]"
      onSubmit={() => {
        close()
        void connect(connection.id, password, database)
      }}
      footer={
        <>
          <button type="button" onClick={close} className={`ml-auto ${dialogButton.ghost}`}>
            Cancel
          </button>
          <button type="submit" className={dialogButton.primary}>
            Connect
          </button>
        </>
      }
    >
      <div className="p-4">
        <label className="block">
          <span className="mb-1 block font-semibold tracking-wider text-[var(--color-faint)] uppercase">
            {connection.user ? `Password for ${connection.user}` : 'Password'}
          </span>
          <input
            autoFocus
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
            className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-panel)] px-3 py-1.5 outline-none focus:bg-[var(--color-elevated)]"
          />
        </label>
        <p className="mt-2 text-[var(--color-faint)]">
          Used for this connection only. It is not saved.
        </p>
        {error && (
          <p className="mt-3 rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-dim)] px-3 py-2 font-[var(--font-mono)] break-words text-[var(--color-danger)]">
            {error}
          </p>
        )}
      </div>
    </FormDialog>
  )
}

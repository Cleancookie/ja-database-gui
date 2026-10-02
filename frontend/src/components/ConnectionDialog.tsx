import { useEffect, useState } from 'react'
import { api, errorMessage } from '../api'
import { useStore } from '../store'
import { PARAMS_WARNING, TRUST_WARNING } from '../secrets'
import { dialogButton, FormDialog } from '../ui'
import { StorageNotice } from './StorageNotice'
import { useTls } from '../tls'
import type { Connection, Kind } from '../types'

const KIND_ORDER: Kind[] = ['postgres', 'mysql', 'mssql', 'sqlite']

const BLANK: Connection = {
  id: '',
  name: '',
  kind: 'postgres',
  host: 'localhost',
  port: 5432,
  user: '',
  database: '',
  file: '',
}

type TestState = { state: 'idle' } | { state: 'testing' } | { state: 'ok' } | { state: 'failed'; message: string }

export function ConnectionDialog({ existing }: { existing: Connection | null }) {
  const drivers = useStore((s) => s.drivers)
  const setDialog = useStore((s) => s.setDialog)
  const saveConnection = useStore((s) => s.saveConnection)
  const deleteConnection = useStore((s) => s.deleteConnection)

  const [conn, setConn] = useState<Connection>(existing ?? BLANK)
  // null means "not touched" — saving then leaves the stored password alone.
  const [password, setPassword] = useState<string | null>(existing ? null : '')
  const [test, setTest] = useState<TestState>({ state: 'idle' })

  const caps = drivers?.[conn.kind]
  const tls = useTls(conn)
  const isFileBased = !caps?.serverHostsDatabases

  // Changing dialect should move the port to that dialect's default, but must
  // not clobber a port the user deliberately typed.
  useEffect(() => {
    if (!caps || isFileBased) return
    setConn((c) => {
      const previousDefault = drivers
        ? Object.values(drivers).some((d) => d.defaultPort === c.port)
        : false
      return !c.port || previousDefault ? { ...c, port: caps.defaultPort } : c
    })
  }, [conn.kind, caps, drivers, isFileBased])

  const patch = (p: Partial<Connection>) => {
    setConn((c) => ({ ...c, ...p }))
    setTest({ state: 'idle' })
  }

  const runTest = async () => {
    setTest({ state: 'testing' })
    try {
      await api.testConnection({ connection: conn, password })
      setTest({ state: 'ok' })
    } catch (e) {
      setTest({ state: 'failed', message: errorMessage(e) })
    }
  }

  const canSave = conn.name.trim() !== '' && (isFileBased ? !!conn.file : !!conn.host)

  const close = () => setDialog({ kind: 'none' })

  return (
    <FormDialog
      open
      onClose={close}
      title={existing ? `Edit ${existing.name}` : 'New connection'}
      widthClass="w-[min(32.5rem,92vw)]"
      onSubmit={() => {
        if (canSave) void saveConnection(conn, password)
      }}
      footer={
        <>
          <button
            type="button"
            onClick={() => void runTest()}
            disabled={test.state === 'testing' || !canSave}
            className={dialogButton.secondary}
          >
            {test.state === 'testing' ? 'Testing…' : 'Test'}
          </button>
          {existing && (
            <button
              type="button"
              onClick={() => {
                void deleteConnection(existing.id)
                close()
              }}
              className={dialogButton.danger}
            >
              Delete
            </button>
          )}
          <button type="button" onClick={close} className={`ml-auto ${dialogButton.ghost}`}>
            Cancel
          </button>
          <button type="submit" disabled={!canSave} className={dialogButton.primary}>
            Save
          </button>
        </>
      }
    >

        <div className="grid grid-cols-2 gap-3 p-4">
          <StorageNotice className="col-span-2" />

          <Field label="Name" className="col-span-2">
            <input
              autoFocus
              value={conn.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="Production replica"
              className={inputClass}
            />
          </Field>

          <Field label="Type" className="col-span-2">
            <div className="flex gap-1.5">
              {KIND_ORDER.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => patch({ kind: k, sslMode: '', trustServerCertificate: false })}
                  className={`flex-1 rounded-lg border px-2 py-1.5 ${
                    conn.kind === k
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent-dim)]/40'
                      : 'border-[var(--color-border-strong)] hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-dim)]/25'
                  }`}
                >
                  {drivers?.[k]?.displayName ?? k}
                </button>
              ))}
            </div>
          </Field>

          {isFileBased ? (
            <Field label="Database file" className="col-span-2">
              <input
                value={conn.file ?? ''}
                onChange={(e) => patch({ file: e.target.value })}
                placeholder="C:\data\app.sqlite"
                spellCheck={false}
                className={`${inputClass} font-[var(--font-mono)]`}
              />
            </Field>
          ) : (
            <>
              <Field label="Host">
                <input
                  value={conn.host ?? ''}
                  onChange={(e) => patch({ host: e.target.value })}
                  spellCheck={false}
                  className={inputClass}
                />
              </Field>
              <Field label="Port">
                <input
                  type="number"
                  value={conn.port ?? ''}
                  onChange={(e) => patch({ port: Number(e.target.value) })}
                  className={inputClass}
                />
              </Field>
              <Field label="User">
                <input
                  value={conn.user ?? ''}
                  onChange={(e) => patch({ user: e.target.value })}
                  spellCheck={false}
                  autoComplete="off"
                  className={inputClass}
                />
              </Field>
              <Field label={conn.askPassword ? 'Password (for Test only)' : 'Password'}>
                <input
                  type="password"
                  value={password ?? ''}
                  onChange={(e) => {
                    setPassword(e.target.value)
                    setTest({ state: 'idle' })
                  }}
                  placeholder={password === null && !conn.askPassword ? '••••••• unchanged' : ''}
                  autoComplete="off"
                  className={inputClass}
                />
              </Field>
              <label className="col-span-2 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={!!conn.askPassword}
                  onChange={(e) => {
                    patch({ askPassword: e.target.checked })
                    // Typed under "ask" it is for Test only; never carry it into a save.
                    setPassword(e.target.checked ? '' : existing && !existing.askPassword ? null : '')
                  }}
                />
                <span>Ask for the password every time (never stored)</span>
              </label>
              <Field label="Database" className="col-span-2">
                <input
                  value={conn.database ?? ''}
                  onChange={(e) => patch({ database: e.target.value })}
                  placeholder={conn.kind === 'postgres' ? 'postgres' : 'optional'}
                  spellCheck={false}
                  className={inputClass}
                />
              </Field>
              <Field label="SSL mode" className="col-span-2">
                <select
                  value={conn.sslMode ?? ''}
                  onChange={(e) => patch({ sslMode: e.target.value })}
                  className={inputClass}
                >
                  <option value="">Default for this host</option>
                  {(caps?.sslModes ?? []).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                {tls && (
                  <span
                    data-testid="tls-effective"
                    className={`mt-1 block ${
                      tls.warn ? 'text-[var(--color-danger)]' : 'text-[var(--color-faint)]'
                    }`}
                  >
                    {tls.implicit ? 'Default: ' : ''}
                    {tls.label}
                    {tls.warn && ' - this host is not on this machine'}
                  </span>
                )}
              </Field>
              {caps?.canTrustServerCertificate && (
                <label className="col-span-2 flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={!!conn.trustServerCertificate}
                    onChange={(e) => patch({ trustServerCertificate: e.target.checked })}
                    className="mt-1"
                  />
                  <span>
                    Trust the server certificate without checking it
                    {conn.trustServerCertificate && (
                      <span className="block text-[var(--color-danger)]">{TRUST_WARNING}</span>
                    )}
                  </span>
                </label>
              )}
            </>
          )}
        </div>

        {conn.params && Object.keys(conn.params).length > 0 && (
          <p className="mx-4 mb-3 rounded-lg border border-[var(--color-warn)] bg-[var(--color-warn-dim)] px-3 py-2">
            {PARAMS_WARNING}
          </p>
        )}
        {test.state === 'failed' && (
          <p className="mx-4 mb-3 rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-dim)] px-3 py-2 font-[var(--font-mono)] break-words text-[var(--color-danger)]">
            {test.message}
          </p>
        )}
        {test.state === 'ok' && (
          <p className="mx-4 mb-3 text-[var(--color-success)]">Connected successfully</p>
        )}

    </FormDialog>
  )
}

const inputClass =
  'w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-panel)] px-3 py-1.5 outline-none placeholder:text-[var(--color-faint)] focus:bg-[var(--color-elevated)]'

function Field({
  label,
  className = '',
  children,
}: {
  label: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block font-semibold tracking-wider text-[var(--color-faint)] uppercase">
        {label}
      </span>
      {children}
    </label>
  )
}

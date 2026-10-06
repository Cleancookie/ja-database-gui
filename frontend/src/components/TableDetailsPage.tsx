/**
 * The table details page.
 *
 * What a dialect cannot answer is stated rather than hidden: the backend puts a
 * reason in `unavailable` keyed by field name, and `Fact` prints that reason
 * where the value would go. A missing row count then reads as an engine
 * limitation instead of looking like an empty table.
 */

import { useStore } from '../store'
import { qualifiedName } from '../commands'
import type { ObjectDetail } from '../types'

/** Bytes as a short human figure. Sizes here span bytes to hundreds of GB. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

function formatNumber(n: number): string {
  return n.toLocaleString()
}

function Section({
  title,
  count,
  children,
}: {
  title: string
  count?: number
  children: React.ReactNode
}) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 flex items-center gap-2 font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        {title}
        {count !== undefined && (
          <span className="font-normal text-[var(--color-faint)]">{count}</span>
        )}
      </h2>
      {children}
    </section>
  )
}

/**
 * One label/value row. `reason` wins over `value`: if the engine told us why it
 * could not answer, that is the more useful thing to show.
 */
function Fact({ label, value, reason }: { label: string; value?: string; reason?: string }) {
  return (
    <div className="flex gap-3 py-1">
      <span className="w-32 shrink-0 text-[var(--color-faint)]">{label}</span>
      {reason ? (
        <span className="italic text-[var(--color-faint)]" title={reason}>
          {reason}
        </span>
      ) : (
        <span className="text-[var(--color-text)]">{value ?? '—'}</span>
      )}
    </div>
  )
}

/** A table that says so when it has no rows, rather than rendering a bare header. */
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[var(--color-faint)]">{children}</p>
}

const TH = 'px-2 py-1 text-left font-medium text-[var(--color-muted)]'
const TD = 'px-2 py-1 align-top'

function Columns({ detail }: { detail: ObjectDetail }) {
  const commentsUnavailable = detail.unavailable?.comment
  const anyComment = detail.columns.some((c) => c.comment)
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b-2 border-[var(--color-border-strong)]">
          <th className={TH}>#</th>
          <th className={TH}>Name</th>
          <th className={TH}>Type</th>
          <th className={TH}>Null</th>
          <th className={TH}>Default</th>
          <th className={TH}>Extra</th>
          {anyComment && !commentsUnavailable && <th className={TH}>Comment</th>}
        </tr>
      </thead>
      <tbody>
        {detail.columns.map((c) => {
          const extra = [
            c.primaryKey ? 'PK' : '',
            c.autoIncrement ? 'auto' : '',
            c.generated ? 'generated' : '',
            c.collation ?? '',
          ].filter(Boolean)
          return (
            <tr key={c.name} className="border-b border-[var(--color-border)]">
              <td className={`${TD} text-[var(--color-faint)]`}>{c.ordinal}</td>
              <td className={`${TD} font-medium font-semibold text-[var(--color-text)]`}>
                {c.name}
                {c.primaryKey && (
                  <span className="ml-1 text-[var(--color-warn)]" title="Primary key">
                    🔑
                  </span>
                )}
              </td>
              <td className={`${TD} text-sky-300`}>{c.dataType}</td>
              <td className={`${TD} text-[var(--color-muted)]`}>{c.nullable ? 'yes' : 'no'}</td>
              <td className={`${TD} text-[var(--color-muted)]`}>{c.default ?? '—'}</td>
              <td className={`${TD} text-[var(--color-faint)]`}>{extra.join(', ') || '—'}</td>
              {anyComment && !commentsUnavailable && (
                <td className={`${TD} text-[var(--color-muted)]`}>{c.comment ?? '—'}</td>
              )}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

export function TableDetailsPage() {
  const detail = useStore((s) => s.detail)
  const loading = useStore((s) => s.detailLoading)
  const error = useStore((s) => s.detailError)
  const setView = useStore((s) => s.setView)

  if (loading) return <div className="p-4 text-[var(--color-faint)]">Describing…</div>
  if (error) return <div className="p-4 text-[var(--color-danger)]">{error}</div>
  if (!detail) return <div className="p-4 text-[var(--color-faint)]">Nothing to describe.</div>

  const u = detail.unavailable ?? {}

  return (
    <div className="h-full overflow-auto p-4">
      <header className="mb-5 flex items-baseline gap-2">
        <h1 className="font-semibold font-semibold text-[var(--color-text)]">
          {qualifiedName(detail.ref)}
        </h1>
        <span className="uppercase tracking-wide text-[var(--color-faint)]">{detail.type}</span>
        <button
          className="ml-auto text-[var(--color-faint)] hover:text-[var(--color-text)]"
          onClick={() => setView('data')}
        >
          Back to rows (Esc)
        </button>
      </header>

      <Section title="Overview">
        <div>
          <Fact
            label="Rows"
            value={
              detail.rowEstimate !== undefined ? `~${formatNumber(detail.rowEstimate)}` : undefined
            }
            reason={u.rowEstimate}
          />
          <Fact
            label="Size"
            value={detail.sizeBytes !== undefined ? formatBytes(detail.sizeBytes) : undefined}
            reason={u.sizeBytes}
          />
          <Fact
            label="Primary key"
            value={detail.primaryKey.length ? detail.primaryKey.join(', ') : 'none'}
          />
          <Fact label="Comment" value={detail.comment || 'none'} reason={u.comment} />
          {detail.dialectDetail?.map((kv) => (
            <Fact key={kv.key} label={kv.key} value={kv.value} />
          ))}
        </div>
      </Section>

      <Section title="Columns" count={detail.columns.length}>
        {detail.columns.length ? <Columns detail={detail} /> : <Empty>No columns.</Empty>}
      </Section>

      <Section title="Indexes" count={detail.indexes.length}>
        {detail.indexes.length ? (
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-[var(--color-border-strong)]">
                <th className={TH}>Name</th>
                <th className={TH}>Columns</th>
                <th className={TH}>Unique</th>
                <th className={TH}>Method</th>
              </tr>
            </thead>
            <tbody>
              {detail.indexes.map((ix) => (
                <tr key={ix.name} className="border-b border-[var(--color-border)]">
                  <td className={`${TD} font-semibold text-[var(--color-text)]`}>
                    {ix.name}
                    {ix.primary && <span className="ml-1 text-[var(--color-warn)]">(primary)</span>}
                  </td>
                  <td className={`${TD} text-[var(--color-text)]`}>
                    {ix.columns.join(', ') || '(expression)'}
                  </td>
                  <td className={`${TD} text-[var(--color-muted)]`}>{ix.unique ? 'yes' : 'no'}</td>
                  <td className={`${TD} text-[var(--color-faint)]`}>{ix.method || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No indexes.</Empty>
        )}
      </Section>

      <Section title="Foreign keys" count={detail.foreignKeys.length}>
        {detail.foreignKeys.length ? (
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-[var(--color-border-strong)]">
                <th className={TH}>Name</th>
                <th className={TH}>Columns</th>
                <th className={TH}>References</th>
                <th className={TH}>On update</th>
                <th className={TH}>On delete</th>
              </tr>
            </thead>
            <tbody>
              {detail.foreignKeys.map((fk) => {
                const target = fk.referencedSchema
                  ? `${fk.referencedSchema}.${fk.referencedTable}`
                  : fk.referencedTable
                return (
                  <tr key={fk.name} className="border-b border-[var(--color-border)]">
                    <td className={`${TD} font-semibold text-[var(--color-text)]`}>{fk.name}</td>
                    <td className={`${TD} text-[var(--color-text)]`}>{fk.columns.join(', ')}</td>
                    <td className={`${TD} text-[var(--color-text)]`}>
                      {target} ({fk.referencedColumns.join(', ')})
                    </td>
                    <td className={`${TD} text-[var(--color-faint)]`}>{fk.onUpdate || '—'}</td>
                    <td className={`${TD} text-[var(--color-faint)]`}>{fk.onDelete || '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <Empty>No foreign keys.</Empty>
        )}
      </Section>

      <Section title="Check constraints" count={u.checks ? undefined : detail.checks.length}>
        {u.checks ? (
          <Empty>
            <span className="italic">{u.checks}</span>
          </Empty>
        ) : detail.checks.length ? (
          <table className="w-full border-collapse">
            <tbody>
              {detail.checks.map((c) => (
                <tr key={c.name} className="border-b border-[var(--color-border)]">
                  <td className={`${TD} w-48 font-semibold text-[var(--color-text)]`}>{c.name}</td>
                  <td className={`${TD} font-mono text-[var(--color-text)]`}>{c.expression}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No check constraints.</Empty>
        )}
      </Section>

      <Section title="Triggers" count={detail.triggers.length}>
        {detail.triggers.length ? (
          <table className="w-full border-collapse">
            <tbody>
              {detail.triggers.map((t) => (
                <tr key={t.name} className="border-b border-[var(--color-border)]">
                  <td className={`${TD} w-48 font-semibold text-[var(--color-text)]`}>{t.name}</td>
                  <td className={`${TD} text-[var(--color-muted)]`}>
                    {[t.timing, t.event].filter(Boolean).join(' ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No triggers.</Empty>
        )}
      </Section>

      {detail.definition && (
        <Section title="Definition">
          <pre className="overflow-x-auto rounded-lg bg-[var(--color-panel)] p-3 font-mono text-[var(--color-text)]">
            {detail.definition}
          </pre>
        </Section>
      )}
    </div>
  )
}

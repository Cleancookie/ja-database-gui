/**
 * Transaction isolation for the SQL editor.
 *
 * The server owns the allow-list (Capabilities.isolationLevels, per dialect);
 * this only names and validates against it. The empty string is the driver
 * default, which is the old behaviour: no transaction around the run.
 */

export const DRIVER_DEFAULT = ''

const LABELS: Record<string, string> = {
  'read uncommitted': 'Read uncommitted',
  'read committed': 'Read committed',
  'repeatable read': 'Repeatable read',
  serializable: 'Serializable',
  snapshot: 'Snapshot',
}

export interface IsolationChoice {
  value: string
  label: string
}

export function isolationLabel(level: string): string {
  return level === DRIVER_DEFAULT ? 'Driver default' : (LABELS[level] ?? level)
}

/** What the dropdown offers: the default first, then the dialect's own levels. */
export function isolationChoices(levels: readonly string[] | undefined): IsolationChoice[] {
  return [DRIVER_DEFAULT, ...(levels ?? [])].map((value) => ({ value, label: isolationLabel(value) }))
}

/**
 * The level to use, given what the tab chose and what the current dialect
 * offers. A tab can be pointed at another connection after choosing, so a level
 * the new dialect lacks falls back to the default rather than being sent.
 */
export function effectiveIsolation(levels: readonly string[] | undefined, chosen: string): string {
  return chosen !== DRIVER_DEFAULT && levels?.includes(chosen) ? chosen : DRIVER_DEFAULT
}

export const ISOLATION_WARNING =
  'A level other than the driver default wraps each run in a transaction: committed when the run ends, rolled back if it fails. ' +
  'Statements that cannot run inside a transaction (PostgreSQL VACUUM or CREATE DATABASE, for example) will error.'

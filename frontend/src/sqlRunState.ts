/**
 * The editor run in flight, as pure transitions so they can be tested without
 * the store. See State.sqlRun for why it is not tab state.
 */
export interface SqlRun {
  token: number
  connectionId: string
  database: string
  /** The user has asked to stop; the failure that follows is a choice, not an error. */
  cancelled: boolean
}

export function startRun(token: number, connectionId: string, database: string): SqlRun {
  return { token, connectionId, database, cancelled: false }
}

/** Marks the run cancelled. A run already cancelled, or none, is unchanged. */
export function markCancelled(run: SqlRun | null): SqlRun | null {
  return run && !run.cancelled ? { ...run, cancelled: true } : run
}

/** Clears the record, unless a newer run has replaced it in the meantime. */
export function endRun(current: SqlRun | null, token: number): SqlRun | null {
  return current?.token === token ? null : current
}

/** Whether the failure of run `token` should read as "cancelled" rather than an error. */
export function wasCancelled(current: SqlRun | null, token: number): boolean {
  return current?.token === token && current.cancelled
}

/** Staged changes across every connection and table, not just the one on screen. */
export function hasUnsavedChanges(s: { stagedSummary: { total: number } }): boolean {
  return s.stagedSummary.total > 0
}

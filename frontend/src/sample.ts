/** Words for the sample database's confirm dialog. Pure so they are tested without a DOM. */
export function sampleResetWarning(connected: boolean): string {
  const base =
    "The sample database is rebuilt from scratch. Any rows, tables or other changes you made to it are lost.";
  return connected
    ? `${base} Its open connection is closed and reopened.`
    : base;
}

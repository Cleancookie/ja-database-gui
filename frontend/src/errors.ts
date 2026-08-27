/**
 * Turning an unknown thrown value into a message.
 *
 * Its own module rather than part of `api.ts` because `api.ts` reads `window`
 * as it loads, and the logic modules that want this — `crash.ts` — are tested
 * without a DOM. Re-exported from `api.ts`, so existing importers are
 * unaffected.
 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

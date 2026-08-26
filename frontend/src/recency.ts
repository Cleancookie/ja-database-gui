/**
 * How recently opened objects are identified and ranked.
 *
 * There are no tabs in this app, deliberately, so switching between the two or
 * three tables being worked on happens through the palette — and alphabetical
 * order is useless for that, since the tables being compared are rarely
 * neighbours in the alphabet.
 *
 * Kept free of the store and the API layer so the ranking rules can be tested
 * without a DOM, the same as `fuzzy.ts` and `cells.ts`.
 */

import { schemaBias } from './fuzzy'
import type { ObjectType } from './types'

/** How many recently opened objects are remembered. Session-only. */
export const RECENT_LIMIT = 20

/**
 * How strongly a recently opened object is favoured.
 *
 * Chosen against the other biases rather than picked out of the air: the
 * noisy-schema penalty is -0.25, so a table opened moments ago in `extensions`
 * still surfaces — having just looked at it is better evidence than the
 * schema's reputation. It stays a bias rather than a sort key, so a clearly
 * better name match still wins on a typed query.
 */
const RECENCY_MAX = 0.3

/**
 * Identifies an object across databases.
 *
 * Schema and name alone are not unique: two databases on one server routinely
 * hold the same table names. The separator is NUL rather than a dot so that
 * ('a', 'b.c') and ('a.b', 'c') cannot collide — an identifier may contain a
 * dot, but not a NUL.
 */
export function refKey(database: string, schema: string, name: string): string {
  return `${database}\u0000${schema}\u0000${name}`
}

/**
 * Bias for position `i` in the recent list, decaying linearly. Anything not in
 * the list, or currently on screen, passes -1 and gets nothing.
 */
export function recencyBias(i: number): number {
  if (i < 0) return 0
  return RECENCY_MAX * (1 - i / RECENT_LIMIT)
}

/**
 * Tables are what people navigate to; routines are usually noise in a name
 * search. Values are on fuzzysort's 0–1 scale, so these are nudges — a function
 * that matches strongly still beats a table that barely matches.
 */
export function typeBias(t: ObjectType): number {
  switch (t) {
    case 'table':
      return 0
    case 'view':
      return -0.02
    default:
      return -0.08
  }
}

/** The whole bias for one object: its schema, its type, and how recent it is. */
export function objectBias(schema: string | undefined, type: ObjectType, recentIndex: number): number {
  return schemaBias(schema) + typeBias(type) + recencyBias(recentIndex)
}

/**
 * Moves recently opened objects to the front, in recency order.
 *
 * The palette groups contiguously and, on an empty query, sorts by bias alone —
 * but an explicit sort keeps the order stable and obvious rather than emergent
 * from bias arithmetic.
 */
export function orderByRecency<T>(items: T[], indexOf: (item: T) => number): T[] {
  // Decorate, sort, undecorate. `indexOf` builds a key string, and calling it
  // from inside the comparator meant O(n log n) of them rather than one per
  // item. Measured at 5000 objects this is worth about 15% of the sort and no
  // more — it is here because the shape is right, not because it was the
  // bottleneck. Array.prototype.sort is stable and the decoration preserves
  // order, so the result is unchanged.
  const ranked = items.map((item) => ({ item, at: rank(indexOf(item)) }))
  ranked.sort((a, b) => a.at - b.at)
  return ranked.map((r) => r.item)
}

function rank(i: number): number {
  // Not recent sorts after everything recent, keeping the catalogue's own
  // order among the rest — the sort is stable, so that is whatever the server
  // returned.
  return i < 0 ? Number.MAX_SAFE_INTEGER : i
}

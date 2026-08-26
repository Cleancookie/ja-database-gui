/**
 * Matching and ranking for the command palette.
 *
 * Scoring is delegated to `fuzzysort`, which is the same class of matcher
 * behind VS Code's file finder: it understands prefixes, word boundaries,
 * camelCase and consecutive runs, and it is far better tuned than anything
 * worth hand-maintaining here.
 *
 * What this module still owns, because it is specific to a database browser:
 *
 * 1. **Where to match.** A bare query is matched against the object *name*.
 *    The schema is only consulted at a discount, so typing "user" finds
 *    `auth.user` rather than everything living in a schema whose name happens
 *    to contain those letters.
 *
 * 2. **Bias.** Framework schemas (Supabase's `extensions`, `graphql`, …) and
 *    routines are demoted, so a real table always wins a close contest.
 *
 * 3. **A cutoff.** This is the part that makes the palette feel filtered.
 *    Fuzzy matching is inherently permissive — "user" legitimately matches
 *    `customers` via c-U-S-t-om-E-R-s — so results are cut relative to the
 *    best hit. With a strong match on screen, weak ones disappear entirely;
 *    with only weak matches, they are all still offered.
 */

import fuzzysort, { type Result } from 'fuzzysort'

export interface Match {
  score: number
  /** Indices into the matched label, for highlighting. */
  positions: number[]
}

/**
 * Where a query matched, before the result is turned into a score or into
 * highlight positions.
 *
 * Kept as fuzzysort's own result rather than a copy: materialising the matched
 * indices into a JS array is the single most expensive thing about ranking a
 * large list — measurably more than the matching itself — and only the handful
 * of rows actually rendered ever need them. See `matchPositions`.
 */
interface FieldMatch {
  result: Result
  /** Subtracted from the score, for matching something other than the name. */
  penalty: number
  /**
   * How far the matched string runs ahead of `name`, or null when the match
   * was not on anything the caller renders and has no honest highlighting.
   */
  offset: number | null
}

/**
 * Results scoring below `best * RELATIVE_CUTOFF` are dropped. At 0.5, an exact
 * hit (1.0) hides anything under 0.5 — which is where the scattered junk sits.
 */
const RELATIVE_CUTOFF = 0.5

/** Nothing below this is ever worth showing, even if it is the best there is. */
const ABSOLUTE_FLOOR = 0.15

/** Matching the schema instead of the name costs this much. */
const QUALIFIER_PENALTY = 0.3

/** Matching a hidden keyword rather than anything visible costs this much. */
const KEYWORD_PENALTY = 0.45

/**
 * A palette candidate. `name` is what the user is most likely typing — a bare
 * table name. `qualifier` is the schema it lives in.
 */
export interface Candidate {
  name: string
  qualifier?: string
  /** Hidden synonyms, matched at a steep discount. */
  keywords?: string
  /** Added to the final score. Negative demotes; see `schemaBias`. */
  bias?: number
}

export interface Scored<T> {
  item: T
  score: number
}

/** Where a non-empty query matches a candidate, and at what discount. */
function bestField(query: string, c: Candidate): FieldMatch | null {
  // A dotted query is an explicit "schema.table", so match it that way.
  if (query.includes('.')) {
    const qualified = c.qualifier ? `${c.qualifier}.${c.name}` : c.name
    const m = fuzzysort.single(query, qualified)
    return m ? { result: m, penalty: 0, offset: qualified.length - c.name.length } : null
  }

  const onName = fuzzysort.single(query, c.name)
  if (onName) return { result: onName, penalty: 0, offset: 0 }

  // Fall back to the schema, then hidden keywords — both discounted so they
  // can never displace a genuine name match, and neither highlights anything:
  // the characters that matched are not in what the row shows.
  if (c.qualifier) {
    const m = fuzzysort.single(query, c.qualifier)
    if (m) return { result: m, penalty: QUALIFIER_PENALTY, offset: null }
  }

  if (c.keywords) {
    const m = fuzzysort.single(query, c.keywords)
    if (m) return { result: m, penalty: KEYWORD_PENALTY, offset: null }
  }

  return null
}

/**
 * A candidate's score, or null when it does not match at all.
 *
 * This is what ranking uses. It deliberately does not produce highlight
 * positions — see `matchPositions`.
 */
export function matchScore(query: string, c: Candidate): number | null {
  const bias = c.bias ?? 0
  if (!query) return bias
  const m = bestField(query, c)
  return m ? m.result.score - m.penalty + bias : null
}

/**
 * The characters of `name` that the query matched, for highlighting.
 *
 * Always indices into `name`, so highlighting lines up with what the palette
 * renders. Called once per *rendered* row rather than once per candidate: the
 * copy out of fuzzysort's internal buffer costs more than the match, and a
 * result nobody can see does not need it. fuzzysort caches its prepared
 * targets, so asking a second time for a row on screen is cheap.
 */
export function matchPositions(query: string, c: Candidate): number[] {
  if (!query) return []
  const m = bestField(query, c)
  if (!m || m.offset === null) return []
  const positions = Array.from(m.result.indexes)
  if (m.offset === 0) return positions
  // Shift onto the name and drop any landing in the schema part.
  return positions.map((p) => p - m.offset!).filter((p) => p >= 0)
}

/** Score and positions together. */
export function matchCandidate(query: string, c: Candidate): Match | null {
  const score = matchScore(query, c)
  return score === null ? null : { score, positions: matchPositions(query, c) }
}

/**
 * Filters and ranks candidates, then applies the relative cutoff that keeps
 * the list short.
 */
export function rankCandidates<T>(
  query: string,
  items: T[],
  toCandidate: (item: T) => Candidate,
): Scored<T>[] {
  const scored: Scored<T>[] = []
  for (const item of items) {
    const score = matchScore(query, toCandidate(item))
    if (score !== null) scored.push({ item, score })
  }
  // Array.prototype.sort is stable, so equal scores keep registry order.
  scored.sort((a, b) => b.score - a.score)

  if (!query || scored.length === 0) return scored

  const best = scored[0].score
  const cutoff = Math.max(ABSOLUTE_FLOOR, best * RELATIVE_CUTOFF)
  return scored.filter((s) => s.score >= cutoff)
}

/**
 * Schemas that are technically the user's but are almost always framework
 * plumbing. Objects in them still appear — they are demoted, so a real table
 * with a similar name always wins, and weak matches fall under the cutoff.
 *
 * This is a heuristic about noise, not correctness: getting it wrong costs a
 * few rank positions, never a missing result for a strong match.
 */
const NOISY_SCHEMAS = new Set([
  'extensions',
  'graphql',
  'graphql_public',
  'pgbouncer',
  'realtime',
  'storage',
  'supabase_functions',
  'supabase_migrations',
  'vault',
  'net',
  'cron',
  'pgsodium',
  'pgsodium_masks',
  '_timescaledb_internal',
  '_timescaledb_catalog',
])

export function schemaBias(schema: string | undefined): number {
  if (!schema) return 0
  return NOISY_SCHEMAS.has(schema.toLowerCase()) ? -0.25 : 0
}

import type { Connection, Settings } from './types'

export const SECTIONS = ['settings', 'hotkeys', 'connections'] as const
export type Section = (typeof SECTIONS)[number]

export interface Transfer {
  app: 'ja-db'
  version: 1
  settings?: Partial<Settings>
  hotkeys?: Record<string, string[]>
  /** No passwords, and no ids: the importing machine assigns its own. */
  connections?: Connection[]
}

/** The file for the chosen sections. Passwords live in the keyring and never reach here. */
export function buildTransfer(
  sections: Section[],
  settings: Settings,
  connections: Connection[],
): Transfer {
  const out: Transfer = { app: 'ja-db', version: 1 }
  if (sections.includes('settings')) {
    const { hotkeys: _, ...rest } = settings
    out.settings = rest
  }
  if (sections.includes('hotkeys')) out.hotkeys = settings.hotkeys ?? {}
  if (sections.includes('connections')) {
    out.connections = connections.map(
      ({ id: _id, createdAt: _c, updatedAt: _u, ...rest }) => rest as Connection,
    )
  }
  return out
}

/**
 * Reads a file written by `buildTransfer`, keeping only what looks right.
 * Settings are matched against the current ones by key and type, so a file
 * from another version cannot add fields or put a string where a number goes.
 */
export function parseTransfer(text: string, current: Settings): Transfer {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('Not a JSON file')
  }
  const obj = raw as Record<string, unknown>
  if (!obj || typeof obj !== 'object' || obj.app !== 'ja-db') throw new Error('Not a ja-db export')

  const out: Transfer = { app: 'ja-db', version: 1 }

  if (obj.settings && typeof obj.settings === 'object') {
    const incoming = obj.settings as Record<string, unknown>
    const kept: Record<string, unknown> = {}
    for (const [key, now] of Object.entries(current)) {
      if (key === 'hotkeys' || !(key in incoming)) continue
      const v = incoming[key]
      if (v === null ? now === null : typeof v === typeof now) kept[key] = v
    }
    out.settings = kept as Partial<Settings>
  }

  if (obj.hotkeys && typeof obj.hotkeys === 'object') {
    const kept: Record<string, string[]> = {}
    for (const [id, keys] of Object.entries(obj.hotkeys as Record<string, unknown>)) {
      if (Array.isArray(keys) && keys.every((k) => typeof k === 'string')) kept[id] = keys
    }
    out.hotkeys = kept
  }

  if (Array.isArray(obj.connections)) {
    out.connections = obj.connections
      .filter(
        (c): c is Connection => !!c && typeof c.name === 'string' && typeof c.kind === 'string',
      )
      .map(
        ({ id: _id, createdAt: _c, updatedAt: _u, ...rest }) => ({ ...rest, id: '' }) as Connection,
      )
  }
  return out
}

const sameServer = (a: Connection, b: Connection) =>
  a.kind === b.kind &&
  a.name === b.name &&
  (a.host ?? '') === (b.host ?? '') &&
  (a.database ?? '') === (b.database ?? '') &&
  (a.file ?? '') === (b.file ?? '')

/** The imported connections not already present, so importing twice adds nothing. */
export function newConnections(incoming: Connection[], existing: Connection[]): Connection[] {
  return incoming.filter((c) => !existing.some((e) => sameServer(e, c)))
}

export function sectionsIn(t: Transfer): Section[] {
  return SECTIONS.filter((s) => t[s] !== undefined)
}

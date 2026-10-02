// Pure, so it can be tested without the API client.

import type { TlsInfo } from './types'

/** Short tag for a list row; the full label goes in the tooltip. */
export function tlsTag(i: TlsInfo): { text: string; colour: string } | null {
  switch (i.level) {
    case 'na':
      return null
    case 'verified':
      return { text: 'TLS', colour: 'var(--color-success)' }
    case 'encrypted':
      return { text: 'TLS unverified', colour: 'var(--color-warn)' }
    case 'partial':
      return { text: 'TLS optional', colour: 'var(--color-warn)' }
    default:
      return { text: 'no TLS', colour: i.warn ? 'var(--color-danger)' : 'var(--color-faint)' }
  }
}

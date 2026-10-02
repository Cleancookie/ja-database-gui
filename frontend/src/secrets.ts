// Pure helpers for password storage: what to warn about, and when to ask.
// Kept free of React and the store so they can be tested without a DOM.

import type { Connection, SecretBackend } from './types'

/** The prefix Go puts on the error for an ask-every-time connection with no session. */
const PASSWORD_REQUIRED = 'PASSWORD_REQUIRED'

export function isPasswordRequired(message: string): boolean {
  return message.includes(PASSWORD_REQUIRED)
}

/**
 * Whether connecting must stop and ask first. An ask-every-time connection that
 * is already open reuses its session, and a typed password means it was asked.
 */
export function needsPasswordPrompt(
  conn: Connection | undefined,
  connected: boolean,
  password: string | null,
): boolean {
  return !!conn?.askPassword && !connected && password === null
}

export interface StorageWarning {
  level: 'warn' | 'error'
  headline: string
  detail: string
}

/** null when passwords are in the OS keyring, or the backend is not known yet. */
export function storageWarning(b: SecretBackend | null): StorageWarning | null {
  if (!b || b.kind === 'keyring') return null
  const why = b.reason ? ` (${b.reason})` : ''
  if (b.kind === 'file') {
    return {
      level: 'warn',
      headline: 'Saved passwords are NOT stored securely',
      detail:
        `No OS keyring is available${why}, so passwords are kept as plain text in secrets.json ` +
        'in the ja-db config folder. On a throwaway dev machine this may be fine. ' +
        'Anywhere else, tick "Ask for the password every time" on each connection.',
    }
  }
  return {
    level: 'error',
    headline: 'Saved passwords cannot be read or saved',
    detail:
      `The OS keyring that holds them is not answering${why}. ja-db will not fall back to a ` +
      'plain-text file. Connections that ask for their password every time still work.',
  }
}

export const PARAMS_WARNING =
  'Extra parameters are saved as plain text in connections.json. Do not put passwords or tokens in them.'

export const TRUST_WARNING =
  'Anyone who can intercept the connection can impersonate this server and read the login and every query. Use only for a server you control, such as a local or containerised one.'

// What the UI says about a connection's TLS mode. The rules live in Go
// (driver.TLS); this only caches the answer and picks a colour.

import { useEffect, useState } from 'react'
import { api } from './api'
import type { Connection, TlsInfo } from './types'

const cache = new Map<string, Promise<TlsInfo>>()

/** Only the fields that change the answer, so typing a name is not a request. */
function key(c: Connection): string {
  return JSON.stringify([c.kind, c.host, c.sslMode, c.trustServerCertificate])
}

export function describeTls(c: Connection): Promise<TlsInfo> {
  const k = key(c)
  let p = cache.get(k)
  if (!p) {
    p = api.describeTLS(c)
    p.catch(() => cache.delete(k))
    cache.set(k, p)
  }
  return p
}

export function useTls(c: Connection): TlsInfo | null {
  const [info, setInfo] = useState<TlsInfo | null>(null)
  const k = key(c)
  useEffect(() => {
    let live = true
    describeTls(c)
      .then((i) => live && setInfo(i))
      .catch(() => live && setInfo(null))
    return () => {
      live = false
    }
    // c is read only through k.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k])
  return info
}

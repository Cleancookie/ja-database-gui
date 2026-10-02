import { useTls } from '../tls'
import { tlsTag } from '../tlsTag'
import type { Connection } from '../types'

/** One word on a list row saying whether the connection's TLS is verified. */
export function TlsTag({ conn }: { conn: Connection }) {
  const info = useTls(conn)
  const tag = info && tlsTag(info)
  if (!info || !tag) return null
  return (
    <span title={info.label} className="ml-2 font-semibold" style={{ color: tag.colour }}>
      {tag.text}
    </span>
  )
}

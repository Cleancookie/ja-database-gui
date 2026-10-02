# 8. TLS is verified by default off this machine; SSL mode is an allow-list

Date: 2026-10-02
Status: Accepted

## Context

Security audit B1-B3 (`docs/SECURITY-AUDIT.md`):

- Postgres defaulted to `sslmode=prefer`: downgradable, certificate never checked.
- SQL Server always sent `TrustServerCertificate=true`.
- MySQL sent no `tls` at all: plaintext.
- `SSLMode` and `Params` were passed to the DSN unchecked, so a `Params` key
  could override whatever the form set.

Making every default `verify-full` would break the common case of a local or
containerised server with a self-signed certificate (or none), and would break
saved connections without a word.

## Decision

```
 SSLMode empty ("Default for this host")        explicit SSLMode
 ├─ loopback host   postgres prefer             used as chosen, if on the
 │                  mysql    preferred          dialect's allow-list
 │                  mssql    true + trust cert
 └─ any other host  postgres verify-full
                    mysql    true
                    mssql    true, certificate checked
```

1. **Empty is a default, not a mode.** It resolves at connect time from the host,
   so editing a connection's host from `localhost` to a remote name moves it to
   verified TLS with no other change. New connections start empty.
2. **Loopback keeps working.** `localhost`, `127.0.0.0/8`, `::1`, `*.localhost`,
   an empty host and a postgres socket path stay on the old behaviour or better
   (`prefer` / `preferred`; SQL Server still trusts its own certificate there).
3. **Allow-list per dialect**, `Capabilities.SSLModes`, enforced in `DSN` and at
   save time (`driver.ValidateConn`):
   postgres `disable allow prefer require verify-ca verify-full`;
   mysql `false preferred skip-verify true`;
   mssql `disable false true strict`.
4. **`Params` cannot carry TLS keys** (`sslmode`, `tls`, `encrypt`,
   `TrustServerCertificate`, any case). They are refused, not ignored.
5. **SQL Server's trust switch is explicit**: `Connection.TrustServerCertificate`,
   a checkbox with a standing warning. It is the only way to skip the check on a
   remote host.
6. **The UI says what is in force.** `DescribeTLS` (both transports) returns the
   resolved mode, a level (`plain partial encrypted verified`) and a `warn` flag
   for a non-loopback host short of verified. The form shows it under the select;
   the Picker tags each connection.
7. **A certificate failure says where to fix it.** `tlsHint` appends the mode in
   force and points at Edit connection.

## Consequences

Existing saved connections (all have an empty mode):

| Connection | Before | Now |
| --- | --- | --- |
| Postgres, remote, server has a CA-signed cert | prefer | verify-full, works |
| Postgres, remote, self-signed or no TLS | prefer | **fails** until a mode is chosen |
| MySQL, remote, any | plaintext | **fails** unless the server has a trusted cert |
| SQL Server, remote, self-signed | trusted | **fails** until the trust box is ticked |
| Any, loopback | as before | as before (MySQL gains opportunistic TLS) |
| Params containing a TLS key | applied | **refused** |

The failure is loud and names the setting. Nothing is silently weakened or
rewritten on disk. This is a breaking change for those rows, hence the commit
marker. `verify-ca` and `verify-full` use the system roots, or `sslrootcert` in
`Params` for a private CA.
